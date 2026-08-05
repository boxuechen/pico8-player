const SCREEN_WIDTH = 128;
const SCREEN_HEIGHT = 128;
const SCREEN_BYTES = 0x2000;
const SCREEN_MAP_REGISTER = 0x5f55;
const CLIP_LEFT = 0x5f20;
const CLIP_TOP = 0x5f21;
const CLIP_RIGHT = 0x5f22;
const CLIP_BOTTOM = 0x5f23;
const TEXT_CURSOR_X = 0x5f26;
const TEXT_CURSOR_Y = 0x5f27;
const PEN_REGISTER = 0x5f25;
const POLYLINE_FLAG = 0x5f35;
const POLYLINE_X = 0x5f3c;
const POLYLINE_Y = 0x5f3e;

/** RAM-backed L1 rasterizer. Presentation remains outside RuntimeCore. */
export class L1Graphics {
  readonly #ram: Uint8Array;
  readonly #view: DataView;

  constructor(ram: Uint8Array) {
    this.#ram = ram;
    this.#view = new DataView(ram.buffer, ram.byteOffset, ram.byteLength);
  }

  reset(): void {
    this.#ram[PEN_REGISTER] = (this.#ram[PEN_REGISTER]! & 0xf0) | 6;
    this.#resetClipAndCursor();
    this.#invalidatePolyline();
  }

  cls(colorRaw?: number): void {
    const color = colorRaw === undefined ? 0 : q16Integer(colorRaw) & 0x0f;
    const packed = color | (color << 4);
    const base = this.#screenBase();
    this.#ram.fill(packed, base, base + SCREEN_BYTES);
    this.#resetClipAndCursor();
  }

  pset(xRaw: number, yRaw: number, colorRaw?: number): void {
    const color = this.#resolveColor(colorRaw);
    this.#plot(q16Integer(xRaw), q16Integer(yRaw), color);
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
      this.#drawLine(sourceX, sourceY, destinationX, destinationY, color);
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
    this.#drawLine(destinationX, destinationY, x1, y1, color);
  }

  rect(x0Raw: number, y0Raw: number, x1Raw: number, y1Raw: number, colorRaw?: number): void {
    const color = this.#resolveColor(colorRaw);
    const [left, right] = ordered(q16Integer(x0Raw), q16Integer(x1Raw));
    const [top, bottom] = ordered(q16Integer(y0Raw), q16Integer(y1Raw));
    this.#horizontal(left, right, top, color);
    this.#horizontal(left, right, bottom, color);
    this.#vertical(top, bottom, left, color);
    this.#vertical(top, bottom, right, color);
  }

  rectfill(
    x0Raw: number,
    y0Raw: number,
    x1Raw: number,
    y1Raw: number,
    colorRaw?: number,
  ): void {
    const color = this.#resolveColor(colorRaw);
    const [left, right] = ordered(q16Integer(x0Raw), q16Integer(x1Raw));
    const [top, bottom] = ordered(q16Integer(y0Raw), q16Integer(y1Raw));
    const firstRow = Math.max(0, top);
    const lastRow = Math.min(SCREEN_HEIGHT - 1, bottom);
    for (let y = firstRow; y <= lastRow; y += 1) this.#horizontal(left, right, y, color);
  }

  circ(xRaw: number, yRaw: number, radiusRaw?: number, colorRaw?: number): void {
    const color = this.#resolveColor(colorRaw);
    const centerX = toInt16(q16Integer(xRaw));
    const centerY = toInt16(q16Integer(yRaw));
    const radius = radiusRaw === undefined ? 4 : toInt16(q16Integer(radiusRaw));
    if (radius < 0 || !circleBoundsTouchScreen(centerX, centerY, radius)) return;

    let x = radius;
    let y = 0;
    let decision = 1 - x;
    while (y <= x) {
      this.#plotCircleOctants(centerX, centerY, x, y, color);
      y += 1;
      if (decision < 0) {
        decision += 2 * y + 1;
      } else {
        x -= 1;
        decision += 2 * (y - x) + 1;
      }
    }
  }

  circfill(xRaw: number, yRaw: number, radiusRaw?: number, colorRaw?: number): void {
    const color = this.#resolveColor(colorRaw);
    const centerX = toInt16(q16Integer(xRaw));
    const centerY = toInt16(q16Integer(yRaw));
    let radius = radiusRaw === undefined ? 4 : toInt16(q16Integer(radiusRaw));
    if (radius < 0 || !circleBoundsTouchScreen(centerX, centerY, radius)) return;
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
  }

  #resolveColor(colorRaw: number | undefined): number {
    if (colorRaw === undefined) return this.#ram[PEN_REGISTER]! & 0x0f;
    const color = q16Integer(colorRaw) & 0x0f;
    this.#ram[PEN_REGISTER] = (this.#ram[PEN_REGISTER]! & 0xf0) | color;
    return color;
  }

  #drawLine(x0: number, y0: number, x1: number, y1: number, color: number): void {
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

  #horizontal(x0: number, x1: number, y: number, color: number): void {
    if (y < 0 || y >= SCREEN_HEIGHT || x1 < 0 || x0 >= SCREEN_WIDTH) return;
    const first = Math.max(0, Math.min(x0, x1));
    const last = Math.min(SCREEN_WIDTH - 1, Math.max(x0, x1));
    for (let x = first; x <= last; x += 1) this.#plot(x, y, color);
  }

  #vertical(y0: number, y1: number, x: number, color: number): void {
    if (x < 0 || x >= SCREEN_WIDTH || y1 < 0 || y0 >= SCREEN_HEIGHT) return;
    const first = Math.max(0, Math.min(y0, y1));
    const last = Math.min(SCREEN_HEIGHT - 1, Math.max(y0, y1));
    for (let y = first; y <= last; y += 1) this.#plot(x, y, color);
  }

  #plotCircleOctants(
    centerX: number,
    centerY: number,
    x: number,
    y: number,
    color: number,
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

  #plot(x: number, y: number, color: number): void {
    if (x < 0 || x >= SCREEN_WIDTH || y < 0 || y >= SCREEN_HEIGHT) return;
    const address = this.#screenBase() + y * 64 + (x >> 1);
    const shift = (x & 1) << 2;
    const mask = 0x0f << shift;
    this.#ram[address] = (this.#ram[address]! & ~mask) | (color << shift);
  }

  #screenBase(): number {
    const configured = this.#ram[SCREEN_MAP_REGISTER]!;
    return (validVideoBase(configured) ? configured : 0x60) << 8;
  }

  #resetClipAndCursor(): void {
    this.#ram[CLIP_LEFT] = 0;
    this.#ram[CLIP_TOP] = 0;
    this.#ram[CLIP_RIGHT] = SCREEN_WIDTH;
    this.#ram[CLIP_BOTTOM] = SCREEN_HEIGHT;
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

function toInt16(value: number): number {
  return (value << 16) >> 16;
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

function validVideoBase(value: number): boolean {
  return value === 0x00 || value === 0x60 || value === 0x80 ||
    value === 0xa0 || value === 0xc0 || value === 0xe0;
}

function circleBoundsTouchScreen(centerX: number, centerY: number, radius: number): boolean {
  return centerX + radius >= 0 && centerX - radius < SCREEN_WIDTH &&
    centerY + radius >= 0 && centerY - radius < SCREEN_HEIGHT;
}
