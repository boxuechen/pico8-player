/** Execution data shared by local calls and the optional Worker wire adapter. */
import type {
  SerializedRuntimeError,
} from "@pico8-player/contracts";

export const PLAYER_PROTOCOL_VERSION = 1 as const;
export {
  PICO_CONTROLLER_COUNT,
  PICO_CONTROLLER_BUTTON_COUNT,
  PICO_CONTROLLER_BUTTON_MASK,
  PICO_DEVKIT_KEYPRESS_BATCH_LIMIT,
  PICO_CART_INPUT_MAX_BYTES,
  PICO_CART_REF_MAX_BYTES,
  PICO_LOCAL_CART_BUNDLE_MAX_ENTRIES,
  PICO_CART_DATA_BYTES,
  PICO_CART_DATA_ID_MAX_BYTES,
  PICO_CART_DATA_MAX_RECORDS,
} from "@pico8-player/contracts";

interface SessionEventContext {
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
