import type { PicoControllerSnapshot } from "@pico8-player/contracts";
import { PICO_CONTROLLER_COUNT } from "../transport/player-protocol.js";
const AXIS_PRESS_THRESHOLD = 0.5;
const AXIS_RELEASE_THRESHOLD = 0.35;

export interface GamepadSource {
  getGamepads(): readonly (Gamepad | null)[];
}

export interface GamepadInputFrontendOptions {
  readonly source?: GamepadSource;
}

function pressed(gamepad: Gamepad, index: number): boolean {
  const button = gamepad.buttons[index];
  return button !== undefined && (button.pressed || button.value >= 0.5);
}

function latchAxisPair(
  current: number,
  value: number,
  negativeBit: number,
  positiveBit: number,
): number {
  let next = current;
  if ((next & negativeBit) !== 0) {
    if (value > -AXIS_RELEASE_THRESHOLD) next &= ~negativeBit;
  } else if (value <= -AXIS_PRESS_THRESHOLD) {
    next = (next & ~positiveBit) | negativeBit;
  }
  if ((next & positiveBit) !== 0) {
    if (value < AXIS_RELEASE_THRESHOLD) next &= ~positiveBit;
  } else if (value >= AXIS_PRESS_THRESHOLD) {
    next = (next & ~negativeBit) | positiveBit;
  }
  return next;
}

/** Polls standard-mapped browser slots; simulation only sees the normalized result. */
export class GamepadInputFrontend {
  readonly #source: GamepadSource;
  readonly #axisMasks = new Uint8Array(PICO_CONTROLLER_COUNT);
  readonly #controllers = new Uint8Array(PICO_CONTROLLER_COUNT);
  #enabled = false;
  #disposed = false;

  constructor(options: GamepadInputFrontendOptions = {}) {
    this.#source = options.source ?? navigator;
  }

  snapshot(): PicoControllerSnapshot {
    this.#assertActive();
    this.#controllers.fill(0);
    if (!this.#enabled) return { controllers: Array.from(this.#controllers) };
    const connected = new Uint8Array(PICO_CONTROLLER_COUNT);
    for (const gamepad of this.#source.getGamepads()) {
      if (
        gamepad === null || gamepad.connected === false || gamepad.mapping !== "standard" ||
        !Number.isInteger(gamepad.index) || gamepad.index < 0 || gamepad.index >= PICO_CONTROLLER_COUNT
      ) continue;
      const player = gamepad.index;
      connected[player] = 1;
      let mask = this.#axisMasks[player]!;
      mask = latchAxisPair(mask, gamepad.axes[0] ?? 0, 1 << 0, 1 << 1);
      mask = latchAxisPair(mask, gamepad.axes[1] ?? 0, 1 << 2, 1 << 3);
      this.#axisMasks[player] = mask;
      if (pressed(gamepad, 14)) mask |= 1 << 0;
      if (pressed(gamepad, 15)) mask |= 1 << 1;
      if (pressed(gamepad, 12)) mask |= 1 << 2;
      if (pressed(gamepad, 13)) mask |= 1 << 3;
      if (pressed(gamepad, 0)) mask |= 1 << 4;
      if (pressed(gamepad, 1)) mask |= 1 << 5;
      this.#controllers[player] = mask;
    }
    for (let player = 0; player < PICO_CONTROLLER_COUNT; player += 1) {
      if (connected[player] === 0) this.#axisMasks[player] = 0;
    }
    return { controllers: Array.from(this.#controllers) };
  }

  setEnabled(enabled: boolean): void {
    this.#assertActive();
    this.#enabled = enabled;
    if (!enabled) this.clear();
  }

  clear(): void {
    if (this.#disposed) return;
    this.#axisMasks.fill(0);
    this.#controllers.fill(0);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.clear();
    this.#disposed = true;
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("GamepadInputFrontend is disposed");
  }
}
