import { PICO_EMPTY_INPUT } from "@pico8-player/contracts";
import type { PicoInputSnapshot } from "@pico8-player/contracts";
import { PICO_CONTROLLER_COUNT } from "../transport/player-protocol.js";

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
  #hostInput: PicoInputSnapshot = PICO_EMPTY_INPUT;
  #hostInputEnabled = false;
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

  setHostInput(snapshot: PicoInputSnapshot): void {
    this.#assertActive();
    this.#hostInput = copyInput(snapshot);
  }

  #snapshot(consumeDevkitEvents: boolean): PicoInputSnapshot {
    this.#assertActive();
    const sources = [
      this.keyboard.snapshot().controllers,
      this.gamepad.snapshot().controllers,
      this.touch?.snapshot().controllers,
      this.#hostInputEnabled ? this.#hostInput.controllers : undefined,
    ];
    const controllers = new Array<number>(PICO_CONTROLLER_COUNT).fill(0);
    for (const source of sources) {
      if (source === undefined) continue;
      for (let player = 0; player < controllers.length; player += 1) {
        controllers[player] = controllers[player]! | source[player]!;
      }
    }
    const localDevkit = consumeDevkitEvents ? this.devkit.takeBatch() : this.devkit.peekBatch();
    const hostDevkit = this.#hostInput.devkit;
    const devkit = !this.#hostInputEnabled ? localDevkit : {
      mouseXRaw: hostDevkit.mouseXRaw,
      mouseYRaw: hostDevkit.mouseYRaw,
      mouseButtons: localDevkit.mouseButtons | hostDevkit.mouseButtons,
      wheelRaw: saturatingInt32(localDevkit.wheelRaw + hostDevkit.wheelRaw),
      movementXRaw: saturatingInt32(localDevkit.movementXRaw + hostDevkit.movementXRaw),
      movementYRaw: saturatingInt32(localDevkit.movementYRaw + hostDevkit.movementYRaw),
      keypresses: [...localDevkit.keypresses, ...hostDevkit.keypresses].slice(0, 64),
    };
    if (consumeDevkitEvents && this.#hostInputEnabled) {
      this.#hostInput = {
        controllers: this.#hostInput.controllers,
        devkit: {
          ...hostDevkit,
          wheelRaw: 0,
          movementXRaw: 0,
          movementYRaw: 0,
          keypresses: [],
        },
      };
    }
    return {
      controllers,
      devkit,
    };
  }

  setEnabled(enabled: boolean): void {
    this.#assertActive();
    if (!enabled) this.#hostInput = PICO_EMPTY_INPUT;
    this.keyboard.setEnabled(enabled);
    this.gamepad.setEnabled(enabled);
    this.touch?.setEnabled(enabled);
    this.devkit.setEnabled(enabled);
    this.#hostInputEnabled = enabled;
  }

  clear(): void {
    if (this.#disposed) return;
    this.keyboard.clear();
    this.gamepad.clear();
    this.touch?.clear();
    this.devkit.clear();
    this.#hostInput = PICO_EMPTY_INPUT;
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

function saturatingInt32(value: number): number {
  return Math.max(-0x8000_0000, Math.min(0x7fff_ffff, value)) | 0;
}

function copyInput(snapshot: PicoInputSnapshot): PicoInputSnapshot {
  const devkit = snapshot?.devkit;
  const int32 = (value: unknown): value is number => Number.isInteger(value) &&
    Number(value) >= -0x8000_0000 && Number(value) <= 0x7fff_ffff;
  if (
    !Array.isArray(snapshot?.controllers) ||
    snapshot.controllers.length !== PICO_CONTROLLER_COUNT ||
    snapshot.controllers.some((buttons) =>
      !Number.isSafeInteger(buttons) || buttons < 0 || buttons > 0x3f) ||
    typeof devkit !== "object" || devkit === null ||
    !int32(devkit.mouseXRaw) || !int32(devkit.mouseYRaw) ||
    !Number.isInteger(devkit.mouseButtons) || devkit.mouseButtons < 0 ||
    devkit.mouseButtons > 0x07 || !int32(devkit.wheelRaw) ||
    !int32(devkit.movementXRaw) || !int32(devkit.movementYRaw) ||
    !Array.isArray(devkit.keypresses) || devkit.keypresses.length > 64 ||
    devkit.keypresses.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 0xff)
  ) {
    throw new RangeError("input must contain a fixed controller snapshot and devkit batch");
  }
  return {
    controllers: snapshot.controllers.slice(),
    devkit: {
      mouseXRaw: devkit.mouseXRaw,
      mouseYRaw: devkit.mouseYRaw,
      mouseButtons: devkit.mouseButtons,
      wheelRaw: devkit.wheelRaw,
      movementXRaw: devkit.movementXRaw,
      movementYRaw: devkit.movementYRaw,
      keypresses: devkit.keypresses.slice(),
    },
  };
}
