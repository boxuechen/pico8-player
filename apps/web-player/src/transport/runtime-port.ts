import type { CartAccess, PicoInputSnapshot } from "@pico8-web/contracts";
import type { SessionEvent } from "./session-contract.js";
import type { AudioChunkMessage, AudioResetMessage } from "./audio-protocol.js";
export interface PlayerLocalCartSource { readonly ref: string; readonly bytes: Uint8Array; readonly access: CartAccess; }
export interface PlayerHostCartDataSeed { readonly id: string; readonly bytes: Uint8Array; }
export interface RuntimeAudioPort {
  postMessage(message: AudioResetMessage | AudioChunkMessage, transfer: ArrayBuffer[]): void;
  start?(): void;
  close(): void;
}
/** Same execution surface for direct calls and the optional Worker client. */
export interface PlayerRuntimePort {
  readonly sessionGeneration: number;
  readonly hasRetainedCart: boolean;
  onEvent(listener: (event: SessionEvent) => void): () => void;
  onSessionGenerationChange(listener: (generation: number) => void): () => void;
  loadCart(source: Uint8Array, instructionBudget?: number, bundle?: readonly PlayerLocalCartSource[], host?: readonly PlayerHostCartDataSeed[]): Promise<SessionEvent>;
  start(): Promise<SessionEvent>;
  pause(): Promise<SessionEvent>;
  resume(): Promise<SessionEvent>;
  reset(): Promise<SessionEvent>;
  stop(): Promise<SessionEvent>;
  step(input: PicoInputSnapshot): Promise<SessionEvent>;
  pulse(timestampMs: number, input: PicoInputSnapshot): Promise<SessionEvent>;
  openPauseMenu(): Promise<SessionEvent>;
  closePauseMenu(): Promise<SessionEvent>;
  invokeMenuItem(slot: 1 | 2 | 3 | 4 | 5, button: 1 | 2 | 4): Promise<SessionEvent>;
  clearInput(): void;
  flushPersistence(): Promise<SessionEvent>;
  dispose(): Promise<void>;
}
