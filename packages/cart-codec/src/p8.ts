import {
  PICO8_0_2_7_CART_VERSION,
  PICO_CART_ROM_SIZE,
} from "@pico8-web/contracts";

import { codecFailure } from "./errors.js";
import type { CartWarning } from "./model.js";
import { encodeP8sciiLine } from "./p8scii.js";

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;
const OFFICIAL_HEADER_PREFIX = "pico-8 cartridge";

const GFX_OFFSET = 0x0000;
const GFX_BYTES = 0x2000;
const MAP_OFFSET = 0x2000;
const MAP_BYTES = 0x1000;
const GFF_OFFSET = 0x3000;
const GFF_BYTES = 0x0100;
const MUSIC_OFFSET = 0x3100;
const MUSIC_BYTES = 0x0100;
const SFX_OFFSET = 0x3200;
const SFX_BYTES = 0x1100;

const GFX_ROW_CHARS = 128;
const GFF_MAP_ROW_CHARS = 256;
const SFX_ROW_CHARS = 168;
const MUSIC_ROW_CHARS = 11;
const LABEL_ROW_CHARS = 128;

export const P8_SECTION_NAMES = [
  "lua",
  "gfx",
  "gff",
  "map",
  "sfx",
  "music",
  "label",
] as const;

export type P8SectionName = (typeof P8_SECTION_NAMES)[number];
export type P8LineEndings = "lf" | "crlf" | "mixed" | "none";

export interface P8DecodeLimits {
  readonly maximumInputBytes: number;
  readonly maximumCodeBytes: number;
  readonly maximumLines: number;
  readonly maximumCartVersion: number;
}

export const DEFAULT_P8_LIMITS: Readonly<P8DecodeLimits> = Object.freeze({
  maximumInputBytes: 1_048_576,
  maximumCodeBytes: 65_535,
  maximumLines: 32_768,
  maximumCartVersion: PICO8_0_2_7_CART_VERSION,
});

export interface P8DecodeOptions {
  readonly limits?: Partial<P8DecodeLimits>;
  /** Resolve one non-recursive #include to caller-authorized plaintext Lua bytes. */
  readonly includeResolver?: (specifier: string) => Uint8Array | undefined;
}

interface SourceLine {
  readonly start: number;
  readonly end: number;
  readonly terminatorBytes: 0 | 1 | 2;
}

interface TextP8Result {
  readonly version: number;
  readonly rom: Uint8Array;
  readonly code: Uint8Array;
  readonly warnings: readonly CartWarning[];
  readonly lineEndings: P8LineEndings;
  readonly sectionRows: Readonly<Record<P8SectionName, number>>;
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    codecFailure("E_CART_LIMITS", `${name} must be a positive safe integer`, {
      details: { name, value },
    });
  }
  return value;
}

function nonNegativeByte(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 255) {
    codecFailure("E_CART_LIMITS", `${name} must be an integer from 0 to 255`, {
      details: { name, value },
    });
  }
  return value;
}

function normalizeLimits(options: P8DecodeOptions): P8DecodeLimits {
  const candidate = { ...DEFAULT_P8_LIMITS, ...options.limits };
  return {
    maximumInputBytes: positiveInteger("maximumInputBytes", candidate.maximumInputBytes),
    maximumCodeBytes: positiveInteger("maximumCodeBytes", candidate.maximumCodeBytes),
    maximumLines: positiveInteger("maximumLines", candidate.maximumLines),
    maximumCartVersion: nonNegativeByte(
      "maximumCartVersion",
      candidate.maximumCartVersion,
    ),
  };
}

function hasBom(input: Uint8Array): boolean {
  return UTF8_BOM.every((byte, index) => input[index] === byte);
}

function scanLines(
  input: Uint8Array,
  start: number,
  maximumLines: number,
): { readonly lines: readonly SourceLine[]; readonly lineEndings: P8LineEndings } {
  const lines: SourceLine[] = [];
  let lf = 0;
  let crlf = 0;
  let cursor = start;
  while (cursor < input.length) {
    if (lines.length >= maximumLines) {
      codecFailure("E_CART_TEXT_CAPACITY", "Text cart exceeds the configured line limit", {
        offset: cursor,
        details: { maximumLines },
      });
    }
    const lineStart = cursor;
    while (cursor < input.length && input[cursor] !== 0x0a && input[cursor] !== 0x0d) {
      cursor += 1;
    }
    const lineEnd = cursor;
    let terminatorBytes: 0 | 1 | 2 = 0;
    if (cursor < input.length) {
      if (input[cursor] === 0x0a) {
        terminatorBytes = 1;
        lf += 1;
        cursor += 1;
      } else if (input[cursor + 1] === 0x0a) {
        terminatorBytes = 2;
        crlf += 1;
        cursor += 2;
      } else {
        codecFailure("E_CART_TEXT_LINE_ENDING", "Lone CR is not a valid cart line ending", {
          offset: cursor,
        });
      }
    }
    lines.push({ start: lineStart, end: lineEnd, terminatorBytes });
  }

  return {
    lines,
    lineEndings: lf > 0 && crlf > 0 ? "mixed" : crlf > 0 ? "crlf" : lf > 0 ? "lf" : "none",
  };
}

