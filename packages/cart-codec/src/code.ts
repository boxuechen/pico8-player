import { codecFailure } from "./errors.js";

const LEGACY_LOOKUP = "\n 0123456789abcdefghijklmnopqrstuvwxyz!#%(){}[]<>+=/*:;.,~_";

export type P8CodeCompression = "raw" | "legacy" | "pxa";

export interface DecodedP8Code {
  readonly compression: P8CodeCompression;
  readonly bytes: Uint8Array;
  readonly declaredBytes: number;
  readonly compressedBytes: number;
}

function bigEndianU16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function trimAtNul(bytes: Uint8Array): Uint8Array {
  const nul = bytes.indexOf(0);
  return nul === -1 ? bytes : bytes.slice(0, nul);
}

function checkOutputLimit(length: number, maximumCodeBytes: number): void {
  if (length > maximumCodeBytes) {
    codecFailure("E_CART_CODE_TOO_LARGE", "Decoded Lua source exceeds configured byte limit", {
      details: { declared: length, maximum: maximumCodeBytes },
    });
  }
}

function decodeLegacy(input: Uint8Array, maximumCodeBytes: number): DecodedP8Code {
  const declaredBytes = bigEndianU16(input, 4);
  checkOutputLimit(declaredBytes, maximumCodeBytes);
  if ((input[6] ?? 0) !== 0 || (input[7] ?? 0) !== 0) {
    codecFailure("E_CART_CODE_CORRUPT", "Legacy code header reserved bytes must be zero");
  }
  const output = new Uint8Array(declaredBytes);
  let outputOffset = 0;
  let inputOffset = 8;
  while (outputOffset < declaredBytes) {
    if (inputOffset >= input.length) {
      codecFailure("E_CART_CODE_CORRUPT", "Truncated legacy code stream");
    }
    const token = input[inputOffset] ?? 0;
    inputOffset += 1;
    if (token === 0) {
      if (inputOffset >= input.length) codecFailure("E_CART_CODE_CORRUPT", "Truncated legacy literal");
      output[outputOffset] = input[inputOffset] ?? 0;
      outputOffset += 1;
      inputOffset += 1;
    } else if (token < 0x3c) {
      const character = LEGACY_LOOKUP.charCodeAt(token - 1);
      if (!Number.isFinite(character)) codecFailure("E_CART_CODE_CORRUPT", "Invalid legacy lookup token");
      output[outputOffset] = character;
      outputOffset += 1;
    } else {
      if (inputOffset >= input.length) codecFailure("E_CART_CODE_CORRUPT", "Truncated legacy back-reference");
      const second = input[inputOffset] ?? 0;
      inputOffset += 1;
      const distance = (token - 0x3c) * 16 + (second & 0x0f);
      const length = (second >>> 4) + 2;
      if (distance <= 0 || distance > outputOffset) {
        codecFailure("E_CART_CODE_CORRUPT", "Invalid legacy back-reference distance", {
          details: { distance, outputOffset },
        });
      }
      if (outputOffset + length > declaredBytes) {
        codecFailure("E_CART_CODE_CORRUPT", "Legacy back-reference exceeds declared output length");
      }
      for (let index = 0; index < length; index += 1) {
        output[outputOffset] = output[outputOffset - distance] ?? 0;
        outputOffset += 1;
      }
    }
  }
  return {
    compression: "legacy",
    bytes: trimAtNul(output),
    declaredBytes,
    compressedBytes: inputOffset,
  };
}

class PxaBitReader {
  readonly #bytes: Uint8Array;
  readonly #bitLimit: number;
  #position = 64;

  constructor(bytes: Uint8Array, compressedBytes: number) {
    this.#bytes = bytes;
    this.#bitLimit = compressedBytes * 8;
  }

