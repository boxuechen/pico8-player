import type { CartAccess, SerializedRuntimeError } from "@pico8-web/contracts";

import type { PlayerRuntimeToHost } from "../transport/public.js";
import type { AudioFrontendOptions } from "./audio-frontend.js";
import {
  mountPico8Player,
  type MountedPlayer,
} from "./main.js";
import type { PlayerShellState } from "./player-controller.js";
import type { PlayerShellMode } from "./ui/player-shell-view.js";
import {
  HostPersistenceFrontend,
  type Pico8CartDataCommit,
  type Pico8HostPersistenceAdapter,
  type Pico8PersistenceFlushResult,
  type Pico8PersistenceStatusEventData,
} from "./host-persistence.js";

export const PICO8_WEB_PLAYER_API_VERSION = 2 as const;

export interface Pico8WebPlayerCreateOptions {
  readonly root: HTMLElement;
  readonly commandTimeoutMs?: number;
  readonly audio?: AudioFrontendOptions;
  /** `hosted` leaves cart selection, controls and surrounding chrome to the caller. */
  readonly shell?: PlayerShellMode;
  readonly persistence?: Pico8HostPersistenceAdapter;
}

export interface Pico8LocalCartSource {
  readonly ref: string;
  readonly bytes: Uint8Array;
  readonly access: CartAccess;
}

export interface Pico8LoadCartOptions {
  readonly displayName?: string;
  readonly instructionBudget?: number;
  readonly localCartBundle?: readonly Pico8LocalCartSource[];
  /** Required when create() received a persistence adapter. */
  readonly contentId?: string;
}

interface Pico8EventEnvelope {
  readonly v: typeof PICO8_WEB_PLAYER_API_VERSION;
  readonly type: "state" | "frame" | "diagnostic" | "fault" | "persistence";
}

export interface Pico8StateEvent extends Pico8EventEnvelope {
  readonly type: "state";
  readonly state: PlayerShellState;
  readonly message: string;
}

export interface Pico8FrameEvent extends Pico8EventEnvelope {
  readonly type: "frame";
  readonly sessionGeneration: number;
  readonly frameId: number;
  readonly targetFps: 30 | 60;
  readonly cpuInstructions: number;
  readonly cpuFractionRaw: number;
  readonly slowFrame: boolean;
  readonly packedScreen: Uint8Array;
  readonly displayPalette: Uint8Array;
}

export interface Pico8DiagnosticEvent extends Pico8EventEnvelope {
  readonly type: "diagnostic";
  readonly error: SerializedRuntimeError;
}

export interface Pico8FaultEvent extends Pico8EventEnvelope {
  readonly type: "fault";
  readonly error: SerializedRuntimeError;
}

export interface Pico8PersistenceEvent extends Pico8EventEnvelope,
  Pico8PersistenceStatusEventData {
  readonly type: "persistence";
}

export type Pico8WebPlayerEvent =
  | Pico8StateEvent
  | Pico8FrameEvent
  | Pico8DiagnosticEvent
  | Pico8FaultEvent
  | Pico8PersistenceEvent;

export type Pico8WebPlayerEventType = Pico8WebPlayerEvent["type"];
export type Pico8WebPlayerEventFor<T extends Pico8WebPlayerEventType> =
  Extract<Pico8WebPlayerEvent, { readonly type: T }>;
export type Pico8WebPlayerEventListener<T extends Pico8WebPlayerEventType> =
  (event: Pico8WebPlayerEventFor<T>) => void;

export class Pico8WebPlayer {
  readonly #mounted: MountedPlayer;
  readonly #listeners = new Map<
    Pico8WebPlayerEventType,
    Set<(event: never) => void>
  >();
  readonly #removeSubscriptions: (() => void)[];
  readonly #persistence: HostPersistenceFrontend | undefined;
  #operation: Promise<void> = Promise.resolve();
  #disposeRequested = false;
  #disposePromise: Promise<void> | undefined;

