import {
  PICO_CONTROLLER_BUTTON_COUNT,
  PICO_CONTROLLER_BUTTON_MASK,
  PICO_CONTROLLER_COUNT,
  type PicoInputSnapshot,
} from "@pico8-web/contracts";

const PLAYER_ZERO_BUTTONS = 0x5f4c;
const BTNP_REPEAT_DELAY = 0x5f5c;
const BTNP_REPEAT_INTERVAL = 0x5f5d;
const DEFAULT_REPEAT_DELAY = 15;
const DEFAULT_REPEAT_INTERVAL = 4;
const DISABLE_REPEAT = 255;

export const ZERO_PICO_INPUT: PicoInputSnapshot = Object.freeze({
  controllers: Object.freeze(new Array<number>(PICO_CONTROLLER_COUNT).fill(0)),
});

export function normalizeControllers(input: PicoInputSnapshot): readonly number[] {
  if (!Array.isArray(input.controllers) || input.controllers.length !== PICO_CONTROLLER_COUNT) {
    throw new RangeError("input controllers must contain exactly eight player masks");
  }
  for (const buttons of input.controllers) {
    if (!Number.isInteger(buttons) || buttons < 0 || buttons > PICO_CONTROLLER_BUTTON_MASK) {
      throw new RangeError("each input controller must be a six-bit button mask");
    }
  }
  return input.controllers;
}

/** RuntimeCore-owned input latch. Physical device mapping belongs to the app. */
export class L1Input {
  readonly #ram: Uint8Array;
  readonly #heldTicks = Array.from(
    { length: PICO_CONTROLLER_COUNT },
    () => new Array<number>(PICO_CONTROLLER_BUTTON_COUNT).fill(0),
  );
  readonly #pressedMasks = new Uint8Array(PICO_CONTROLLER_COUNT);

  constructor(ram: Uint8Array) {
    this.#ram = ram;
  }

  reset(): void {
    for (const player of this.#heldTicks) player.fill(0);
    this.#pressedMasks.fill(0);
    this.#ram.fill(0, PLAYER_ZERO_BUTTONS, PLAYER_ZERO_BUTTONS + PICO_CONTROLLER_COUNT);
    this.#ram[BTNP_REPEAT_DELAY] = 0;
    this.#ram[BTNP_REPEAT_INTERVAL] = 0;
  }

  beginTick(input: PicoInputSnapshot, targetFps: 30 | 60): void {
    const controllers = normalizeControllers(input);
    if (targetFps !== 30 && targetFps !== 60) {
      throw new RangeError("input targetFps must be 30 or 60");
    }

    // Repeat registers are sampled once. Guest writes during update/draw affect
    // the next simulation tick, never the already-latched btnp result.
    const configuredDelay = this.#ram[BTNP_REPEAT_DELAY]!;
    const configuredInterval = this.#ram[BTNP_REPEAT_INTERVAL]!;
    const rateScale = targetFps / 30;
    const repeatDisabled = configuredDelay === DISABLE_REPEAT;
    const delay = (configuredDelay === 0 ? DEFAULT_REPEAT_DELAY : configuredDelay) * rateScale;
    const interval = (
      configuredInterval === 0 ? DEFAULT_REPEAT_INTERVAL : configuredInterval
    ) * rateScale;

    for (let player = 0; player < PICO_CONTROLLER_COUNT; player += 1) {
      const buttons = controllers[player]!;
      const heldTicksForPlayer = this.#heldTicks[player]!;
      let pressedMask = 0;
      for (let button = 0; button < PICO_CONTROLLER_BUTTON_COUNT; button += 1) {
        const bit = 1 << button;
        if ((buttons & bit) === 0) {
          heldTicksForPlayer[button] = 0;
          continue;
        }
        const heldTicks = (heldTicksForPlayer[button] ?? 0) + 1;
        heldTicksForPlayer[button] = heldTicks;
        if (
          heldTicks === 1 ||
          (!repeatDisabled && heldTicks > delay && (heldTicks - delay - 1) % interval === 0)
        ) {
          pressedMask |= bit;
        }
      }
      this.#pressedMasks[player] = pressedMask;
      this.#ram[PLAYER_ZERO_BUTTONS + player] = buttons;
    }
  }

  btn(buttonRaw?: number, playerRaw?: number): number {
    if (buttonRaw === undefined) {
      return (this.#ram[PLAYER_ZERO_BUTTONS]! & PICO_CONTROLLER_BUTTON_MASK) |
        ((this.#ram[PLAYER_ZERO_BUTTONS + 1]! & PICO_CONTROLLER_BUTTON_MASK) << 8);
    }
    const button = q16Integer(buttonRaw);
    const player = playerRaw === undefined ? 0 : q16Integer(playerRaw);
    return validButton(button, player) &&
      (this.#ram[PLAYER_ZERO_BUTTONS + player]! & (1 << button)) !== 0 ? 1 : 0;
  }

  btnp(buttonRaw: number, playerRaw?: number): number {
    const button = q16Integer(buttonRaw);
    const player = playerRaw === undefined ? 0 : q16Integer(playerRaw);
    return validButton(button, player) &&
      (this.#pressedMasks[player]! & (1 << button)) !== 0 ? 1 : 0;
  }
}

function validButton(button: number, player: number): boolean {
  return player >= 0 && player < PICO_CONTROLLER_COUNT &&
    button >= 0 && button < PICO_CONTROLLER_BUTTON_COUNT;
}

function q16Integer(raw: number): number {
  return raw >> 16;
}