function lineBytes(input: Uint8Array, line: SourceLine): Uint8Array {
  return input.subarray(line.start, line.end);
}

function asciiText(bytes: Uint8Array, offset: number, code: "E_CART_TEXT_HEADER" | "E_CART_TEXT_VERSION"): string {
  let result = "";
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    if (byte > 0x7f || byte === 0) {
      codecFailure(code, "Cart structure line must be ASCII", { offset: offset + index });
    }
    result += String.fromCharCode(byte);
  }
  return result;
}

function sectionMarker(bytes: Uint8Array): string | undefined {
  if (
    bytes.length < 5 ||
    bytes[0] !== 0x5f ||
    bytes[1] !== 0x5f ||
    bytes[bytes.length - 2] !== 0x5f ||
    bytes[bytes.length - 1] !== 0x5f
  ) {
    return undefined;
  }
  let name = "";
  for (let index = 2; index < bytes.length - 2; index += 1) {
    const byte = bytes[index] ?? 0;
    const valid =
      (byte >= 0x30 && byte <= 0x39) ||
      (byte >= 0x41 && byte <= 0x5a) ||
      byte === 0x2d || byte === 0x2e || byte === 0x3a || byte === 0x5f ||
      (byte >= 0x61 && byte <= 0x7a);
    if (!valid) return undefined;
    name += String.fromCharCode(byte);
  }
  return name;
}

function isKnownSection(name: string): name is P8SectionName {
  return (P8_SECTION_NAMES as readonly string[]).includes(name);
}

function hexNibble(bytes: Uint8Array, index: number, sourceOffset: number): number {
  const byte = bytes[index] ?? 0;
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10;
  codecFailure("E_CART_TEXT_ROW", "Section row contains a non-hex character", {
    offset: sourceOffset + index,
  });
}

function hexByte(bytes: Uint8Array, index: number, sourceOffset: number): number {
  return (hexNibble(bytes, index, sourceOffset) << 4) | hexNibble(bytes, index + 1, sourceOffset);
}

function requireRowLength(
  section: P8SectionName,
  bytes: Uint8Array,
  expected: number,
  sourceOffset: number,
): void {
  if (bytes.length !== expected) {
    codecFailure("E_CART_TEXT_ROW", `__${section}__ row has an invalid encoded width`, {
      offset: sourceOffset,
      details: { section, actualChars: bytes.length, expectedChars: expected },
    });
  }
}

function requireCapacity(
  section: P8SectionName,
  row: number,
  maximumRows: number,
  sourceOffset: number,
): void {
  if (row >= maximumRows) {
    codecFailure("E_CART_TEXT_CAPACITY", `__${section}__ exceeds its row capacity`, {
      offset: sourceOffset,
      details: { section, maximumRows },
    });
  }
}

function decodeHexChunk(
  section: P8SectionName,
  bytes: Uint8Array,
  maximumChars: number,
  sourceOffset: number,
  target: Uint8Array,
  targetOffset: number,
  swapNibbles = false,
): number {
  if (bytes.length < 2 || bytes.length > maximumChars || bytes.length % 2 !== 0) {
    codecFailure("E_CART_TEXT_ROW", `__${section}__ row has an invalid encoded width`, {
      offset: sourceOffset,
      details: { section, actualChars: bytes.length, maximumChars },
    });
  }
  const decodedBytes = bytes.length / 2;
  if (targetOffset + decodedBytes > target.length) {
    codecFailure("E_CART_TEXT_CAPACITY", `__${section}__ exceeds its byte capacity`, {
      offset: sourceOffset,
      details: { section, maximumBytes: target.length },
    });
  }
  for (let index = 0; index < bytes.length; index += 2) {
    const first = hexNibble(bytes, index, sourceOffset);
    const second = hexNibble(bytes, index + 1, sourceOffset);
    target[targetOffset + index / 2] = swapNibbles ? first | (second << 4) : (first << 4) | second;
  }
  return decodedBytes;
}

