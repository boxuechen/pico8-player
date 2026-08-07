import {
  computeIntegerScale,
  derivePlayerShellPresentation,
  type PlayerShellState,
} from "./player-shell-policy.js";

export interface PlayerShellElements {
  readonly root: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly status: HTMLElement;
  readonly diagnostic: HTMLElement;
  readonly fileInput: HTMLInputElement;
  readonly fileLabel: HTMLElement;
  readonly dropZone: HTMLElement;
  readonly playButton: HTMLButtonElement;
  readonly pauseButton: HTMLButtonElement;
  readonly resetButton: HTMLButtonElement;
  readonly stopButton: HTMLButtonElement;
  readonly muteButton: HTMLButtonElement;
  readonly fullscreenButton: HTMLButtonElement;
  readonly touchControls: HTMLElement;
}

export interface PlayerShellViewOptions {
  readonly window?: Window;
  readonly document?: Document;
}

export interface PlayerShellRenderModel {
  readonly state: PlayerShellState;
  readonly message: string;
  readonly hasRetainedCart: boolean;
  readonly muted: boolean;
}

interface TouchControlDefinition {
  readonly label: string;
  readonly accessibleName: string;
  readonly picoButton: number;
}

const TOUCH_CONTROLS: readonly TouchControlDefinition[] = [
  { label: "←", accessibleName: "Move left", picoButton: 0 },
  { label: "→", accessibleName: "Move right", picoButton: 1 },
  { label: "↑", accessibleName: "Move up", picoButton: 2 },
  { label: "↓", accessibleName: "Move down", picoButton: 3 },
  { label: "O", accessibleName: "O button", picoButton: 4 },
  { label: "X", accessibleName: "X button", picoButton: 5 },
];

function button(document: Document, label: string, action: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  element.dataset.action = action;
  element.className = "pico8-player__button";
  return element;
}

export class PlayerShellView {
  readonly elements: PlayerShellElements;
  readonly #window: Window;
  readonly #document: Document;
  readonly #resizeObserver: ResizeObserver | undefined;
  #disposed = false;

  private constructor(
    elements: PlayerShellElements,
    options: PlayerShellViewOptions,
  ) {
    this.elements = elements;
    this.#window = options.window ?? window;
    this.#document = options.document ?? document;
    this.#document.addEventListener("fullscreenchange", this.#onFullscreenChange);
    this.#window.addEventListener("resize", this.#onWindowResize);
    const ResizeObserverClass = globalThis.ResizeObserver;
    if (ResizeObserverClass !== undefined) {
      const resizeObserver = new ResizeObserverClass((entries: ResizeObserverEntry[]) => {
        const entry = entries.find(({ target }) => target === this.elements.dropZone);
        if (entry === undefined) return;
        const fullscreen = this.fullscreen;
        this.resize(
          entry.contentRect.width,
          fullscreen ? entry.contentRect.height : entry.contentRect.width,
        );
      });
      this.#resizeObserver = resizeObserver;
      resizeObserver.observe(elements.dropZone);
    }
    this.#syncFullscreen();
    this.#resizeFromLayout();
  }

  static create(root: HTMLElement, options: PlayerShellViewOptions = {}): PlayerShellView {
    const document = options.document ?? root.ownerDocument;
    const shell = document.createElement("section");
    shell.className = "pico8-player";
    shell.setAttribute("aria-label", "PICO-8 player");
    shell.dataset.playerState = "idle";
    shell.dataset.scale = "1";

    const chrome = document.createElement("header");
    chrome.className = "pico8-player__chrome";
    const brand = document.createElement("span");
    brand.className = "pico8-player__brand";
    brand.textContent = "PICO-8";
    const status = document.createElement("output");
    status.className = "pico8-player__status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.setAttribute("aria-atomic", "true");
    chrome.append(brand, status);

    const dropZone = document.createElement("div");
    dropZone.className = "pico8-player__stage";
    dropZone.dataset.dropTarget = "cart";
    const canvas = document.createElement("canvas");
    canvas.className = "pico8-player__canvas";
    canvas.setAttribute("aria-label", "PICO-8 playfield");
    canvas.tabIndex = 0;
    const dropHint = document.createElement("span");
    dropHint.className = "pico8-player__drop-hint";
    dropHint.textContent = "Drop a local cart";
    dropHint.setAttribute("aria-hidden", "true");
    dropZone.append(canvas, dropHint);

    const controls = document.createElement("div");
    controls.className = "pico8-player__toolbar";
    controls.setAttribute("role", "toolbar");
    controls.setAttribute("aria-label", "Playback controls");
    const fileLabel = document.createElement("label");
    fileLabel.className = "pico8-player__button pico8-player__file-label";
    fileLabel.textContent = "Choose cart";
    const fileInput = document.createElement("input");
    fileInput.className = "pico8-player__file-input";
    fileInput.type = "file";
    fileInput.accept = ".p8,.p8.png,image/png";
    fileInput.setAttribute("aria-label", "Choose a local PICO-8 cartridge");
    fileLabel.append(fileInput);
    const playButton = button(document, "Play", "play");
    const pauseButton = button(document, "Pause", "pause");
    const resetButton = button(document, "Reset", "reset");
    const stopButton = button(document, "Stop", "stop");
    const muteButton = button(document, "Mute", "mute");
    muteButton.setAttribute("aria-pressed", "false");
    const fullscreenButton = button(document, "Fullscreen", "fullscreen");
    fullscreenButton.setAttribute("aria-pressed", "false");
    controls.append(
      fileLabel,
      playButton,
      pauseButton,
      resetButton,
      stopButton,
      muteButton,
      fullscreenButton,
    );

    const touchControls = document.createElement("div");
    touchControls.className = "pico8-player__touch-controls";
    touchControls.setAttribute("role", "group");
    touchControls.setAttribute("aria-label", "Player 1 touch controls");
    for (const definition of TOUCH_CONTROLS) {
      const control = button(document, definition.label, `touch-${definition.picoButton}`);
      control.classList.add("pico8-player__touch-button");
      control.dataset.picoButton = String(definition.picoButton);
      control.dataset.picoPlayer = "0";
      control.setAttribute("aria-label", definition.accessibleName);
      control.setAttribute("aria-pressed", "false");
      touchControls.append(control);
    }

    const diagnostic = document.createElement("pre");
    diagnostic.className = "pico8-player__diagnostic";
    diagnostic.setAttribute("role", "alert");
    diagnostic.setAttribute("aria-live", "assertive");
    diagnostic.setAttribute("aria-atomic", "true");
    diagnostic.hidden = true;

    shell.append(chrome, dropZone, controls, touchControls, diagnostic);
    root.replaceChildren(shell);
    return new PlayerShellView({
      root: shell,
      canvas,
      status,
      diagnostic,
      fileInput,
      fileLabel,
      dropZone,
      playButton,
      pauseButton,
      resetButton,
      stopButton,
      muteButton,
      fullscreenButton,
      touchControls,
    }, { ...options, document });
  }

