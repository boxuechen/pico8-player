import { codecFailure } from "./errors.js";
import { inflateZlib } from "./inflate.js";

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
const CART_WIDTH = 160;
const CART_HEIGHT = 205;
const BYTES_PER_PIXEL = 4;
const SCANLINE_BYTES = CART_WIDTH * BYTES_PER_PIXEL;
const INFLATED_BYTES = CART_HEIGHT * (SCANLINE_BYTES + 1);

export interface PngLimits {
  readonly maximumInputBytes: number;
  readonly maximumChunks: number;
  readonly maximumIdatBytes: number;
  readonly maximumInflatedBytes: number;
}

export interface DecodedCartPng {
  readonly rgba: Uint8Array;
  readonly chunkCount: number;
  readonly idatBytes: number;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1_000000) +
    ((bytes[offset + 1] ?? 0) << 16) +
    ((bytes[offset + 2] ?? 0) << 8) +
    (bytes[offset + 3] ?? 0)
  ) >>> 0;
}

function chunkType(bytes: Uint8Array, offset: number): string {
  let type = "";
  for (let index = 0; index < 4; index += 1) {
    const value = bytes[offset + index] ?? 0;
    if (!((value >= 65 && value <= 90) || (value >= 97 && value <= 122))) {
      codecFailure("E_CART_PNG_ORDER", "PNG chunk type must contain ASCII letters", {
        offset,
      });
    }
    type += String.fromCharCode(value);
  }
  return type;
}

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffff_ffff;
  for (let index = start; index < end; index += 1) {
    crc ^= bytes[index] ?? 0;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 0 ? 0 : 0xedb8_8320);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function concatenate(parts: ReadonlyArray<Uint8Array>, totalBytes: number): Uint8Array {
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function paeth(left: number, up: number, upperLeft: number): number {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  return upDistance <= upperLeftDistance ? up : upperLeft;
}

function unfilter(scanlines: Uint8Array): Uint8Array {
  if (scanlines.length !== INFLATED_BYTES) {
    codecFailure("E_CART_PNG_DEFLATE", "Inflated PNG scanline length is invalid", {
      details: { actual: scanlines.length, expected: INFLATED_BYTES },
    });
  }
  const rgba = new Uint8Array(CART_WIDTH * CART_HEIGHT * BYTES_PER_PIXEL);
  let inputOffset = 0;
  for (let row = 0; row < CART_HEIGHT; row += 1) {
    const filter = scanlines[inputOffset] ?? 255;
    inputOffset += 1;
    if (filter > 4) {
      codecFailure("E_CART_PNG_FILTER", "Unsupported PNG scanline filter", {
        offset: inputOffset - 1,
        details: { filter, row },
      });
    }
    const rowOffset = row * SCANLINE_BYTES;
    for (let column = 0; column < SCANLINE_BYTES; column += 1) {
      const encoded = scanlines[inputOffset] ?? 0;
      inputOffset += 1;
      const outputOffset = rowOffset + column;
      const left = column < BYTES_PER_PIXEL ? 0 : (rgba[outputOffset - BYTES_PER_PIXEL] ?? 0);
      const up = row === 0 ? 0 : (rgba[outputOffset - SCANLINE_BYTES] ?? 0);
      const upperLeft = row === 0 || column < BYTES_PER_PIXEL
        ? 0
        : (rgba[outputOffset - SCANLINE_BYTES - BYTES_PER_PIXEL] ?? 0);
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) predictor = paeth(left, up, upperLeft);
      rgba[outputOffset] = (encoded + predictor) & 0xff;
    }
  }
  return rgba;
}