function decodeSfxRow(bytes: Uint8Array, sourceOffset: number, target: Uint8Array, row: number): void {
  requireRowLength("sfx", bytes, SFX_ROW_CHARS, sourceOffset);
  const targetOffset = row * 68;
  target[targetOffset + 64] = hexByte(bytes, 0, sourceOffset);
  target[targetOffset + 65] = hexByte(bytes, 2, sourceOffset);
  target[targetOffset + 66] = hexByte(bytes, 4, sourceOffset);
  target[targetOffset + 67] = hexByte(bytes, 6, sourceOffset);

  for (let note = 0; note < 32; note += 1) {
    const textOffset = 8 + note * 5;
    const key = hexByte(bytes, textOffset, sourceOffset);
    const waveform = hexNibble(bytes, textOffset + 2, sourceOffset);
    const volume = hexNibble(bytes, textOffset + 3, sourceOffset);
    const effect = hexNibble(bytes, textOffset + 4, sourceOffset);
    if (key > 63 || volume > 7 || effect > 7) {
      codecFailure("E_CART_TEXT_ROW", "SFX note field exceeds its packed bit width", {
        offset: sourceOffset + textOffset,
        details: { key, waveform, volume, effect },
      });
    }
    const packed =
      key |
      ((waveform & 7) << 6) |
      (volume << 9) |
      (effect << 12) |
      (waveform > 7 ? 0x8000 : 0);
    target[targetOffset + note * 2] = packed;
    target[targetOffset + note * 2 + 1] = packed >>> 8;
  }
}

function decodeMusicRow(bytes: Uint8Array, sourceOffset: number, target: Uint8Array, row: number): void {
  requireRowLength("music", bytes, MUSIC_ROW_CHARS, sourceOffset);
  if (bytes[2] !== 0x20) {
    codecFailure("E_CART_TEXT_ROW", "Music row must separate flags and channels with one space", {
      offset: sourceOffset + 2,
    });
  }
  const flags = hexByte(bytes, 0, sourceOffset);
  if (flags > 0x0f) {
    codecFailure("E_CART_TEXT_ROW", "Music flags exceed four packed bits", {
      offset: sourceOffset,
      details: { flags },
    });
  }
  const targetOffset = row * 4;
  for (let channel = 0; channel < 4; channel += 1) {
    const textOffset = 3 + channel * 2;
    const pattern = hexByte(bytes, textOffset, sourceOffset);
    if (pattern > 0x7f) {
      codecFailure("E_CART_TEXT_ROW", "Music channel pattern uses the reserved flag bit", {
        offset: sourceOffset + textOffset,
        details: { channel, pattern },
      });
    }
    target[targetOffset + channel] = pattern | (((flags >>> channel) & 1) << 7);
  }
}

function validateLabelRow(bytes: Uint8Array, sourceOffset: number): void {
  requireRowLength("label", bytes, LABEL_ROW_CHARS, sourceOffset);
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    const valid =
      (byte >= 0x30 && byte <= 0x39) ||
      (byte >= 0x61 && byte <= 0x76) ||
      (byte >= 0x41 && byte <= 0x56);
    if (!valid) {
      codecFailure("E_CART_TEXT_ROW", "Label row contains a non-base32 palette character", {
        offset: sourceOffset + index,
      });
    }
  }
}

interface IncludeDirective {
  readonly offset: number;
  readonly specifier: string;
}

function includeDirective(bytes: Uint8Array, sourceOffset: number): IncludeDirective | undefined {
  let cursor = 0;
  while (bytes[cursor] === 0x20 || bytes[cursor] === 0x09) cursor += 1;
  const directive = "#include";
  for (let index = 0; index < directive.length; index += 1) {
    if (bytes[cursor + index] !== directive.charCodeAt(index)) return undefined;
  }
  const separator = bytes[cursor + directive.length];
  if (separator !== 0x20 && separator !== 0x09) return undefined;
  let start = cursor + directive.length;
  while (bytes[start] === 0x20 || bytes[start] === 0x09) start += 1;
  let end = bytes.length;
  while (bytes[end - 1] === 0x20 || bytes[end - 1] === 0x09) end -= 1;
  if (start >= end) {
    codecFailure("E_CART_INCLUDE_UNRESOLVED", "Text cart include has no specifier", {
      offset: sourceOffset + cursor,
    });
  }
  let specifier = "";
  for (let index = start; index < end; index += 1) {
    const byte = bytes[index] ?? 0;
    if (byte < 0x20 || byte > 0x7e) {
      codecFailure("E_CART_INCLUDE_UNRESOLVED", "Text cart include specifier must be printable ASCII", {
        offset: sourceOffset + index,
      });
    }
    specifier += String.fromCharCode(byte);
  }
  return { offset: cursor, specifier };
}

