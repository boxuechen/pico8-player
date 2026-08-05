import type {
  Phase0EHostToRuntime,
  Phase0ERuntimeToHost,
} from "../transport/public.js";
import { isPhase0ERuntimeToHost } from "../transport/public.js";
import type {
  PicoInputSnapshot,
  SerializedRuntimeError,
} from "@pico8-web/contracts";

export interface RuntimeWorkerPort {
  postMessage(message: Phase0EHostToRuntime, transfer?: readonly ArrayBuffer[]): void;
  addEventListener(
    type: "message",
    listener: (event: { readonly data: unknown }) => void,
  ): void;
  terminate(): void;
}

export type RuntimeWorkerFactory = () => RuntimeWorkerPort;

export interface RuntimeClientOptions {
  readonly commandTimeoutMs?: number;
}

interface PendingCommand {
  readonly generation: number;
  readonly timer: number;
  readonly resolve: (event: Phase0ERuntimeToHost) => void;
  readonly reject: (error: RuntimeClientError) => void;
}

type CommandBody<T = Phase0EHostToRuntime> = T extends Phase0EHostToRuntime
  ? Omit<T, "v" | "requestId" | "sessionGeneration">
  : never;

export class RuntimeClientError extends Error {
  readonly record: SerializedRuntimeError;

  constructor(record: SerializedRuntimeError) {
    super(record.message);
    this.name = "RuntimeClientError";
    this.record = record;
  }
}

export class Phase0ERuntimeClient {
  readonly #factory: RuntimeWorkerFactory;
  readonly #timeoutMs: number;
  readonly #pending = new Map<number, PendingCommand>();
  #worker: RuntimeWorkerPort;
  #generation = 0;
  #nextRequestId = 1;
  #disposed = false;

  constructor(factory: RuntimeWorkerFactory, options: RuntimeClientOptions = {}) {
    const timeoutMs = options.commandTimeoutMs ?? 1000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("commandTimeoutMs must be positive");
    }
    this.#factory = factory;
    this.#timeoutMs = timeoutMs;
    this.#worker = this.#spawn();
  }

  get sessionGeneration(): number {
    return this.#generation;
  }

  loadCart(
    p8PngBytes: Uint8Array,
    instructionBudget?: number,
  ): Promise<Phase0ERuntimeToHost> {
    const bytes = p8PngBytes.slice().buffer;
    return this.#send(
      {
        type: "loadCart",
        p8PngBytes: bytes,
        ...(instructionBudget === undefined ? {} : { instructionBudget }),
      },
      [bytes],
    );
  }

  step(input: PicoInputSnapshot): Promise<Phase0ERuntimeToHost> {
    return this.#send({ type: "step", input });
  }

  hostResponse(
    hostRequestId: number,
    response: Uint8Array,
    isError = false,
  ): Promise<Phase0ERuntimeToHost> {
    const bytes = response.slice().buffer;
    return this.#send(
      { type: "hostResponse", hostRequestId, bytes, isError },
      [bytes],
    );
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    try {
      await this.#send({ type: "dispose" });
    } finally {
      this.#disposed = true;
      this.#worker.terminate();
      for (const pending of this.#pending.values()) {
        globalThis.clearTimeout(pending.timer);
      }
      this.#pending.clear();
    }
  }

  #spawn(): RuntimeWorkerPort {
    this.#generation += 1;
    const worker = this.#factory();
    worker.addEventListener("message", (event) => this.#receive(event.data));
    return worker;
  }

  #receive(value: unknown): void {
    if (!isPhase0ERuntimeToHost(value)) return;
    if (value.sessionGeneration !== this.#generation) return;
    const pending = this.#pending.get(value.requestId);
    if (pending === undefined || pending.generation !== this.#generation) return;
    globalThis.clearTimeout(pending.timer);
    this.#pending.delete(value.requestId);
    pending.resolve(value);
  }

  #send(
    command: CommandBody,
    transfer: readonly ArrayBuffer[] = [],
  ): Promise<Phase0ERuntimeToHost> {
    if (this.#disposed) {
      return Promise.reject(
        new RuntimeClientError({
          code: "E_INVALID_STATE",
          message: "runtime client is disposed",
          phase: "none",
          recoverable: false,
        }),
      );
    }
    const requestId = this.#nextRequestId++;
    const generation = this.#generation;
    const envelope = {
      ...command,
      v: 1 as const,
      requestId,
      sessionGeneration: generation,
    } as Phase0EHostToRuntime;
    return new Promise((resolve, reject) => {
      const timer = globalThis.setTimeout(
        () => this.#watchdog(requestId, generation),
        this.#timeoutMs,
      );
      this.#pending.set(requestId, { generation, timer, resolve, reject });
      this.#worker.postMessage(envelope, transfer);
    });
  }

  #watchdog(requestId: number, generation: number): void {
    const timedOut = this.#pending.get(requestId);
    if (timedOut === undefined || timedOut.generation !== generation) return;
    const error = new RuntimeClientError({
      code: "E_VM_WATCHDOG",
      message: "Runtime Worker did not respond before the command deadline",
      phase: "none",
      recoverable: true,
      details: { sessionGeneration: generation },
    });
    this.#worker.terminate();
    for (const [id, pending] of this.#pending) {
      if (pending.generation !== generation) continue;
      globalThis.clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.reject(error);
    }
    if (!this.#disposed) this.#worker = this.#spawn();
  }
}
