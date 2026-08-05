import { codecFailure } from "./errors.js";

class BitReader {
  readonly #bytes: Uint8Array;
  #bitOffset = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  get bitOffset(): number {
    return this.#bitOffset;
  }

  read(count: number): number {
    if (count < 0 || count > 24 || this.#bitOffset + count > this.#bytes.length * 8) {
      codecFailure("E_CART_PNG_DEFLATE", "Truncated DEFLATE bitstream", {
        offset: this.#bitOffset >>> 3,
      });
    }
    let value = 0;
    for (let bit = 0; bit < count; bit += 1) {
      const byte = this.#bytes[this.#bitOffset >>> 3] ?? 0;
      value |= ((byte >>> (this.#bitOffset & 7)) & 1) << bit;
      this.#bitOffset += 1;
    }
    return value >>> 0;
  }

  alignToByte(): void {
    this.#bitOffset = (this.#bitOffset + 7) & ~7;
  }
}

class BoundedOutput {
  readonly #bytes: Uint8Array;
  #length = 0;

  constructor(expectedLength: number, maximumLength: number) {
    if (expectedLength > maximumLength) {
      codecFailure("E_CART_PNG_INFLATE_LIMIT", "Inflated PNG exceeds configured output limit", {
        details: { expectedLength, maximumLength },
      });
    }
    this.#bytes = new Uint8Array(expectedLength);
  }

  get length(): number {
    return this.#length;
  }

  write(value: number): void {
    if (this.#length >= this.#bytes.length) {
      codecFailure("E_CART_PNG_INFLATE_LIMIT", "DEFLATE output exceeds expected PNG size");
    }
    this.#bytes[this.#length] = value;
    this.#length += 1;
  }

  copy(distance: number, length: number): void {
    if (distance <= 0 || distance > this.#length) {
      codecFailure("E_CART_PNG_DEFLATE", "Invalid DEFLATE back-reference distance", {
        details: { distance, outputLength: this.#length },
      });
    }
    if (this.#length + length > this.#bytes.length) {
      codecFailure("E_CART_PNG_INFLATE_LIMIT", "DEFLATE back-reference exceeds expected PNG size");
    }
    for (let index = 0; index < length; index += 1) {
      this.write(this.#bytes[this.#length - distance] ?? 0);
    }
  }

  finish(): Uint8Array {
    if (this.#length !== this.#bytes.length) {
      codecFailure("E_CART_PNG_DEFLATE", "DEFLATE output length does not match PNG dimensions", {
        details: { actual: this.#length, expected: this.#bytes.length },
      });
    }
    return this.#bytes;
  }
}

interface HuffmanTable {
  readonly byLength: ReadonlyArray<ReadonlyMap<number, number>>;
  readonly maximumBits: number;
}

function reverseBits(value: number, count: number): number {
  let reversed = 0;
  for (let bit = 0; bit < count; bit += 1) {
    reversed = (reversed << 1) | ((value >>> bit) & 1);
  }
  return reversed >>> 0;
}

function buildHuffman(codeLengths: ArrayLike<number>, label: string): HuffmanTable {
  const counts = new Uint16Array(16);
  let maximumBits = 0;
  let populated = 0;
  for (let symbol = 0; symbol < codeLengths.length; symbol += 1) {
    const length = codeLengths[symbol] ?? 0;
    if (length < 0 || length > 15) {
      codecFailure("E_CART_PNG_DEFLATE", `Invalid ${label} Huffman code length`);
    }
    if (length > 0) {
      counts[length] = (counts[length] ?? 0) + 1;
      maximumBits = Math.max(maximumBits, length);
      populated += 1;
    }
  }
  if (populated === 0) {
    codecFailure("E_CART_PNG_DEFLATE", `Empty ${label} Huffman tree`);
  }

  let remaining = 1;
  for (let bits = 1; bits <= 15; bits += 1) {
    remaining = (remaining << 1) - (counts[bits] ?? 0);
    if (remaining < 0) {
      codecFailure("E_CART_PNG_DEFLATE", `Oversubscribed ${label} Huffman tree`);
    }
  }

  const nextCode = new Uint16Array(16);
  let code = 0;
  for (let bits = 1; bits <= 15; bits += 1) {
    code = (code + (counts[bits - 1] ?? 0)) << 1;
    nextCode[bits] = code;
  }
  const byLength = Array.from({ length: 16 }, () => new Map<number, number>());
  for (let symbol = 0; symbol < codeLengths.length; symbol += 1) {
    const length = codeLengths[symbol] ?? 0;
    if (length === 0) continue;
    const canonical = nextCode[length] ?? 0;
    nextCode[length] = canonical + 1;
    byLength[length]?.set(reverseBits(canonical, length), symbol);
  }
  return { byLength, maximumBits };
}

function readHuffman(reader: BitReader, table: HuffmanTable): number {
  let code = 0;
  for (let length = 1; length <= table.maximumBits; length += 1) {
    code |= reader.read(1) << (length - 1);
    const symbol = table.byLength[length]?.get(code);
    if (symbol !== undefined) return symbol;
  }
  codecFailure("E_CART_PNG_DEFLATE", "Invalid Huffman symbol", {
    offset: reader.bitOffset >>> 3,
  });
}

const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51,
  59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
] as const;
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4,
  4, 4, 5, 5, 5, 5, 0,
] as const;
const DISTANCE_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385,
  513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
] as const;
const DISTANCE_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9,
  10, 10, 11, 11, 12, 12, 13, 13,
] as const;

function fixedTables(): { literal: HuffmanTable; distance: HuffmanTable } {
  const literalLengths = new Uint8Array(288);
  literalLengths.fill(8, 0, 144);
  literalLengths.fill(9, 144, 256);
  literalLengths.fill(7, 256, 280);
  literalLengths.fill(8, 280);
  const distanceLengths = new Uint8Array(32);
  distanceLengths.fill(5);
  return {
    literal: buildHuffman(literalLengths, "fixed literal/length"),
    distance: buildHuffman(distanceLengths, "fixed distance"),
  };
}

function dynamicTables(reader: BitReader): { literal: HuffmanTable; distance: HuffmanTable | null } {
  const literalCount = reader.read(5) + 257;
  const distanceCount = reader.read(5) + 1;
  const codeLengthCount = reader.read(4) + 4;
  const order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15] as const;
  const codeLengthLengths = new Uint8Array(19);
  for (let index = 0; index < codeLengthCount; index += 1) {
    const symbol = order[index];
    if (symbol === undefined) codecFailure("E_CART_PNG_DEFLATE", "Invalid code-length alphabet");
    codeLengthLengths[symbol] = reader.read(3);
  }
  const codeLengthTable = buildHuffman(codeLengthLengths, "code-length");
  const total = literalCount + distanceCount;
  const lengths: number[] = [];
  while (lengths.length < total) {
    const symbol = readHuffman(reader, codeLengthTable);
    if (symbol <= 15) {
      lengths.push(symbol);
      continue;
    }
    let repeat: number;
    let value: number;
    if (symbol === 16) {
      if (lengths.length === 0) codecFailure("E_CART_PNG_DEFLATE", "Repeat code has no previous length");
      repeat = reader.read(2) + 3;
      value = lengths[lengths.length - 1] ?? 0;
    } else if (symbol === 17) {
      repeat = reader.read(3) + 3;
      value = 0;
    } else if (symbol === 18) {
      repeat = reader.read(7) + 11;
      value = 0;
    } else {
      codecFailure("E_CART_PNG_DEFLATE", "Invalid code-length repeat symbol");
    }
    if (lengths.length + repeat > total) {
      codecFailure("E_CART_PNG_DEFLATE", "Code-length repeat exceeds dynamic tree size");
    }
    for (let index = 0; index < repeat; index += 1) lengths.push(value);
  }
  const literalLengths = lengths.slice(0, literalCount);
  if ((literalLengths[256] ?? 0) === 0) {
    codecFailure("E_CART_PNG_DEFLATE", "Dynamic literal tree is missing end-of-block");
  }
  const distanceLengths = lengths.slice(literalCount);
  const distance = distanceLengths.some((length) => length !== 0)
    ? buildHuffman(distanceLengths, "dynamic distance")
    : null;
  return { literal: buildHuffman(literalLengths, "dynamic literal/length"), distance };
}

