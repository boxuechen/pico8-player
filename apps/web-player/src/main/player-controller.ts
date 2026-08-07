import type { PlayerRuntimeToHost } from "../transport/public.js";
import { RuntimeClientError } from "./runtime-client.js";
import type { PlayerComposition } from "./compose-player.js";
import type { GamepadSource } from "./gamepad-input.js";
import { PlayerInputFrontend } from "./player-input.js";
import type { PlayerLocalCartSource } from "./player-runtime-client.js";
import {
  isActivelyPlaying,
  validateLocalCartSelection,
  type PlayerShellState,
} from "./ui/player-shell-policy.js";
import {
  PlayerShellView,
  type PlayerShellElements,
} from "./ui/player-shell-view.js";

export type { PlayerShellState } from "./ui/player-shell-policy.js";
export type { PlayerShellElements } from "./ui/player-shell-view.js";

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
  readonly #view: PlayerShellView;
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
  #muted = false;
  #stateMessage = "Select a local .p8 or .p8.png cartridge";
  #disposed = false;
  #operation = Promise.resolve();

  constructor(
    composition: PlayerComposition,
    view: PlayerShellView,
    options: PlayerControllerOptions = {},
  ) {
    this.#composition = composition;
    this.#view = view;
    this.#elements = view.elements;
    const elements = view.elements;
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
      touchRoot: elements.touchControls,
    });
    this.#removeRuntimeListener = composition.runtime.onEvent(
      (event) => this.#onRuntimeEvent(event),
    );
    this.#bind(elements.canvas, "click", () => elements.canvas.focus());
    this.#bind(elements.fileInput, "change", () => {
      const files = elements.fileInput.files === null
        ? []
        : Array.from(elements.fileInput.files);
      void this.#loadLocalFiles(files).finally(() => {
        elements.fileInput.value = "";
      });
    });
    this.#bind(elements.dropZone, "dragenter", (event) => this.#drag(event as DragEvent));
    this.#bind(elements.dropZone, "dragover", (event) => this.#drag(event as DragEvent));
    this.#bind(elements.dropZone, "dragleave", () => this.#view.setDropActive(false));
    this.#bind(elements.dropZone, "drop", (event) => {
      const dragEvent = event as DragEvent;
      dragEvent.preventDefault();
      this.#view.setDropActive(false);
      const files = dragEvent.dataTransfer === null
        ? []
        : Array.from(dragEvent.dataTransfer.files);
      void this.#loadLocalFiles(files);
    });
    this.#bind(elements.playButton, "click", () => {
      if (this.#state === "audio-blocked") {
        void this.retryAudio().catch((error) => this.#showUiError(error));
        return;
      }
      // AudioContext.resume() must be called in the trusted event task. Runtime
      // mutations remain serialized behind the controller operation queue.
      const audioProbe = this.#muted
        ? Promise.resolve(true)
        : this.#composition.resumeAudio();
      this.#enqueue(async () => {
        if (this.#state === "paused") await this.resume(audioProbe);
        else if (this.#state === "ready") await this.start(audioProbe);
      });
    });
    this.#bind(elements.pauseButton, "click", () => this.#enqueue(() => this.pause()));
    this.#bind(elements.resetButton, "click", () => this.#enqueue(async () => {
      const restart = isActivelyPlaying(this.#state);
      await this.reset();
      if (restart) await this.start();
    }));
    this.#bind(elements.stopButton, "click", () => this.#enqueue(() => this.stop()));
    this.#bind(elements.muteButton, "click", () => {
      void this.toggleMute().catch((error) => this.#showUiError(error));
    });
    this.#bind(elements.fullscreenButton, "click", () => {
      void this.#view.toggleFullscreen().catch((error) => this.#showUiError(error));
    });
    this.#bind(this.#window, "blur", () => this.#pauseForEnvironment());
    this.#bind(this.#window, "focus", () => this.#resumeFromEnvironment());
    this.#bind(this.#document, "visibilitychange", () => {
      if (this.#document.visibilityState === "hidden") this.#pauseForEnvironment();
      else this.#resumeFromEnvironment();
    });
    this.#bind(this.#window, "pagehide", () => this.#composition.flushPersistence());
    this.#renderState(this.#stateMessage);
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

  get muted(): boolean {
    return this.#muted;
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
    this.#view.clearDiagnostic();
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

  async start(audioProbe?: Promise<boolean>): Promise<void> {
    this.#assertActive();
    if (this.#state !== "ready") return;
    try {
      const audioReady = this.#muted
        ? true
        : await (audioProbe ?? this.#composition.resumeAudio());
      if (this.#disposed) return;
      await this.#composition.start();
      if (this.#disposed) return;
      this.#environmentPaused = false;
      this.#input.setEnabled(true);
      this.#elements.canvas.focus();
      this.#setPlayingState(audioReady);
      this.#scheduleFrame();
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }

  async pause(): Promise<void> {
    this.#assertActive();
    if (!isActivelyPlaying(this.#state)) return;
    this.#environmentPaused = false;
    await this.#pauseInternal();
  }

  async resume(audioProbe?: Promise<boolean>): Promise<void> {
    this.#assertActive();
    if (this.#state !== "paused") return;
    try {
      const audioReady = this.#muted
        ? true
        : await (audioProbe ?? this.#composition.resumeAudio());
      if (this.#disposed) return;
      await this.#composition.resume();
      if (this.#disposed) return;
      this.#input.setEnabled(true);
      this.#elements.canvas.focus();
      this.#setPlayingState(audioReady);
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
      this.#view.clearDiagnostic();
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
    await this.#view.exitFullscreen().catch(() => undefined);
    await this.#composition.dispose();
    this.#view.dispose();
  }

  async retryAudio(): Promise<void> {
    this.#assertActive();
    if (this.#state !== "audio-blocked") return;
    if (this.#muted) {
      this.#setState("running", "Running · Muted");
      return;
    }
    const audioReady = await this.#composition.resumeAudio();
    if (this.#disposed) return;
    this.#setPlayingState(audioReady);
  }

  async toggleMute(): Promise<void> {
    this.#assertActive();
    this.#muted = !this.#muted;
    this.#composition.setMuted(this.#muted);
    if (this.#muted) {
      if (this.#state === "audio-blocked") {
        this.#setState("running", "Running · Muted");
      } else {
        this.#renderState(isActivelyPlaying(this.#state) ? "Running · Muted" : this.#stateMessage);
      }
      return;
    }
    if (isActivelyPlaying(this.#state)) {
      const audioReady = await this.#composition.resumeAudio();
      if (this.#disposed) return;
      this.#setPlayingState(audioReady);
    } else {
      this.#renderState(this.#stateMessage);
    }
  }

  #scheduleFrame(): void {
    if (this.#frameHandle !== undefined || !isActivelyPlaying(this.#state)) return;
    this.#frameHandle = this.#animationFrames.request((timestamp) => {
      this.#frameHandle = undefined;
      if (!isActivelyPlaying(this.#state)) return;
      void this.#composition.pulse(timestamp, this.#input.takeSnapshot()).then(
        () => this.#scheduleFrame(),
        (error) => {
          if (
            error instanceof RuntimeClientError &&
            error.record.code === "E_INVALID_STATE" &&
            !isActivelyPlaying(this.#state)
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
    if (!isActivelyPlaying(this.#state)) return;
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
    if (
      event.type === "state" && event.state === "stopped" &&
      isActivelyPlaying(this.#state)
    ) {
      this.#cancelFrame();
      this.#input.setEnabled(false);
      this.#input.setDevkitFlags(0);
      this.#composition.runtime.clearInput();
      this.#setState("stopped", "Cartridge stopped");
      void this.#composition.suspendAudio().catch((error) => this.#fail(error));
      return;
    }
    if (event.type === "diagnostic") {
      this.#view.showDiagnostic(`${event.error.code}: ${event.error.message}`);
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
    this.#view.showDiagnostic(message);
    this.#setState("faulted", "Faulted");
  }

  #setState(state: PlayerShellState, text: string): void {
    this.#state = state;
    this.#stateMessage = text;
    this.#renderState(text);
  }

  #renderState(text: string): void {
    this.#stateMessage = text;
    this.#view.render({
      state: this.#state,
      message: text,
      hasRetainedCart: this.#composition.runtime.hasRetainedCart,
      muted: this.#muted,
    });
    for (const listener of this.#stateListeners) {
      listener({ state: this.#state, message: text });
    }
  }

  #setPlayingState(audioReady: boolean): void {
    if (audioReady) {
      this.#setState("running", this.#muted ? "Running · Muted" : "Running");
    } else {
      this.#setState(
        "audio-blocked",
        "Running without audio · Select Enable audio to try again",
      );
    }
  }

  async #loadLocalFiles(files: readonly File[]): Promise<void> {
    if (this.#disposed) return;
    const validation = validateLocalCartSelection(files);
    if (!validation.ok) {
      this.#view.showDiagnostic(validation.message);
      return;
    }
    const file = files[0]!;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch (error) {
      this.#showUiError(error);
      return;
    }
    this.#enqueue(async () => {
      await this.loadCart(bytes, file.name);
      await this.start();
    });
  }

  #drag(event: DragEvent): void {
    if (this.#state === "loading" || this.#state === "disposed") return;
    event.preventDefault();
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "copy";
    this.#view.setDropActive(true);
  }

  #showUiError(error: unknown): void {
    if (this.#disposed) return;
    const message = error instanceof Error ? error.message : String(error);
    this.#view.showDiagnostic(message);
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
