import type { PicoInputSnapshot } from "@pico8-web/contracts";

const PLAYER_ZERO_BUTTONS = 0x5f4c;
const PLAYER_REGISTER_COUNT = 8;
const BTNP_REPEAT_DELAY = 0x5f5c;
const BTNP_REPEAT_INTERVAL = 0x5f5d;
const BUTTON_COUNT = 6;
const BUTTON_MASK = (1 << BUTTON_COUNT) - 1;
const DEFAULT_REPEAT_DELAY = 15;
const DEFAULT_REPEAT_INTERVAL = 4;
const DISABLE_REPEAT = 255;

export function normalizeButtons(input: PicoInputSnapshot): number {
  if (!Number.isInteger(input.buttons) || input.buttons < 0 || input.buttons > BUTTON_MASK) {
    throw new RangeError("input buttons must be a six-bit P1 bitmask");
  }
  return input.buttons;
}

/** RuntimeCore-owned input latch. Physical device mapping belongs to the app. */
export class L1Input {
  readonly #ram: Uint8Array;
  readonly #heldTicks = new Array<number>(BUTTON_COUNT).fill(0);
  #pressedMask = 0;

  constructor(ram: Uint8Array) {
    this.#ram = ram;
  }

  reset(): void {
    this.#heldTicks.fill(0);
    this.#pressedMask = 0;
    this.#ram.fill(0, PLAYER_ZERO_BUTTONS, PLAYER_ZERO_BUTTONS + PLAYER_REGISTER_COUNT);
    this.#ram[BTNP_REPEAT_DELAY] = 0;
    this.#ram[BTNP_REPEAT_INTERVAL] = 0;
  }

  beginTick(input: PicoInputSnapshot, targetFps: 30 | 60): void {
    const buttons = normalizeButtons(input);
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

    let pressedMask = 0;
    for (let button = 0; button < BUTTON_COUNT; button += 1) {
      const bit = 1 << button;
      if ((buttons & bit) === 0) {
        this.#heldTicks[button] = 0;
        continue;
      }
      const heldTicks = (this.#heldTicks[button] ?? 0) + 1;
      this.#heldTicks[button] = heldTicks;
      if (
        heldTicks === 1 ||
        (!repeatDisabled && heldTicks > delay && (heldTicks - delay - 1) % interval === 0)
      ) {
        pressedMask |= bit;
      }
    }

    this.#pressedMask = pressedMask;
    this.#ram[PLAYER_ZERO_BUTTONS] = buttons;
    this.#ram.fill(0, PLAYER_ZERO_BUTTONS + 1, PLAYER_ZERO_BUTTONS + PLAYER_REGISTER_COUNT);
  }

  btn(buttonRaw?: number, playerRaw?: number): number {
    const buttons = this.#ram[PLAYER_ZERO_BUTTONS]! & BUTTON_MASK;
    if (buttonRaw === undefined) return buttons;
    const button = q16Integer(buttonRaw);
    const player = playerRaw === undefined ? 0 : q16Integer(playerRaw);
    return validL1Button(button, player) && (buttons & (1 << button)) !== 0 ? 1 : 0;
  }

  btnp(buttonRaw: number, playerRaw?: number): number {
    const button = q16Integer(buttonRaw);
    const player = playerRaw === undefined ? 0 : q16Integer(playerRaw);
    return validL1Button(button, player) && (this.#pressedMask & (1 << button)) !== 0 ? 1 : 0;
  }
}

function validL1Button(button: number, player: number): boolean {
  return player === 0 && button >= 0 && button < BUTTON_COUNT;
}

function q16Integer(raw: number): number {
  return raw >> 16;
}