function inflateCompressed(
  reader: BitReader,
  output: BoundedOutput,
  literal: HuffmanTable,
  distance: HuffmanTable | null,
): void {
  for (;;) {
    const symbol = readHuffman(reader, literal);
    if (symbol < 256) {
      output.write(symbol);
      continue;
    }
    if (symbol === 256) return;
    if (symbol < 257 || symbol > 285) {
      codecFailure("E_CART_PNG_DEFLATE", "Reserved DEFLATE length symbol");
    }
    const lengthIndex = symbol - 257;
    const lengthBase = LENGTH_BASE[lengthIndex];
    const lengthExtra = LENGTH_EXTRA[lengthIndex];
    if (lengthBase === undefined || lengthExtra === undefined) {
      codecFailure("E_CART_PNG_DEFLATE", "Invalid DEFLATE length symbol");
    }
    const length = lengthBase + reader.read(lengthExtra);
    if (distance === null) {
      codecFailure("E_CART_PNG_DEFLATE", "Length symbol used without a distance alphabet");
    }
    const distanceSymbol = readHuffman(reader, distance);
    const distanceBase = DISTANCE_BASE[distanceSymbol];
    const distanceExtra = DISTANCE_EXTRA[distanceSymbol];
    if (distanceBase === undefined || distanceExtra === undefined) {
      codecFailure("E_CART_PNG_DEFLATE", "Reserved DEFLATE distance symbol");
    }
    output.copy(distanceBase + reader.read(distanceExtra), length);
  }
}

