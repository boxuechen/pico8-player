import {
  PICO_RAM_SIZE,
  type PicoInputSnapshot,
  type PicoMemoryLease,
} from "@pico8-web/contracts";
import { L1Graphics } from "../graphics/l1-graphics.js";
import { L1Input } from "../input/l1-input.js";
import type { PicoLogicalMemoryPort } from "../frame-runtime.js";
import { PicoRam } from "../memory/pico-ram.js";

/**
 * Browser-neutral synchronous PICO API surface called from z8lua imports.
 * Numeric arguments retain their signed Q16.16 bits across the ABI.
 */
export interface PicoApiHost {
  readonly memoryLeaseId: string;
  reset(): void;
  beginTick(input: PicoInputSnapshot, targetFps: 30 | 60): void;
  cls(colorRaw?: number): void;
  color(colorRaw?: number): number;
  camera(xRaw?: number, yRaw?: number): void;
  clip(
    xRaw?: number,
    yRaw?: number,
    widthRaw?: number,
    heightRaw?: number,
    clipPrevious?: boolean,
  ): void;
  pal(sourceRaw?: number, targetRaw?: number, paletteRaw?: number): number;
  palt(colorOrMaskRaw?: number, transparent?: boolean): number;
  fillp(patternRaw?: number): number;
  pget(xRaw: number, yRaw: number): number;
  sget(xRaw: number, yRaw: number): number;
  sset(xRaw: number, yRaw: number, colorRaw?: number): void;
  spr(
    spriteRaw: number,
    xRaw: number,
    yRaw: number,
    widthRaw?: number,
    heightRaw?: number,
    flipX?: boolean,
    flipY?: boolean,
  ): void;
  sspr(
    sourceXRaw: number,
    sourceYRaw: number,
    sourceWidthRaw: number,
    sourceHeightRaw: number,
    destinationXRaw: number,
    destinationYRaw: number,
    destinationWidthRaw?: number,
    destinationHeightRaw?: number,
    flipX?: boolean,
    flipY?: boolean,
  ): void;
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
  oval(x0Raw: number, y0Raw: number, x1Raw: number, y1Raw: number, colorRaw?: number): void;
  ovalfill(
    x0Raw: number,
    y0Raw: number,
    x1Raw: number,
    y1Raw: number,
    colorRaw?: number,
  ): void;
  /** Returns a held-button mask when omitted, otherwise a boolean encoded as 0/1. */
  btn(buttonRaw?: number, playerRaw?: number): number;
  /** Returns the current tick's edge/repeat state as a boolean encoded as 0/1. */
  btnp(buttonRaw: number, playerRaw?: number): number;
}

class RuntimePicoApiHost implements PicoApiHost {
  readonly memoryLeaseId: string;
  readonly #graphics: L1Graphics;
  readonly #input: L1Input;

  constructor(memory: PicoMemoryLease, logicalMemory: PicoLogicalMemoryPort) {
    if (
      !(memory.buffer instanceof ArrayBuffer) ||
      memory.byteLength !== PICO_RAM_SIZE ||
      memory.byteOffset < 0 ||
      memory.byteOffset + memory.byteLength > memory.buffer.byteLength
    ) {
      throw new RangeError("PicoApiHost requires a valid 64 KiB memory lease");
    }
    this.memoryLeaseId = memory.leaseId;
    const picoRam = new PicoRam(memory, logicalMemory);
    const ram = picoRam.physicalBytes;
    this.#graphics = new L1Graphics(picoRam);
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

  color(colorRaw?: number): number {
    return this.#graphics.color(colorRaw);
  }

  camera(xRaw?: number, yRaw?: number): void {
    this.#graphics.camera(xRaw, yRaw);
  }

  clip(
    xRaw?: number,
    yRaw?: number,
    widthRaw?: number,
    heightRaw?: number,
    clipPrevious?: boolean,
  ): void {
    this.#graphics.clip(xRaw, yRaw, widthRaw, heightRaw, clipPrevious);
  }

  pal(sourceRaw?: number, targetRaw?: number, paletteRaw?: number): number {
    return this.#graphics.pal(sourceRaw, targetRaw, paletteRaw);
  }

  palt(colorOrMaskRaw?: number, transparent?: boolean): number {
    return this.#graphics.palt(colorOrMaskRaw, transparent);
  }

  fillp(patternRaw?: number): number {
    return this.#graphics.fillp(patternRaw);
  }

  pget(xRaw: number, yRaw: number): number {
    return this.#graphics.pget(xRaw, yRaw);
  }

  sget(xRaw: number, yRaw: number): number {
    return this.#graphics.sget(xRaw, yRaw);
  }

  sset(xRaw: number, yRaw: number, colorRaw?: number): void {
    this.#graphics.sset(xRaw, yRaw, colorRaw);
  }

  spr(
    spriteRaw: number,
    xRaw: number,
    yRaw: number,
    widthRaw?: number,
    heightRaw?: number,
    flipX?: boolean,
    flipY?: boolean,
  ): void {
    this.#graphics.spr(spriteRaw, xRaw, yRaw, widthRaw, heightRaw, flipX, flipY);
  }

  sspr(
    sourceXRaw: number,
    sourceYRaw: number,
    sourceWidthRaw: number,
    sourceHeightRaw: number,
    destinationXRaw: number,
    destinationYRaw: number,
    destinationWidthRaw?: number,
    destinationHeightRaw?: number,
    flipX?: boolean,
    flipY?: boolean,
  ): void {
    this.#graphics.sspr(
      sourceXRaw,
      sourceYRaw,
      sourceWidthRaw,
      sourceHeightRaw,
      destinationXRaw,
      destinationYRaw,
      destinationWidthRaw,
      destinationHeightRaw,
      flipX,
      flipY,
    );
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

  oval(x0Raw: number, y0Raw: number, x1Raw: number, y1Raw: number, colorRaw?: number): void {
    this.#graphics.oval(x0Raw, y0Raw, x1Raw, y1Raw, colorRaw);
  }

  ovalfill(
    x0Raw: number,
    y0Raw: number,
    x1Raw: number,
    y1Raw: number,
    colorRaw?: number,
  ): void {
    this.#graphics.ovalfill(x0Raw, y0Raw, x1Raw, y1Raw, colorRaw);
  }

  btn(buttonRaw?: number, playerRaw?: number): number {
    return this.#input.btn(buttonRaw, playerRaw);
  }

  btnp(buttonRaw: number, playerRaw?: number): number {
    return this.#input.btnp(buttonRaw, playerRaw);
  }
}

/** Create the browser-neutral host over the VM's stable memory lease. */
export function createPicoApiHost(
  memory: PicoMemoryLease,
  logicalMemory: PicoLogicalMemoryPort,
): PicoApiHost {
  return new RuntimePicoApiHost(memory, logicalMemory);
}
