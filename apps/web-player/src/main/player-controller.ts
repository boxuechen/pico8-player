import type { PlayerRuntimeToHost } from "../transport/public.js";
import { RuntimeClientError } from "./runtime-client.js";
import type { PlayerComposition } from "./compose-player.js";
import type { GamepadSource } from "./gamepad-input.js";
import { PlayerInputFrontend } from "./player-input.js";
import type { PlayerLocalCartSource } from "./player-runtime-client.js";

export type PlayerShellState =
  | "idle"
  | "loading"
  | "ready"
  | "running"
  | "paused"
  | "stopped"
  | "faulted"
  | "disposed";

export interface PlayerShellElements {
  readonly root: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly status: HTMLElement;
  readonly diagnostic: HTMLElement;
  readonly fileInput?: HTMLInputElement;
  readonly playButton?: HTMLButtonElement;
  readonly pauseButton?: HTMLButtonElement;
  readonly resetButton?: HTMLButtonElement;
  readonly stopButton?: HTMLButtonElement;
  readonly touchControls?: HTMLElement;
}

export interface AnimationFrameSource {
  request(callback: FrameRequestCallback): number;
  cancel(handle: number): void;
}

export interface PlayerControllerOptions {
  readonly window?: Window;
  readonly document?: Document;
  readonly animationFrames?: AnimationFrameSource;
  readonly gamepadSource?: GamepadSource;
}

export interface PlayerControllerLoadOptions {
  readonly displayName?: string;
  readonly instructionBudget?: number;
  readonly localCartBundle?: readonly PlayerLocalCartSource[];
}

export interface PlayerShellStateEvent {
  readonly state: PlayerShellState;
  readonly message: string;
}

export type PlayerShellStateListener = (event: PlayerShellStateEvent) => void;

export class PlayerController {
  readonly #composition: PlayerComposition;
  readonly #elements: PlayerShellElements;
  readonly #window: Window;
  readonly #document: Document;
  readonly #animationFrames: AnimationFrameSource;
  readonly #input: PlayerInputFrontend;
  readonly #removeRuntimeListener: () => void;
  readonly #removeListeners: (() => void)[] = [];
  readonly #stateListeners = new Set<PlayerShellStateListener>();
  #state: PlayerShellState = "idle";
  #frameHandle: number | undefined;
  #environmentPaused = false;
  #disposed = false;
  #operation = Promise.resolve();

