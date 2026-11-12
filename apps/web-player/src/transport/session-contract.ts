/** Execution data shared by local calls and the optional Worker wire adapter. */
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
export const PLAYER_CART_DATA_BYTES = 256 as const;
export const PLAYER_CART_DATA_ID_MAX_BYTES = 64 as const;
export const PLAYER_CART_DATA_MAX_RECORDS = 4096 as const;

interface SessionCommandContext {
  readonly requestId: number;
  readonly sessionGeneration: number;
}

export interface PlayerLocalCartBundleEntry {
  readonly ref: string;
  readonly cartBytes: ArrayBuffer;
  readonly access: CartAccess;
}

export interface PlayerCartDataSeedEntry {
  readonly id: string;
  readonly bytes: ArrayBuffer;
}

export type SessionControlCommand =
  | (SessionCommandContext & {
      readonly type: "loadCart";
      readonly cartBytes: ArrayBuffer;
      /** Caller-authorized local-only targets. The Worker performs no discovery. */
      readonly localCartBundle?: readonly PlayerLocalCartBundleEntry[];
      /** Presence selects caller-owned persistence; an empty array is a valid fresh store. */
      readonly hostCartData?: readonly PlayerCartDataSeedEntry[];
      readonly instructionBudget?: number;
    })
  | (SessionCommandContext & { readonly type: "start" })
  | (SessionCommandContext & { readonly type: "step"; readonly sequence: number })
  | (SessionCommandContext & {
      readonly type: "vsync";
      readonly sequence: number;
      readonly timestampMs: number;
    })
  | (SessionCommandContext & { readonly type: "pause" })
  | (SessionCommandContext & { readonly type: "openPauseMenu" })
  | (SessionCommandContext & { readonly type: "closePauseMenu" })
  | (SessionCommandContext & {
      readonly type: "invokeMenuItem";
      readonly slot: 1 | 2 | 3 | 4 | 5;
      readonly button: 1 | 2 | 4;
    })
  | (SessionCommandContext & { readonly type: "resume" })
  | (SessionCommandContext & { readonly type: "reset" })
  | (SessionCommandContext & { readonly type: "stop" })
  | (SessionCommandContext & { readonly type: "flushPersistence" })
  | (SessionCommandContext & { readonly type: "dispose" });

export type SessionInputCommand = SessionCommandContext & {
  readonly type: "input";
  /** Requestless commands reserve request id zero. */
  readonly requestId: 0;
  readonly sequence: number;
  readonly input: PicoInputSnapshot;
};

export type SessionCommand =
  | SessionControlCommand
  | SessionInputCommand;

interface SessionEventContext {
  readonly requestId: number;
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

export type SessionEvent =
  | (SessionEventContext & {
      readonly type: "cartdata-commit";
      readonly id: string;
      readonly revision: number;
      readonly bytes: ArrayBuffer;
    })
  | (SessionEventContext & {
      readonly type: "persistence-flushed";
      /** Worker durability, or completion of the host-owned commit drain. */
      readonly durable: boolean;
      readonly message?: string;
    })
  | (SessionEventContext & {
      /** Must be the first event published for an atomic guest load() commit. */
      readonly type: "session-replaced";
      readonly previousSessionGeneration: number;
      readonly nextSessionGeneration: number;
      readonly cartRef: string;
      readonly breadcrumb: ArrayBuffer;
      readonly breadcrumbDepth: number;
    })
  | (SessionEventContext & {
      readonly type: "pause-menu";
      readonly open: boolean;
      readonly outcome: "opened" | "keep-open" | "closed" | "removed";
      readonly items: readonly PlayerMenuItemSnapshot[];
    })
  | (SessionEventContext & {
      readonly type: "state";
      readonly state: PlayerRuntimeState;
      readonly mode: "none" | "callback" | "custom";
      readonly targetFps: 0 | 30 | 60;
      readonly devkitFlags: number;
    })
  | (SessionEventContext & {
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
  | (SessionEventContext & {
      readonly type: "heartbeat";
      readonly vsyncSequence: number;
      readonly tickCount: number;
      readonly droppedTicks: number;
    })
  | (SessionEventContext & {
      readonly type: "runtime-control";
      readonly control: "run" | "stop";
      /** Copy-owned P8 byte string: run parameter or stop message. */
      readonly payload: ArrayBuffer;
    })
  | (SessionEventContext & {
      readonly type: "diagnostic";
      readonly error: SerializedRuntimeError;
    })
  | (SessionEventContext & {
      readonly type: "fault";
      readonly error: SerializedRuntimeError;
    });
