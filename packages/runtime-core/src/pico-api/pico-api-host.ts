import {
  PICO_RAM_SIZE,
  type PicoInputSnapshot,
  type PicoMemoryLease,
} from "@pico8-web/contracts";
import { L1Graphics } from "../graphics/l1-graphics.js";
import { L1Input } from "../input/l1-input.js";

/**
 * Browser-neutral synchronous PICO API surface called from z8lua imports.
 * Numeric arguments retain their signed Q16.16 bits across the ABI.
 */
export interface PicoApiHost {
  readonly memoryLeaseId: string;
  reset(): void;
  beginTick(input: PicoInputSnapshot, targetFps: 30 | 60): void;
  cls(colorRaw?: number): void;
  pset(xRaw: number, yRaw: number, colorRaw?: number): void;
  line(
    x0Raw?: number,
    y0Raw?: number,
    x1OrColorRaw?: number,
    y1Raw?: number,
    colorRaw?: number,
  ): void;
  rect(x0Raw: number, y0Raw: number, x1Raw: number, y1Raw: number, colorRaw?: number): void;
  rectfill(x0Raw: number, y0Raw: number, x1Raw: number, y1Raw: number, colorRaw?: number): void;
  circ(xRaw: number, yRaw: number, radiusRaw?: number, colorRaw?: number): void;
  circfill(xRaw: number, yRaw: number, radiusRaw?: number, colorRaw?: number): void;
  /** Returns a held-button mask when omitted, otherwise a boolean encoded as 0/1. */
  btn(buttonRaw?: number, playerRaw?: number): number;
  /** Returns the current tick's edge/repeat state as a boolean encoded as 0/1. */
  btnp(buttonRaw: number, playerRaw?: number): number;
}

class RuntimePicoApiHost implements PicoApiHost {
  readonly memoryLeaseId: string;
  readonly #graphics: L1Graphics;
  readonly #input: L1Input;

  constructor(memory: PicoMemoryLease) {
    if (
      !(memory.buffer instanceof ArrayBuffer) ||
      memory.byteLength !== PICO_RAM_SIZE ||
      memory.byteOffset < 0 ||
      memory.byteOffset + memory.byteLength > memory.buffer.byteLength
    ) {
      throw new RangeError("PicoApiHost requires a valid 64 KiB memory lease");
    }
    this.memoryLeaseId = memory.leaseId;
    const ram = new Uint8Array(memory.buffer, memory.byteOffset, memory.byteLength);
    this.#graphics = new L1Graphics(ram);
    this.#input = new L1Input(ram);
  }

  reset(): void {
    this.#graphics.reset();
    this.#input.reset();
  }

  beginTick(input: PicoInputSnapshot, targetFps: 30 | 60): void {
    this.#input.beginTick(input, targetFps);
  }

  cls(colorRaw?: number): void {
    this.#graphics.cls(colorRaw);
  }

  pset(xRaw: number, yRaw: number, colorRaw?: number): void {
    this.#graphics.pset(xRaw, yRaw, colorRaw);
  }

  line(
    x0Raw?: number,
    y0Raw?: number,
    x1OrColorRaw?: number,
    y1Raw?: number,
    colorRaw?: number,
  ): void {
    this.#graphics.line(x0Raw, y0Raw, x1OrColorRaw, y1Raw, colorRaw);
  }

  rect(x0Raw: number, y0Raw: number, x1Raw: number, y1Raw: number, colorRaw?: number): void {
    this.#graphics.rect(x0Raw, y0Raw, x1Raw, y1Raw, colorRaw);
  }

  rectfill(
    x0Raw: number,
    y0Raw: number,
    x1Raw: number,
    y1Raw: number,
    colorRaw?: number,
  ): void {
    this.#graphics.rectfill(x0Raw, y0Raw, x1Raw, y1Raw, colorRaw);
  }

  circ(xRaw: number, yRaw: number, radiusRaw?: number, colorRaw?: number): void {
    this.#graphics.circ(xRaw, yRaw, radiusRaw, colorRaw);
  }

  circfill(xRaw: number, yRaw: number, radiusRaw?: number, colorRaw?: number): void {
    this.#graphics.circfill(xRaw, yRaw, radiusRaw, colorRaw);
  }

  btn(buttonRaw?: number, playerRaw?: number): number {
    return this.#input.btn(buttonRaw, playerRaw);
  }

  btnp(buttonRaw: number, playerRaw?: number): number {
    return this.#input.btnp(buttonRaw, playerRaw);
  }
}

/** Create the browser-neutral host over the VM's stable memory lease. */
export function createPicoApiHost(memory: PicoMemoryLease): PicoApiHost {
  return new RuntimePicoApiHost(memory);
}
