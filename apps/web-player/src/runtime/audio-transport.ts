import {
  AUDIO_PROTOCOL_VERSION,
  PICO_CANONICAL_SAMPLE_RATE,
  type AudioChunkMessage,
  type AudioResetMessage,
} from "../transport/public.js";

export interface RuntimeAudioMessagePort {
  postMessage(message: AudioResetMessage | AudioChunkMessage, transfer: ArrayBuffer[]): void;
  start?(): void;
  close(): void;
}

export interface CanonicalPcmChunk {
  readonly sequence: number;
  readonly firstSample: bigint;
  readonly frameCount: number;
  readonly pcm16le: ArrayBuffer;
}

function assertUint32(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${name} must be a uint32`);
  }
}

export class PcmOutput {
  #port: RuntimeAudioMessagePort | undefined;
  #generation = -1;
  #nextSequence = 0;
  #nextFirstSample = 0n;
  #disposed = false;

  get sessionGeneration(): number {
    return this.#generation;
  }

  get attached(): boolean {
    return this.#port !== undefined;
  }

  attach(port: RuntimeAudioMessagePort, sessionGeneration: number): void {
    this.#assertActive();
    assertUint32(sessionGeneration, "sessionGeneration");
    if (sessionGeneration < this.#generation) {
      port.close();
      return;
    }
    this.#port?.close();
    this.#port = port;
    port.start?.();
    if (sessionGeneration === this.#generation) {
      this.reset(this.#nextSequence, this.#nextFirstSample);
    } else {
      this.beginGeneration(sessionGeneration);
    }
  }

  beginGeneration(
    sessionGeneration: number,
    nextSequence = 0,
    firstSample = 0n,
  ): void {
    this.#assertActive();
    assertUint32(sessionGeneration, "sessionGeneration");
    this.#generation = sessionGeneration;
    this.reset(nextSequence, firstSample);
  }

  reset(nextSequence: number, firstSample: bigint): void {
    this.#assertActive();
    assertUint32(nextSequence, "nextSequence");
    if (firstSample < 0n) throw new RangeError("firstSample must be non-negative");
    this.#nextSequence = nextSequence;
    this.#nextFirstSample = firstSample;
    this.#port?.postMessage({
      v: AUDIO_PROTOCOL_VERSION,
      type: "audioReset",
      sessionGeneration: this.#generation,
      nextSequence,
      firstSample: firstSample.toString(),
    }, []);
  }

  send(chunk: CanonicalPcmChunk): void {
    this.#assertActive();
    assertUint32(chunk.sequence, "sequence");
    if (chunk.firstSample < 0n) throw new RangeError("firstSample must be non-negative");
    if (
      !Number.isInteger(chunk.frameCount) ||
      chunk.frameCount <= 0 ||
      chunk.frameCount > 0x10000 ||
      chunk.pcm16le.byteLength !== chunk.frameCount * 2
    ) {
      throw new RangeError("PCM frameCount does not match the transferred buffer");
    }
    const message: AudioChunkMessage = {
      v: AUDIO_PROTOCOL_VERSION,
      type: "audioChunk",
      sessionGeneration: this.#generation,
      sequence: chunk.sequence,
      firstSample: chunk.firstSample.toString(),
      sampleRate: PICO_CANONICAL_SAMPLE_RATE,
      frameCount: chunk.frameCount,
      pcm16le: chunk.pcm16le,
    };
    this.#nextSequence = (chunk.sequence + 1) >>> 0;
    this.#nextFirstSample = chunk.firstSample + BigInt(chunk.frameCount);
    this.#port?.postMessage(message, [chunk.pcm16le]);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#port?.close();
    this.#port = undefined;
    this.#generation = -1;
    this.#disposed = true;
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("PcmOutput is disposed");
  }

}