  constructor(
    composition: PlayerComposition,
    elements: PlayerShellElements,
    options: PlayerControllerOptions = {},
  ) {
    this.#composition = composition;
    this.#elements = elements;
    this.#window = options.window ?? window;
    this.#document = options.document ?? document;
    this.#animationFrames = options.animationFrames ?? {
      request: (callback) => this.#window.requestAnimationFrame(callback),
      cancel: (handle) => this.#window.cancelAnimationFrame(handle),
    };
    elements.canvas.tabIndex = elements.canvas.tabIndex >= 0 ? elements.canvas.tabIndex : 0;
    this.#input = new PlayerInputFrontend(elements.canvas, {
      window: this.#window,
      document: this.#document,
      ...(options.gamepadSource === undefined
        ? {}
        : { gamepadSource: options.gamepadSource }),
      ...(elements.touchControls === undefined
        ? {}
        : { touchRoot: elements.touchControls }),
    });
    this.#removeRuntimeListener = composition.runtime.onEvent(
      (event) => this.#onRuntimeEvent(event),
    );
    this.#bind(elements.canvas, "click", () => elements.canvas.focus());
    if (elements.fileInput !== undefined) {
      this.#bind(elements.fileInput, "change", () => {
        const file = elements.fileInput?.files?.[0];
        if (file === undefined) return;
        this.#enqueue(async () => {
          await this.loadCart(new Uint8Array(await file.arrayBuffer()), file.name);
          await this.start();
        });
      });
    }
    if (elements.playButton !== undefined) {
      this.#bind(elements.playButton, "click", () => this.#enqueue(async () => {
        if (this.#state === "paused") await this.resume();
        else if (this.#state === "ready") await this.start();
      }));
    }
    if (elements.pauseButton !== undefined) {
      this.#bind(elements.pauseButton, "click", () => this.#enqueue(() => this.pause()));
    }
    if (elements.resetButton !== undefined) {
      this.#bind(elements.resetButton, "click", () => this.#enqueue(async () => {
        const restart = this.#state === "running";
        await this.reset();
        if (restart) await this.start();
      }));
    }
    if (elements.stopButton !== undefined) {
      this.#bind(elements.stopButton, "click", () => this.#enqueue(() => this.stop()));
    }
    this.#bind(this.#window, "blur", () => this.#pauseForEnvironment());
    this.#bind(this.#window, "focus", () => this.#resumeFromEnvironment());
    this.#bind(this.#document, "visibilitychange", () => {
      if (this.#document.visibilityState === "hidden") this.#pauseForEnvironment();
      else this.#resumeFromEnvironment();
    });
    this.#bind(this.#window, "pagehide", () => this.#composition.flushPersistence());
    this.#renderState("Select a .p8 or .p8.png cartridge");
  }

  get state(): PlayerShellState {
    return this.#state;
  }

  get inputButtons(): number {
    return this.#input.buttons;
  }

  get inputControllers(): readonly number[] {
    return this.#input.snapshot().controllers;
  }

  onStateChange(listener: PlayerShellStateListener): () => void {
    this.#assertActive();
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  async loadCart(
    source: Uint8Array,
    options: string | PlayerControllerLoadOptions = {},
  ): Promise<void> {
    this.#assertActive();
    const normalized = typeof options === "string" ? { displayName: options } : options;
    const displayName = normalized.displayName ?? "cartridge";
    this.#cancelFrame();
    this.#input.setEnabled(false);
    this.#input.setDevkitFlags(0);
    this.#composition.runtime.clearInput();
    this.#setState("loading", `Loading ${displayName}…`);
    this.#elements.diagnostic.textContent = "";
    try {
      await this.#composition.loadCart(
        source,
        normalized.instructionBudget,
        normalized.localCartBundle,
      );
      if (this.#disposed) return;
      this.#setState("ready", `${displayName} ready`);
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }

  async start(): Promise<void> {
    this.#assertActive();
    if (this.#state !== "ready") return;
    try {
      await this.#composition.resumeAudio();
      if (this.#disposed) return;
      await this.#composition.start();
      if (this.#disposed) return;
      this.#environmentPaused = false;
      this.#input.setEnabled(true);
      this.#elements.canvas.focus();
      this.#setState("running", "Running");
      this.#scheduleFrame();
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }

  async pause(): Promise<void> {
    this.#assertActive();
    if (this.#state !== "running") return;
    this.#environmentPaused = false;
    await this.#pauseInternal();
  }

  async resume(): Promise<void> {
    this.#assertActive();
    if (this.#state !== "paused") return;
    try {
      await this.#composition.resumeAudio();
      if (this.#disposed) return;
      await this.#composition.resume();
      if (this.#disposed) return;
      this.#input.setEnabled(true);
      this.#elements.canvas.focus();
      this.#setState("running", "Running");
      this.#scheduleFrame();
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }

  async reset(): Promise<void> {
    this.#assertActive();
    this.#cancelFrame();
    this.#input.setEnabled(false);
    this.#input.setDevkitFlags(0);
    this.#composition.runtime.clearInput();
    try {
      await this.#composition.reset();
      if (this.#disposed) return;
      this.#elements.diagnostic.textContent = "";
      this.#setState("ready", "Reset complete");
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.#assertActive();
    if (["idle", "loading", "stopped", "disposed"].includes(this.#state)) return;
    this.#cancelFrame();
    this.#input.setEnabled(false);
    this.#input.setDevkitFlags(0);
    this.#composition.runtime.clearInput();
    try {
      await this.#composition.stop();
      if (this.#disposed) return;
      await this.#composition.suspendAudio();
      if (this.#disposed) return;
      this.#setState("stopped", "Stopped");
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#setState("disposed", "Disposed");
    this.#cancelFrame();
    this.#input.dispose();
    this.#removeRuntimeListener();
    for (const remove of this.#removeListeners.splice(0)) remove();
    this.#stateListeners.clear();
    await this.#composition.dispose();
  }

  #scheduleFrame(): void {
    if (this.#frameHandle !== undefined || this.#state !== "running") return;
    this.#frameHandle = this.#animationFrames.request((timestamp) => {
      this.#frameHandle = undefined;
      if (this.#state !== "running") return;
      void this.#composition.pulse(timestamp, this.#input.takeSnapshot()).then(
        () => this.#scheduleFrame(),
        (error) => {
          if (
            error instanceof RuntimeClientError &&
            error.record.code === "E_INVALID_STATE" &&
            this.#state !== "running"
          ) return;
          this.#fail(error);
        },
      );
    });
  }

  #cancelFrame(): void {
    if (this.#frameHandle === undefined) return;
    this.#animationFrames.cancel(this.#frameHandle);
    this.#frameHandle = undefined;
  }

  async #pauseInternal(): Promise<void> {
    this.#cancelFrame();
    this.#input.setEnabled(false);
    this.#composition.runtime.clearInput();
    try {
      await this.#composition.pause();
      if (this.#disposed) return;
      await this.#composition.suspendAudio();
      if (this.#disposed) return;
      this.#setState("paused", "Paused");
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }

  #pauseForEnvironment(): void {
    if (this.#state !== "running") return;
    this.#environmentPaused = true;
    this.#enqueue(() => this.#pauseInternal());
  }

  #resumeFromEnvironment(): void {
    if (!this.#environmentPaused || this.#state !== "paused") return;
    if (this.#document.visibilityState === "hidden") return;
    this.#environmentPaused = false;
    this.#enqueue(() => this.resume());
  }

  #onRuntimeEvent(event: PlayerRuntimeToHost): void {
    if (event.type === "state" || event.type === "frame") {
      this.#input.setDevkitFlags(event.devkitFlags);
    }
    if (event.type === "state" && event.state === "stopped" && this.#state === "running") {
      this.#cancelFrame();
      this.#input.setEnabled(false);
      this.#input.setDevkitFlags(0);
      this.#composition.runtime.clearInput();
      this.#setState("stopped", "Cartridge stopped");
      void this.#composition.suspendAudio().catch((error) => this.#fail(error));
      return;
    }
    if (event.type === "diagnostic") {
      this.#elements.diagnostic.textContent = `${event.error.code}: ${event.error.message}`;
    } else if (event.type === "fault") {
      this.#fail(new RuntimeClientError(event.error));
    }
  }

  #fail(error: unknown): void {
    if (this.#disposed || this.#state === "faulted") return;
    this.#cancelFrame();
    this.#input.setEnabled(false);
    this.#input.setDevkitFlags(0);
    this.#composition.runtime.clearInput();
    const message = error instanceof RuntimeClientError
      ? `${error.record.code}: ${error.record.message}`
      : error instanceof Error ? error.message : String(error);
    this.#elements.diagnostic.textContent = message;
    this.#setState("faulted", "Faulted");
  }

  #setState(state: PlayerShellState, text: string): void {
    this.#state = state;
    this.#renderState(text);
  }

  #renderState(text: string): void {
    this.#elements.root.dataset.playerState = this.#state;
    this.#elements.status.textContent = text;
    this.#elements.status.setAttribute("aria-live", "polite");
    this.#elements.diagnostic.setAttribute("aria-live", "assertive");
    const canPlay = this.#state === "ready" || this.#state === "paused";
    if (this.#elements.playButton !== undefined) this.#elements.playButton.disabled = !canPlay;
    if (this.#elements.pauseButton !== undefined) {
      this.#elements.pauseButton.disabled = this.#state !== "running";
    }
    if (this.#elements.resetButton !== undefined) {
      this.#elements.resetButton.disabled = !this.#composition.runtime.hasRetainedCart ||
        this.#state === "loading" || this.#state === "disposed";
    }
    if (this.#elements.stopButton !== undefined) {
      this.#elements.stopButton.disabled = !["ready", "running", "paused", "faulted"].includes(
        this.#state,
      );
    }
    for (const listener of this.#stateListeners) {
      listener({ state: this.#state, message: text });
    }
  }

  #enqueue(operation: () => Promise<void>): void {
    this.#operation = this.#operation.then(operation, operation).catch((error) => {
      this.#fail(error);
    });
  }

  #bind(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    target.addEventListener(type, listener);
    this.#removeListeners.push(() => target.removeEventListener(type, listener));
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("PlayerController is disposed");
  }
}
