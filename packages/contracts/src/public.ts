/** Physical PICO-8 Base RAM size. Cart ROM is a separate object. */
export const PICO_RAM_SIZE = 0x1_0000 as const;

/** Serialized cartridge ROM size before it is copied into Base RAM. */
export const PICO_CART_ROM_SIZE = 0x8000 as const;

/** Highest cart format version accepted by the PICO-8 0.2.7 target. */
export const PICO8_0_2_7_CART_VERSION = 42 as const;

/** Stable content identity shared by codec, RuntimeCore and app transports. */
export interface CartIdentity {
  /** Lower-case SHA-256 of the exact caller-provided cart input bytes. */
  readonly contentSha256: string;
}

/**
 * Runtime-neutral lease for a stable 64 KiB region in an adapter-owned buffer.
 * It intentionally exposes neither WebAssembly.Memory nor an Emscripten module.
 */
export interface PicoMemoryLease {
  readonly buffer: ArrayBuffer;
  readonly byteOffset: number;
  readonly byteLength: typeof PICO_RAM_SIZE;
  readonly leaseId: string;
}

/** Stable cross-domain failure codes introduced by the Phase 0E slice. */
export type RuntimeErrorCode =
  | "E_VM_SYNTAX"
  | "E_VM_RUNTIME"
  | "E_VM_INSTRUCTION_BUDGET"
  | "E_VM_OOM"
  | "E_VM_WATCHDOG"
  | "E_CART_PARSE"
  | "E_TIME_DISCONTINUITY"
  | "E_FEATURE_UNSUPPORTED"
  | "E_HOST_REQUEST"
  | "E_HOST_API"
  | "E_INVALID_STATE"
  | "E_INVARIANT";

export type RuntimePhase =
  | "none"
  | "compile"
  | "boot"
  | "init"
  | "update"
  | "update60"
  | "draw"
  | "custom-loop"
  | "host-call";

export interface SerializedRuntimeError {
  readonly code: RuntimeErrorCode;
  readonly message: string;
  readonly phase: RuntimePhase;
  readonly line?: number;
  readonly trace?: string;
  readonly recoverable: boolean;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
}

export const PICO_CONTROLLER_COUNT = 8;
export const PICO_CONTROLLER_BUTTON_COUNT = 6;
export const PICO_CONTROLLER_BUTTON_MASK = 0x3f;

export interface PicoInputSnapshot {
  /** Player 0..7 left/right/up/down/O/X masks; validation fixes length to 8 and each value to 6 bits. */
  readonly controllers: readonly number[];
}
