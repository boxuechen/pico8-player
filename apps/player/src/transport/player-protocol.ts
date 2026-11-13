import type { SessionEvent } from "./session-contract.js";
import type { CartAccess, PicoInputSnapshot } from "@pico8-player/contracts";
interface PlayerCommandContext {
  readonly v: 1;
  readonly workerGeneration: number;
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

export type PlayerRuntimeControlCommand =
  | (PlayerCommandContext & {
      readonly type: "loadCart";
      readonly cartBytes: ArrayBuffer;
      /** Caller-authorized local-only targets. The Worker performs no discovery. */
      readonly localCartBundle?: readonly PlayerLocalCartBundleEntry[];
      /** Presence selects caller-owned persistence; an empty array is a valid fresh store. */
      readonly hostCartData?: readonly PlayerCartDataSeedEntry[];
      readonly instructionBudget?: number;
    })
  | (PlayerCommandContext & { readonly type: "start" })
  | (PlayerCommandContext & { readonly type: "step"; readonly sequence: number })
  | (PlayerCommandContext & {
      readonly type: "vsync";
      readonly sequence: number;
      readonly timestampMs: number;
    })
  | (PlayerCommandContext & { readonly type: "pause" })
  | (PlayerCommandContext & { readonly type: "openPauseMenu" })
  | (PlayerCommandContext & { readonly type: "closePauseMenu" })
  | (PlayerCommandContext & {
      readonly type: "invokeMenuItem";
      readonly slot: 1 | 2 | 3 | 4 | 5;
      readonly button: 1 | 2 | 4;
    })
  | (PlayerCommandContext & { readonly type: "resume" })
  | (PlayerCommandContext & { readonly type: "reset" })
  | (PlayerCommandContext & { readonly type: "stop" })
  | (PlayerCommandContext & { readonly type: "flushPersistence" })
  | (PlayerCommandContext & { readonly type: "dispose" });

export type PlayerRuntimeInputCommand = PlayerCommandContext & {
  readonly type: "input";
  /** Requestless commands reserve request id zero. */
  readonly requestId: 0;
  readonly sequence: number;
  readonly input: PicoInputSnapshot;
};

export type PlayerHostToRuntime =
  | PlayerRuntimeControlCommand
  | PlayerRuntimeInputCommand;


export * from "./session-contract.js";
type WireEvent<T> = T extends unknown ? T & { readonly v: 1; readonly workerGeneration: number; readonly requestId: number } : never;
export type PlayerRuntimeToHost = WireEvent<SessionEvent>;
