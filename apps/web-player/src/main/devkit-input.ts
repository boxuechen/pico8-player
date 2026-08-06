import type { PicoDevkitInputBatch } from "@pico8-web/contracts";
import { PLAYER_DEVKIT_KEYPRESS_BATCH_LIMIT } from "../transport/player-protocol.js";

const DEVKIT_ENABLE = 0x01;
const DEVKIT_POINTER_LOCK = 0x04;
const Q16_ONE = 0x1_0000;
const LOGICAL_MAX = 127;

const CONTROL_KEYS = new Map<string, number>([
  ["Backspace", 8],
  ["Tab", 9],
  ["Enter", 13],
  ["Escape", 27],
  ["Delete", 127],
]);

function saturatingAddInt32(left: number, right: number): number {
  const result = left + right;
  return Math.max(-0x8000_0000, Math.min(0x7fff_ffff, result)) | 0;
}

function eventDeltaRaw(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(
    -0x8000_0000,
    Math.min(0x7fff_ffff, Math.trunc(value * Q16_ONE)),
  ) | 0;
}

function keyByte(event: KeyboardEvent): number | undefined {
  const control = CONTROL_KEYS.get(event.key);
  if (control !== undefined) return control;
  if (event.key.length !== 1) return undefined;
  const byte = event.key.charCodeAt(0);
  return byte <= 0xff ? byte : undefined;
}

/** DOM-owned adapter for PICO-8's opt-in mouse and keyboard devkit channel. */
export class DevkitInputFrontend {
  readonly #canvas: HTMLCanvasElement;
  readonly #window: Window;
  readonly #document: Document;
  readonly #keypresses: number[] = [];
  readonly #removeListeners: (() => void)[] = [];
  #enabled = false;
  #flags = 0;
  #mouseXRaw = 0;
  #mouseYRaw = 0;
  #mouseButtons = 0;
  #wheelRaw = 0;
  #movementXRaw = 0;
  #movementYRaw = 0;
  #disposed = false;

  constructor(
    canvas: HTMLCanvasElement,
    options: { readonly window?: Window; readonly document?: Document } = {},
  ) {
    this.#canvas = canvas;
    this.#window = options.window ?? window;
    this.#document = options.document ?? document;
    this.#bind(canvas, "pointermove", this.#onPointerMove);
    this.#bind(canvas, "pointerdown", this.#onPointerDown);
    this.#bind(this.#window, "pointerup", this.#onPointerUp);
    this.#bind(canvas, "wheel", this.#onWheel, { passive: false });
    this.#bind(canvas, "contextmenu", this.#onContextMenu);
    this.#bind(this.#window, "keydown", this.#onKeyDown);
    this.#bind(this.#window, "blur", this.#onBlur);
    this.#bind(this.#document, "visibilitychange", this.#onVisibilityChange);
    this.#bind(this.#document, "pointerlockchange", this.#onPointerLockChange);
    this.#bind(this.#document, "pointerlockerror", this.#onPointerLockError);
  }

  get flags(): number {
    return this.#flags;
  }

