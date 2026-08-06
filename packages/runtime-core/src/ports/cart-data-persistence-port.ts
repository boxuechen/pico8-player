import type {
  PicoCartDataCommit,
  PicoCartDataSeed,
  SerializedRuntimeError,
} from "@pico8-web/contracts";

/**
 * Browser-neutral asynchronous port consumed by the Runtime Worker composer.
 * RuntimeCore frame execution remains synchronous and only emits commit DTOs.
 */
export interface CartDataPersistencePort {
  /** Returns copy-owned records. Implementations contain read failures as diagnostics. */
  hydrate(): Promise<readonly PicoCartDataSeed[]>;
  /** Copies and coalesces a committed runtime snapshot without blocking simulation. */
  enqueue(commit: PicoCartDataCommit): void;
  /** Best-effort durable write; failed snapshots remain pending for a later retry. */
  flush(): Promise<void>;
  /** Drains bounded, serialized persistence diagnostics. */
  takeDiagnostics(): readonly SerializedRuntimeError[];
  /** Performs a final best-effort flush and releases adapter resources. */
  dispose(): Promise<void>;
}
