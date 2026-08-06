import type { PicoInputSnapshot } from "@pico8-web/contracts";
import { PLAYER_CONTROLLER_COUNT } from "../transport/player-protocol.js";

import { GamepadInputFrontend, type GamepadSource } from "./gamepad-input.js";
import { DevkitInputFrontend } from "./devkit-input.js";
import { KeyboardInputFrontend } from "./input-frontend.js";
import { TouchInputFrontend } from "./touch-input.js";

export interface PlayerInputFrontendOptions {
  readonly window?: Window;
  readonly document?: Document;
  readonly gamepadSource?: GamepadSource;
  readonly touchRoot?: HTMLElement;
}

/** Merges app-owned device sources without allowing one source to clear another. */
export class PlayerInputFrontend {
  readonly keyboard: KeyboardInputFrontend;
  readonly gamepad: GamepadInputFrontend;
  readonly devkit: DevkitInputFrontend;
  readonly touch: TouchInputFrontend | undefined;
  #disposed = false;

  constructor(focusTarget: HTMLCanvasElement, options: PlayerInputFrontendOptions = {}) {
    this.keyboard = new KeyboardInputFrontend(focusTarget, options);
    this.gamepad = new GamepadInputFrontend({
      ...(options.gamepadSource === undefined ? {} : { source: options.gamepadSource }),
    });
    this.devkit = new DevkitInputFrontend(focusTarget, options);
    this.touch = options.touchRoot === undefined
      ? undefined
      : new TouchInputFrontend(options.touchRoot, options);
  }

  get buttons(): number {
    return this.snapshot().controllers[0]!;
  }

  snapshot(): PicoInputSnapshot {
    return this.#snapshot(false);
  }

  takeSnapshot(): PicoInputSnapshot {
    return this.#snapshot(true);
  }

  setDevkitFlags(flags: number): void {
    this.#assertActive();
    this.devkit.setFlags(flags);
  }

  #snapshot(consumeDevkitEvents: boolean): PicoInputSnapshot {
    this.#assertActive();
    const sources = [
      this.keyboard.snapshot().controllers,
      this.gamepad.snapshot().controllers,
      this.touch?.snapshot().controllers,
    ];
    const controllers = new Array<number>(PLAYER_CONTROLLER_COUNT).fill(0);
    for (const source of sources) {
      if (source === undefined) continue;
      for (let player = 0; player < controllers.length; player += 1) {
        controllers[player] = controllers[player]! | source[player]!;
      }
    }
    return {
      controllers,
      devkit: consumeDevkitEvents ? this.devkit.takeBatch() : this.devkit.peekBatch(),
    };
  }

  setEnabled(enabled: boolean): void {
    this.#assertActive();
    this.keyboard.setEnabled(enabled);
    this.gamepad.setEnabled(enabled);
    this.touch?.setEnabled(enabled);
    this.devkit.setEnabled(enabled);
  }

  clear(): void {
    if (this.#disposed) return;
    this.keyboard.clear();
    this.gamepad.clear();
    this.touch?.clear();
    this.devkit.clear();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.clear();
    this.#disposed = true;
    this.keyboard.dispose();
    this.gamepad.dispose();
    this.touch?.dispose();
    this.devkit.dispose();
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("PlayerInputFrontend is disposed");
  }
}
