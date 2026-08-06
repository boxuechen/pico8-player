/** Physical PICO-8 Base RAM size. Cart ROM is a separate object. */
export const PICO_RAM_SIZE = 0x1_0000 as const;

/** Serialized cartridge ROM size before it is copied into Base RAM. */
export const PICO_CART_ROM_SIZE = 0x8000 as const;

/** Cart data ROM that may be synchronously accessed by reload/cstore. */
export const PICO_CART_DATA_ROM_SIZE = 0x4300 as const;

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
  | "E_PERSISTENCE_READ"
  | "E_PERSISTENCE_WRITE"
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
export const PICO_DEVKIT_KEYPRESS_BATCH_LIMIT = 64;
export const PICO_CART_DATA_BYTES = 256;
export const PICO_CART_DATA_NUMBER_COUNT = 64;
export const PICO_CART_DATA_ID_MAX_BYTES = 64;

/** Maximum caller-provided encoded cart input accepted by the L3 loader. */
export const PICO_CART_INPUT_MAX_BYTES = 1_048_576;

/** Maximum UTF-8 byte length of an opaque cart reference. */
export const PICO_CART_REF_MAX_BYTES = 256;

/** Maximum number of caller-authorized entries in one Worker-local bundle. */
export const PICO_LOCAL_CART_BUNDLE_MAX_ENTRIES = 64;

/** Maximum copied payload or response for one root VM HostRequest. */
export const PICO_HOST_REQUEST_MAX_BYTES = 4096;

/**
 * Caller-created authority attached to resolved cart bytes. These bits are
 * data, not hints: ref text, extensions and cart contents cannot elevate them.
 */
export interface CartAccess {
  readonly load: boolean;
  readonly reloadData: boolean;
  readonly cstoreData: boolean;
  readonly include: boolean;
}

export interface PicoControllerSnapshot {
  /** Player 0..7 left/right/up/down/O/X masks. */
  readonly controllers: readonly number[];
}

export interface PicoDevkitInputBatch {
  readonly mouseXRaw: number;
  readonly mouseYRaw: number;
  readonly mouseButtons: number;
  readonly wheelRaw: number;
  readonly movementXRaw: number;
  readonly movementYRaw: number;
  readonly keypresses: readonly number[];
}

export interface PicoInputSnapshot extends PicoControllerSnapshot {
  readonly devkit: PicoDevkitInputBatch;
}

/** Browser-neutral prehydrated record copied before guest execution begins. */
export interface PicoCartDataSeed {
  readonly id: string;
  readonly bytes: Uint8Array;
}

/** Copy-owned snapshot emitted only after a successful runtime transaction. */
export interface PicoCartDataCommit {
  readonly id: string;
  readonly bytes: Uint8Array;
  readonly revision: number;
}
