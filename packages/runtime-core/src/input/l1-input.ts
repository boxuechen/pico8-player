import {
  PICO_CONTROLLER_BUTTON_COUNT,
  PICO_CONTROLLER_BUTTON_MASK,
  PICO_CONTROLLER_COUNT,
  PICO_DEVKIT_KEYPRESS_BATCH_LIMIT,
  type PicoDevkitInputBatch,
  type PicoInputSnapshot,
} from "@pico8-player/contracts";

const DEVKIT_MODE = 0x5f2d;
const PLAYER_ZERO_BUTTONS = 0x5f4c;
const BTNP_REPEAT_DELAY = 0x5f5c;
const BTNP_REPEAT_INTERVAL = 0x5f5d;
const DEFAULT_REPEAT_DELAY = 15;
const DEFAULT_REPEAT_INTERVAL = 4;
const DISABLE_REPEAT = 255;
const DEVKIT_ENABLE = 0x01;
const DEVKIT_MOUSE_BUTTONS = 0x02;
const DEVKIT_FLAG_MASK = 0x07;
const DEVKIT_BUTTON_COUNT = 7;

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

function signedInt32(value: number): boolean {
  return Number.isInteger(value) && value >= -0x8000_0000 && value <= 0x7fff_ffff;
}

export function normalizeDevkitInput(input: PicoInputSnapshot): PicoDevkitInputBatch {
  const devkit = input.devkit;
  if (
    typeof devkit !== "object" || devkit === null ||
    !signedInt32(devkit.mouseXRaw) || !signedInt32(devkit.mouseYRaw) ||
    !Number.isInteger(devkit.mouseButtons) || devkit.mouseButtons < 0 ||
    devkit.mouseButtons > 0x07 ||
    !signedInt32(devkit.wheelRaw) || !signedInt32(devkit.movementXRaw) ||
    !signedInt32(devkit.movementYRaw) || !Array.isArray(devkit.keypresses) ||
    devkit.keypresses.length > PICO_DEVKIT_KEYPRESS_BATCH_LIMIT ||
    devkit.keypresses.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 0xff)
  ) {
    throw new RangeError("input devkit batch is malformed");
  }
  return devkit;
}

export function normalizeInputSnapshot(input: PicoInputSnapshot): PicoInputSnapshot {
  normalizeControllers(input);
  normalizeDevkitInput(input);
  return input;
}