  setFlags(flags: number): void {
    this.#assertActive();
    this.#flags = flags & 0x07;
    if ((this.#flags & DEVKIT_ENABLE) === 0) this.clear();
    if ((this.#flags & DEVKIT_POINTER_LOCK) === 0) this.#exitPointerLock();
  }

  setEnabled(enabled: boolean): void {
    this.#assertActive();
    this.#enabled = enabled;
    if (!enabled) this.clear();
  }

  peekBatch(): PicoDevkitInputBatch {
    this.#assertActive();
    return this.#batch();
  }

  takeBatch(): PicoDevkitInputBatch {
    this.#assertActive();
    const batch = this.#batch();
    this.#wheelRaw = 0;
    this.#movementXRaw = 0;
    this.#movementYRaw = 0;
    this.#keypresses.length = 0;
    return batch;
  }

  clear(): void {
    if (this.#disposed) return;
    this.#mouseButtons = 0;
    this.#wheelRaw = 0;
    this.#movementXRaw = 0;
    this.#movementYRaw = 0;
    this.#keypresses.length = 0;
    this.#exitPointerLock();
  }

  reset(): void {
    if (this.#disposed) return;
    this.#flags = 0;
    this.clear();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.reset();
    this.#disposed = true;
    for (const remove of this.#removeListeners.splice(0)) remove();
  }

  #batch(): PicoDevkitInputBatch {
    return {
      mouseXRaw: this.#mouseXRaw,
      mouseYRaw: this.#mouseYRaw,
      mouseButtons: this.#mouseButtons,
      wheelRaw: this.#wheelRaw,
      movementXRaw: this.#movementXRaw,
      movementYRaw: this.#movementYRaw,
      keypresses: this.#keypresses.slice(),
    };
  }

  readonly #onPointerMove = (event: Event): void => {
    if (!this.#acceptsPointerInput()) return;
    const pointer = event as PointerEvent;
    const rect = this.#canvas.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      const x = Math.floor((pointer.clientX - rect.left) * 128 / rect.width);
      const y = Math.floor((pointer.clientY - rect.top) * 128 / rect.height);
      this.#mouseXRaw = Math.max(0, Math.min(LOGICAL_MAX, x)) * Q16_ONE;
      this.#mouseYRaw = Math.max(0, Math.min(LOGICAL_MAX, y)) * Q16_ONE;
    }
    if (
      (this.#flags & DEVKIT_POINTER_LOCK) !== 0 &&
      this.#document.pointerLockElement === this.#canvas
    ) {
      this.#movementXRaw = saturatingAddInt32(
        this.#movementXRaw,
        eventDeltaRaw(pointer.movementX),
      );
      this.#movementYRaw = saturatingAddInt32(
        this.#movementYRaw,
        eventDeltaRaw(pointer.movementY),
      );
    }
  };

  readonly #onPointerDown = (event: Event): void => {
    if (!this.#acceptsPointerInput()) return;
    const pointer = event as PointerEvent;
    this.#canvas.focus();
    this.#mouseButtons = pointer.buttons & 0x07;
    if (pointer.button === 0 && (this.#flags & DEVKIT_POINTER_LOCK) !== 0) {
      const pending = this.#canvas.requestPointerLock();
      if (pending !== undefined) void pending.catch(() => this.clear());
    }
  };

  readonly #onPointerUp = (event: Event): void => {
    if (!this.#enabled) return;
    this.#mouseButtons = (event as PointerEvent).buttons & 0x07;
  };

  readonly #onWheel = (event: Event): void => {
    if (!this.#acceptsPointerInput()) return;
    const wheel = event as WheelEvent;
    wheel.preventDefault();
    const direction = Math.sign(wheel.deltaY);
    this.#wheelRaw = saturatingAddInt32(this.#wheelRaw, direction * Q16_ONE);
  };

  readonly #onContextMenu = (event: Event): void => {
    if (this.#acceptsPointerInput()) event.preventDefault();
  };

  readonly #onKeyDown = (event: Event): void => {
    const keyboard = event as KeyboardEvent;
    if (!this.#acceptsInput() || keyboard.repeat) return;
    const byte = keyByte(keyboard);
    if (byte === undefined || this.#keypresses.length >= PLAYER_DEVKIT_KEYPRESS_BATCH_LIMIT) return;
    this.#keypresses.push(byte);
  };

  readonly #onBlur = (): void => this.clear();

  readonly #onVisibilityChange = (): void => {
    if (this.#document.visibilityState === "hidden") this.clear();
  };

  readonly #onPointerLockChange = (): void => {
    if (this.#document.pointerLockElement !== this.#canvas) this.clear();
  };

  readonly #onPointerLockError = (): void => this.clear();

  #acceptsInput(): boolean {
    return this.#acceptsPointerInput() &&
      this.#document.activeElement === this.#canvas;
  }

  #acceptsPointerInput(): boolean {
    return this.#enabled && (this.#flags & DEVKIT_ENABLE) !== 0;
  }

  #exitPointerLock(): void {
    if (this.#document.pointerLockElement === this.#canvas) {
      this.#document.exitPointerLock();
    }
  }

  #bind(
    target: EventTarget,
    type: string,
    listener: EventListener,
    options?: AddEventListenerOptions,
  ): void {
    target.addEventListener(type, listener, options);
    this.#removeListeners.push(() => target.removeEventListener(type, listener, options));
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("DevkitInputFrontend is disposed");
  }
}