  get fullscreen(): boolean {
    return this.#document.fullscreenElement === this.elements.root;
  }

  render(model: PlayerShellRenderModel): void {
    this.#assertActive();
    const presentation = derivePlayerShellPresentation(model);
    const { elements } = this;
    elements.root.dataset.playerState = model.state;
    elements.root.dataset.audioState = presentation.audioBlocked
      ? "blocked"
      : model.muted ? "muted" : "enabled";
    elements.root.setAttribute("aria-busy", String(presentation.busy));
    elements.status.textContent = model.message;
    elements.fileInput.disabled = presentation.cartSelectionDisabled;
    elements.fileLabel.setAttribute(
      "aria-disabled",
      String(presentation.cartSelectionDisabled),
    );
    elements.playButton.disabled = presentation.playDisabled;
    elements.playButton.textContent = presentation.playLabel;
    elements.pauseButton.disabled = presentation.pauseDisabled;
    elements.resetButton.disabled = presentation.resetDisabled;
    elements.stopButton.disabled = presentation.stopDisabled;
    elements.muteButton.disabled = presentation.muteDisabled;
    elements.muteButton.textContent = model.muted ? "Unmute" : "Mute";
    elements.muteButton.setAttribute("aria-pressed", String(model.muted));
    elements.fullscreenButton.disabled = presentation.fullscreenDisabled;
    for (const control of elements.touchControls.querySelectorAll<HTMLButtonElement>(
      "[data-pico-button]",
    )) {
      control.disabled = presentation.touchDisabled;
      control.setAttribute("aria-disabled", String(presentation.touchDisabled));
    }
    this.#syncFullscreen();
  }

  showDiagnostic(message: string): void {
    this.#assertActive();
    this.elements.diagnostic.textContent = message;
    this.elements.diagnostic.hidden = message.length === 0;
  }

  clearDiagnostic(): void {
    this.showDiagnostic("");
  }

  setDropActive(active: boolean): void {
    this.#assertActive();
    this.elements.root.dataset.dropActive = String(active);
  }

  resize(availableWidthCssPixels: number, availableHeightCssPixels: number): number {
    this.#assertActive();
    const scale = computeIntegerScale(
      availableWidthCssPixels,
      availableHeightCssPixels,
    );
    this.elements.root.dataset.scale = String(scale);
    return scale;
  }

  async toggleFullscreen(): Promise<void> {
    this.#assertActive();
    if (this.fullscreen) {
      await this.#document.exitFullscreen();
    } else {
      if (this.elements.root.requestFullscreen === undefined) {
        throw new Error("Fullscreen is unavailable in this browser context.");
      }
      await this.elements.root.requestFullscreen();
    }
    this.#syncFullscreen();
    this.#resizeFromLayout();
  }

  async exitFullscreen(): Promise<void> {
    if (this.#disposed || !this.fullscreen) return;
    await this.#document.exitFullscreen();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#resizeObserver?.disconnect();
    this.#document.removeEventListener("fullscreenchange", this.#onFullscreenChange);
    this.#window.removeEventListener("resize", this.#onWindowResize);
    this.elements.root.dataset.dropActive = "false";
  }

  readonly #onFullscreenChange = (): void => {
    if (this.#disposed) return;
    this.#syncFullscreen();
    this.#resizeFromLayout();
  };

  readonly #onWindowResize = (): void => {
    if (this.#disposed) return;
    this.#resizeFromLayout();
  };

  #syncFullscreen(): void {
    const fullscreen = this.fullscreen;
    this.elements.root.dataset.fullscreen = String(fullscreen);
    this.elements.fullscreenButton.setAttribute("aria-pressed", String(fullscreen));
    this.elements.fullscreenButton.textContent = fullscreen ? "Exit fullscreen" : "Fullscreen";
  }

  #resizeFromLayout(): void {
    const bounds = this.elements.dropZone.getBoundingClientRect();
    const width = bounds.width > 0 ? bounds.width : 128;
    const height = this.fullscreen && bounds.height > 0 ? bounds.height : width;
    this.resize(width, height);
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("PlayerShellView is disposed");
  }
}
