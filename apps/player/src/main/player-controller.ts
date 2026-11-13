import type {
  PlayerMenuItemSnapshot,
  SessionEvent as PlayerRuntimeToHost,
} from "../transport/public.js";
import type { PicoInputSnapshot } from "@pico8-player/contracts";
import { RuntimeClientError } from "../transport/runtime-error.js";
import type { PlayerComposition } from "./compose-player.js";
import type { GamepadSource } from "./gamepad-input.js";
import { PlayerInputFrontend } from "./player-input.js";
import { PlayerLifecycleQueue } from "../runtime/lifecycle-queue.js";
import type {
  PlayerHostCartDataSeed,
  PlayerLocalCartSource,
} from "../transport/runtime-port.js";
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
  readonly hostCartData?: readonly PlayerHostCartDataSeed[];
}

export interface PlayerShellStateEvent {
  readonly state: PlayerShellState;
  readonly message: string;
}

export type PlayerShellStateListener = (event: PlayerShellStateEvent) => void;

const P8SCII_EXTENDED_GLYPHS =
  "█▒🐱⬇░✽●♥☉웃⌂⬅😐♪🅾◆…➡★⧗⬆ˇ∧❎▤▥" +
  "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよ" +
  "らりるれろわをんっゃゅょ" +
  "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨ" +
  "ラリルレロワヲンッャュョ◜◝";

const P8SCII_LOW_GLYPHS = new Map<number, string>([
  ...Array.from("¹²³⁴⁵⁶⁷⁸", (glyph, index) => [index + 1, glyph] as const),
  [0x0b, "ᵇ"], [0x0c, "ᶜ"], [0x0e, "ᵉ"], [0x0f, "ᶠ"],
  ...Array.from("▮■□⁙⁘‖◀▶「」¥•、。゛゜", (glyph, index) =>
    [index + 0x10, glyph] as const),
]);

function decodeP8sciiLabel(bytes: Uint8Array): string {
  const extended = Array.from(P8SCII_EXTENDED_GLYPHS);
  return Array.from(bytes, (byte) => {
    if (byte >= 0x20 && byte <= 0x7e) return String.fromCharCode(byte);
    if (byte === 0x7f) return "○";
    if (byte >= 0x80) return extended[byte - 0x80] ?? "�";
    if (byte === 0x09) return "\t";
    if (byte === 0x0a) return "\n";
    if (byte === 0x0d) return "\r";
    return P8SCII_LOW_GLYPHS.get(byte) ?? "�";
  }).join("");
}

/** Internal capability supplied only within an admitted lifecycle transaction. */
export type PlayerLifecycleActions = Pick<PlayerController,
  "loadCart" | "start" | "pause" | "resume" | "reset" | "stop" |
  "openPauseMenu" | "closePauseMenu" | "invokeMenuItem" | "retryAudio" | "toggleMute">;

