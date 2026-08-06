import {
  isAudioPortAttachmentEnvelope,
  isAudioTransportMessage,
  isAudioWorkletControlMessage,
} from "../transport/public.js";
import { Pcm16Queue, PcmDeviceRenderer } from "./pcm-queue.js";

interface WorkletMessageEvent {
  readonly data: unknown;
}

interface WorkletMessagePort {
  onmessage: ((event: WorkletMessageEvent) => void) | null;
  postMessage(message: unknown): void;
  start?(): void;
  close(): void;
}

declare const sampleRate: number;
declare abstract class AudioWorkletProcessor {
  readonly port: WorkletMessagePort;
  abstract process(
    inputs: readonly Float32Array[][],
    outputs: readonly Float32Array[][],
    parameters: Readonly<Record<string, Float32Array>>,
  ): boolean;
}
declare function registerProcessor(
  name: string,
  processor: new () => AudioWorkletProcessor,
): void;

function isPort(value: unknown): value is WorkletMessagePort {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<WorkletMessagePort>;
  return (
    typeof candidate.postMessage === "function" &&
    typeof candidate.close === "function"
  );
}

export class Pico8AudioProcessor extends AudioWorkletProcessor {
  readonly #queue = new Pcm16Queue();
  readonly #renderer = new PcmDeviceRenderer(this.#queue);
  #audioPort: WorkletMessagePort | undefined;
  #disposed = false;
  #quantumsSinceStats = 0;

  constructor() {
    super();
    this.port.onmessage = (event) => this.#handleControl(event.data);
  }

  process(
    _inputs: readonly Float32Array[][],
    outputs: readonly Float32Array[][],
  ): boolean {
    if (this.#disposed) return false;
    this.#renderer.render(outputs[0] ?? [], sampleRate);
    this.#quantumsSinceStats += 1;
    if (this.#quantumsSinceStats >= 32) {
      this.#quantumsSinceStats = 0;
      this.#postStats();
    }
    return true;
  }

  #handleControl(value: unknown): void {
    if (isAudioPortAttachmentEnvelope(value)) {
      const port = (value as { readonly port?: unknown }).port;
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

  #handleAudio(value: unknown): void {
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

  #postStats(): void {
    this.port.postMessage(this.#queue.snapshot(sampleRate));
  }

  #dispose(): void {
    if (this.#disposed) return;
    this.#audioPort?.close();
    this.#audioPort = undefined;
    this.#disposed = true;
    this.#postStats();
    this.port.close();
  }
}

registerProcessor("pico8-audio-processor", Pico8AudioProcessor);
