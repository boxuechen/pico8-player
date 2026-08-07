import type {
  CartAccess,
  PicoInputSnapshot,
  SerializedRuntimeError,
} from "@pico8-web/contracts";

export const PLAYER_PROTOCOL_VERSION = 1 as const;
/** Runtime mirror of the package DTO constants for browser-native ESM modules. */
export const PLAYER_CONTROLLER_COUNT = 8 as const;
export const PLAYER_CONTROLLER_BUTTON_COUNT = 6 as const;
export const PLAYER_CONTROLLER_BUTTON_MASK = 0x3f as const;
export const PLAYER_DEVKIT_KEYPRESS_BATCH_LIMIT = 64 as const;
export const PLAYER_CART_INPUT_MAX_BYTES = 1_048_576 as const;
export const PLAYER_CART_REF_MAX_BYTES = 256 as const;
export const PLAYER_LOCAL_CART_BUNDLE_MAX_ENTRIES = 64 as const;

interface PlayerCommandEnvelope {
  readonly v: typeof PLAYER_PROTOCOL_VERSION;
  readonly requestId: number;
  readonly workerGeneration: number;
  readonly sessionGeneration: number;
}

export interface PlayerLocalCartBundleEntry {
  readonly ref: string;
  readonly cartBytes: ArrayBuffer;
  readonly access: CartAccess;
}

export type PlayerRuntimeControlCommand =
  | (PlayerCommandEnvelope & {
      readonly type: "loadCart";
      readonly cartBytes: ArrayBuffer;
      /** Caller-authorized local-only targets. The Worker performs no discovery. */
      readonly localCartBundle?: readonly PlayerLocalCartBundleEntry[];
      readonly instructionBudget?: number;
    })
  | (PlayerCommandEnvelope & { readonly type: "start" })
  | (PlayerCommandEnvelope & {
      readonly type: "vsync";
      readonly sequence: number;
      readonly timestampMs: number;
    })
  | (PlayerCommandEnvelope & { readonly type: "pause" })
  | (PlayerCommandEnvelope & { readonly type: "openPauseMenu" })
  | (PlayerCommandEnvelope & { readonly type: "closePauseMenu" })
  | (PlayerCommandEnvelope & {
      readonly type: "invokeMenuItem";
      readonly slot: 1 | 2 | 3 | 4 | 5;
      readonly button: 1 | 2 | 4;
    })
  | (PlayerCommandEnvelope & { readonly type: "resume" })
  | (PlayerCommandEnvelope & { readonly type: "reset" })
  | (PlayerCommandEnvelope & { readonly type: "stop" })
  | (PlayerCommandEnvelope & { readonly type: "dispose" });

export type PlayerRuntimeInputCommand = PlayerCommandEnvelope & {
  readonly type: "input";
  /** Requestless commands reserve request id zero. */
  readonly requestId: 0;
  readonly sequence: number;
  readonly input: PicoInputSnapshot;
};

/** Requestless lifecycle hint used by pagehide to best-effort flush durable data. */
export type PlayerRuntimePersistenceFlushCommand = PlayerCommandEnvelope & {
  readonly type: "flushPersistence";
  readonly requestId: 0;
};

export type PlayerHostToRuntime =
  | PlayerRuntimeControlCommand
  | PlayerRuntimeInputCommand
  | PlayerRuntimePersistenceFlushCommand;

interface PlayerEventEnvelope {
  readonly v: typeof PLAYER_PROTOCOL_VERSION;
  readonly requestId: number;
  readonly workerGeneration: number;
  readonly sessionGeneration: number;
}

export type PlayerRuntimeState =
  | "ready"
  | "running"
  | "waiting-host"
  | "paused"
  | "stopped"
  | "disposed";

export interface PlayerMenuItemSnapshot {
  readonly slot: 1 | 2 | 3 | 4 | 5;
  readonly label: ArrayBuffer;
  readonly filter: number;
}

export type PlayerRuntimeToHost =
  | (PlayerEventEnvelope & {
      /** Must be the first event published for an atomic guest load() commit. */
      readonly type: "session-replaced";
      readonly previousSessionGeneration: number;
      readonly nextSessionGeneration: number;
      readonly cartRef: string;
      readonly breadcrumb: ArrayBuffer;
      readonly breadcrumbDepth: number;
    })
  | (PlayerEventEnvelope & {
      readonly type: "pause-menu";
      readonly open: boolean;
      readonly outcome: "opened" | "keep-open" | "closed" | "removed";
      readonly items: readonly PlayerMenuItemSnapshot[];
    })
  | (PlayerEventEnvelope & {
      readonly type: "state";
      readonly state: PlayerRuntimeState;
      readonly mode: "none" | "callback" | "custom";
      readonly targetFps: 0 | 30 | 60;
      readonly devkitFlags: number;
    })
  | (PlayerEventEnvelope & {
      readonly type: "frame";
      readonly frameId: number;
      readonly completedSlices: string;
      readonly timeRawBeforeStep: number;
      readonly targetFps: 30 | 60;
      readonly cpuInstructions: number;
      readonly cpuFractionRaw: number;
      readonly slowFrame: boolean;
      readonly devkitFlags: number;
      readonly packedScreen: ArrayBuffer;
      readonly displayPalette: ArrayBuffer;
    })
  | (PlayerEventEnvelope & {
      readonly type: "heartbeat";
      readonly vsyncSequence: number;
      readonly tickCount: number;
      readonly droppedTicks: number;
    })
  | (PlayerEventEnvelope & {
      readonly type: "runtime-control";
      readonly control: "run" | "stop";
      /** Copy-owned P8 byte string: run parameter or stop message. */
      readonly payload: ArrayBuffer;
    })
  | (PlayerEventEnvelope & {
      readonly type: "diagnostic";
      readonly error: SerializedRuntimeError;
    })
  | (PlayerEventEnvelope & {
      readonly type: "fault";
      readonly error: SerializedRuntimeError;
    });
