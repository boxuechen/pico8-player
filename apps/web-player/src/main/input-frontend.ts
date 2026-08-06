import type { PicoInputSnapshot } from "@pico8-web/contracts";
import { PLAYER_CONTROLLER_COUNT } from "../transport/player-protocol.js";

interface KeyboardBinding {
  readonly player: number;
  readonly button: number;
}

const KEY_TO_BUTTON = new Map<string, KeyboardBinding>([
  ["ArrowLeft", { player: 0, button: 0 }],
  ["ArrowRight", { player: 0, button: 1 }],
  ["ArrowUp", { player: 0, button: 2 }],
  ["ArrowDown", { player: 0, button: 3 }],
  ["KeyZ", { player: 0, button: 4 }],
  ["KeyN", { player: 0, button: 4 }],
  ["KeyC", { player: 0, button: 4 }],
  ["KeyX", { player: 0, button: 5 }],
  ["KeyM", { player: 0, button: 5 }],
  ["KeyV", { player: 0, button: 5 }],
  ["KeyS", { player: 1, button: 0 }],
  ["KeyF", { player: 1, button: 1 }],
  ["KeyE", { player: 1, button: 2 }],
  ["KeyD", { player: 1, button: 3 }],
  ["ShiftLeft", { player: 1, button: 4 }],
  ["Tab", { player: 1, button: 5 }],
  ["KeyW", { player: 1, button: 5 }],
  ["KeyQ", { player: 1, button: 5 }],
  ["KeyA", { player: 1, button: 5 }],
]);

export interface KeyboardInputFrontendOptions {
  readonly window?: Window;
  readonly document?: Document;
  readonly onChange?: (snapshot: PicoInputSnapshot) => void;
}

/** Maps the documented player 0/1 keys into the normalized controller snapshot. */
export class KeyboardInputFrontend {
  readonly #focusTarget: HTMLElement;
  readonly #window: Window;
  readonly #document: Document;
  readonly #onChange: ((snapshot: PicoInputSnapshot) => void) | undefined;
  readonly #heldCodes = new Set<string>();
  #enabled = false;
  readonly #controllers = new Uint8Array(PLAYER_CONTROLLER_COUNT);
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
    return this.#controllers[0]!;
  }

  get controllers(): readonly number[] {
    return Array.from(this.#controllers);
  }

  snapshot(): PicoInputSnapshot {
    return { controllers: Array.from(this.#controllers) };
  }

  setEnabled(enabled: boolean): void {
    this.#assertActive();
    this.#enabled = enabled;
    if (!enabled) this.clear();
  }

  clear(): void {
    if (this.#disposed) return;
    if (this.#heldCodes.size === 0 && this.#controllers.every((value) => value === 0)) return;
    this.#heldCodes.clear();
    this.#setControllers(new Uint8Array(PLAYER_CONTROLLER_COUNT));
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
    const binding = KEY_TO_BUTTON.get(event.code);
    if (binding === undefined || !this.#acceptsInput()) return;
    event.preventDefault();
    if (this.#heldCodes.has(event.code)) return;
    this.#heldCodes.add(event.code);
    this.#recomputeButtons();
  };

  readonly #onKeyUp = (event: KeyboardEvent): void => {
    const binding = KEY_TO_BUTTON.get(event.code);
    if (binding === undefined || !this.#enabled) return;
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
    const controllers = new Uint8Array(PLAYER_CONTROLLER_COUNT);
    for (const code of this.#heldCodes) {
      const binding = KEY_TO_BUTTON.get(code);
      if (binding !== undefined) {
        controllers[binding.player] = controllers[binding.player]! | (1 << binding.button);
      }
    }
    this.#setControllers(controllers);
  }

  #setControllers(controllers: Uint8Array): void {
    if (controllers.every((value, index) => value === this.#controllers[index])) return;
    this.#controllers.set(controllers);
    this.#onChange?.(this.snapshot());
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("KeyboardInputFrontend is disposed");
  }
}
