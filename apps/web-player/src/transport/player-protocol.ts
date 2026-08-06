import type {
  PicoInputSnapshot,
  SerializedRuntimeError,
} from "@pico8-web/contracts";

export const PLAYER_PROTOCOL_VERSION = 1 as const;
/** Runtime mirror of the package DTO constants for browser-native ESM modules. */
export const PLAYER_CONTROLLER_COUNT = 8 as const;
export const PLAYER_CONTROLLER_BUTTON_COUNT = 6 as const;
export const PLAYER_CONTROLLER_BUTTON_MASK = 0x3f as const;

interface PlayerCommandEnvelope {
  readonly v: typeof PLAYER_PROTOCOL_VERSION;
  readonly requestId: number;
  readonly workerGeneration: number;
  readonly sessionGeneration: number;
}

export type PlayerRuntimeControlCommand =
  | (PlayerCommandEnvelope & {
      readonly type: "loadCart";
      readonly cartBytes: ArrayBuffer;
      readonly instructionBudget?: number;
    })
  | (PlayerCommandEnvelope & { readonly type: "start" })
  | (PlayerCommandEnvelope & {
      readonly type: "vsync";
      readonly sequence: number;
      readonly timestampMs: number;
    })
  | (PlayerCommandEnvelope & { readonly type: "pause" })
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

export type PlayerHostToRuntime =
  | PlayerRuntimeControlCommand
  | PlayerRuntimeInputCommand;

interface PlayerEventEnvelope {
  readonly v: typeof PLAYER_PROTOCOL_VERSION;
  readonly requestId: number;
  readonly workerGeneration: number;
  readonly sessionGeneration: number;
}

export type PlayerRuntimeState =
  | "ready"
  | "running"
  | "paused"
  | "stopped"
  | "disposed";

export type PlayerRuntimeToHost =
  | (PlayerEventEnvelope & {
      readonly type: "state";
      readonly state: PlayerRuntimeState;
      readonly mode: "none" | "callback" | "custom";
      readonly targetFps: 0 | 30 | 60;
    })
  | (PlayerEventEnvelope & {
      readonly type: "frame";
      readonly frameId: number;
      readonly completedSlices: string;
      readonly timeRawBeforeStep: number;
      readonly targetFps: 30 | 60;
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
      readonly type: "diagnostic";
      readonly error: SerializedRuntimeError;
    })
  | (PlayerEventEnvelope & {
      readonly type: "fault";
      readonly error: SerializedRuntimeError;
    });