export function decodeCartPng(input: Uint8Array, limits: PngLimits): DecodedCartPng {
  if (input.length > limits.maximumInputBytes) {
    codecFailure("E_CART_INPUT_TOO_LARGE", "PNG input exceeds configured byte limit", {
      details: { actual: input.length, maximum: limits.maximumInputBytes },
    });
  }
  if (input.length < PNG_SIGNATURE.length) codecFailure("E_CART_PNG_SIGNATURE", "Truncated PNG signature");
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (input[index] !== PNG_SIGNATURE[index]) {
      codecFailure("E_CART_PNG_SIGNATURE", "Input is not a PNG file", { offset: index });
    }
  }

  let offset: number = PNG_SIGNATURE.length;
  let chunkCount = 0;
  let seenHeader = false;
  let seenPalette = false;
  let seenIdat = false;
  let idatClosed = false;
  let seenEnd = false;
  let idatBytes = 0;
  const idatParts: Uint8Array[] = [];
  while (offset < input.length) {
    if (chunkCount >= limits.maximumChunks) {
      codecFailure("E_CART_PNG_CHUNK_LIMIT", "PNG contains too many chunks", { offset });
    }
    if (input.length - offset < 12) {
      codecFailure("E_CART_PNG_TRUNCATED", "Truncated PNG chunk header", { offset });
    }
    const length = readU32(input, offset);
    const typeOffset = offset + 4;
    const type = chunkType(input, typeOffset);
    const dataOffset = offset + 8;
    const crcOffset = dataOffset + length;
    const nextOffset = crcOffset + 4;
    if (nextOffset > input.length) {
      codecFailure("E_CART_PNG_CHUNK_LENGTH", "PNG chunk length exceeds input", {
        offset,
        details: { type, length },
      });
    }
    const expectedCrc = readU32(input, crcOffset);
    const actualCrc = crc32(input, typeOffset, crcOffset);
    if (expectedCrc !== actualCrc) {
      codecFailure("E_CART_PNG_CRC", `PNG ${type} CRC mismatch`, {
        offset: crcOffset,
        details: { expected: expectedCrc, actual: actualCrc },
      });
    }
    chunkCount += 1;

    if (type === "IHDR") {
      if (seenHeader || chunkCount !== 1 || length !== 13) {
        codecFailure("E_CART_PNG_IHDR", "PNG must start with exactly one 13-byte IHDR", { offset });
      }
      seenHeader = true;
      const width = readU32(input, dataOffset);
      const height = readU32(input, dataOffset + 4);
      if (width !== CART_WIDTH || height !== CART_HEIGHT) {
        codecFailure("E_CART_PNG_DIMENSIONS", "PICO-8 cart PNG must be 160 by 205 pixels", {
          offset: dataOffset,
          details: { width, height },
        });
      }
      const bitDepth = input[dataOffset + 8] ?? -1;
      const colorType = input[dataOffset + 9] ?? -1;
      const compression = input[dataOffset + 10] ?? -1;
      const filter = input[dataOffset + 11] ?? -1;
      const interlace = input[dataOffset + 12] ?? -1;
      if (bitDepth !== 8 || colorType !== 6 || compression !== 0 || filter !== 0 || interlace !== 0) {
        codecFailure("E_CART_PNG_FORMAT", "Only non-interlaced RGBA8 cart PNGs are supported", {
          offset: dataOffset + 8,
          details: { bitDepth, colorType, compression, filter, interlace },
        });
      }
    } else if (!seenHeader) {
      codecFailure("E_CART_PNG_ORDER", "IHDR must be the first PNG chunk", { offset });
    } else if (type === "PLTE") {
      if (seenPalette || seenIdat || length === 0 || length > 768 || length % 3 !== 0) {
        codecFailure("E_CART_PNG_ORDER", "Invalid PLTE chunk", { offset });
      }
      seenPalette = true;
    } else if (type === "IDAT") {
      if (idatClosed) codecFailure("E_CART_PNG_ORDER", "IDAT chunks must be consecutive", { offset });
      seenIdat = true;
      idatBytes += length;
      if (idatBytes > limits.maximumIdatBytes) {
        codecFailure("E_CART_PNG_IDAT_LIMIT", "PNG IDAT data exceeds configured byte limit", {
          offset,
          details: { actual: idatBytes, maximum: limits.maximumIdatBytes },
        });
      }
      idatParts.push(input.subarray(dataOffset, crcOffset));
    } else if (type === "IEND") {
      if (!seenIdat || seenEnd || length !== 0) {
        codecFailure("E_CART_PNG_ORDER", "Invalid PNG IEND chunk", { offset });
      }
      seenEnd = true;
      if (nextOffset !== input.length) {
        codecFailure("E_CART_PNG_ORDER", "Trailing bytes after PNG IEND", { offset: nextOffset });
      }
    } else {
      if (seenIdat) idatClosed = true;
      const critical = ((input[typeOffset] ?? 0) & 0x20) === 0;
      if (critical) {
        codecFailure("E_CART_PNG_CRITICAL_CHUNK", `Unsupported critical PNG chunk ${type}`, {
          offset,
        });
      }
    }
    offset = nextOffset;
    if (seenEnd) break;
  }
  if (!seenHeader || !seenIdat || !seenEnd) {
    codecFailure("E_CART_PNG_ORDER", "PNG is missing IHDR, IDAT, or IEND");
  }
  const compressed = concatenate(idatParts, idatBytes);
  const scanlines = inflateZlib(compressed, INFLATED_BYTES, limits.maximumInflatedBytes);
  return { rgba: unfilter(scanlines), chunkCount, idatBytes };
}
