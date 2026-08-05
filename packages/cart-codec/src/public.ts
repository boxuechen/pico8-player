import {
  PICO8_0_2_7_CART_VERSION,
  PICO_CART_ROM_SIZE,
} from "@pico8-web/contracts";

import { decodeP8Code, type P8CodeCompression } from "./code.js";
import {
  CART_CODEC_ERROR_CODES,
  CartCodecError,
  type CartCodecErrorCode,
  type CartCodecErrorDetails,
  codecFailure,
} from "./errors.js";
import {
  createParsedCart,
  type CartFormat,
  type CartIdentity,
  type CartWarning,
  type CartWarningCode,
  type ParsedCart,
} from "./model.js";
import {
  DEFAULT_P8_LIMITS,
  P8_SECTION_NAMES,
  decodeTextP8,
  type P8DecodeLimits,
  type P8DecodeOptions,
  type P8LineEndings,
  type P8SectionName,
} from "./p8.js";
import { decodeCartPng } from "./png.js";

export {
  CART_CODEC_ERROR_CODES,
  CartCodecError,
  DEFAULT_P8_LIMITS,
  P8_SECTION_NAMES,
};
export type {
  CartCodecErrorCode,
  CartCodecErrorDetails,
  CartFormat,
  CartIdentity,
  CartWarning,
  CartWarningCode,
  P8CodeCompression,
  P8DecodeLimits,
  P8DecodeOptions,
  P8LineEndings,
  P8SectionName,
  ParsedCart,
};

export const P8PNG_WIDTH = 160 as const;
export const P8PNG_HEIGHT = 205 as const;
export const P8PNG_PAYLOAD_BYTES = 0x8020 as const;
export const P8PNG_USED_PAYLOAD_BYTES = 0x8001 as const;
export const P8PNG_CODE_OFFSET = 0x4300 as const;

export interface P8PngDecodeLimits {
  readonly maximumInputBytes: number;
  readonly maximumChunks: number;
  readonly maximumIdatBytes: number;
  readonly maximumInflatedBytes: number;
  readonly maximumCodeBytes: number;
  readonly maximumCartVersion: number;
}

export const DEFAULT_P8PNG_LIMITS: Readonly<P8PngDecodeLimits> = Object.freeze({
  maximumInputBytes: 1_048_576,
  maximumChunks: 128,
  maximumIdatBytes: 262_144,
  maximumInflatedBytes: P8PNG_HEIGHT * (P8PNG_WIDTH * 4 + 1),
  maximumCodeBytes: 65_535,
  maximumCartVersion: PICO8_0_2_7_CART_VERSION,
});

export interface P8PngDecodeOptions {
  readonly limits?: Partial<P8PngDecodeLimits>;
}

export interface DecodedP8PngCart extends ParsedCart {
  readonly format: "p8.png";
  readonly width: typeof P8PNG_WIDTH;
  readonly height: typeof P8PNG_HEIGHT;
  readonly codeCompression: P8CodeCompression;
  readonly declaredCodeBytes: number;
  readonly compressedCodeBytes: number;
  readonly pngChunkCount: number;
  readonly pngIdatBytes: number;
}

export interface DecodedP8Cart extends ParsedCart {
  readonly format: "p8";
  readonly lineEndings: P8LineEndings;
  readonly sectionRows: Readonly<Record<P8SectionName, number>>;
}

export interface CartDecodeOptions {
  readonly p8?: P8DecodeOptions;
  readonly p8Png?: P8PngDecodeOptions;
}

function positiveInteger(name: string, value: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    codecFailure("E_CART_LIMITS", `${name} must be a positive safe integer`, {
      details: { name, value, maximum },
    });
  }
  return value;
}

function nonNegativeInteger(name: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    codecFailure("E_CART_LIMITS", `${name} must be a non-negative safe integer`, {
      details: { name, value, maximum },
    });
  }
  return value;
}

function normalizeLimits(options: P8PngDecodeOptions): P8PngDecodeLimits {
  const candidate = { ...DEFAULT_P8PNG_LIMITS, ...options.limits };
  return {
    maximumInputBytes: positiveInteger("maximumInputBytes", candidate.maximumInputBytes),
    maximumChunks: positiveInteger("maximumChunks", candidate.maximumChunks, 65_535),
    maximumIdatBytes: positiveInteger("maximumIdatBytes", candidate.maximumIdatBytes),
    maximumInflatedBytes: positiveInteger("maximumInflatedBytes", candidate.maximumInflatedBytes),
    maximumCodeBytes: positiveInteger("maximumCodeBytes", candidate.maximumCodeBytes, 65_535),
    maximumCartVersion: nonNegativeInteger("maximumCartVersion", candidate.maximumCartVersion, 255),
  };
}