function appendCode(
  output: number[],
  bytes: Uint8Array,
  line: SourceLine,
  options: P8DecodeOptions,
  limits: P8DecodeLimits,
): void {
  const include = includeDirective(bytes, line.start);
  if (include !== undefined) {
    const resolved = options.includeResolver?.(include.specifier);
    if (!(resolved instanceof Uint8Array)) {
      codecFailure("E_CART_INCLUDE_UNRESOLVED", "Text cart include requires an authorized resolver entry", {
        offset: line.start + include.offset,
      });
    }
    if (resolved.length > limits.maximumInputBytes) {
      codecFailure("E_CART_INPUT_TOO_LARGE", "Resolved include exceeds the configured input limit", {
        offset: line.start + include.offset,
        details: { inputBytes: resolved.length, maximumInputBytes: limits.maximumInputBytes },
      });
    }
    const included = scanLines(resolved, hasBom(resolved) ? UTF8_BOM.length : 0, limits.maximumLines);
    for (const includedLine of included.lines) {
      const encoded = encodeP8sciiLine(lineBytes(resolved, includedLine), line.start + include.offset);
      const terminator = includedLine.terminatorBytes > 0 ? 1 : 0;
      if (output.length + encoded.length + terminator > limits.maximumCodeBytes) {
        codecFailure("E_CART_CODE_TOO_LARGE", "Text cart code exceeds the configured byte limit", {
          offset: line.start + include.offset,
          details: { maximumCodeBytes: limits.maximumCodeBytes },
        });
      }
      for (const byte of encoded) output.push(byte);
      if (terminator > 0) output.push(0x0a);
    }
    const lastIncludedLine = included.lines.at(-1);
    if (line.terminatorBytes > 0 && lastIncludedLine?.terminatorBytes !== 1 && lastIncludedLine?.terminatorBytes !== 2) {
      if (output.length + 1 > limits.maximumCodeBytes) {
        codecFailure("E_CART_CODE_TOO_LARGE", "Text cart code exceeds the configured byte limit", {
          offset: line.start + include.offset,
          details: { maximumCodeBytes: limits.maximumCodeBytes },
        });
      }
      output.push(0x0a);
    }
    return;
  }
  const encoded = encodeP8sciiLine(bytes, line.start);
  const nextLength = output.length + encoded.length + (line.terminatorBytes > 0 ? 1 : 0);
  if (nextLength > limits.maximumCodeBytes) {
    codecFailure("E_CART_CODE_TOO_LARGE", "Text cart code exceeds the configured byte limit", {
      offset: line.start,
      details: { maximumCodeBytes: limits.maximumCodeBytes },
    });
  }
  for (const byte of encoded) output.push(byte);
  if (line.terminatorBytes > 0) output.push(0x0a);
}