  private constructor(mounted: MountedPlayer, persistence?: Pico8HostPersistenceAdapter) {
    this.#mounted = mounted;
    this.#persistence = persistence === undefined
      ? undefined
      : new HostPersistenceFrontend(persistence, (event) => this.#emit({
        v: PICO8_WEB_PLAYER_API_VERSION,
        type: "persistence",
        ...event,
      }));
    this.#removeSubscriptions = [
      mounted.controller.onStateChange((event) => {
        this.#emit({
          v: PICO8_WEB_PLAYER_API_VERSION,
          type: "state",
          state: event.state,
          message: event.message,
        });
      }),
      mounted.composition.runtime.onEvent((event) => this.#onRuntimeEvent(event)),
    ];
  }

  static async create(options: Pico8WebPlayerCreateOptions): Promise<Pico8WebPlayer> {
    const mounted = await mountPico8Player({
      root: options.root,
      useDefaultAssets: true,
      ...(options.commandTimeoutMs === undefined
        ? {}
        : { commandTimeoutMs: options.commandTimeoutMs }),
      ...(options.audio === undefined ? {} : { audio: options.audio }),
      ...(options.shell === undefined ? {} : { shell: options.shell }),
    });
    return new Pico8WebPlayer(mounted, options.persistence);
  }

  get state(): PlayerShellState {
    return this.#disposeRequested ? "disposed" : this.#mounted.controller.state;
  }

  get root(): HTMLElement {
    return this.#mounted.elements.root;
  }

  get canvas(): HTMLCanvasElement {
    return this.#mounted.elements.canvas;
  }

  on<T extends Pico8WebPlayerEventType>(
    type: T,
    listener: Pico8WebPlayerEventListener<T>,
  ): () => void {
    this.#assertActive();
    let listeners = this.#listeners.get(type);
    if (listeners === undefined) {
      listeners = new Set();
      this.#listeners.set(type, listeners);
    }
    const erased = listener as (event: never) => void;
    listeners.add(erased);
    return () => listeners?.delete(erased);
  }

  loadCart(source: Uint8Array, options: Pico8LoadCartOptions = {}): Promise<void> {
    return this.#enqueue(async () => {
      let hostCartData: readonly import("./player-runtime-client.js").PlayerHostCartDataSeed[] |
        undefined;
      if (this.#persistence !== undefined) {
        if (options.contentId === undefined) {
          throw new TypeError("contentId is required with a host persistence adapter");
        }
        if (this.#persistence.active) await this.#flushPersistenceInternal("cart-switch");
        hostCartData = await this.#persistence.activate(options.contentId);
      }
      await this.#mounted.controller.loadCart(source, {
        ...options,
        ...(hostCartData === undefined ? {} : { hostCartData }),
      });
    });
  }

  start(): Promise<void> {
    return this.#enqueue(() => this.#mounted.controller.start());
  }

  pause(): Promise<void> {
    return this.#enqueue(() => this.#mounted.controller.pause());
  }

  resume(): Promise<void> {
    return this.#enqueue(() => this.#mounted.controller.resume());
  }

  reset(): Promise<void> {
    return this.#enqueue(() => this.#mounted.controller.reset());
  }

  stop(): Promise<void> {
    return this.#enqueue(() => this.#mounted.controller.stop());
  }

  /** Replaces the caller-owned input snapshot without entering the lifecycle queue. */
  setInput(snapshot: import("@pico8-web/contracts").PicoInputSnapshot): void {
    this.#assertActive();
    this.#mounted.controller.setInput(snapshot);
  }

  flushPersistence(reason = "explicit"): Promise<Pico8PersistenceFlushResult> {
    return this.#enqueue(() => this.#flushPersistenceInternal(reason));
  }

  handleLifecycle(
    event: "inactive" | "background" | "active",
  ): Promise<Pico8PersistenceFlushResult | { readonly status: "handled"; readonly event: string }> {
    return this.#enqueue(async () => {
      if (event === "active") return { status: "handled", event } as const;
      this.#mounted.controller.clearInput();
      if (["running", "audio-blocked", "menu-open"].includes(this.#mounted.controller.state)) {
        await this.#mounted.controller.pause();
      }
      if (event === "background") return this.#flushPersistenceInternal("background");
      return { status: "handled", event } as const;
    });
  }

  dispose(): Promise<void> {
    if (this.#disposePromise !== undefined) return this.#disposePromise;
    this.#disposeRequested = true;
    this.#emit({
      v: PICO8_WEB_PLAYER_API_VERSION,
      type: "state",
      state: "disposed",
      message: "Disposed",
    });
    for (const remove of this.#removeSubscriptions.splice(0)) remove();
    this.#listeners.clear();
    this.#disposePromise = this.#operation.catch(() => undefined).then(async () => {
      if (this.#mounted.controller.state !== "idle") {
        await this.#flushPersistenceInternal("dispose").catch(() => undefined);
      }
      await this.#mounted.controller.dispose();
    });
    return this.#disposePromise;
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#disposeRequested) {
      return Promise.reject(new Error("Pico8WebPlayer is disposed"));
    }
    const result = this.#operation.then(async () => {
      this.#assertActive();
      const value = await operation();
      this.#assertActive();
      return value;
    });
    this.#operation = result.then(() => undefined, () => undefined);
    return result;
  }

  #onRuntimeEvent(event: PlayerRuntimeToHost): void {
    if (event.type === "cartdata-commit") {
      this.#persistence?.enqueue({
        id: event.id,
        revision: event.revision,
        bytes: new Uint8Array(event.bytes).slice(),
      } satisfies Pico8CartDataCommit);
    } else if (event.type === "frame") {
      this.#emit({
        v: PICO8_WEB_PLAYER_API_VERSION,
        type: "frame",
        sessionGeneration: event.sessionGeneration,
        frameId: event.frameId,
        targetFps: event.targetFps,
        cpuInstructions: event.cpuInstructions,
        cpuFractionRaw: event.cpuFractionRaw,
        slowFrame: event.slowFrame,
        packedScreen: new Uint8Array(event.packedScreen).slice(),
        displayPalette: new Uint8Array(event.displayPalette).slice(),
      });
    } else if (event.type === "diagnostic" || event.type === "fault") {
      this.#emit({
        v: PICO8_WEB_PLAYER_API_VERSION,
        type: event.type,
        error: {
          ...event.error,
          ...(event.error.details === undefined
            ? {}
            : { details: { ...event.error.details } }),
        },
      });
    }
  }

  async #flushPersistenceInternal(reason: string): Promise<Pico8PersistenceFlushResult> {
    await this.#mounted.composition.flushPersistence();
    if (this.#persistence === undefined) {
      return { status: "flushed", reason, durable: true };
    }
    return this.#persistence.flush(reason);
  }

  #emit(event: Pico8WebPlayerEvent): void {
    if (this.#disposeRequested && event.type !== "state") return;
    const listeners = this.#listeners.get(event.type);
    if (listeners === undefined) return;
    for (const listener of [...listeners]) listener(event as never);
  }

  #assertActive(): void {
    if (this.#disposeRequested) throw new Error("Pico8WebPlayer is disposed");
  }
}

export function createPico8WebPlayer(
  options: Pico8WebPlayerCreateOptions,
): Promise<Pico8WebPlayer> {
  return Pico8WebPlayer.create(options);
}
