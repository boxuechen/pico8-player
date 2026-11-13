import {
  AUDIO_PROTOCOL_VERSION,
  PICO_CANONICAL_SAMPLE_RATE,
  type AudioChunkMessage,
  type AudioDeviceStatsMessage,
  type AudioResetMessage,
} from "../transport/public.js";

export interface PcmQueueOptions {
  readonly capacityFrames?: number;
  readonly prebufferFrames?: number;
  readonly lowWaterFrames?: number;
  readonly highWaterFrames?: number;
}

export interface PcmPushResult {
  readonly accepted: boolean;
  readonly resynced: boolean;
}

export const PICO_AUDIO_QUEUE_CAPACITY_FRAMES = 66_150;
export const PICO_AUDIO_QUEUE_PREBUFFER_FRAMES = 11_025;
export const PICO_AUDIO_QUEUE_LOW_WATER_FRAMES = 5_512;
export const PICO_AUDIO_QUEUE_HIGH_WATER_FRAMES = 44_100;

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

export class Pcm16Queue {
  readonly #samples: Int16Array;
  readonly #prebufferFrames: number;
  readonly #lowWaterFrames: number;
  readonly #highWaterFrames: number;
  #readOffset = 0;
  #writeOffset = 0;
  #size = 0;
  #generation = -1;
  #expectedSequence = 0;
  #expectedFirstSample = 0n;
  #playing = false;
  #startedOnce = false;
  #queueHighWaterFrames = 0;
  #startupUnderruns = 0;
  #steadyUnderruns = 0;
  #overruns = 0;
  #droppedSourceFrames = 0;
  #discontinuities = 0;
  #staleChunks = 0;
  #receivedChunks = 0;
  #renderedDeviceFrames = 0;

  constructor(options: PcmQueueOptions = {}) {
    const capacity = positiveInteger(
      options.capacityFrames ?? PICO_AUDIO_QUEUE_CAPACITY_FRAMES,
      "capacityFrames",
    );
    const prebuffer = positiveInteger(
      options.prebufferFrames ?? PICO_AUDIO_QUEUE_PREBUFFER_FRAMES,
      "prebufferFrames",
    );
    const lowWater = positiveInteger(
      options.lowWaterFrames ?? PICO_AUDIO_QUEUE_LOW_WATER_FRAMES,
      "lowWaterFrames",
    );
    const highWater = positiveInteger(
      options.highWaterFrames ?? PICO_AUDIO_QUEUE_HIGH_WATER_FRAMES,
      "highWaterFrames",
    );
    if (!(lowWater < prebuffer && prebuffer <= highWater && highWater <= capacity)) {
      throw new RangeError(
        "queue watermarks must satisfy low < prebuffer <= high <= capacity",
      );
    }
    this.#samples = new Int16Array(capacity);
    this.#prebufferFrames = prebuffer;
    this.#lowWaterFrames = lowWater;
    this.#highWaterFrames = highWater;
  }

  get sessionGeneration(): number {
    return this.#generation;
  }

  get queuedFrames(): number {
    return this.#size;
  }

  get playing(): boolean {
    return this.#playing;
  }

  reset(message: AudioResetMessage): void {
    this.#generation = message.sessionGeneration;
    this.#expectedSequence = message.nextSequence;
    this.#expectedFirstSample = BigInt(message.firstSample);
    this.#clearBufferedState();
    this.#startedOnce = false;
    this.#queueHighWaterFrames = 0;
    this.#startupUnderruns = 0;
    this.#steadyUnderruns = 0;
    this.#overruns = 0;
    this.#droppedSourceFrames = 0;
    this.#discontinuities = 0;
    this.#staleChunks = 0;
    this.#receivedChunks = 0;
    this.#renderedDeviceFrames = 0;
  }

  push(message: AudioChunkMessage): PcmPushResult {
    if (message.sessionGeneration !== this.#generation) {
      this.#staleChunks += 1;
      return { accepted: false, resynced: false };
    }
    let resynced = false;
    const firstSample = BigInt(message.firstSample);
    if (
      message.sequence !== this.#expectedSequence ||
      firstSample !== this.#expectedFirstSample
    ) {
      this.#discontinuities += 1;
      this.#clearBufferedState();
      resynced = true;
    }

    const bytes = new DataView(message.pcm16le);
    for (let index = 0; index < message.frameCount; index += 1) {
      this.#enqueue(bytes.getInt16(index * 2, true));
    }
    this.#expectedSequence = (message.sequence + 1) >>> 0;
    this.#expectedFirstSample = firstSample + BigInt(message.frameCount);
    this.#receivedChunks += 1;
    if (this.#size > this.#highWaterFrames) {
      const dropped = this.#size - this.#highWaterFrames;
      this.#drop(dropped);
      this.#overruns += 1;
      this.#droppedSourceFrames += dropped;
    }
    this.#queueHighWaterFrames = Math.max(this.#queueHighWaterFrames, this.#size);
    return { accepted: true, resynced };
  }

