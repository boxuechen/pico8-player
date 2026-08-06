import {
  PICO_RAM_SIZE,
  type PicoInputSnapshot,
  type PicoMemoryLease,
} from "@pico8-web/contracts";
import {
  PicoSfxSynth,
  type AudioChannelSnapshot,
  type AudioMusicSnapshot,
  type CanonicalAudioSlice,
} from "../audio/sfx-synth.js";
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
  resetAudio(): void;
  beginTick(input: PicoInputSnapshot, targetFps: 30 | 60): void;
  renderAudioSlices(sliceCount: number, targetFps: 30 | 60): CanonicalAudioSlice;
  snapshotAudioChannels(): readonly AudioChannelSnapshot[];
  snapshotAudioMusic(): AudioMusicSnapshot;
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
  mget(xRaw: number, yRaw: number): number;
  mset(xRaw: number, yRaw: number, valueRaw: number): void;
  /** Returns a flag byte when omitted, otherwise a boolean encoded as 0/1. */
  fget(spriteRaw: number, flagRaw?: number): number;
  fset(spriteRaw: number, flagOrValueRaw: number, value?: boolean): void;
  map(
    tileXRaw?: number,
    tileYRaw?: number,
    screenXRaw?: number,
    screenYRaw?: number,
    tileWidthRaw?: number,
    tileHeightRaw?: number,
    layersRaw?: number,
  ): void;
  tline(
    x0Raw: number,
    y0Raw: number,
    x1Raw: number,
    y1Raw: number,
    mxRaw: number,
    myRaw: number,
    mdxRaw?: number,
    mdyRaw?: number,
    layersRaw?: number,
  ): void;
  print(
    bytes: Uint8Array,
    xOrColorRaw?: number,
    yRaw?: number,
    colorRaw?: number,
  ): number;
  cursor(xRaw: number, yRaw: number, colorRaw?: number): void;
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
  sfx(
    sfxRaw: number,
    channelRaw?: number,
    offsetRaw?: number,
    lengthRaw?: number,
  ): void;
  music(patternRaw: number, fadeLengthRaw?: number, channelMaskRaw?: number): void;
}

class RuntimePicoApiHost implements PicoApiHost {
  readonly memoryLeaseId: string;
  readonly #graphics: L1Graphics;
  readonly #input: L1Input;
  readonly #audio: PicoSfxSynth;

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
    this.#audio = new PicoSfxSynth(ram);
    this.#graphics = new L1Graphics(picoRam, {
      play: (bytes) => this.#audio.playP8sciiAudio(bytes),
    });
    this.#input = new L1Input(ram);
  }

  reset(): void {
    this.#graphics.reset();
    this.#input.reset();
    this.#audio.reset();
  }

  resetAudio(): void {
    this.#audio.reset();
  }

  beginTick(input: PicoInputSnapshot, targetFps: 30 | 60): void {
    this.#input.beginTick(input, targetFps);
  }

  renderAudioSlices(sliceCount: number, targetFps: 30 | 60): CanonicalAudioSlice {
    return this.#audio.renderSlices(sliceCount, targetFps);
  }

  snapshotAudioChannels(): readonly AudioChannelSnapshot[] {
    return this.#audio.snapshotChannels();
  }

  snapshotAudioMusic(): AudioMusicSnapshot {
    return this.#audio.snapshotMusic();
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

  mget(xRaw: number, yRaw: number): number {
    return this.#graphics.mget(xRaw, yRaw);
  }

  mset(xRaw: number, yRaw: number, valueRaw: number): void {
    this.#graphics.mset(xRaw, yRaw, valueRaw);
  }

  fget(spriteRaw: number, flagRaw?: number): number {
    return this.#graphics.fget(spriteRaw, flagRaw);
  }

  fset(spriteRaw: number, flagOrValueRaw: number, value?: boolean): void {
    this.#graphics.fset(spriteRaw, flagOrValueRaw, value);
  }

  map(
    tileXRaw?: number,
    tileYRaw?: number,
    screenXRaw?: number,
    screenYRaw?: number,
    tileWidthRaw?: number,
    tileHeightRaw?: number,
    layersRaw?: number,
  ): void {
    this.#graphics.map(
      tileXRaw,
      tileYRaw,
      screenXRaw,
      screenYRaw,
      tileWidthRaw,
      tileHeightRaw,
      layersRaw,
    );
  }

  tline(
    x0Raw: number,
    y0Raw: number,
    x1Raw: number,
    y1Raw: number,
    mxRaw: number,
    myRaw: number,
    mdxRaw?: number,
    mdyRaw?: number,
    layersRaw?: number,
  ): void {
    this.#graphics.tline(
      x0Raw,
      y0Raw,
      x1Raw,
      y1Raw,
      mxRaw,
      myRaw,
      mdxRaw,
      mdyRaw,
      layersRaw,
    );
  }

  print(
    bytes: Uint8Array,
    xOrColorRaw?: number,
    yRaw?: number,
    colorRaw?: number,
  ): number {
    return this.#graphics.print(bytes, xOrColorRaw, yRaw, colorRaw);
  }

  cursor(xRaw: number, yRaw: number, colorRaw?: number): void {
    this.#graphics.cursor(xRaw, yRaw, colorRaw);
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

  sfx(
    sfxRaw: number,
    channelRaw?: number,
    offsetRaw?: number,
    lengthRaw?: number,
  ): void {
    this.#audio.sfx(sfxRaw, channelRaw, offsetRaw, lengthRaw);
  }

  music(patternRaw: number, fadeLengthRaw?: number, channelMaskRaw?: number): void {
    this.#audio.music(patternRaw, fadeLengthRaw, channelMaskRaw);
  }
}

/** Create the browser-neutral host over the VM's stable memory lease. */
export function createPicoApiHost(
  memory: PicoMemoryLease,
  logicalMemory: PicoLogicalMemoryPort,
): PicoApiHost {
  return new RuntimePicoApiHost(memory, logicalMemory);
}