/** RuntimeCore-owned input latch. Physical device mapping belongs to the app. */
export class L1Input {
  readonly #ram: Uint8Array;
  readonly #heldTicks = Array.from(
    { length: PICO_CONTROLLER_COUNT },
    () => new Array<number>(DEVKIT_BUTTON_COUNT).fill(0),
  );
  readonly #pressedMasks = new Uint8Array(PICO_CONTROLLER_COUNT);
  readonly #keypressQueue: number[] = [];
  #devkitFlags = 0;
  #mouseXRaw = 0;
  #mouseYRaw = 0;
  #mouseButtons = 0;
  #wheelRaw = 0;
  #movementXRaw = 0;
  #movementYRaw = 0;
  #targetFps: 30 | 60 = 30;

  constructor(ram: Uint8Array) {
    this.#ram = ram;
  }

  reset(): void {
    for (const player of this.#heldTicks) player.fill(0);
    this.#pressedMasks.fill(0);
    this.#ram.fill(0, PLAYER_ZERO_BUTTONS, PLAYER_ZERO_BUTTONS + PICO_CONTROLLER_COUNT);
    this.#ram[BTNP_REPEAT_DELAY] = 0;
    this.#ram[BTNP_REPEAT_INTERVAL] = 0;
    this.#ram[DEVKIT_MODE] = 0;
    this.#clearDevkitState();
    this.#targetFps = 30;
  }

  beginTick(input: PicoInputSnapshot, targetFps: 30 | 60): void {
    const controllers = normalizeControllers(input);
    const devkit = normalizeDevkitInput(input);
    if (targetFps !== 30 && targetFps !== 60) {
      throw new RangeError("input targetFps must be 30 or 60");
    }
    this.#targetFps = targetFps;

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

    this.#devkitFlags = this.#ram[DEVKIT_MODE]! & DEVKIT_FLAG_MASK;
    if ((this.#devkitFlags & DEVKIT_ENABLE) !== 0) {
      this.#mouseXRaw = devkit.mouseXRaw | 0;
      this.#mouseYRaw = devkit.mouseYRaw | 0;
      this.#mouseButtons = devkit.mouseButtons;
      this.#wheelRaw = devkit.wheelRaw | 0;
      this.#movementXRaw = devkit.movementXRaw | 0;
      this.#movementYRaw = devkit.movementYRaw | 0;
      for (const byte of devkit.keypresses) {
        if (this.#keypressQueue.length >= PICO_DEVKIT_KEYPRESS_BATCH_LIMIT) break;
        this.#keypressQueue.push(byte);
      }
    } else {
      this.#clearDevkitState();
    }

    for (let player = 0; player < PICO_CONTROLLER_COUNT; player += 1) {
      const mouseOverlay = player === 0 &&
          (this.#devkitFlags & (DEVKIT_ENABLE | DEVKIT_MOUSE_BUTTONS)) ===
            (DEVKIT_ENABLE | DEVKIT_MOUSE_BUTTONS)
        ? this.#mouseButtons << 4
        : 0;
      const buttons = controllers[player]! | mouseOverlay;
      const heldTicksForPlayer = this.#heldTicks[player]!;
      let pressedMask = 0;
      const buttonCount = player === 0 ? DEVKIT_BUTTON_COUNT : PICO_CONTROLLER_BUTTON_COUNT;
      for (let button = 0; button < buttonCount; button += 1) {
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
      const playerZeroMask = this.#mouseButtonsEnabled()
        ? (1 << DEVKIT_BUTTON_COUNT) - 1
        : PICO_CONTROLLER_BUTTON_MASK;
      return (this.#ram[PLAYER_ZERO_BUTTONS]! & playerZeroMask) |
        ((this.#ram[PLAYER_ZERO_BUTTONS + 1]! & PICO_CONTROLLER_BUTTON_MASK) << 8);
    }
    const button = q16Integer(buttonRaw);
    const player = playerRaw === undefined ? 0 : q16Integer(playerRaw);
    return this.#validButton(button, player) &&
      (this.#ram[PLAYER_ZERO_BUTTONS + player]! & (1 << button)) !== 0 ? 1 : 0;
  }

  btnp(buttonRaw?: number, playerRaw?: number): number {
    if (buttonRaw === undefined) {
      return this.#pressedMasks[0]! |
        ((this.#pressedMasks[1]! & PICO_CONTROLLER_BUTTON_MASK) << 8);
    }
    const button = q16Integer(buttonRaw);
    const player = playerRaw === undefined ? 0 : q16Integer(playerRaw);
    return this.#validButton(button, player) &&
      (this.#pressedMasks[player]! & (1 << button)) !== 0 ? 1 : 0;
  }

  stat(selectorRaw: number): number {
    const selector = q16Integer(selectorRaw);
    if (selector === 8 || selector === 9) return this.#targetFps << 16;
    if ((this.#devkitFlags & DEVKIT_ENABLE) === 0) {
      return selector === 31 ? -1 : 0;
    }
    switch (selector) {
      case 30: return this.#keypressQueue.length === 0 ? 0 : 1;
      case 31: return this.#keypressQueue.shift() ?? -1;
      case 32: return this.#mouseXRaw;
      case 33: return this.#mouseYRaw;
      case 34: return this.#mouseButtons;
      case 36: return this.#wheelRaw;
      case 38: return this.#movementXRaw;
      case 39: return this.#movementYRaw;
      default: return 0;
    }
  }

  get devkitFlags(): number {
    return this.#ram[DEVKIT_MODE]! & DEVKIT_FLAG_MASK;
  }

  #mouseButtonsEnabled(): boolean {
    return (this.#devkitFlags & (DEVKIT_ENABLE | DEVKIT_MOUSE_BUTTONS)) ===
      (DEVKIT_ENABLE | DEVKIT_MOUSE_BUTTONS);
  }

  #validButton(button: number, player: number): boolean {
    if (player < 0 || player >= PICO_CONTROLLER_COUNT || button < 0) return false;
    if (button < PICO_CONTROLLER_BUTTON_COUNT) return true;
    return player === 0 && button === 6 && this.#mouseButtonsEnabled();
  }

  #clearDevkitState(): void {
    this.#keypressQueue.length = 0;
    this.#devkitFlags = 0;
    this.#mouseXRaw = 0;
    this.#mouseYRaw = 0;
    this.#mouseButtons = 0;
    this.#wheelRaw = 0;
    this.#movementXRaw = 0;
    this.#movementYRaw = 0;
  }
}

function q16Integer(raw: number): number {
  return raw >> 16;
}