  beginRenderQuantum(): boolean {
    if (!this.#playing && this.#size >= this.#prebufferFrames) {
      this.#playing = true;
      this.#startedOnce = true;
    }
    if (this.#playing) return true;
    if (this.#startedOnce) this.#steadyUnderruns += 1;
    else this.#startupUnderruns += 1;
    return false;
  }

  dequeue(): number | undefined {
    if (this.#size === 0) return undefined;
    const sample = this.#samples[this.#readOffset]!;
    this.#readOffset = (this.#readOffset + 1) % this.#samples.length;
    this.#size -= 1;
    return sample;
  }

  markSteadyUnderrun(): void {
    this.#steadyUnderruns += 1;
    this.#playing = false;
  }

  markRenderedDeviceFrames(frames: number): void {
    this.#renderedDeviceFrames += frames;
  }

  snapshot(deviceSampleRate: number): AudioDeviceStatsMessage {
    return {
      v: AUDIO_PROTOCOL_VERSION,
      type: "audioStats",
      sessionGeneration: Math.max(0, this.#generation),
      deviceSampleRate,
      queuedSourceFrames: this.#size,
      queueHighWaterFrames: this.#queueHighWaterFrames,
      configuredLowWaterFrames: this.#lowWaterFrames,
      configuredHighWaterFrames: this.#highWaterFrames,
      startupUnderruns: this.#startupUnderruns,
      steadyUnderruns: this.#steadyUnderruns,
      overruns: this.#overruns,
      droppedSourceFrames: this.#droppedSourceFrames,
      discontinuities: this.#discontinuities,
      staleChunks: this.#staleChunks,
      receivedChunks: this.#receivedChunks,
      renderedDeviceFrames: this.#renderedDeviceFrames,
      playing: this.#playing,
    };
  }

  #enqueue(sample: number): void {
    if (this.#size === this.#samples.length) {
      this.#drop(1);
      this.#overruns += 1;
      this.#droppedSourceFrames += 1;
    }
    this.#samples[this.#writeOffset] = sample;
    this.#writeOffset = (this.#writeOffset + 1) % this.#samples.length;
    this.#size += 1;
  }

  #drop(frames: number): void {
    this.#readOffset = (this.#readOffset + frames) % this.#samples.length;
    this.#size -= frames;
  }

  #clearBufferedState(): void {
    this.#readOffset = 0;
    this.#writeOffset = 0;
    this.#size = 0;
    this.#playing = false;
  }
}

export class PcmDeviceRenderer {
  readonly #queue: Pcm16Queue;
  #currentSample: number | undefined;
  #nextSample: number | undefined;
  #phase = 0;

  constructor(queue: Pcm16Queue) {
    this.#queue = queue;
  }

  reset(): void {
    this.#currentSample = undefined;
    this.#nextSample = undefined;
    this.#phase = 0;
  }

  render(channels: readonly Float32Array[], deviceSampleRate: number): boolean {
    const frameCount = channels[0]?.length ?? 0;
    for (const channel of channels) channel.fill(0);
    if (frameCount === 0) return true;
    this.#queue.markRenderedDeviceFrames(frameCount);
    if (!this.#queue.beginRenderQuantum()) return false;
    if (this.#currentSample === undefined || this.#nextSample === undefined) {
      this.#currentSample = this.#queue.dequeue();
      this.#nextSample = this.#queue.dequeue();
      if (this.#currentSample === undefined || this.#nextSample === undefined) {
        this.#queue.markSteadyUnderrun();
        this.reset();
        return false;
      }
    }

    const ratio = PICO_CANONICAL_SAMPLE_RATE / deviceSampleRate;
    for (let frame = 0; frame < frameCount; frame += 1) {
      const interpolated =
        this.#currentSample +
        (this.#nextSample - this.#currentSample) * this.#phase;
      const output = Math.max(-1, Math.min(1, interpolated / 32_768));
      for (const channel of channels) channel[frame] = output;
      this.#phase += ratio;
      while (this.#phase >= 1) {
        this.#currentSample = this.#nextSample;
        this.#nextSample = this.#queue.dequeue();
        this.#phase -= 1;
        if (this.#nextSample === undefined) {
          for (const channel of channels) channel.fill(0, frame + 1);
          this.#queue.markSteadyUnderrun();
          this.reset();
          return false;
        }
      }
    }
    return true;
  }
}
