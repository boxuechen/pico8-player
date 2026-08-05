import type { PicoRam } from "../memory/pico-ram.js";
import { PicoMapMemory } from "./map-memory.js";
import { P8sciiText } from "./p8scii-text.js";

const SCREEN_WIDTH = 128;
const SCREEN_HEIGHT = 128;
const SCREEN_BYTES = 0x2000;
const GFX_ADDRESS = 0x0000;
const SCREEN_ADDRESS = 0x6000;
const DRAW_PALETTE = 0x5f00;
const DISPLAY_PALETTE = 0x5f10;
const CLIP_LEFT = 0x5f20;
const CLIP_TOP = 0x5f21;
const CLIP_RIGHT = 0x5f22;
const CLIP_BOTTOM = 0x5f23;
const PRINT_START_X = 0x5f24;
const TEXT_CURSOR_X = 0x5f26;
const TEXT_CURSOR_Y = 0x5f27;
const PEN_REGISTER = 0x5f25;
const CAMERA_X = 0x5f28;
const CAMERA_Y = 0x5f2a;
const FILL_PATTERN = 0x5f31;
const FILL_FLAGS = 0x5f33;
const COLOR_SETTING_FLAGS = 0x5f34;
const POLYLINE_FLAG = 0x5f35;
const MISC_FEATURES = 0x5f36;
const TLINE_MASK_X = 0x5f38;
const TLINE_MASK_Y = 0x5f39;
const TLINE_OFFSET_X = 0x5f3a;
const TLINE_OFFSET_Y = 0x5f3b;
const POLYLINE_X = 0x5f3c;
const POLYLINE_Y = 0x5f3e;
const SGET_OUT_OF_BOUNDS = 0x5f59;
const MGET_OUT_OF_BOUNDS = 0x5f5a;
const PGET_OUT_OF_BOUNDS = 0x5f5b;
const SECONDARY_PALETTE = 0x5f60;
const SPRITE_FLAGS = 0x3000;

interface RasterColor {
  readonly primary: number;
  readonly alternate: number;
  readonly pattern: number;
  readonly alternateTransparent: boolean;
  readonly inverted: boolean;
}

/** RAM-backed standard 128x128 packed-4bpp rasterizer. */
export class L1Graphics {
  readonly #memory: PicoRam;
  readonly #mapMemory: PicoMapMemory;
  readonly #ram: Uint8Array;
  readonly #view: DataView;
  readonly #text: P8sciiText;
  readonly #shapeMask = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT);
  #maskingShape = false;