function extractPayload(rgba: Uint8Array): Uint8Array {
  if (rgba.length !== P8PNG_WIDTH * P8PNG_HEIGHT * 4) {
    codecFailure("E_CART_PAYLOAD", "RGBA byte length does not match cart dimensions");
  }
  const payload = new Uint8Array(P8PNG_PAYLOAD_BYTES);
  for (let pixel = 0; pixel < payload.length; pixel += 1) {
    const offset = pixel * 4;
    const red = rgba[offset] ?? 0;
    const green = rgba[offset + 1] ?? 0;
    const blue = rgba[offset + 2] ?? 0;
    const alpha = rgba[offset + 3] ?? 0;
    payload[pixel] =
      ((alpha & 3) << 6) |
      ((red & 3) << 4) |
      ((green & 3) << 2) |
      (blue & 3);
  }
  return payload;
}

export function decodeP8Png(
  input: Uint8Array,
  options: P8PngDecodeOptions = {},
): DecodedP8PngCart {
  if (!(input instanceof Uint8Array)) {
    codecFailure("E_CART_ARGUMENT", "decodeP8Png expects Uint8Array input");
  }
  const limits = normalizeLimits(options);
  const png = decodeCartPng(input, limits);
  const payload = extractPayload(png.rgba);
  const cartVersion = payload[PICO_CART_ROM_SIZE] ?? 0;
  if (cartVersion > limits.maximumCartVersion) {
    codecFailure("E_CART_FUTURE_VERSION", "Cart version is newer than the configured target", {
      details: { cartVersion, maximumCartVersion: limits.maximumCartVersion },
    });
  }
  const rom = payload.slice(0, PICO_CART_ROM_SIZE);
  const code = decodeP8Code(rom.subarray(P8PNG_CODE_OFFSET), limits.maximumCodeBytes);
  return createParsedCart(input, {
    format: "p8.png",
    version: cartVersion,
    rom,
    code: code.bytes,
  }, {
    width: P8PNG_WIDTH,
    height: P8PNG_HEIGHT,
    codeCompression: code.compression,
    declaredCodeBytes: code.declaredBytes,
    compressedCodeBytes: code.compressedBytes,
    pngChunkCount: png.chunkCount,
    pngIdatBytes: png.idatBytes,
  });
}

export function decodeP8(
  input: Uint8Array,
  options: P8DecodeOptions = {},
): DecodedP8Cart {
  if (!(input instanceof Uint8Array)) {
    codecFailure("E_CART_ARGUMENT", "decodeP8 expects Uint8Array input");
  }
  const decoded = decodeTextP8(input, options);
  return createParsedCart(input, {
    format: "p8",
    version: decoded.version,
    rom: decoded.rom,
    code: decoded.code,
    warnings: decoded.warnings,
  }, {
    lineEndings: decoded.lineEndings,
    sectionRows: decoded.sectionRows,
  });
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const TEXT_MAGIC = "pico-8 cartridge";

function hasBytes(input: Uint8Array, expected: readonly number[], offset = 0): boolean {
  return expected.every((byte, index) => input[offset + index] === byte);
}

function hasTextMagic(input: Uint8Array): boolean {
  const offset = hasBytes(input, [0xef, 0xbb, 0xbf]) ? 3 : 0;
  for (let index = 0; index < TEXT_MAGIC.length; index += 1) {
    if (input[offset + index] !== TEXT_MAGIC.charCodeAt(index)) return false;
  }
  return true;
}

/** Detect a supported cart from raw bytes without trusting names or media types. */
export function decodeCart(
  input: Uint8Array,
  options: CartDecodeOptions = {},
): ParsedCart {
  if (!(input instanceof Uint8Array)) {
    codecFailure("E_CART_ARGUMENT", "decodeCart expects Uint8Array input");
  }
  if (hasBytes(input, PNG_SIGNATURE)) return decodeP8Png(input, options.p8Png ?? {});
  if (hasTextMagic(input)) return decodeP8(input, options.p8 ?? {});
  codecFailure("E_CART_FORMAT", "Cart bytes do not match a supported format", { offset: 0 });
}
