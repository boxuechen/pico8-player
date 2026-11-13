// apps/player/src/transport/audio-protocol.ts
var AUDIO_PROTOCOL_VERSION = 1;
var PICO_CANONICAL_SAMPLE_RATE = 22050;

// packages/contracts/dist/public.js
var PICO_CONTROLLER_COUNT = 8;
var PICO_EMPTY_INPUT = Object.freeze({
  controllers: Object.freeze(new Array(PICO_CONTROLLER_COUNT).fill(0)),
  devkit: Object.freeze({
    mouseXRaw: 0,
    mouseYRaw: 0,
    mouseButtons: 0,
    wheelRaw: 0,
    movementXRaw: 0,
    movementYRaw: 0,
    keypresses: Object.freeze([])
  })
});

// apps/player/src/transport/validators.ts
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function isUint(value) {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 4294967295;
}
function isDecimalUint(value) {
  return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value);
}
function isAudioEnvelope(value) {
  return isRecord(value) && value.v === AUDIO_PROTOCOL_VERSION && isUint(value.sessionGeneration);
}
function isAudioPortAttachmentEnvelope(value) {
  return isAudioEnvelope(value) && value.type === "attachAudioPort";
}
function isAudioTransportMessage(value) {
  if (!isAudioEnvelope(value)) return false;
  if (value.type === "audioReset") {
    return isUint(value.nextSequence) && isDecimalUint(value.firstSample);
  }
  if (value.type !== "audioChunk") return false;
  return isUint(value.sequence) && isDecimalUint(value.firstSample) && value.sampleRate === PICO_CANONICAL_SAMPLE_RATE && isUint(value.frameCount) && Number(value.frameCount) > 0 && Number(value.frameCount) <= 65536 && value.pcm16le instanceof ArrayBuffer && value.pcm16le.byteLength === Number(value.frameCount) * 2;
}
function isAudioWorkletControlMessage(value) {
  return isRecord(value) && value.v === AUDIO_PROTOCOL_VERSION && (value.type === "requestAudioStats" || value.type === "disposeAudio");
}