function readBigEndianU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1_000000) +
    ((bytes[offset + 1] ?? 0) << 16) +
    ((bytes[offset + 2] ?? 0) << 8) +
    (bytes[offset + 3] ?? 0)
  ) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let first = 1;
  let second = 0;
  for (let offset = 0; offset < bytes.length; offset += 5_552) {
    const end = Math.min(offset + 5_552, bytes.length);
    for (let index = offset; index < end; index += 1) {
      first += bytes[index] ?? 0;
      second += first;
    }
    first %= 65_521;
    second %= 65_521;
  }
  return ((second << 16) | first) >>> 0;
}

export function inflateZlib(
  input: Uint8Array,
  expectedOutputBytes: number,
  maximumOutputBytes: number,
): Uint8Array {
  if (input.length < 6) codecFailure("E_CART_PNG_ZLIB", "Truncated zlib stream");
  const cmf = input[0] ?? 0;
  const flags = input[1] ?? 0;
  if ((cmf & 0x0f) !== 8 || (cmf >>> 4) > 7 || ((cmf << 8) | flags) % 31 !== 0) {
    codecFailure("E_CART_PNG_ZLIB", "Invalid zlib header");
  }
  if ((flags & 0x20) !== 0) codecFailure("E_CART_PNG_ZLIB", "Preset zlib dictionaries are unsupported");

  const deflate = input.subarray(2, input.length - 4);
  const reader = new BitReader(deflate);
  const output = new BoundedOutput(expectedOutputBytes, maximumOutputBytes);
  let finalBlock = false;
  while (!finalBlock) {
    finalBlock = reader.read(1) === 1;
    const blockType = reader.read(2);
    if (blockType === 0) {
      reader.alignToByte();
      const length = reader.read(16);
      const complement = reader.read(16);
      if (((length ^ 0xffff) & 0xffff) !== complement) {
        codecFailure("E_CART_PNG_DEFLATE", "Stored DEFLATE block length check failed");
      }
      for (let index = 0; index < length; index += 1) output.write(reader.read(8));
    } else if (blockType === 1) {
      const tables = fixedTables();
      inflateCompressed(reader, output, tables.literal, tables.distance);
    } else if (blockType === 2) {
      const tables = dynamicTables(reader);
      inflateCompressed(reader, output, tables.literal, tables.distance);
    } else {
      codecFailure("E_CART_PNG_DEFLATE", "Reserved DEFLATE block type");
    }
  }
  if (Math.ceil(reader.bitOffset / 8) !== deflate.length) {
    codecFailure("E_CART_PNG_DEFLATE", "Trailing bytes after final DEFLATE block");
  }
  const bytes = output.finish();
  const expectedAdler = readBigEndianU32(input, input.length - 4);
  const actualAdler = adler32(bytes);
  if (actualAdler !== expectedAdler) {
    codecFailure("E_CART_PNG_ZLIB", "zlib Adler-32 mismatch", {
      details: { expected: expectedAdler, actual: actualAdler },
    });
  }
  return bytes;
}