export interface PlayerDisposeHooks {
  readonly beforeDispose?: (actions: PlayerLifecycleActions) => Promise<void>;
  readonly afterDispose?: () => Promise<void>;
}

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
  #menuWasAudioBlocked = false;
  #stateMessage = "Select a local .p8 or .p8.png cartridge";
  #disposed = false;
  readonly #lifecycle = new PlayerLifecycleQueue();
  readonly #actions: PlayerLifecycleActions = {
    loadCart: (source, options) => this.#loadCart(source, options),
    start: (audioProbe) => this.#start(audioProbe),
    pause: () => this.#pause(),
    resume: (audioProbe) => this.#resume(audioProbe),
    reset: () => this.#reset(),
    stop: () => this.#stop(),
    openPauseMenu: () => this.#openPauseMenu(),
    closePauseMenu: () => this.#closePauseMenu(),
    invokeMenuItem: (slot, button) => this.#invokeMenuItem(slot, button),
    retryAudio: (audioProbe) => this.#retryAudio(audioProbe),
    toggleMute: (audioProbe) => this.#toggleMute(audioProbe),
  };

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
      this.#loadLocalFiles(files);
      elements.fileInput.value = "";
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
      this.#loadLocalFiles(files);
    });
    this.#bind(elements.playButton, "click", () => {
      if (this.#lifecycle.closed) return;
      if (this.#state === "audio-blocked") {
        void this.retryAudio().catch((error) => this.#showUiError(error));
        return;
      }
      // AudioContext.resume() must be called in the trusted event task. Runtime
      // mutations remain serialized behind the controller operation queue.
      const audioProbe = this.#muted
        ? Promise.resolve(true)
        : this.#composition.resumeAudio();
      this.#enqueue(async (actions) => {
        if (this.#state === "paused") await actions.resume(audioProbe);
        else if (this.#state === "ready") await actions.start(audioProbe);
      });
    });
    this.#bind(elements.pauseButton, "click", () => this.#enqueue(actions => actions.pause()));
    this.#bind(elements.menuButton, "click", () => this.#enqueue(actions => actions.openPauseMenu()));
    this.#bind(elements.pauseMenuItems, "click", (event) => {
      if (this.#state !== "menu-open") return;
      const target = event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>("[role=menuitem]")
        : null;
      if (target === null) return;
      const slot = this.#menuSlot(target);
      if (slot === undefined) this.#enqueue(actions => actions.closePauseMenu());
      else if (!this.#menuFiltered(target, 4)) {
        this.#enqueue(actions => actions.invokeMenuItem(slot, 4));
      }
    });
    this.#bind(elements.pauseMenu, "keydown", (event) => {
      this.#onPauseMenuKeydown(event as KeyboardEvent);
    });
    this.#bind(elements.resetButton, "click", () => this.#enqueue(async (actions) => {
      const restart = isActivelyPlaying(this.#state);
      await actions.reset();
      if (restart) await actions.start();
    }));
    this.#bind(elements.stopButton, "click", () => this.#enqueue(actions => actions.stop()));
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
    this.#bind(this.#window, "pagehide", (event) => {
      this.#enqueue(async () => { await this.#composition.runtime.flushPersistence(); });
      if ((event as PageTransitionEvent).persisted) this.#pauseForEnvironment();
    });
    this.#bind(this.#window, "pageshow", (event) => {
      if ((event as PageTransitionEvent).persisted) this.#resumeFromEnvironment();
    });
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

  setInput(snapshot: PicoInputSnapshot): void {
    this.#assertActive();
    this.#input.setHostInput(snapshot);
  }

  clearInput(): void {
    this.#assertActive();
    this.#input.clear();
    this.#composition.runtime.clearInput();
  }

  onStateChange(listener: PlayerShellStateListener): () => void {
    this.#assertActive();
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  /** Serializes facade transactions and Controller entrypoints with DOM/environment intents. */
  runLifecycle<T>(operation: (actions: PlayerLifecycleActions) => Promise<T>): Promise<T> {
    return this.#lifecycle.run(() => operation(this.#actions));
  }

  loadCart(source: Uint8Array, options: string | PlayerControllerLoadOptions = {}): Promise<void> {
    return this.runLifecycle(actions => actions.loadCart(source, options));
  }

  start(audioProbe?: Promise<boolean>): Promise<void> {
    return this.runLifecycle(actions => actions.start(audioProbe));
  }

  pause(): Promise<void> { return this.runLifecycle(actions => actions.pause()); }
  resume(audioProbe?: Promise<boolean>): Promise<void> {
    return this.runLifecycle(actions => actions.resume(audioProbe));
  }
  reset(): Promise<void> { return this.runLifecycle(actions => actions.reset()); }
  stop(): Promise<void> { return this.runLifecycle(actions => actions.stop()); }
  openPauseMenu(): Promise<void> { return this.runLifecycle(actions => actions.openPauseMenu()); }
  closePauseMenu(): Promise<void> { return this.runLifecycle(actions => actions.closePauseMenu()); }
  invokeMenuItem(slot: 1 | 2 | 3 | 4 | 5, button: 1 | 2 | 4): Promise<void> {
    return this.runLifecycle(actions => actions.invokeMenuItem(slot, button));
  }

  retryAudio(audioProbe?: Promise<boolean>): Promise<void> {
    if (this.#lifecycle.closed) return Promise.reject(new Error("Player lifecycle is disposed"));
    // Preserve the trusted event task for browser audio unlock only.
    const probe = audioProbe ?? (this.#state === "audio-blocked" && !this.#muted
      ? this.#composition.resumeAudio() : undefined);
    return this.runLifecycle(actions => actions.retryAudio(probe));
  }

  toggleMute(audioProbe?: Promise<boolean>): Promise<void> {
    if (this.#lifecycle.closed) return Promise.reject(new Error("Player lifecycle is disposed"));
    const probe = audioProbe ?? (this.#muted && isActivelyPlaying(this.#state)
      ? this.#composition.resumeAudio() : undefined);
    return this.runLifecycle(actions => actions.toggleMute(probe));
  }

  dispose(hooks: PlayerDisposeHooks = {}): Promise<void> {
    return this.#lifecycle.close(async () => {
      try {
        await hooks.beforeDispose?.(this.#actions);
      } finally {
        try { await this.#dispose(); }
        finally { await hooks.afterDispose?.(); }
      }
    });
  }

  async #loadCart(
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
    this.#view.hidePauseMenu(false);
    this.#setState("loading", `Loading ${displayName}…`);
    this.#view.clearDiagnostic();
    try {
      const loaded = await this.#composition.runtime.loadCart(
        source,
        normalized.instructionBudget,
        normalized.localCartBundle,
        normalized.hostCartData,
      );
      if (this.#disposed) return;
      if (loaded.type === "state" && loaded.state === "stopped") {
        await this.#composition.suspendAudio();
        if (this.#disposed) return;
        this.#setState("stopped", "Cartridge stopped");
        return;
      }
      this.#setState("ready", `${displayName} ready`);
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }

  async #start(audioProbe?: Promise<boolean>): Promise<void> {
    this.#assertActive();
    if (this.#state !== "ready") return;
    try {
      const audioReady = this.#muted
        ? true
        : await (audioProbe ?? this.#composition.resumeAudio());
      if (this.#disposed) return;
      await this.#composition.runtime.start();
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

  async #pause(): Promise<void> {
    this.#assertActive();
    if (!isActivelyPlaying(this.#state) && this.#state !== "menu-open") return;
    this.#environmentPaused = false;
    await this.#pauseInternal();
  }

  async #openPauseMenu(): Promise<void> {
    this.#assertActive();
    if (!isActivelyPlaying(this.#state)) return;
    this.#menuWasAudioBlocked = this.#state === "audio-blocked";
    this.#cancelFrame();
    this.#input.setEnabled(false);
    this.#composition.runtime.clearInput();
    try {
      const event = await this.#composition.runtime.openPauseMenu();
      if (this.#disposed) return;
      if (event.type !== "pause-menu" || !event.open) {
        throw new Error("Runtime did not open the cartridge pause menu");
      }
      await this.#composition.suspendAudio();
      if (this.#disposed) return;
      this.#view.showPauseMenu(this.#decodeMenuItems(event.items));
      this.#setState("menu-open", "Cartridge menu");
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }

  async #closePauseMenu(): Promise<void> {
    this.#assertActive();
    if (this.#state !== "menu-open") return;
    const event = await this.#composition.runtime.closePauseMenu();
    if (this.#disposed) return;
    if (event.type !== "pause-menu" || event.open) {
      throw new Error("Runtime did not close the cartridge pause menu");
    }
    await this.#resumeAfterMenu();
  }

  async #invokeMenuItem(
    slot: 1 | 2 | 3 | 4 | 5,
    button: 1 | 2 | 4,
  ): Promise<void> {
    this.#assertActive();
    if (this.#state !== "menu-open") return;
    const event = await this.#composition.runtime.invokeMenuItem(slot, button);
    if (this.#disposed) return;
    if (event.type !== "pause-menu") {
      throw new Error("Runtime returned an invalid menu invocation outcome");
    }
    if (event.open) {
      this.#view.showPauseMenu(this.#decodeMenuItems(event.items), slot);
      this.#setState("menu-open", "Cartridge menu");
      return;
    }
    await this.#resumeAfterMenu();
  }

  async #resume(audioProbe?: Promise<boolean>): Promise<void> {
    this.#assertActive();
    if (this.#state !== "paused") return;
    try {
      const audioReady = this.#muted
        ? true
        : await (audioProbe ?? this.#composition.resumeAudio());
      if (this.#disposed) return;
      await this.#composition.runtime.resume();
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

  async #reset(): Promise<void> {
    this.#assertActive();
    this.#cancelFrame();
    this.#input.setEnabled(false);
    this.#input.setDevkitFlags(0);
    this.#composition.runtime.clearInput();
    this.#view.hidePauseMenu(false);
    try {
      await this.#composition.runtime.reset();
      if (this.#disposed) return;
      this.#view.clearDiagnostic();
      this.#setState("ready", "Reset complete");
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }

  async #stop(): Promise<void> {
    this.#assertActive();
    if (["idle", "loading", "stopped", "disposed"].includes(this.#state)) return;
    this.#cancelFrame();
    this.#input.setEnabled(false);
    this.#input.setDevkitFlags(0);
    this.#composition.runtime.clearInput();
    this.#view.hidePauseMenu(false);
    try {
      await this.#composition.runtime.stop();
      if (this.#disposed) return;
      await this.#composition.suspendAudio();
      if (this.#disposed) return;
      this.#setState("stopped", "Stopped");
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }

  async #dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#setState("disposed", "Disposed");
    this.#cancelFrame();
    this.#input.dispose();
    this.#view.hidePauseMenu(false);
    this.#removeRuntimeListener();
    for (const remove of this.#removeListeners.splice(0)) remove();
    this.#stateListeners.clear();
    await this.#view.exitFullscreen().catch(() => undefined);
    try { await this.#composition.dispose(); }
    finally { this.#view.dispose(); }
  }

  async #retryAudio(audioProbe?: Promise<boolean>): Promise<void> {
    this.#assertActive();
    if (this.#state !== "audio-blocked") return;
    if (this.#muted) {
      this.#setState("running", "Running · Muted");
      return;
    }
    const audioReady = await (audioProbe ?? this.#composition.resumeAudio());
    if (this.#disposed) return;
    this.#setPlayingState(audioReady);
  }

  async #toggleMute(audioProbe?: Promise<boolean>): Promise<void> {
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
      const audioReady = await (audioProbe ?? this.#composition.resumeAudio());
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
      void this.#composition.runtime.pulse(timestamp, this.#input.takeSnapshot()).then(
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
      await this.#composition.runtime.pause();
      if (this.#disposed) return;
      await this.#composition.suspendAudio();
      if (this.#disposed) return;
      this.#view.hidePauseMenu(false);
      this.#setState("paused", "Paused");
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }

  #pauseForEnvironment(): void {
    this.#enqueue(async () => {
      if ((!isActivelyPlaying(this.#state) && this.#state !== "menu-open") ||
        this.#environmentPaused) return;
      this.#environmentPaused = true;
      await this.#pauseInternal();
    });
  }

  #resumeFromEnvironment(): void {
    this.#enqueue(async (actions) => {
      if (!this.#environmentPaused || this.#document.visibilityState === "hidden") return;
      this.#environmentPaused = false;
      if (this.#state === "paused") await actions.resume();
    });
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
      this.#enqueue(async () => {
        if (this.#state === "stopped") await this.#composition.suspendAudio();
      });
      return;
    }
    if (event.type === "diagnostic") {
      this.#view.showDiagnostic(`${event.error.code}: ${event.error.message}`);
    } else if (event.type === "fault") {
      this.#fail(new RuntimeClientError(event.error));
    } else if (event.type === "pause-menu" && !event.open) {
      this.#view.hidePauseMenu(false);
    }
  }

  #fail(error: unknown): void {
    if (this.#disposed || this.#state === "faulted") return;
    this.#cancelFrame();
    this.#input.setEnabled(false);
    this.#input.setDevkitFlags(0);
    this.#composition.runtime.clearInput();
    this.#view.hidePauseMenu(false);
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

  async #resumeAfterMenu(): Promise<void> {
    this.#view.hidePauseMenu(true);
    this.#composition.runtime.clearInput();
    const audioReady = this.#muted
      ? true
      : this.#menuWasAudioBlocked
        ? false
        : await this.#composition.resumeAudio();
    if (this.#disposed) return;
    this.#input.setEnabled(true);
    this.#setPlayingState(audioReady);
    this.#scheduleFrame();
  }

  #decodeMenuItems(items: readonly PlayerMenuItemSnapshot[]) {
    return items.map((item) => ({
      slot: item.slot,
      label: decodeP8sciiLabel(new Uint8Array(item.label)),
      filter: item.filter,
    }));
  }

  #menuSlot(button: HTMLButtonElement): 1 | 2 | 3 | 4 | 5 | undefined {
    const raw = Number(button.dataset.menuSlot);
    return raw >= 1 && raw <= 5 && Number.isInteger(raw)
      ? raw as 1 | 2 | 3 | 4 | 5
      : undefined;
  }

  #menuFiltered(button: HTMLButtonElement, intent: 1 | 2 | 4): boolean {
    return ((Number(button.dataset.menuFilter ?? 0) >> 8) & intent) !== 0;
  }

  #onPauseMenuKeydown(event: KeyboardEvent): void {
    if (this.#state !== "menu-open") return;
    const buttons = this.#view.pauseMenuButtons();
    const current = event.target instanceof HTMLButtonElement
      ? buttons.indexOf(event.target)
      : -1;
    if (event.key === "Escape") {
      event.preventDefault();
      this.#enqueue(actions => actions.closePauseMenu());
      return;
    }
    if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next = event.key === "Home" ? 0
        : event.key === "End" ? buttons.length - 1
        : event.key === "ArrowUp"
          ? (current <= 0 ? buttons.length - 1 : current - 1)
          : (current + 1) % buttons.length;
      for (const [index, button] of buttons.entries()) button.tabIndex = index === next ? 0 : -1;
      buttons[next]?.focus();
      return;
    }
    const target = current < 0 ? undefined : buttons[current];
    if (target === undefined) return;
    const slot = this.#menuSlot(target);
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      if (slot === undefined) return;
      event.preventDefault();
      const intent = event.key === "ArrowLeft" ? 1 : 2;
      if (!this.#menuFiltered(target, intent)) {
        this.#enqueue(actions => actions.invokeMenuItem(slot, intent));
      }
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (slot === undefined) this.#enqueue(actions => actions.closePauseMenu());
      else if (!this.#menuFiltered(target, 4)) {
        this.#enqueue(actions => actions.invokeMenuItem(slot, 4));
      }
    }
  }

  #loadLocalFiles(files: readonly File[]): void {
    if (this.#lifecycle.closed) return;
    const validation = validateLocalCartSelection(files);
    if (!validation.ok) {
      this.#view.showDiagnostic(validation.message);
      return;
    }
    const file = files[0]!;
    this.#enqueue(async (actions) => {
      let bytes: Uint8Array;
      try { bytes = new Uint8Array(await file.arrayBuffer()); }
      catch (error) { this.#showUiError(error); return; }
      if (this.#lifecycle.closed) return;
      await actions.loadCart(bytes, file.name);
      await actions.start();
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

  #enqueue(operation: (actions: PlayerLifecycleActions) => Promise<void>): void {
    void this.runLifecycle(operation).catch((error) => {
      if (!this.#lifecycle.closed) this.#fail(error);
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