// apps/player/src/worklet/pcm-queue.ts
var PICO_AUDIO_QUEUE_CAPACITY_FRAMES = 66150;
var PICO_AUDIO_QUEUE_PREBUFFER_FRAMES = 11025;
var PICO_AUDIO_QUEUE_LOW_WATER_FRAMES = 5512;
var PICO_AUDIO_QUEUE_HIGH_WATER_FRAMES = 44100;
function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}
var Pcm16Queue = class {
  #samples;
  #prebufferFrames;
  #lowWaterFrames;
  #highWaterFrames;
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
  constructor(options = {}) {
    const capacity = positiveInteger(
      options.capacityFrames ?? PICO_AUDIO_QUEUE_CAPACITY_FRAMES,
      "capacityFrames"
    );
    const prebuffer = positiveInteger(
      options.prebufferFrames ?? PICO_AUDIO_QUEUE_PREBUFFER_FRAMES,
      "prebufferFrames"
    );
    const lowWater = positiveInteger(
      options.lowWaterFrames ?? PICO_AUDIO_QUEUE_LOW_WATER_FRAMES,
      "lowWaterFrames"
    );
    const highWater = positiveInteger(
      options.highWaterFrames ?? PICO_AUDIO_QUEUE_HIGH_WATER_FRAMES,
      "highWaterFrames"
    );
    if (!(lowWater < prebuffer && prebuffer <= highWater && highWater <= capacity)) {
      throw new RangeError(
        "queue watermarks must satisfy low < prebuffer <= high <= capacity"
      );
    }
    this.#samples = new Int16Array(capacity);
    this.#prebufferFrames = prebuffer;
    this.#lowWaterFrames = lowWater;
    this.#highWaterFrames = highWater;
  }
  get sessionGeneration() {
    return this.#generation;
  }
  get queuedFrames() {
    return this.#size;
  }
  get playing() {
    return this.#playing;
  }
  reset(message) {
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
  push(message) {
    if (message.sessionGeneration !== this.#generation) {
      this.#staleChunks += 1;
      return { accepted: false, resynced: false };
    }
    let resynced = false;
    const firstSample = BigInt(message.firstSample);
    if (message.sequence !== this.#expectedSequence || firstSample !== this.#expectedFirstSample) {
      this.#discontinuities += 1;
      this.#clearBufferedState();
      resynced = true;
    }
    const bytes = new DataView(message.pcm16le);
    for (let index = 0; index < message.frameCount; index += 1) {
      this.#enqueue(bytes.getInt16(index * 2, true));
    }
    this.#expectedSequence = message.sequence + 1 >>> 0;
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
  beginRenderQuantum() {
    if (!this.#playing && this.#size >= this.#prebufferFrames) {
      this.#playing = true;
      this.#startedOnce = true;
    }
    if (this.#playing) return true;
    if (this.#startedOnce) this.#steadyUnderruns += 1;
    else this.#startupUnderruns += 1;
    return false;
  }
  dequeue() {
    if (this.#size === 0) return void 0;
    const sample = this.#samples[this.#readOffset];
    this.#readOffset = (this.#readOffset + 1) % this.#samples.length;
    this.#size -= 1;
    return sample;
  }
  markSteadyUnderrun() {
    this.#steadyUnderruns += 1;
    this.#playing = false;
  }
  markRenderedDeviceFrames(frames) {
    this.#renderedDeviceFrames += frames;
  }
  snapshot(deviceSampleRate) {
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
      playing: this.#playing
    };
  }
  #enqueue(sample) {
    if (this.#size === this.#samples.length) {
      this.#drop(1);
      this.#overruns += 1;
      this.#droppedSourceFrames += 1;
    }
    this.#samples[this.#writeOffset] = sample;
    this.#writeOffset = (this.#writeOffset + 1) % this.#samples.length;
    this.#size += 1;
  }
  #drop(frames) {
    this.#readOffset = (this.#readOffset + frames) % this.#samples.length;
    this.#size -= frames;
  }
  #clearBufferedState() {
    this.#readOffset = 0;
    this.#writeOffset = 0;
    this.#size = 0;
    this.#playing = false;
  }
};
var PcmDeviceRenderer = class {
  #queue;
  #currentSample;
  #nextSample;
  #phase = 0;
  constructor(queue) {
    this.#queue = queue;
  }
  reset() {
    this.#currentSample = void 0;
    this.#nextSample = void 0;
    this.#phase = 0;
  }
  render(channels, deviceSampleRate) {
    const frameCount = channels[0]?.length ?? 0;
    for (const channel of channels) channel.fill(0);
    if (frameCount === 0) return true;
    this.#queue.markRenderedDeviceFrames(frameCount);
    if (!this.#queue.beginRenderQuantum()) return false;
    if (this.#currentSample === void 0 || this.#nextSample === void 0) {
      this.#currentSample = this.#queue.dequeue();
      this.#nextSample = this.#queue.dequeue();
      if (this.#currentSample === void 0 || this.#nextSample === void 0) {
        this.#queue.markSteadyUnderrun();
        this.reset();
        return false;
      }
    }
    const ratio = PICO_CANONICAL_SAMPLE_RATE / deviceSampleRate;
    for (let frame = 0; frame < frameCount; frame += 1) {
      const interpolated = this.#currentSample + (this.#nextSample - this.#currentSample) * this.#phase;
      const output = Math.max(-1, Math.min(1, interpolated / 32768));
      for (const channel of channels) channel[frame] = output;
      this.#phase += ratio;
      while (this.#phase >= 1) {
        this.#currentSample = this.#nextSample;
        this.#nextSample = this.#queue.dequeue();
        this.#phase -= 1;
        if (this.#nextSample === void 0) {
          for (const channel of channels) channel.fill(0, frame + 1);
          this.#queue.markSteadyUnderrun();
          this.reset();
          return false;
        }
      }
    }
    return true;
  }
};

// apps/player/src/worklet/pico8-audio-processor.ts
function isPort(value) {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value;
  return typeof candidate.postMessage === "function" && typeof candidate.close === "function";
}
var Pico8AudioProcessor = class extends AudioWorkletProcessor {
  #queue = new Pcm16Queue();
  #renderer = new PcmDeviceRenderer(this.#queue);
  #audioPort;
  #disposed = false;
  #quantumsSinceStats = 0;
  constructor() {
    super();
    this.port.onmessage = (event) => this.#handleControl(event.data);
  }
  process(_inputs, outputs) {
    if (this.#disposed) return false;
    this.#renderer.render(outputs[0] ?? [], sampleRate);
    this.#quantumsSinceStats += 1;
    if (this.#quantumsSinceStats >= 32) {
      this.#quantumsSinceStats = 0;
      this.#postStats();
    }
    return true;
  }
  #handleControl(value) {
    if (isAudioPortAttachmentEnvelope(value)) {
      const port = value.port;
      if (!isPort(port)) return;
      if (value.sessionGeneration < this.#queue.sessionGeneration) {
        port.close();
        return;
      }
      this.#audioPort?.close();
      this.#audioPort = port;
      port.onmessage = (event) => this.#handleAudio(event.data);
      port.start?.();
      this.#postStats();
      return;
    }
    if (!isAudioWorkletControlMessage(value)) return;
    if (value.type === "requestAudioStats") this.#postStats();
    else this.#dispose();
  }
  #handleAudio(value) {
    if (!isAudioTransportMessage(value)) return;
    if (value.type === "audioReset") {
      this.#queue.reset(value);
      this.#renderer.reset();
    } else {
      const result = this.#queue.push(value);
      if (result.resynced) this.#renderer.reset();
    }
    this.#postStats();
  }
  #postStats() {
    this.port.postMessage(this.#queue.snapshot(sampleRate));
  }
  #dispose() {
    if (this.#disposed) return;
    this.#audioPort?.close();
    this.#audioPort = void 0;
    this.#disposed = true;
    this.#postStats();
    this.port.close();
  }
};
registerProcessor("pico8-audio-processor", Pico8AudioProcessor);
export {
  Pico8AudioProcessor
};
