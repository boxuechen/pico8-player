import type { PicoRam } from "../memory/pico-ram.js";
import { DEFAULT_P8SCII_FONT } from "./p8scii-font.js";

const PRINT_START_X = 0x5f24;
const PEN_REGISTER = 0x5f25;
const TEXT_CURSOR_X = 0x5f26;
const TEXT_CURSOR_Y = 0x5f27;
const MISC_FEATURES = 0x5f36;
const DEFAULT_ATTRIBUTES = 0x5f58;
const CUSTOM_FONT = 0x5600;

const NO_AUTOMATIC_NEWLINE = 0x04;
const NO_PRINT_SCROLL = 0x40;
const CHARACTER_WRAP = 0x80;
const MAX_PRINT_BYTES = 65_536;
const MAX_GLYPHS_PER_PRINT = 65_536;
const MAX_PIXEL_WRITES_PER_PRINT = 8_388_608;
const MAX_NESTED_CONTROLS_PER_PRINT = 256;

export interface P8sciiRasterPort {
  plot(worldX: number, worldY: number, sourceColor: number): void;
  clear(sourceColor: number): void;
  scroll(rows: number): void;
}

interface PrintStyle {
  padding: boolean;
  wide: boolean;
  tall: boolean;
  solid: boolean;
  invert: boolean;
  stripey: boolean;
  custom: boolean;
  charWidth: number | undefined;
  extendedWidth: number | undefined;
  charHeight: number | undefined;
  offsetX: number;
  offsetY: number;
  tabWidth: number;
  tabOverridden: boolean;
  foreground: number;
  background: number;
  underline: boolean;
  outlineMask: number;
  outlineColor: number;
  outlineUsesForeground: boolean;
  outlineSkipsInterior: boolean;
}

interface PrintCursor {
  x: number;
  y: number;
  homeX: number;
  homeY: number;
  lastGlyphX: number;
  lastGlyphY: number;
  lastAdvance: number;
  lineHeight: number;
  rightmostX: number;
  wrapEnabled: boolean;
  wrapLimit: number;
  implicit: boolean;
  automaticNewline: boolean;
  terminated: boolean;
}

interface GlyphMetrics {
  readonly advance: number;
  readonly cellHeight: number;
  readonly glyphWidth: number;
  readonly glyphHeight: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

interface GlyphSource {
  readonly rows: Uint8Array;
  readonly metrics: GlyphMetrics;
  readonly padding: boolean;
}

class ByteCursor {
  index = 0;

  constructor(readonly bytes: Uint8Array) {}

  read(): number | undefined {
    if (this.index >= this.bytes.byteLength) return undefined;
    return this.bytes[this.index++];
  }

  remaining(): number {
    return this.bytes.byteLength - this.index;
  }
}

/** Browser-neutral, byte-preserving P8SCII parser and software glyph renderer. */
export class P8sciiText {
  readonly #memory: PicoRam;
  readonly #ram: Uint8Array;
  readonly #raster: P8sciiRasterPort;
  #glyphCount = 0;
  #pixelWrites = 0;
  #nestedControlDepth = 0;

  constructor(memory: PicoRam, raster: P8sciiRasterPort) {
    this.#memory = memory;
    this.#ram = memory.physicalBytes;
    this.#raster = raster;
  }

  cursor(xRaw: number, yRaw: number, colorRaw?: number): void {
    const x = q16Integer(xRaw);
    const y = q16Integer(yRaw);
    this.#ram[TEXT_CURSOR_X] = x & 0xff;
    this.#ram[TEXT_CURSOR_Y] = y & 0xff;
    this.#ram[PRINT_START_X] = x & 0xff;
    if (colorRaw !== undefined) this.#ram[PEN_REGISTER] = q16Color(colorRaw);
  }