  constructor(memory: PicoRam) {
    this.#memory = memory;
    this.#mapMemory = new PicoMapMemory(memory);
    this.#ram = memory.physicalBytes;
    this.#view = new DataView(
      this.#ram.buffer,
      this.#ram.byteOffset,
      this.#ram.byteLength,
    );
    this.#text = new P8sciiText(memory, {
      plot: (worldX, worldY, sourceColor) => {
        this.#plotTextPixel(worldX, worldY, sourceColor);
      },
      clear: (sourceColor) => {
        this.cls((sourceColor & 0x0f) << 16);
      },
      scroll: (rows) => {
        this.#scrollScreen(rows);
      },
    });
  }

  reset(): void {
    this.#resetPalette(0);
    this.#resetPalette(1);
    this.#resetPalette(2);
    this.#ram[PEN_REGISTER] = 6;
    this.#view.setInt16(CAMERA_X, 0, true);
    this.#view.setInt16(CAMERA_Y, 0, true);
    this.#view.setUint16(FILL_PATTERN, 0, true);
    this.#ram[FILL_FLAGS] = 0;
    this.#ram[COLOR_SETTING_FLAGS] = 0;
    this.#resetClipAndCursor();
    this.#invalidatePolyline();
  }

  cls(colorRaw?: number): void {
    const color = colorRaw === undefined ? 0 : q16Integer(colorRaw) & 0x0f;
    const packed = color | (color << 4);
    this.#memory.fill(SCREEN_ADDRESS, SCREEN_BYTES, packed);
    this.#resetClipAndCursor();
  }

  color(colorRaw?: number): number {
    const previous = this.#ram[PEN_REGISTER]!;
    this.#ram[PEN_REGISTER] = colorRaw === undefined ? 6 : (colorRaw >>> 16) & 0xff;
    return previous;
  }

  camera(xRaw?: number, yRaw?: number): void {
    this.#view.setInt16(CAMERA_X, xRaw === undefined ? 0 : toInt16(q16Integer(xRaw)), true);
    this.#view.setInt16(CAMERA_Y, yRaw === undefined ? 0 : toInt16(q16Integer(yRaw)), true);
  }

  clip(
    xRaw?: number,
    yRaw?: number,
    widthRaw?: number,
    heightRaw?: number,
    clipPrevious = false,
  ): void {
    if (
      xRaw === undefined || yRaw === undefined ||
      widthRaw === undefined || heightRaw === undefined
    ) {
      this.#resetClip();
      return;
    }
    const x = toInt16(q16Integer(xRaw));
    const y = toInt16(q16Integer(yRaw));
    const width = Math.max(0, toInt16(q16Integer(widthRaw)));
    const height = Math.max(0, toInt16(q16Integer(heightRaw)));
    let left = clamp(x, 0, SCREEN_WIDTH);
    let top = clamp(y, 0, SCREEN_HEIGHT);
    let right = clamp(x + width, 0, SCREEN_WIDTH);
    let bottom = clamp(y + height, 0, SCREEN_HEIGHT);
    if (clipPrevious) {
      left = Math.max(left, this.#ram[CLIP_LEFT]!);
      top = Math.max(top, this.#ram[CLIP_TOP]!);
      right = Math.min(right, this.#ram[CLIP_RIGHT]!);
      bottom = Math.min(bottom, this.#ram[CLIP_BOTTOM]!);
    }
    this.#ram[CLIP_LEFT] = Math.min(left, right);
    this.#ram[CLIP_TOP] = Math.min(top, bottom);
    this.#ram[CLIP_RIGHT] = Math.max(left, right);
    this.#ram[CLIP_BOTTOM] = Math.max(top, bottom);
  }

  pal(sourceRaw?: number, targetRaw?: number, paletteRaw?: number): number {
    if (sourceRaw === undefined) {
      this.#resetPalette(0);
      this.#resetPalette(1);
      this.#resetPalette(2);
      return 0;
    }
    if (targetRaw === undefined) {
      this.#resetPalette(q16Integer(sourceRaw));
      return 0;
    }
    const palette = paletteRaw === undefined ? 0 : q16Integer(paletteRaw);
    if (palette < 0 || palette > 2) return 0;
    const source = q16Integer(sourceRaw) & 0x0f;
    const address = palette === 0
      ? DRAW_PALETTE + source
      : palette === 1
        ? DISPLAY_PALETTE + source
        : SECONDARY_PALETTE + source;
    const previous = this.#ram[address]!;
    const target = q16Integer(targetRaw);
    this.#ram[address] = palette === 0
      ? (previous & 0x10) | (target & 0x0f)
      : palette === 1
        ? target & 0x8f
        : target & 0xff;
    return palette === 0 ? previous & 0x0f : previous;
  }

  palt(colorOrMaskRaw?: number, transparent?: boolean): number {
    if (transparent === undefined) {
      let previous = 0;
      const mask = colorOrMaskRaw === undefined ? 0x8000 : q16Integer(colorOrMaskRaw) & 0xffff;
      for (let color = 0; color < 16; color += 1) {
        const address = DRAW_PALETTE + color;
        if ((this.#ram[address]! & 0x10) !== 0) previous |= 1 << (15 - color);
        this.#ram[address] = (this.#ram[address]! & 0x0f) |
          ((mask & (1 << (15 - color))) !== 0 ? 0x10 : 0);
      }
      return toInt16(previous);
    }
    const color = q16Integer(colorOrMaskRaw ?? 0) & 0x0f;
    const address = DRAW_PALETTE + color;
    const previous = (this.#ram[address]! & 0x10) !== 0;
    this.#ram[address] = (this.#ram[address]! & 0x0f) | (transparent ? 0x10 : 0);
    return previous ? 1 : 0;
  }

  fillp(patternRaw?: number): number {
    const previous = (
      (this.#view.getUint16(FILL_PATTERN, true) << 16) |
      ((this.#ram[FILL_FLAGS]! & 0x01) << 15) |
      ((this.#ram[FILL_FLAGS]! & 0x02) << 13) |
      ((this.#ram[FILL_FLAGS]! & 0x04) << 11)
    ) | 0;
    const pattern = patternRaw ?? 0;
    this.#view.setUint16(FILL_PATTERN, (pattern >>> 16) & 0xffff, true);
    this.#ram[FILL_FLAGS] = ((pattern >>> 15) & 0x01) |
      ((pattern >>> 13) & 0x02) |
      ((pattern >>> 11) & 0x04);
    return previous;
  }

  pget(xRaw: number, yRaw: number): number {
    const x = toInt16(q16Integer(xRaw)) - this.#view.getInt16(CAMERA_X, true);
    const y = toInt16(q16Integer(yRaw)) - this.#view.getInt16(CAMERA_Y, true);
    if (!this.#insideClip(x, y)) return this.#outOfBoundsPixel();
    const address = SCREEN_ADDRESS + y * 64 + (x >> 1);
    return (this.#memory.readU8(address) >>> ((x & 1) << 2)) & 0x0f;
  }

  sget(xRaw: number, yRaw: number): number {
    const x = toInt16(q16Integer(xRaw));
    const y = toInt16(q16Integer(yRaw));
    if (!insideSpriteSheet(x, y)) return this.#outOfBoundsSpritePixel();
    return this.#readSpritePixel(x, y);
  }

  sset(xRaw: number, yRaw: number, colorRaw?: number): void {
    const x = toInt16(q16Integer(xRaw));
    const y = toInt16(q16Integer(yRaw));
    if (!insideSpriteSheet(x, y)) return;
    const color = colorRaw === undefined
      ? this.#ram[PEN_REGISTER]!
      : (colorRaw >>> 16) & 0xff;
    const mapped = this.#ram[DRAW_PALETTE + (color & 0x0f)]! & 0x0f;
    this.#writeSpritePixel(x, y, mapped);
  }

  spr(
    spriteRaw: number,
    xRaw: number,
    yRaw: number,
    widthRaw?: number,
    heightRaw?: number,
    flipX = false,
    flipY = false,
  ): void {
    const sprite = toInt16(q16Integer(spriteRaw));
    const sourceX = (sprite % 16) * 8;
    const sourceY = Math.trunc(sprite / 16) * 8;
    const width = q16ScaledInteger(widthRaw ?? 0x0001_0000, 8);
    const height = q16ScaledInteger(heightRaw ?? 0x0001_0000, 8);
    const destinationX = toInt16(q16Integer(xRaw)) - this.#cameraX();
    const destinationY = toInt16(q16Integer(yRaw)) - this.#cameraY();
    this.#blitSprite(
      sourceX,
      sourceY,
      width,
      height,
      destinationX,
      destinationY,
      width,
      height,
      flipX,
      flipY,
    );
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
    flipX = false,
    flipY = false,
  ): void {
    const sourceX = toInt16(q16Integer(sourceXRaw));
    const sourceY = toInt16(q16Integer(sourceYRaw));
    const sourceWidth = toInt16(q16Integer(sourceWidthRaw));
    const sourceHeight = toInt16(q16Integer(sourceHeightRaw));
    let destinationX = toInt16(q16Integer(destinationXRaw)) - this.#cameraX();
    let destinationY = toInt16(q16Integer(destinationYRaw)) - this.#cameraY();
    let destinationWidth = destinationWidthRaw === undefined
      ? sourceWidth
      : toInt16(q16Integer(destinationWidthRaw));
    let destinationHeight = destinationHeightRaw === undefined
      ? sourceHeight
      : toInt16(q16Integer(destinationHeightRaw));
    if (destinationWidth < 0) {
      destinationWidth = -destinationWidth;
      destinationX -= destinationWidth - 1;
      flipX = !flipX;
    }
    if (destinationHeight < 0) {
      destinationHeight = -destinationHeight;
      destinationY -= destinationHeight - 1;
      flipY = !flipY;
    }
    this.#blitSprite(
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      destinationX,
      destinationY,
      destinationWidth,
      destinationHeight,
      flipX,
      flipY,
    );
  }

  mget(xRaw: number, yRaw: number): number {
    return this.#readMapTile(
      toInt16(q16Integer(xRaw)),
      toInt16(q16Integer(yRaw)),
    );
  }

  mset(xRaw: number, yRaw: number, valueRaw: number): void {
    this.#mapMemory.write(
      toInt16(q16Integer(xRaw)),
      toInt16(q16Integer(yRaw)),
      q16Integer(valueRaw),
    );
  }

  fget(spriteRaw: number, flagRaw?: number): number {
    const sprite = toInt16(q16Integer(spriteRaw));
    if (sprite < 0 || sprite > 255) return 0;
    const flags = this.#ram[SPRITE_FLAGS + sprite]!;
    if (flagRaw === undefined) return flags;
    const flag = toInt16(q16Integer(flagRaw));
    return flag >= 0 && flag < 8 && (flags & (1 << flag)) !== 0 ? 1 : 0;
  }

  fset(spriteRaw: number, flagOrValueRaw: number, value?: boolean): void {
    const sprite = toInt16(q16Integer(spriteRaw));
    if (sprite < 0 || sprite > 255) return;
    const address = SPRITE_FLAGS + sprite;
    if (value === undefined) {
      this.#ram[address] = q16Integer(flagOrValueRaw) & 0xff;
      return;
    }
    const flag = toInt16(q16Integer(flagOrValueRaw));
    if (flag < 0 || flag >= 8) return;
    this.#ram[address] = value
      ? this.#ram[address]! | (1 << flag)
      : this.#ram[address]! & ~(1 << flag);
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
    const layout = this.#mapMemory.layout();
    const tileX = toInt16(q16Integer(tileXRaw ?? 0));
    const tileY = toInt16(q16Integer(tileYRaw ?? 0));
    const destinationX = toInt16(q16Integer(screenXRaw ?? 0)) - this.#cameraX();
    const destinationY = toInt16(q16Integer(screenYRaw ?? 0)) - this.#cameraY();
    const tileWidth = tileWidthRaw === undefined
      ? layout.width
      : toInt16(q16Integer(tileWidthRaw));
    const tileHeight = tileHeightRaw === undefined
      ? layout.height
      : toInt16(q16Integer(tileHeightRaw));
    if (tileWidth <= 0 || tileHeight <= 0) return;
    const layers = layersRaw === undefined ? 0 : q16Integer(layersRaw) & 0xff;
    const firstTileX = Math.max(
      0,
      Math.floor((this.#ram[CLIP_LEFT]! - destinationX) / 8),
    );
    const finalTileX = Math.min(
      tileWidth,
      Math.ceil((this.#ram[CLIP_RIGHT]! - destinationX) / 8),
    );
    const firstTileY = Math.max(
      0,
      Math.floor((this.#ram[CLIP_TOP]! - destinationY) / 8),
    );
    const finalTileY = Math.min(
      tileHeight,
      Math.ceil((this.#ram[CLIP_BOTTOM]! - destinationY) / 8),
    );
    for (let offsetY = firstTileY; offsetY < finalTileY; offsetY += 1) {
      for (let offsetX = firstTileX; offsetX < finalTileX; offsetX += 1) {
        const sprite = this.#readMapTile(tileX + offsetX, tileY + offsetY);
        if (!this.#tileSelected(sprite, layers)) continue;
        this.#blitSprite(
          (sprite & 0x0f) * 8,
          (sprite >>> 4) * 8,
          8,
          8,
          destinationX + offsetX * 8,
          destinationY + offsetY * 8,
          8,
          8,
          false,
          false,
        );
      }
    }
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
    const x0 = toInt16(q16Integer(x0Raw)) - this.#cameraX();
    const y0 = toInt16(q16Integer(y0Raw)) - this.#cameraY();
    const x1 = toInt16(q16Integer(x1Raw)) - this.#cameraX();
    const y1 = toInt16(q16Integer(y1Raw)) - this.#cameraY();
    const deltaX = (mdxRaw ?? 0x0000_2000) | 0;
    const deltaY = (mdyRaw ?? 0) | 0;
    const layers = layersRaw === undefined ? 0 : q16Integer(layersRaw) & 0xff;
    const maskX = tlineMask(this.#ram[TLINE_MASK_X]!);
    const maskY = tlineMask(this.#ram[TLINE_MASK_Y]!);
    const horizontal = Math.abs(x1 - x0) >= Math.abs(y1 - y0);
    const major0 = horizontal ? x0 : y0;
    const major1 = horizontal ? x1 : y1;
    const minor0 = horizontal ? y0 : x0;
    const minor1 = horizontal ? y1 : x1;
    const direction = major0 <= major1 ? 1 : -1;
    let major = clamp(major0, -1, SCREEN_WIDTH);
    const majorEnd = clamp(major1, -1, SCREEN_WIDTH);
    const skipped = Math.abs(major - major0);
    let mapX = advanceTlineQ16(mxRaw, deltaX, skipped, maskX);
    let mapY = advanceTlineQ16(myRaw, deltaY, skipped, maskY);

    for (;;) {
      const minor = major0 === major1
        ? minor0
        : roundAwayFromZero(
          minor0 + ((minor1 - minor0) * (major - major0)) / (major1 - major0),
        );
      const x = horizontal ? major : minor;
      const y = horizontal ? minor : major;
      this.#plotTlineSample(x, y, mapX, mapY, maskX, maskY, layers);
      if (major === majorEnd) break;
      major += direction;
      mapX = advanceTlineQ16(mapX, deltaX, 1, maskX);
      mapY = advanceTlineQ16(mapY, deltaY, 1, maskY);
    }
  }

  print(
    bytes: Uint8Array,
    xOrColorRaw?: number,
    yRaw?: number,
    colorRaw?: number,
  ): number {
    return this.#text.print(bytes, xOrColorRaw, yRaw, colorRaw);
  }

  cursor(xRaw: number, yRaw: number, colorRaw?: number): void {
    this.#text.cursor(xRaw, yRaw, colorRaw);
  }

  pset(xRaw: number, yRaw: number, colorRaw?: number): void {
    const color = this.#resolveColor(colorRaw);
    const [x, y] = this.#cameraPoint(xRaw, yRaw);
    this.#plot(x, y, color);
  }

  line(
    x0Raw?: number,
    y0Raw?: number,
    x1OrColorRaw?: number,
    y1Raw?: number,
    colorRaw?: number,
  ): void {
    if (x0Raw === undefined || y0Raw === undefined) {
      if (x0Raw !== undefined) this.#resolveColor(x0Raw);
      this.#invalidatePolyline();
      return;
    }

    const destinationX = toInt16(q16Integer(x0Raw));
    const destinationY = toInt16(q16Integer(y0Raw));
    if (y1Raw === undefined) {
      const color = this.#resolveColor(x1OrColorRaw);
      const sourceX = this.#view.getInt16(POLYLINE_X, true);
      const sourceY = this.#view.getInt16(POLYLINE_Y, true);
      this.#writePolylineEndpoint(destinationX, destinationY);
      if (this.#polylineInvalid()) {
        this.#setPolylineInvalid(false);
        return;
      }
      this.#drawLine(
        sourceX - this.#cameraX(),
        sourceY - this.#cameraY(),
        destinationX - this.#cameraX(),
        destinationY - this.#cameraY(),
        color,
      );
      return;
    }

    if (x1OrColorRaw === undefined) {
      this.#invalidatePolyline();
      return;
    }
    const x1 = toInt16(q16Integer(x1OrColorRaw));
    const y1 = toInt16(q16Integer(y1Raw));
    const color = this.#resolveColor(colorRaw);
    this.#writePolylineEndpoint(x1, y1);
    this.#setPolylineInvalid(false);
    this.#drawLine(
      destinationX - this.#cameraX(),
      destinationY - this.#cameraY(),
      x1 - this.#cameraX(),
      y1 - this.#cameraY(),
      color,
    );
  }

  rect(x0Raw: number, y0Raw: number, x1Raw: number, y1Raw: number, colorRaw?: number): void {
    const color = this.#resolveColor(colorRaw);
    const [left, right] = ordered(
      toInt16(q16Integer(x0Raw)) - this.#cameraX(),
      toInt16(q16Integer(x1Raw)) - this.#cameraX(),
    );
    const [top, bottom] = ordered(
      toInt16(q16Integer(y0Raw)) - this.#cameraY(),
      toInt16(q16Integer(y1Raw)) - this.#cameraY(),
    );
    this.#horizontal(left, right, top, color);
    this.#horizontal(left, right, bottom, color);
    if (top + 1 < bottom) {
      this.#vertical(top + 1, bottom - 1, left, color);
      this.#vertical(top + 1, bottom - 1, right, color);
    }
  }

  rectfill(
    x0Raw: number,
    y0Raw: number,
    x1Raw: number,
    y1Raw: number,
    colorRaw?: number,
  ): void {
    const color = this.#resolveColor(colorRaw);
    const [left, right] = ordered(
      toInt16(q16Integer(x0Raw)) - this.#cameraX(),
      toInt16(q16Integer(x1Raw)) - this.#cameraX(),
    );
    const [top, bottom] = ordered(
      toInt16(q16Integer(y0Raw)) - this.#cameraY(),
      toInt16(q16Integer(y1Raw)) - this.#cameraY(),
    );
    this.#drawFilled(color, color.inverted, () => {
      for (let y = top; y <= bottom; y += 1) this.#horizontal(left, right, y, color);
    });
  }

  circ(xRaw: number, yRaw: number, radiusRaw?: number, colorRaw?: number): void {
    const color = this.#resolveColor(colorRaw);
    const [centerX, centerY] = this.#cameraPoint(xRaw, yRaw);
    const radius = radiusRaw === undefined ? 4 : toInt16(q16Integer(radiusRaw));
    if (radius < 0 || !circleBoundsTouchScreen(centerX, centerY, radius)) return;

    let x = radius;
    let y = 0;
    let decision = 1 - x;
    while (y <= x) {
      this.#plotCircleOctants(centerX, centerY, x, y, color);
      y += 1;
      if (decision < 0) decision += 2 * y + 1;
      else {
        x -= 1;
        decision += 2 * (y - x) + 1;
      }
    }
  }

  circfill(xRaw: number, yRaw: number, radiusRaw?: number, colorRaw?: number): void {
    const color = this.#resolveColor(colorRaw);
    const [centerX, centerY] = this.#cameraPoint(xRaw, yRaw);
    const requestedRadius = radiusRaw === undefined ? 4 : toInt16(q16Integer(radiusRaw));
    if (requestedRadius < 0) return;
    if (!color.inverted && !circleBoundsTouchScreen(centerX, centerY, requestedRadius)) return;
    this.#drawFilled(color, color.inverted, () => {
      let radius = requestedRadius;
      if (radius === 0) {
        this.#plot(centerX, centerY, color);
        return;
      }
      if (radius === 1) {
        this.#plot(centerX, centerY - 1, color);
        this.#horizontal(centerX - 1, centerX + 1, centerY, color);
        this.#plot(centerX, centerY + 1, color);
        return;
      }
      let x = -radius;
      let y = 0;
      let error = 2 - 2 * radius;
      do {
        this.#horizontal(centerX + x, centerX - x, centerY + y, color);
        this.#horizontal(centerX + x, centerX - x, centerY - y, color);
        radius = error;
        if (radius > x) error += ++x * 2 + 1;
        if (radius <= y) error += ++y * 2 + 1;
      } while (x < 0);
    });
  }

  oval(x0Raw: number, y0Raw: number, x1Raw: number, y1Raw: number, colorRaw?: number): void {
    const color = this.#resolveColor(colorRaw);
    const [x0, x1] = ordered(
      toInt16(q16Integer(x0Raw)) - this.#cameraX(),
      toInt16(q16Integer(x1Raw)) - this.#cameraX(),
    );
    const [y0, y1] = ordered(
      toInt16(q16Integer(y0Raw)) - this.#cameraY(),
      toInt16(q16Integer(y1Raw)) - this.#cameraY(),
    );
    if (x1 < 0 || x0 >= SCREEN_WIDTH || y1 < 0 || y0 >= SCREEN_HEIGHT) return;
    const centerX = (x0 + x1) / 2;
    const centerY = (y0 + y1) / 2;
    const radiusX = Math.max(1, (x1 - x0) / 2);
    const radiusY = Math.max(1, (y1 - y0) / 2);
    const plotSymmetric = (x: number, y: number) => {
      this.#plot(x, y, color);
      this.#plot(Math.trunc(2 * centerX - x), y, color);
      this.#plot(x, Math.trunc(2 * centerY - y), color);
      this.#plot(Math.trunc(2 * centerX - x), Math.trunc(2 * centerY - y), color);
    };
    const xCutoff = radiusX / Math.sqrt(1 + radiusY * radiusY / (radiusX * radiusX));
    for (let dx = 0; dx <= xCutoff; dx += 1) {
      const x = Math.ceil(centerX + dx);
      const y = roundAwayFromZero(centerY - radiusY / radiusX * Math.sqrt(radiusX * radiusX - dx * dx));
      plotSymmetric(x, y);
    }
    const yCutoff = radiusY / Math.sqrt(1 + radiusX * radiusX / (radiusY * radiusY));
    for (let dy = 0; dy < yCutoff; dy += 1) {
      const y = Math.ceil(centerY + dy);
      const x = roundAwayFromZero(centerX - radiusX / radiusY * Math.sqrt(radiusY * radiusY - dy * dy));
      plotSymmetric(x, y);
    }
  }

  ovalfill(
    x0Raw: number,
    y0Raw: number,
    x1Raw: number,
    y1Raw: number,
    colorRaw?: number,
  ): void {
    const color = this.#resolveColor(colorRaw);
    const [x0, x1] = ordered(
      toInt16(q16Integer(x0Raw)) - this.#cameraX(),
      toInt16(q16Integer(x1Raw)) - this.#cameraX(),
    );
    const [y0, y1] = ordered(
      toInt16(q16Integer(y0Raw)) - this.#cameraY(),
      toInt16(q16Integer(y1Raw)) - this.#cameraY(),
    );
    if (!color.inverted && (x1 < 0 || x0 >= SCREEN_WIDTH || y1 < 0 || y0 >= SCREEN_HEIGHT)) {
      return;
    }
    const centerX = (x0 + x1) / 2;
    const centerY = (y0 + y1) / 2;
    const radiusX = Math.max(1, (x1 - x0) / 2);
    const radiusY = Math.max(1, (y1 - y0) / 2);
    this.#drawFilled(color, color.inverted, () => {
      const xCutoff = radiusX / Math.sqrt(1 + radiusY * radiusY / (radiusX * radiusX));
      for (let dx = 0; dx <= xCutoff; dx += 1) {
        const x = Math.ceil(centerX + dx);
        const y = roundAwayFromZero(centerY - radiusY / radiusX * Math.sqrt(radiusX * radiusX - dx * dx));
        this.#vertical(Math.trunc(2 * centerY) - y, y, x, color);
        this.#vertical(Math.trunc(2 * centerY) - y, y, Math.trunc(2 * centerX) - x, color);
      }
      const yCutoff = radiusY / Math.sqrt(1 + radiusX * radiusX / (radiusY * radiusY));
      for (let dy = 0; dy <= yCutoff; dy += 1) {
        const x = roundAwayFromZero(centerX - radiusX / radiusY * Math.sqrt(radiusY * radiusY - dy * dy));
        const y = Math.ceil(centerY + dy);
        this.#horizontal(Math.trunc(2 * centerX) - x, x, y, color);
        this.#horizontal(Math.trunc(2 * centerX) - x, x, Math.trunc(2 * centerY) - y, color);
      }
    });
  }

  #resetPalette(palette: number): void {
    if (palette === 0) {
      for (let color = 0; color < 16; color += 1) {
        this.#ram[DRAW_PALETTE + color] = color | (color === 0 ? 0x10 : 0);
      }
    } else if (palette === 1) {
      for (let color = 0; color < 16; color += 1) {
        this.#ram[DISPLAY_PALETTE + color] = color;
      }
    } else if (palette === 2) {
      for (let color = 0; color < 16; color += 1) {
        this.#ram[SECONDARY_PALETTE + color] = color | (color << 4);
      }
    }
  }

  #resolveColor(colorRaw: number | undefined): RasterColor {
    let pen = this.#ram[PEN_REGISTER]!;
    let inverted = false;
    if (colorRaw !== undefined) {
      pen = (colorRaw >>> 16) & 0xff;
      this.#ram[PEN_REGISTER] = pen;
      if ((colorRaw & 0x1000_0000) !== 0 && (this.#ram[COLOR_SETTING_FLAGS]! & 1) !== 0) {
        this.#view.setUint16(FILL_PATTERN, colorRaw & 0xffff, true);
        this.#ram[FILL_FLAGS] = (colorRaw >>> 24) & 0x07;
        inverted = (colorRaw & 0x0800_0000) !== 0 &&
          (this.#ram[COLOR_SETTING_FLAGS]! & 2) !== 0;
      }
    }
    let primary = this.#ram[DRAW_PALETTE + (pen & 0x0f)]! & 0x0f;
    let alternate = this.#ram[DRAW_PALETTE + ((pen >>> 4) & 0x0f)]! & 0x0f;
    const flags = this.#ram[FILL_FLAGS]!;
    if ((flags & 0x04) !== 0) {
      const secondary = this.#ram[SECONDARY_PALETTE + primary]!;
      primary = secondary & 0x0f;
      alternate = (secondary >>> 4) & 0x0f;
    }
    return {
      primary,
      alternate,
      pattern: this.#view.getUint16(FILL_PATTERN, true),
      alternateTransparent: (flags & 0x01) !== 0,
      inverted,
    };
  }

  #cameraPoint(xRaw: number, yRaw: number): readonly [number, number] {
    return [
      toInt16(q16Integer(xRaw)) - this.#cameraX(),
      toInt16(q16Integer(yRaw)) - this.#cameraY(),
    ];
  }

  #cameraX(): number {
    return this.#view.getInt16(CAMERA_X, true);
  }

  #cameraY(): number {
    return this.#view.getInt16(CAMERA_Y, true);
  }

  #blitSprite(
    sourceX: number,
    sourceY: number,
    sourceWidth: number,
    sourceHeight: number,
    destinationX: number,
    destinationY: number,
    destinationWidth: number,
    destinationHeight: number,
    flipX: boolean,
    flipY: boolean,
  ): void {
    if (
      destinationWidth <= 0 || destinationHeight <= 0 ||
      sourceWidth === 0 || sourceHeight === 0 ||
      destinationX + destinationWidth <= 0 || destinationX >= SCREEN_WIDTH ||
      destinationY + destinationHeight <= 0 || destinationY >= SCREEN_HEIGHT
    ) {
      return;
    }
    const firstDestinationOffsetX = Math.max(
      0,
      -destinationX,
      this.#ram[CLIP_LEFT]! - destinationX,
    );
    const finalDestinationOffsetX = Math.min(
      destinationWidth,
      SCREEN_WIDTH - destinationX,
      this.#ram[CLIP_RIGHT]! - destinationX,
    );
    const firstDestinationOffsetY = Math.max(
      0,
      -destinationY,
      this.#ram[CLIP_TOP]! - destinationY,
    );
    const finalDestinationOffsetY = Math.min(
      destinationHeight,
      SCREEN_HEIGHT - destinationY,
      this.#ram[CLIP_BOTTOM]! - destinationY,
    );
    for (
      let destinationOffsetY = firstDestinationOffsetY;
      destinationOffsetY < finalDestinationOffsetY;
      destinationOffsetY += 1
    ) {
      const sampleOffsetY = flipY
        ? destinationHeight - 1 - destinationOffsetY
        : destinationOffsetY;
      const sampleY = sourceY + Math.floor(
        sourceHeight * sampleOffsetY / destinationHeight,
      );
      const y = destinationY + destinationOffsetY;
      for (
        let destinationOffsetX = firstDestinationOffsetX;
        destinationOffsetX < finalDestinationOffsetX;
        destinationOffsetX += 1
      ) {
        const sampleOffsetX = flipX
          ? destinationWidth - 1 - destinationOffsetX
          : destinationOffsetX;
        const sampleX = sourceX + Math.floor(
          sourceWidth * sampleOffsetX / destinationWidth,
        );
        const x = destinationX + destinationOffsetX;
        this.#plotSprite(x, y, this.#readSpritePixelSafe(sampleX, sampleY));
      }
    }
  }

  #readSpritePixelSafe(x: number, y: number): number {
    return insideSpriteSheet(x, y) ? this.#readSpritePixel(x, y) : 0;
  }

  #readMapTile(x: number, y: number): number {
    const tile = this.#mapMemory.read(x, y);
    if (tile !== undefined) return tile;
    return (this.#ram[MISC_FEATURES]! & 0x10) !== 0
      ? this.#ram[MGET_OUT_OF_BOUNDS]!
      : 0;
  }

  #tileSelected(sprite: number, layers: number): boolean {
    if (sprite === 0 && (this.#ram[MISC_FEATURES]! & 0x08) === 0) return false;
    return layers === 0 || (this.#ram[SPRITE_FLAGS + sprite]! & layers) !== 0;
  }

  #plotTlineSample(
    x: number,
    y: number,
    mapXRaw: number,
    mapYRaw: number,
    maskX: number,
    maskY: number,
    layers: number,
  ): void {
    if (!this.#insideClip(x, y)) return;
    const maskedX = (mapXRaw & maskX) >>> 0;
    const maskedY = (mapYRaw & maskY) >>> 0;
    const mapX = (maskedX >>> 16) + this.#ram[TLINE_OFFSET_X]!;
    const mapY = (maskedY >>> 16) + this.#ram[TLINE_OFFSET_Y]!;
    const sprite = this.#readMapTile(mapX, mapY);
    if (!this.#tileSelected(sprite, layers)) return;
    const sourceX = (sprite & 0x0f) * 8 + ((maskedX >>> 13) & 0x07);
    const sourceY = (sprite >>> 4) * 8 + ((maskedY >>> 13) & 0x07);
    this.#plotSprite(x, y, this.#readSpritePixel(sourceX, sourceY));
  }

  #readSpritePixel(x: number, y: number): number {
    const address = GFX_ADDRESS + y * 64 + (x >> 1);
    return (this.#memory.readU8(address) >>> ((x & 1) << 2)) & 0x0f;
  }

  #writeSpritePixel(x: number, y: number, color: number): void {
    const address = GFX_ADDRESS + y * 64 + (x >> 1);
    const shift = (x & 1) << 2;
    const mask = 0x0f << shift;
    const packed = this.#memory.readU8(address);
    this.#memory.writeU8(address, (packed & ~mask) | ((color & 0x0f) << shift));
  }

  #plotSprite(x: number, y: number, sourceColor: number): void {
    if (!this.#insideClip(x, y)) return;
    const drawEntry = this.#ram[DRAW_PALETTE + (sourceColor & 0x0f)]!;
    if ((drawEntry & 0x10) !== 0) return;
    let color = drawEntry & 0x0f;
    const flags = this.#ram[FILL_FLAGS]!;
    if ((flags & 0x02) !== 0) {
      const secondary = this.#ram[SECONDARY_PALETTE + color]!;
      const patternBit = (this.#view.getUint16(FILL_PATTERN, true) >>>
        (15 - (x & 3) - 4 * (y & 3))) & 1;
      if (patternBit !== 0 && (flags & 0x01) !== 0) return;
      color = patternBit === 0 ? secondary & 0x0f : (secondary >>> 4) & 0x0f;
    }
    this.#writeScreenPixel(x, y, color);
  }

  #plotTextPixel(worldX: number, worldY: number, sourceColor: number): void {
    const x = worldX - this.#cameraX();
    const y = worldY - this.#cameraY();
    if (!this.#insideClip(x, y)) return;
    const color = this.#ram[DRAW_PALETTE + (sourceColor & 0x0f)]! & 0x0f;
    this.#writeScreenPixel(x, y, color);
  }

  #scrollScreen(rows: number): void {
    const amount = clamp(Math.trunc(rows), 0, SCREEN_HEIGHT);
    if (amount === 0) return;
    const remainingBytes = (SCREEN_HEIGHT - amount) * (SCREEN_WIDTH >> 1);
    const snapshot = this.#memory.copy(
      SCREEN_ADDRESS + amount * (SCREEN_WIDTH >> 1),
      remainingBytes,
    );
    for (let index = 0; index < snapshot.byteLength; index += 1) {
      this.#memory.writeU8(SCREEN_ADDRESS + index, snapshot[index]!);
    }
    this.#memory.fill(SCREEN_ADDRESS + remainingBytes, SCREEN_BYTES - remainingBytes, 0);
  }

  #drawFilled(color: RasterColor, inverted: boolean, drawShape: () => void): void {
    if (!inverted) {
      drawShape();
      return;
    }
    this.#shapeMask.fill(0);
    this.#maskingShape = true;
    try {
      drawShape();
    } finally {
      this.#maskingShape = false;
    }
    const left = this.#ram[CLIP_LEFT]!;
    const top = this.#ram[CLIP_TOP]!;
    const right = this.#ram[CLIP_RIGHT]!;
    const bottom = this.#ram[CLIP_BOTTOM]!;
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        if (this.#shapeMask[y * SCREEN_WIDTH + x] === 0) this.#plot(x, y, color);
      }
    }
  }

  #drawLine(x0: number, y0: number, x1: number, y1: number, color: RasterColor): void {
    const horizontal = Math.abs(x1 - x0) >= Math.abs(y1 - y0);
    const dx = x0 <= x1 ? 1 : -1;
    const dy = y0 <= y1 ? 1 : -1;
    let x = clamp(x0, -1, SCREEN_WIDTH);
    let y = clamp(y0, -1, SCREEN_HEIGHT);
    const xEnd = clamp(x1, -1, SCREEN_WIDTH);
    const yEnd = clamp(y1, -1, SCREEN_HEIGHT);

    for (;;) {
      this.#plot(x, y, color);
      if (horizontal) {
        if (x === xEnd) break;
        x += dx;
        y = roundAwayFromZero(y0 + ((y1 - y0) * (x - x0)) / (x1 - x0));
      } else {
        if (y === yEnd) break;
        y += dy;
        x = roundAwayFromZero(x0 + ((x1 - x0) * (y - y0)) / (y1 - y0));
      }
    }
  }

  #horizontal(x0: number, x1: number, y: number, color: RasterColor): void {
    if (y < 0 || y >= SCREEN_HEIGHT) return;
    const first = Math.max(0, Math.min(x0, x1));
    const last = Math.min(SCREEN_WIDTH - 1, Math.max(x0, x1));
    for (let x = first; x <= last; x += 1) this.#plot(x, y, color);
  }

  #vertical(y0: number, y1: number, x: number, color: RasterColor): void {
    if (x < 0 || x >= SCREEN_WIDTH) return;
    const first = Math.max(0, Math.min(y0, y1));
    const last = Math.min(SCREEN_HEIGHT - 1, Math.max(y0, y1));
    for (let y = first; y <= last; y += 1) this.#plot(x, y, color);
  }

  #plotCircleOctants(
    centerX: number,
    centerY: number,
    x: number,
    y: number,
    color: RasterColor,
  ): void {
    this.#plot(centerX + x, centerY + y, color);
    this.#plot(centerX + y, centerY + x, color);
    this.#plot(centerX - x, centerY + y, color);
    this.#plot(centerX - y, centerY + x, color);
    this.#plot(centerX - x, centerY - y, color);
    this.#plot(centerX - y, centerY - x, color);
    this.#plot(centerX + x, centerY - y, color);
    this.#plot(centerX + y, centerY - x, color);
  }

  #plot(x: number, y: number, color: RasterColor): void {
    if (x < 0 || x >= SCREEN_WIDTH || y < 0 || y >= SCREEN_HEIGHT) return;
    if (this.#maskingShape) {
      this.#shapeMask[y * SCREEN_WIDTH + x] = 1;
      return;
    }
    if (!this.#insideClip(x, y)) return;
    const patternBit = (color.pattern >>> (15 - (x & 3) - 4 * (y & 3))) & 1;
    if (patternBit !== 0 && color.alternateTransparent) return;
    const pixel = patternBit === 0 ? color.primary : color.alternate;
    this.#writeScreenPixel(x, y, pixel);
  }

  #writeScreenPixel(x: number, y: number, pixel: number): void {
    const address = SCREEN_ADDRESS + y * 64 + (x >> 1);
    const shift = (x & 1) << 2;
    const mask = 0x0f << shift;
    const packed = this.#memory.readU8(address);
    this.#memory.writeU8(address, (packed & ~mask) | (pixel << shift));
  }

  #insideClip(x: number, y: number): boolean {
    return x >= 0 && x < SCREEN_WIDTH && y >= 0 && y < SCREEN_HEIGHT &&
      x >= this.#ram[CLIP_LEFT]! && x < this.#ram[CLIP_RIGHT]! &&
      y >= this.#ram[CLIP_TOP]! && y < this.#ram[CLIP_BOTTOM]!;
  }

  #outOfBoundsPixel(): number {
    return (this.#ram[MISC_FEATURES]! & 0x10) !== 0 ? this.#ram[PGET_OUT_OF_BOUNDS]! : 0;
  }

  #outOfBoundsSpritePixel(): number {
    return (this.#ram[MISC_FEATURES]! & 0x10) !== 0 ? this.#ram[SGET_OUT_OF_BOUNDS]! : 0;
  }

  #resetClip(): void {
    this.#ram[CLIP_LEFT] = 0;
    this.#ram[CLIP_TOP] = 0;
    this.#ram[CLIP_RIGHT] = SCREEN_WIDTH;
    this.#ram[CLIP_BOTTOM] = SCREEN_HEIGHT;
  }

  #resetClipAndCursor(): void {
    this.#resetClip();
    this.#ram[PRINT_START_X] = 0;
    this.#ram[TEXT_CURSOR_X] = 0;
    this.#ram[TEXT_CURSOR_Y] = 0;
  }

  #invalidatePolyline(): void {
    this.#writePolylineEndpoint(0, 0);
    this.#setPolylineInvalid(true);
  }

  #polylineInvalid(): boolean {
    return (this.#ram[POLYLINE_FLAG]! & 1) !== 0;
  }

  #setPolylineInvalid(invalid: boolean): void {
    const value = this.#ram[POLYLINE_FLAG]!;
    this.#ram[POLYLINE_FLAG] = invalid ? value | 1 : value & ~1;
  }

  #writePolylineEndpoint(x: number, y: number): void {
    this.#view.setInt16(POLYLINE_X, x, true);
    this.#view.setInt16(POLYLINE_Y, y, true);
  }
}

function q16Integer(raw: number): number {
  return raw >> 16;
}

function q16ScaledInteger(raw: number, scale: number): number {
  return Math.floor((raw | 0) * scale / 65_536);
}

function advanceTlineQ16(
  value: number,
  delta: number,
  count: number,
  mask: number,
): number {
  return ((value & ~mask) | ((value + Math.imul(delta, count)) & mask)) | 0;
}

function tlineMask(register: number): number {
  const tiles = register === 0 ? 256 : register;
  return (tiles * 65_536 - 1) >>> 0;
}

function toInt16(value: number): number {
  return (value << 16) >> 16;
}

function insideSpriteSheet(x: number, y: number): boolean {
  return x >= 0 && x < SCREEN_WIDTH && y >= 0 && y < SCREEN_HEIGHT;
}

function ordered(first: number, second: number): readonly [number, number] {
  return first <= second ? [first, second] : [second, first];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function roundAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

function circleBoundsTouchScreen(centerX: number, centerY: number, radius: number): boolean {
  return centerX + radius >= 0 && centerX - radius < SCREEN_WIDTH &&
    centerY + radius >= 0 && centerY - radius < SCREEN_HEIGHT;
}
