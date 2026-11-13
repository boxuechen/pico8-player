import type {
  PicoCartDataCommit,
  PicoCartDataSeed,
  SerializedRuntimeError,
} from "@pico8-player/contracts";

/**
 * Browser-neutral asynchronous port consumed by the Runtime Worker composer.
 * RuntimeCore frame execution remains synchronous and only emits commit DTOs.
 */
export interface CartDataPersistencePort {
  /** Returns copy-owned records. Implementations contain read failures as diagnostics. */
  hydrate(): Promise<readonly PicoCartDataSeed[]>;
  /** Copies and coalesces a committed runtime snapshot without blocking simulation. */
  enqueue(commit: PicoCartDataCommit): void;
  /** Reports actual durability; failed snapshots remain pending for a later retry. */
  flush(): Promise<{ readonly durable: boolean; readonly message?: string }>;
  /** Drains bounded, serialized persistence diagnostics. */
  takeDiagnostics(): readonly SerializedRuntimeError[];
  /** Performs a final best-effort flush and releases adapter resources. */
  dispose(): Promise<void>;
}