  print(
    bytes: Uint8Array,
    xOrColorRaw?: number,
    yRaw?: number,
    colorRaw?: number,
  ): number {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("print expects a byte string");
    if (bytes.byteLength > MAX_PRINT_BYTES) {
      throw new RangeError(`print byte string exceeds ${MAX_PRINT_BYTES} bytes`);
    }
    this.#glyphCount = 0;
    this.#pixelWrites = 0;
    this.#nestedControlDepth = 0;

    const hasCoordinates = yRaw !== undefined;
    const explicitColor = hasCoordinates ? colorRaw : xOrColorRaw;
    if (explicitColor !== undefined) this.#ram[PEN_REGISTER] = q16Color(explicitColor);
    const x = hasCoordinates ? q16Integer(xOrColorRaw ?? 0) : this.#ram[TEXT_CURSOR_X]!;
    const y = hasCoordinates ? q16Integer(yRaw) : this.#ram[TEXT_CURSOR_Y]!;
    const homeX = hasCoordinates ? x : this.#ram[PRINT_START_X]!;
    const style = this.#initialStyle();
    const cursor: PrintCursor = {
      x,
      y,
      homeX,
      homeY: y,
      lastGlyphX: x,
      lastGlyphY: y,
      lastAdvance: this.#baseWidth(style, 0x20) * (style.wide ? 2 : 1),
      lineHeight: 0,
      rightmostX: x,
      wrapEnabled: (this.#ram[MISC_FEATURES]! & CHARACTER_WRAP) !== 0,
      wrapLimit: 128,
      implicit: !hasCoordinates,
      automaticNewline: !hasCoordinates &&
        (this.#ram[MISC_FEATURES]! & NO_AUTOMATIC_NEWLINE) === 0,
      terminated: false,
    };
    const input = new ByteCursor(bytes);
    while (!cursor.terminated) {
      const byte = input.read();
      if (byte === undefined) break;
      this.#processByte(byte, input, cursor, style);
    }

    if (cursor.automaticNewline && !cursor.terminated) {
      this.#newline(cursor, style);
      this.#scrollFinalCursor(cursor);
    }
    this.#ram[TEXT_CURSOR_X] = cursor.x & 0xff;
    this.#ram[TEXT_CURSOR_Y] = cursor.y & 0xff;
    this.#ram[PRINT_START_X] = cursor.homeX & 0xff;
    return toInt16(cursor.rightmostX);
  }

  #initialStyle(): PrintStyle {
    const flags = this.#ram[DEFAULT_ATTRIBUTES]!;
    const enabled = (flags & 0x01) !== 0;
    const dimensions = this.#ram[DEFAULT_ATTRIBUTES + 1]!;
    const widthsAndTabs = this.#ram[DEFAULT_ATTRIBUTES + 2]!;
    const offsets = this.#ram[DEFAULT_ATTRIBUTES + 3]!;
    const charWidth = dimensions & 0x0f;
    const charHeight = dimensions >>> 4;
    const extendedWidth = widthsAndTabs & 0x0f;
    const tabWidth = widthsAndTabs >>> 4;
    return {
      padding: enabled ? (flags & 0x02) !== 0 : true,
      wide: enabled && (flags & 0x04) !== 0,
      tall: enabled && (flags & 0x08) !== 0,
      solid: enabled && (flags & 0x10) !== 0,
      invert: enabled && (flags & 0x20) !== 0,
      stripey: enabled && (flags & 0x40) !== 0,
      custom: enabled && (flags & 0x80) !== 0,
      charWidth: charWidth === 0 ? undefined : charWidth,
      extendedWidth: extendedWidth === 0 ? undefined : extendedWidth,
      charHeight: charHeight === 0 ? undefined : charHeight,
      offsetX: offsets & 0x0f,
      offsetY: offsets >>> 4,
      tabWidth: tabWidth === 0 ? 16 : (tabWidth + 1) * 4,
      tabOverridden: false,
      foreground: this.#ram[PEN_REGISTER]!,
      background: 0,
      underline: false,
      outlineMask: 0,
      outlineColor: 0,
      outlineUsesForeground: false,
      outlineSkipsInterior: false,
    };
  }

  #processByte(
    byte: number,
    input: ByteCursor,
    cursor: PrintCursor,
    style: PrintStyle,
  ): void {
    switch (byte) {
      case 0:
        cursor.automaticNewline = false;
        cursor.terminated = true;
        return;
      case 1:
        this.#repeat(input, cursor, style);
        return;
      case 2: {
        const parameter = input.read();
        if (parameter !== undefined) {
          style.background = p8sciiValue(parameter);
          style.solid = true;
        }
        return;
      }
      case 3: {
        const parameter = input.read();
        if (parameter !== undefined) this.#moveX(cursor, p8sciiValue(parameter) - 16);
        return;
      }
      case 4: {
        const parameter = input.read();
        if (parameter !== undefined) cursor.y += p8sciiValue(parameter) - 16;
        return;
      }
      case 5: {
        const x = input.read();
        const y = input.read();
        if (x !== undefined) this.#moveX(cursor, p8sciiValue(x) - 16);
        if (y !== undefined) cursor.y += p8sciiValue(y) - 16;
        return;
      }
      case 6:
        this.#special(input, cursor, style);
        return;
      case 7:
        this.#consumeDeferredAudio(input);
        return;
      case 8:
        this.#moveX(cursor, -cursor.lastAdvance);
        return;
      case 9:
        this.#tab(cursor, style);
        return;
      case 10:
        this.#newline(cursor, style);
        return;
      case 11:
        this.#decorate(input, cursor, style);
        return;
      case 12: {
        const parameter = input.read();
        if (parameter !== undefined) {
          style.foreground = p8sciiValue(parameter);
          this.#ram[PEN_REGISTER] = style.foreground & 0xff;
        }
        return;
      }
      case 13:
        cursor.x = cursor.homeX;
        this.#touchRight(cursor);
        return;
      case 14:
        style.custom = true;
        return;
      case 15:
        style.custom = false;
        return;
      default:
        this.#drawCharacter(byte, cursor, style);
    }
  }