export function decodeTextP8(input: Uint8Array, options: P8DecodeOptions = {}): TextP8Result {
  const limits = normalizeLimits(options);
  if (input.length > limits.maximumInputBytes) {
    codecFailure("E_CART_INPUT_TOO_LARGE", "Text cart exceeds the configured input limit", {
      details: { inputBytes: input.length, maximumInputBytes: limits.maximumInputBytes },
    });
  }
  const start = hasBom(input) ? UTF8_BOM.length : 0;
  const scanned = scanLines(input, start, limits.maximumLines);
  if (scanned.lines.length < 2) {
    codecFailure("E_CART_TEXT_HEADER", "Text cart is missing its header or version line", {
      offset: start,
    });
  }

  const headerLine = scanned.lines[0];
  const versionLine = scanned.lines[1];
  if (headerLine === undefined || versionLine === undefined) {
    codecFailure("E_CART_TEXT_HEADER", "Text cart is missing its header or version line", {
      offset: start,
    });
  }
  const header = asciiText(
    lineBytes(input, headerLine),
    headerLine.start,
    "E_CART_TEXT_HEADER",
  );
  if (header !== OFFICIAL_HEADER_PREFIX && !header.startsWith(`${OFFICIAL_HEADER_PREFIX} `)) {
    codecFailure("E_CART_TEXT_HEADER", "Text cart header does not identify a PICO-8 cartridge", {
      offset: headerLine.start,
    });
  }

  const versionText = asciiText(
    lineBytes(input, versionLine),
    versionLine.start,
    "E_CART_TEXT_VERSION",
  );
  const versionMatch = /^version ([0-9]{1,3})$/.exec(versionText);
  if (versionMatch === null) {
    codecFailure("E_CART_TEXT_VERSION", "Text cart version line is malformed", {
      offset: versionLine.start,
    });
  }
  const version = Number(versionMatch[1]);
  if (version > 255) {
    codecFailure("E_CART_TEXT_VERSION", "Text cart version is outside the byte range", {
      offset: versionLine.start + "version ".length,
      details: { version },
    });
  }
  if (version > limits.maximumCartVersion) {
    codecFailure("E_CART_FUTURE_VERSION", "Cart version is newer than the configured target", {
      offset: versionLine.start + "version ".length,
      details: { cartVersion: version, maximumCartVersion: limits.maximumCartVersion },
    });
  }

  const gfx = new Uint8Array(GFX_BYTES);
  const map = new Uint8Array(MAP_BYTES * 2);
  const gff = new Uint8Array(GFF_BYTES);
  const music = new Uint8Array(MUSIC_BYTES);
  const sfx = new Uint8Array(SFX_BYTES);
  const code: number[] = [];
  const warnings: CartWarning[] = [];
  const rows: Record<P8SectionName, number> = {
    lua: 0,
    gfx: 0,
    gff: 0,
    map: 0,
    sfx: 0,
    music: 0,
    label: 0,
  };
  const seen = new Set<P8SectionName>();
  const hexOffsets = { gfx: 0, gff: 0, map: 0 };
  let current: P8SectionName | "unknown" | undefined;

  for (let lineIndex = 2; lineIndex < scanned.lines.length; lineIndex += 1) {
    const line = scanned.lines[lineIndex];
    if (line === undefined) continue;
    const bytes = lineBytes(input, line);
    const marker = sectionMarker(bytes);
    if (marker !== undefined) {
      if (!isKnownSection(marker)) {
        warnings.push({
          code: "W_CART_UNKNOWN_SECTION",
          message: `Unknown text cart section __${marker}__ was ignored`,
          offset: line.start,
          section: marker,
        });
        current = "unknown";
      } else {
        if (seen.has(marker)) {
          codecFailure("E_CART_TEXT_SECTION", `Duplicate __${marker}__ section`, {
            offset: line.start,
            details: { section: marker },
          });
        }
        seen.add(marker);
        current = marker;
      }
      continue;
    }

    if (current === undefined) {
      if (bytes.length > 0) {
        codecFailure("E_CART_TEXT_SECTION", "Unexpected data before the first cart section", {
          offset: line.start,
        });
      }
      continue;
    }
    if (current === "unknown") continue;
    if (current === "lua") {
      appendCode(code, bytes, line, options, limits);
      rows.lua += 1;
      continue;
    }
    if (bytes.length === 0) continue;

    const row = rows[current];
    switch (current) {
      case "gfx":
        hexOffsets.gfx += decodeHexChunk(
          current, bytes, GFX_ROW_CHARS, line.start, gfx, hexOffsets.gfx, true,
        );
        break;
      case "gff":
        hexOffsets.gff += decodeHexChunk(
          current, bytes, GFF_MAP_ROW_CHARS, line.start, gff, hexOffsets.gff,
        );
        break;
      case "map":
        hexOffsets.map += decodeHexChunk(
          current, bytes, GFF_MAP_ROW_CHARS, line.start, map, hexOffsets.map,
        );
        break;
      case "sfx":
        requireCapacity(current, row, 64, line.start);
        decodeSfxRow(bytes, line.start, sfx, row);
        break;
      case "music":
        requireCapacity(current, row, 64, line.start);
        decodeMusicRow(bytes, line.start, music, row);
        break;
      case "label":
        requireCapacity(current, row, 128, line.start);
        validateLabelRow(bytes, line.start);
        break;
    }
    rows[current] += 1;
  }

  const rom = new Uint8Array(PICO_CART_ROM_SIZE);
  rom.set(gfx, GFX_OFFSET);
  for (let index = 0; index < MAP_BYTES; index += 1) {
    rom[0x1000 + index] = (rom[0x1000 + index] ?? 0) | (map[MAP_BYTES + index] ?? 0);
  }
  rom.set(map.subarray(0, MAP_BYTES), MAP_OFFSET);
  rom.set(gff, GFF_OFFSET);
  rom.set(music, MUSIC_OFFSET);
  rom.set(sfx, SFX_OFFSET);

  return {
    version,
    rom,
    code: Uint8Array.from(code),
    warnings,
    lineEndings: scanned.lineEndings,
    sectionRows: Object.freeze({ ...rows }),
  };
}