  read(count: number): number {
    if (count < 0 || count > 24 || this.#position + count > this.#bitLimit) {
      codecFailure("E_CART_CODE_CORRUPT", "Truncated PXA bitstream", {
        offset: this.#position >>> 3,
      });
    }
    let value = 0;
    for (let bit = 0; bit < count; bit += 1) {
      const byte = this.#bytes[this.#position >>> 3] ?? 0;
      value |= ((byte >>> (this.#position & 7)) & 1) << bit;
      this.#position += 1;
    }
    return value >>> 0;
  }
}

function decodePxa(input: Uint8Array, maximumCodeBytes: number): DecodedP8Code {
  const declaredBytes = bigEndianU16(input, 4);
  const compressedBytes = bigEndianU16(input, 6);
  checkOutputLimit(declaredBytes, maximumCodeBytes);
  if (compressedBytes < 8 || compressedBytes > input.length) {
    codecFailure("E_CART_CODE_CORRUPT", "PXA compressed length is outside the code block", {
      details: { compressedBytes, codeBlockBytes: input.length },
    });
  }
  const reader = new PxaBitReader(input, compressedBytes);
  const output = new Uint8Array(declaredBytes);
  let outputOffset = 0;
  const moveToFront = Array.from({ length: 256 }, (_, index) => index);
  const write = (value: number): void => {
    if (outputOffset >= output.length) {
      codecFailure("E_CART_CODE_CORRUPT", "PXA stream exceeds declared output length");
    }
    output[outputOffset] = value;
    outputOffset += 1;
  };

  while (outputOffset < declaredBytes) {
    if (reader.read(1) === 1) {
      let bitCount = 4;
      while (reader.read(1) === 1) {
        bitCount += 1;
        if (bitCount > 8) codecFailure("E_CART_CODE_CORRUPT", "PXA move-to-front index is too large");
      }
      const index = reader.read(bitCount) + (2 ** bitCount) - 16;
      if (index < 0 || index >= moveToFront.length) {
        codecFailure("E_CART_CODE_CORRUPT", "Invalid PXA move-to-front index", { details: { index } });
      }
      const character = moveToFront[index];
      if (character === undefined) codecFailure("E_CART_CODE_CORRUPT", "Missing PXA move-to-front value");
      moveToFront.splice(index, 1);
      moveToFront.unshift(character);
      if (character === 0) codecFailure("E_CART_CODE_CORRUPT", "PXA terminator precedes declared output length");
      write(character);
    } else {
      const distanceBits = reader.read(1) === 0 ? 15 : reader.read(1) === 0 ? 10 : 5;
      const distance = reader.read(distanceBits) + 1;
      if (distanceBits === 10 && distance === 1) {
        for (;;) {
          const character = reader.read(8);
          if (character === 0) break;
          write(character);
        }
      } else {
        let length = 3;
        let group: number;
        do {
          group = reader.read(3);
          length += group;
          if (length > declaredBytes) codecFailure("E_CART_CODE_CORRUPT", "PXA match length exceeds output limit");
        } while (group === 7);
        if (distance <= 0 || distance > outputOffset || outputOffset + length > declaredBytes) {
          codecFailure("E_CART_CODE_CORRUPT", "Invalid PXA back-reference", {
            details: { distance, length, outputOffset },
          });
        }
        for (let index = 0; index < length; index += 1) {
          write(output[outputOffset - distance] ?? 0);
        }
      }
    }
  }
  return { compression: "pxa", bytes: output, declaredBytes, compressedBytes };
}

export function decodeP8Code(input: Uint8Array, maximumCodeBytes: number): DecodedP8Code {
  if (input.length < 8) codecFailure("E_CART_CODE_CORRUPT", "Code block is too short");
  if (input[0] === 0 && input[1] === 0x70 && input[2] === 0x78 && input[3] === 0x61) {
    return decodePxa(input, maximumCodeBytes);
  }
  if (input[0] === 0x3a && input[1] === 0x63 && input[2] === 0x3a && input[3] === 0) {
    return decodeLegacy(input, maximumCodeBytes);
  }
  const bytes = trimAtNul(input).slice();
  checkOutputLimit(bytes.length, maximumCodeBytes);
  return {
    compression: "raw",
    bytes,
    declaredBytes: bytes.length,
    compressedBytes: bytes.length + (bytes.length < input.length ? 1 : 0),
  };
}