  #repeat(input: ByteCursor, cursor: PrintCursor, style: PrintStyle): void {
    const countByte = input.read();
    if (countByte === undefined) {
      cursor.automaticNewline = false;
      return;
    }
    const count = p8sciiValue(countByte);
    const repeated = input.read();
    if (repeated === undefined) {
      cursor.automaticNewline = false;
      const height = Math.max(cursor.lineHeight, this.#baseHeight(style));
      cursor.x = cursor.homeX;
      cursor.y += height * count;
      return;
    }
    for (let index = 0; index < count && !cursor.terminated; index += 1) {
      this.#processNestedByte(repeated, input, cursor, style);
    }
  }

  #special(input: ByteCursor, cursor: PrintCursor, style: PrintStyle): void {
    let command = input.read();
    if (command === undefined) return;
    let enable = true;
    if (command === 0x2d) {
      enable = false;
      command = input.read();
      if (command === undefined) return;
    }
    if (command >= 0x31 && command <= 0x39) return;
    switch (command) {
      case 0x63: {
        const color = input.read();
        if (color === undefined) return;
        this.#raster.clear(p8sciiValue(color));
        cursor.x = 0;
        cursor.y = 0;
        cursor.homeX = 0;
        cursor.homeY = 0;
        cursor.lineHeight = 0;
        this.#touchRight(cursor);
        return;
      }
      case 0x64:
        input.read();
        return;
      case 0x67:
        cursor.x = cursor.homeX;
        cursor.y = cursor.homeY;
        this.#touchRight(cursor);
        return;
      case 0x68:
        cursor.homeX = cursor.x;
        cursor.homeY = cursor.y;
        return;
      case 0x6a: {
        const x = input.read();
        const y = input.read();
        if (x !== undefined) cursor.x = p8sciiValue(x) * 4;
        if (y !== undefined) cursor.y = p8sciiValue(y) * 4;
        this.#touchRight(cursor);
        return;
      }
      case 0x72: {
        const boundary = input.read();
        if (boundary !== undefined) {
          cursor.wrapLimit = p8sciiValue(boundary) * 4;
          cursor.wrapEnabled = cursor.wrapLimit > 0;
        }
        return;
      }
      case 0x73: {
        const width = input.read();
        if (width !== undefined) {
          style.tabWidth = p8sciiValue(width);
          style.tabOverridden = true;
        }
        return;
      }
      case 0x75:
        style.underline = enable;
        return;
      case 0x78: {
        const width = input.read();
        if (width !== undefined) {
          style.charWidth = p8sciiValue(width);
          style.extendedWidth = style.charWidth + (style.custom ? 0 : 4);
        }
        return;
      }
      case 0x79: {
        const height = input.read();
        if (height !== undefined) style.charHeight = p8sciiValue(height);
        return;
      }
      case 0x77:
        style.wide = enable;
        return;
      case 0x74:
        style.tall = enable;
        return;
      case 0x3d:
        style.stripey = enable;
        return;
      case 0x70:
        style.wide = enable;
        style.tall = enable;
        style.stripey = enable;
        return;
      case 0x69:
        style.invert = enable;
        return;
      case 0x62:
        style.padding = enable;
        return;
      case 0x23:
        style.solid = enable;
        return;
      case 0x2e:
      case 0x2c:
        this.#oneOffRaw(input, cursor, style, command === 0x2c);
        return;
      case 0x3a:
      case 0x3b:
        this.#oneOffHex(input, cursor, style, command === 0x3b);
        return;
      case 0x6f:
        this.#outline(input, style);
        return;
      case 0x40:
        this.#rawWriteCounted(input);
        return;
      case 0x21:
        this.#rawWriteRemaining(input, cursor);
        return;
      default:
        return;
    }
  }

