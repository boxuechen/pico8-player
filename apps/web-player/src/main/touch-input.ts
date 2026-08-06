import type { PicoInputSnapshot } from "@pico8-web/contracts";
import {
  PLAYER_CONTROLLER_BUTTON_COUNT,
  PLAYER_CONTROLLER_COUNT,
} from "../transport/player-protocol.js";

interface TouchBinding {
  readonly player: number;
  readonly button: number;
}

export interface TouchInputFrontendOptions {
  readonly window?: Window;
  readonly document?: Document;
  readonly onChange?: (snapshot: PicoInputSnapshot) => void;
}

/** Converts multi-pointer virtual controls to an isolated controller source. */
export class TouchInputFrontend {
  readonly #window: Window;
  readonly #document: Document;
  readonly #onChange: ((snapshot: PicoInputSnapshot) => void) | undefined;
  readonly #controllers = new Uint8Array(PLAYER_CONTROLLER_COUNT);
  readonly #pointers = new Map<number, TouchBinding>();
  readonly #removeListeners: (() => void)[] = [];
  #enabled = false;
  #disposed = false;

  constructor(root: HTMLElement, options: TouchInputFrontendOptions = {}) {
    this.#window = options.window ?? window;
    this.#document = options.document ?? document;
    this.#onChange = options.onChange;
    for (const element of root.querySelectorAll<HTMLElement>("[data-pico-button]")) {
      const player = Number(element.dataset.picoPlayer ?? 0);
      const button = Number(element.dataset.picoButton);
      if (!Number.isInteger(player) || player < 0 || player >= PLAYER_CONTROLLER_COUNT ||
        !Number.isInteger(button) || button < 0 || button >= PLAYER_CONTROLLER_BUTTON_COUNT) continue;
      const binding = { player, button };
      this.#bind(element, "pointerdown", (event) => this.#press(event as PointerEvent, binding));
      this.#bind(element, "pointerup", (event) => this.#release(event as PointerEvent));
      this.#bind(element, "pointercancel", (event) => this.#release(event as PointerEvent));
      this.#bind(element, "lostpointercapture", (event) => this.#release(event as PointerEvent));
    }
    this.#bind(this.#window, "blur", () => this.clear());
    this.#bind(this.#document, "visibilitychange", () => {
      if (this.#document.visibilityState === "hidden") this.clear();
    });
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
    if (this.#pointers.size === 0 && this.#controllers.every((value) => value === 0)) return;
    this.#pointers.clear();
    this.#controllers.fill(0);
    this.#onChange?.(this.snapshot());
  }

  dispose(): void {
    if (this.#disposed) return;
    this.clear();
    this.#disposed = true;
    for (const remove of this.#removeListeners.splice(0)) remove();
  }

  #press(event: PointerEvent, binding: TouchBinding): void {
    if (!this.#enabled) return;
    event.preventDefault();
    this.#pointers.set(event.pointerId, binding);
    try {
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    } catch {
      // Synthetic tests and detached controls may not provide pointer capture.
    }
    this.#recompute();
  }

  #release(event: PointerEvent): void {
    if (!this.#pointers.delete(event.pointerId)) return;
    event.preventDefault();
    this.#recompute();
  }

  #recompute(): void {
    const next = new Uint8Array(PLAYER_CONTROLLER_COUNT);
    for (const { player, button } of this.#pointers.values()) {
      next[player] = next[player]! | (1 << button);
    }
    if (next.every((value, index) => value === this.#controllers[index])) return;
    this.#controllers.set(next);
    this.#onChange?.(this.snapshot());
  }

  #bind(target: EventTarget, type: string, listener: EventListener): void {
    target.addEventListener(type, listener);
    this.#removeListeners.push(() => target.removeEventListener(type, listener));
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("TouchInputFrontend is disposed");
  }
}
