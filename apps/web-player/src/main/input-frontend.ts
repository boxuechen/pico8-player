import type { PicoInputSnapshot } from "@pico8-web/contracts";

const KEY_TO_BUTTON = new Map<string, number>([
  ["ArrowLeft", 0],
  ["ArrowRight", 1],
  ["ArrowUp", 2],
  ["ArrowDown", 3],
  ["KeyZ", 4],
  ["KeyN", 4],
  ["KeyC", 4],
  ["KeyX", 5],
  ["KeyM", 5],
  ["KeyV", 5],
]);

export interface KeyboardInputFrontendOptions {
  readonly window?: Window;
  readonly document?: Document;
  readonly onChange?: (snapshot: PicoInputSnapshot) => void;
}

/** Maps physical Player 1 keys to the browser-neutral six-button snapshot. */
export class KeyboardInputFrontend {
  readonly #focusTarget: HTMLElement;
  readonly #window: Window;
  readonly #document: Document;
  readonly #onChange: ((snapshot: PicoInputSnapshot) => void) | undefined;
  readonly #heldCodes = new Set<string>();
  #enabled = false;
  #buttons = 0;
  #disposed = false;

  constructor(
    focusTarget: HTMLElement,
    options: KeyboardInputFrontendOptions = {},
  ) {
    this.#focusTarget = focusTarget;
    this.#window = options.window ?? window;
    this.#document = options.document ?? document;
    this.#onChange = options.onChange;
    this.#window.addEventListener("keydown", this.#onKeyDown);
    this.#window.addEventListener("keyup", this.#onKeyUp);
    this.#window.addEventListener("blur", this.#onBlur);
    this.#document.addEventListener("visibilitychange", this.#onVisibilityChange);
  }

  get buttons(): number {
    return this.#buttons;
  }

  snapshot(): PicoInputSnapshot {
    return { buttons: this.#buttons };
  }

  setEnabled(enabled: boolean): void {
    this.#assertActive();
    this.#enabled = enabled;
    if (!enabled) this.clear();
  }

  clear(): void {
    if (this.#disposed) return;
    if (this.#heldCodes.size === 0 && this.#buttons === 0) return;
    this.#heldCodes.clear();
    this.#setButtons(0);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.clear();
    this.#disposed = true;
    this.#window.removeEventListener("keydown", this.#onKeyDown);
    this.#window.removeEventListener("keyup", this.#onKeyUp);
    this.#window.removeEventListener("blur", this.#onBlur);
    this.#document.removeEventListener("visibilitychange", this.#onVisibilityChange);
  }

  readonly #onKeyDown = (event: KeyboardEvent): void => {
    const button = KEY_TO_BUTTON.get(event.code);
    if (button === undefined || !this.#acceptsInput()) return;
    event.preventDefault();
    if (this.#heldCodes.has(event.code)) return;
    this.#heldCodes.add(event.code);
    this.#recomputeButtons();
  };

  readonly #onKeyUp = (event: KeyboardEvent): void => {
    const button = KEY_TO_BUTTON.get(event.code);
    if (button === undefined || !this.#enabled) return;
    if (this.#acceptsInput()) event.preventDefault();
    if (!this.#heldCodes.delete(event.code)) return;
    this.#recomputeButtons();
  };

  readonly #onBlur = (): void => this.clear();

  readonly #onVisibilityChange = (): void => {
    if (this.#document.visibilityState === "hidden") this.clear();
  };

  #acceptsInput(): boolean {
    return this.#enabled && this.#document.activeElement === this.#focusTarget;
  }

  #recomputeButtons(): void {
    let buttons = 0;
    for (const code of this.#heldCodes) {
      const button = KEY_TO_BUTTON.get(code);
      if (button !== undefined) buttons |= 1 << button;
    }
    this.#setButtons(buttons);
  }

  #setButtons(buttons: number): void {
    if (buttons === this.#buttons) return;
    this.#buttons = buttons;
    this.#onChange?.(this.snapshot());
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("KeyboardInputFrontend is disposed");
  }
}