  #drawCharacter(byte: number, cursor: PrintCursor, style: PrintStyle): void {
    const source = this.#fontGlyph(byte, style);
    this.#drawGlyph(source, cursor, style);
  }

  #fontGlyph(byte: number, style: PrintStyle): GlyphSource {
    const custom = style.custom;
    const baseWidth = custom
      ? this.#memory.readU8(CUSTOM_FONT + (byte >= 0x80 ? 1 : 0))
      : byte >= 0x80 ? 8 : 4;
    const baseHeight = custom ? this.#memory.readU8(CUSTOM_FONT + 2) : 6;
    const requestedWidth = byte >= 0x80
      ? style.extendedWidth ?? baseWidth
      : style.charWidth ?? baseWidth;
    let advance = requestedWidth;
    let verticalAdjustment = 0;
    if (custom && (this.#memory.readU8(CUSTOM_FONT + 5) & 0x01) !== 0) {
      const adjustmentIndex = byte - 16;
      if (adjustmentIndex >= 0) {
        const packed = this.#memory.readU8(CUSTOM_FONT + 8 + (adjustmentIndex >> 1));
        const nibble = (adjustmentIndex & 1) === 0 ? packed & 0x0f : packed >>> 4;
        const widthAdjustment = (nibble & 0x07) < 4
          ? nibble & 0x07
          : (nibble & 0x07) - 8;
        advance += widthAdjustment;
        if ((nibble & 0x08) !== 0) verticalAdjustment = -1;
      }
    }
    advance = Math.max(0, advance);
    const cellHeight = Math.max(0, style.charHeight ?? baseHeight);
    const rows = custom
      ? this.#memory.copy(CUSTOM_FONT + byte * 8, 8)
      : DEFAULT_P8SCII_FONT.subarray(byte * 8, byte * 8 + 8);
    return {
      rows,
      metrics: {
        advance,
        cellHeight,
        glyphWidth: Math.min(8, Math.max(0, Math.min(baseWidth, requestedWidth))),
        glyphHeight: Math.min(8, custom ? cellHeight : Math.min(cellHeight, 5)),
        offsetX: style.offsetX + (custom ? this.#memory.readU8(CUSTOM_FONT + 3) : 0),
        offsetY: style.offsetY +
          (custom ? this.#memory.readU8(CUSTOM_FONT + 4) : 0) +
          verticalAdjustment,
      },
      padding: style.padding,
    };
  }

  #drawGlyph(source: GlyphSource, cursor: PrintCursor, style: PrintStyle): void {
    this.#glyphCount += 1;
    if (this.#glyphCount > MAX_GLYPHS_PER_PRINT) {
      throw new RangeError(`print glyph work exceeds ${MAX_GLYPHS_PER_PRINT}`);
    }
    const { metrics } = source;
    const scaleX = style.wide ? 2 : 1;
    const scaleY = style.tall ? 2 : 1;
    const advance = metrics.advance * scaleX;
    if (cursor.wrapEnabled && cursor.x + advance > cursor.wrapLimit) {
      this.#newline(cursor, style);
    }
    this.#scrollForGlyph(cursor, metrics.cellHeight * scaleY);
    cursor.lastGlyphX = cursor.x;
    cursor.lastGlyphY = cursor.y;
    cursor.lastAdvance = advance;
    cursor.lineHeight = Math.max(cursor.lineHeight, metrics.cellHeight * scaleY);

    const baseX = cursor.x + metrics.offsetX;
    const baseY = cursor.y + metrics.offsetY;
    const first = source.padding ? -1 : 0;
    for (let dy = first; dy < metrics.cellHeight; dy += 1) {
      for (let dx = first; dx < metrics.advance; dx += 1) {
        const foreground = this.#glyphBit(source, dx, dy) !== style.invert;
        for (let sy = 0; sy < scaleY; sy += 1) {
          for (let sx = 0; sx < scaleX; sx += 1) {
            const stripeGap = style.stripey && (sx !== 0 || sy !== 0);
            if ((!foreground || stripeGap) && style.solid) {
              this.#plot(baseX + dx * scaleX + sx, baseY + dy * scaleY + sy, style.background);
            }
          }
        }
      }
    }

    if (style.outlineMask !== 0) {
      const color = style.outlineUsesForeground ? style.foreground : style.outlineColor;
      const offsets = [
        [-1, -1], [0, -1], [1, -1], [-1, 0],
        [1, 0], [-1, 1], [0, 1], [1, 1],
      ] as const;
      this.#forEachForegroundPixel(source, baseX, baseY, style, (x, y) => {
        for (let index = 0; index < offsets.length; index += 1) {
          if ((style.outlineMask & (1 << index)) === 0) continue;
          const offset = offsets[index]!;
          this.#plot(x + offset[0], y + offset[1], color);
        }
      });
    }

    if (!style.outlineSkipsInterior) {
      this.#forEachForegroundPixel(source, baseX, baseY, style, (x, y) => {
        this.#plot(x, y, style.foreground);
      });
    }
    if (style.underline) {
      const underlineY = baseY + Math.max(0, metrics.cellHeight * scaleY - 1);
      const underlineStart = baseX - (source.padding ? scaleX : 0);
      for (let x = underlineStart; x < baseX + advance; x += 1) {
        this.#plot(x, underlineY, style.foreground);
      }
    }

    cursor.x += advance;
    this.#touchRight(cursor);
  }

  #forEachForegroundPixel(
    source: GlyphSource,
    baseX: number,
    baseY: number,
    style: PrintStyle,
    visit: (x: number, y: number) => void,
  ): void {
    const scaleX = style.wide ? 2 : 1;
    const scaleY = style.tall ? 2 : 1;
    const first = source.padding ? -1 : 0;
    for (let dy = first; dy < source.metrics.cellHeight; dy += 1) {
      for (let dx = first; dx < source.metrics.advance; dx += 1) {
        if (this.#glyphBit(source, dx, dy) === style.invert) continue;
        for (let sy = 0; sy < scaleY; sy += 1) {
          for (let sx = 0; sx < scaleX; sx += 1) {
            if (style.stripey && (sx !== 0 || sy !== 0)) continue;
            visit(baseX + dx * scaleX + sx, baseY + dy * scaleY + sy);
          }
        }
      }
    }
  }

  #glyphBit(source: GlyphSource, x: number, y: number): boolean {
    if (
      x < 0 || y < 0 ||
      x >= source.metrics.glyphWidth || y >= source.metrics.glyphHeight
    ) {
      return false;
    }
    return ((source.rows[y]! >>> x) & 1) !== 0;
  }

  #oneOffRaw(
    input: ByteCursor,
    cursor: PrintCursor,
    style: PrintStyle,
    respectPadding: boolean,
  ): void {
    if (input.remaining() < 8) {
      input.index = input.bytes.byteLength;
      return;
    }
    const rows = input.bytes.slice(input.index, input.index + 8);
    input.index += 8;
    this.#drawOneOff(rows, cursor, style, respectPadding);
  }

  #oneOffHex(
    input: ByteCursor,
    cursor: PrintCursor,
    style: PrintStyle,
    respectPadding: boolean,
  ): void {
    if (input.remaining() < 16) {
      input.index = input.bytes.byteLength;
      return;
    }
    const rows = new Uint8Array(8);
    for (let index = 0; index < 8; index += 1) {
      const high = hexValue(input.read()!);
      const low = hexValue(input.read()!);
      rows[index] = high < 0 || low < 0 ? 0 : (high << 4) | low;
    }
    this.#drawOneOff(rows, cursor, style, respectPadding);
  }

  #drawOneOff(
    rows: Uint8Array,
    cursor: PrintCursor,
    style: PrintStyle,
    respectPadding: boolean,
  ): void {
    this.#drawGlyph({
      rows,
      metrics: {
        advance: 8,
        cellHeight: 8,
        glyphWidth: 8,
        glyphHeight: 8,
        offsetX: style.offsetX,
        offsetY: style.offsetY,
      },
      padding: respectPadding && style.padding,
    }, cursor, style);
  }

  #outline(input: ByteCursor, style: PrintStyle): void {
    const color = input.read();
    const high = input.read();
    const low = input.read();
    if (color === undefined || high === undefined || low === undefined) return;
    const highValue = hexValue(high);
    const lowValue = hexValue(low);
    style.outlineMask = highValue < 0 || lowValue < 0 ? 0 : (highValue << 4) | lowValue;
    style.outlineUsesForeground = color === 0x24 || color === 0x21;
    style.outlineSkipsInterior = color === 0x21;
    style.outlineColor = style.outlineUsesForeground ? style.foreground : p8sciiValue(color);
  }

  #rawWriteCounted(input: ByteCursor): void {
    if (input.remaining() < 8) {
      input.index = input.bytes.byteLength;
      return;
    }
    const address = this.#readHexWord(input);
    const count = this.#readHexWord(input);
    if (address < 0 || count < 0) return;
    const available = Math.min(count, input.remaining());
    for (let index = 0; index < available; index += 1) {
      this.#memory.writeU8(address + index, input.read()!);
    }
  }

  #rawWriteRemaining(input: ByteCursor, cursor: PrintCursor): void {
    if (input.remaining() < 4) {
      input.index = input.bytes.byteLength;
      return;
    }
    const address = this.#readHexWord(input);
    if (address >= 0) {
      let index = 0;
      while (input.remaining() > 0) this.#memory.writeU8(address + index++, input.read()!);
    } else {
      input.index = input.bytes.byteLength;
    }
    cursor.automaticNewline = false;
    cursor.terminated = true;
  }

  #readHexWord(input: ByteCursor): number {
    let result = 0;
    let valid = true;
    for (let index = 0; index < 4; index += 1) {
      const value = hexValue(input.read()!);
      if (value < 0) {
        valid = false;
      } else {
        result = (result << 4) | value;
      }
    }
    return valid ? result : -1;
  }

  #decorate(input: ByteCursor, cursor: PrintCursor, style: PrintStyle): void {
    const position = input.read();
    const character = input.read();
    if (position === undefined || character === undefined) return;
    const savedX = cursor.x;
    const savedY = cursor.y;
    const value = p8sciiValue(position);
    cursor.x = cursor.lastGlyphX + (value & 0x03) - 2;
    cursor.y = cursor.lastGlyphY + (value >>> 2) - 8;
    this.#processNestedByte(character, input, cursor, style);
    cursor.x = savedX;
    cursor.y = savedY;
  }

  #processNestedByte(
    byte: number,
    input: ByteCursor,
    cursor: PrintCursor,
    style: PrintStyle,
  ): void {
    this.#nestedControlDepth += 1;
    if (this.#nestedControlDepth > MAX_NESTED_CONTROLS_PER_PRINT) {
      throw new RangeError(
        `print control nesting exceeds ${MAX_NESTED_CONTROLS_PER_PRINT}`,
      );
    }
    try {
      this.#processByte(byte, input, cursor, style);
    } finally {
      this.#nestedControlDepth -= 1;
    }
  }

  #tab(cursor: PrintCursor, style: PrintStyle): void {
    let width = style.tabWidth;
    let origin = 0;
    if (style.custom && !style.tabOverridden) {
      const customWidth = this.#memory.readU8(CUSTOM_FONT + 6);
      if (customWidth !== 0) width = customWidth;
      if ((this.#memory.readU8(CUSTOM_FONT + 5) & 0x02) !== 0) origin = cursor.homeX;
    }
    if (width <= 0) return;
    const relative = positiveModulo(cursor.x - origin, width);
    this.#moveX(cursor, width - relative);
  }

  #newline(cursor: PrintCursor, style: PrintStyle): void {
    const height = Math.max(cursor.lineHeight, this.#baseHeight(style));
    cursor.x = cursor.homeX;
    cursor.y += height;
    cursor.lineHeight = 0;
    this.#touchRight(cursor);
  }

  #baseWidth(style: PrintStyle, byte: number): number {
    const fallback = style.custom
      ? this.#memory.readU8(CUSTOM_FONT + (byte >= 0x80 ? 1 : 0))
      : byte >= 0x80 ? 8 : 4;
    return byte >= 0x80
      ? style.extendedWidth ?? fallback
      : style.charWidth ?? fallback;
  }

  #baseHeight(style: PrintStyle): number {
    const fallback = style.custom ? this.#memory.readU8(CUSTOM_FONT + 2) : 6;
    return Math.max(0, style.charHeight ?? fallback) * (style.tall ? 2 : 1);
  }

  #scrollForGlyph(cursor: PrintCursor, glyphHeight: number): void {
    if (!cursor.implicit || (this.#ram[MISC_FEATURES]! & NO_PRINT_SCROLL) !== 0) return;
    const overflow = cursor.y + glyphHeight - 128;
    if (overflow <= 0) return;
    this.#raster.scroll(Math.min(128, overflow));
    cursor.y -= overflow;
    cursor.homeY -= overflow;
    cursor.lastGlyphY -= overflow;
  }

  #scrollFinalCursor(cursor: PrintCursor): void {
    if (!cursor.implicit || (this.#ram[MISC_FEATURES]! & NO_PRINT_SCROLL) !== 0) return;
    const overflow = cursor.y - 122;
    if (overflow <= 0) return;
    this.#raster.scroll(Math.min(128, overflow));
    cursor.y -= overflow;
    cursor.homeY -= overflow;
    cursor.lastGlyphY -= overflow;
  }

  #consumeDeferredAudio(input: ByteCursor): void {
    while (input.remaining() > 0) {
      if (input.read() === 0x20) return;
    }
  }

  #moveX(cursor: PrintCursor, delta: number): void {
    cursor.x += delta;
    this.#touchRight(cursor);
  }

  #touchRight(cursor: PrintCursor): void {
    cursor.rightmostX = Math.max(cursor.rightmostX, cursor.x);
  }

  #plot(x: number, y: number, color: number): void {
    this.#pixelWrites += 1;
    if (this.#pixelWrites > MAX_PIXEL_WRITES_PER_PRINT) {
      throw new RangeError(`print raster work exceeds ${MAX_PIXEL_WRITES_PER_PRINT} pixels`);
    }
    this.#raster.plot(x, y, color & 0x0f);
  }
}

function q16Integer(raw: number): number {
  return raw >> 16;
}

function q16Color(raw: number): number {
  return (raw >>> 16) & 0xff;
}

function p8sciiValue(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x61 && byte <= 0x99) return byte - 0x57;
  if (byte >= 0x41 && byte <= 0x5a) return byte - 0x37;
  return 0;
}

function hexValue(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x57;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x37;
  return -1;
}

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function toInt16(value: number): number {
  return (value << 16) >> 16;
}
