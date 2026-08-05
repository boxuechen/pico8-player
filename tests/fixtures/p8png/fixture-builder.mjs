import { constants as zlibConstants, deflateSync } from "node:zlib";

export const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
export const WIDTH = 160;
export const HEIGHT = 205;
export const ROM_BYTES = 0x8000;
export const PAYLOAD_BYTES = 0x8020;
export const CODE_OFFSET = 0x4300;

export function bytesFromHex(hex) {
  if (!/^(?:[0-9a-f]{2})*$/u.test(hex)) throw new Error(`Invalid fixture hex: ${hex}`);
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function crc32(bytes) {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 0 ? 0 : 0xedb8_8320);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function u32(value) {
  return Uint8Array.from([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function ascii(text) {
  return Uint8Array.from([...text].map((character) => character.charCodeAt(0)));
}

export function makeChunk(type, data = new Uint8Array()) {
  const typeBytes = ascii(type);
  const crcInput = new Uint8Array(typeBytes.length + data.length);
  crcInput.set(typeBytes);
  crcInput.set(data, typeBytes.length);
  const result = new Uint8Array(12 + data.length);
  result.set(u32(data.length), 0);
  result.set(typeBytes, 4);
  result.set(data, 8);
  result.set(u32(crc32(crcInput)), 8 + data.length);
  return result;
}

function join(parts) {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

class BitWriter {
  bytes = Array(8).fill(0);
  position = 64;

  write(count, value) {
    for (let bit = 0; bit < count; bit += 1) {
      const byteIndex = this.position >>> 3;
      while (this.bytes.length <= byteIndex) this.bytes.push(0);
      this.bytes[byteIndex] |= ((value >>> bit) & 1) << (this.position & 7);
      this.position += 1;
    }
  }

  finish(codeLength) {
    const compressedLength = Math.ceil(this.position / 8);
    this.bytes[0] = 0;
    this.bytes[1] = 0x70;
    this.bytes[2] = 0x78;
    this.bytes[3] = 0x61;
    this.bytes[4] = (codeLength >>> 8) & 0xff;
    this.bytes[5] = codeLength & 0xff;
    this.bytes[6] = (compressedLength >>> 8) & 0xff;
    this.bytes[7] = compressedLength & 0xff;
    return Uint8Array.from(this.bytes.slice(0, compressedLength));
  }
}

class DeflateBitWriter {
  bytes = [];
  position = 0;

  write(count, value) {
    for (let bit = 0; bit < count; bit += 1) {
      const byteIndex = this.position >>> 3;
      while (this.bytes.length <= byteIndex) this.bytes.push(0);
      this.bytes[byteIndex] |= ((value >>> bit) & 1) << (this.position & 7);
      this.position += 1;
    }
  }

  finish() {
    return Uint8Array.from(this.bytes);
  }
}

function writePxaMtf(writer, moveToFront, character) {
  const index = moveToFront.indexOf(character);
  if (index <= 0) throw new Error("PXA fixture MTF only emits non-zero symbols");
  let bitCount = 4;
  while (index > (2 ** (bitCount + 1)) - 17) bitCount += 1;
  writer.write(1, 1);
  for (let index = 4; index < bitCount; index += 1) writer.write(1, 1);
  writer.write(1, 0);
  writer.write(bitCount, index - (2 ** bitCount) + 16);
  moveToFront.splice(index, 1);
  moveToFront.unshift(character);
}

function makePxaBackrefCode(code) {
  const expected = bytesFromHex("616263616263");
  if (!Buffer.from(code).equals(Buffer.from(expected))) {
    throw new Error("The synthetic PXA vector is intentionally fixed to abcabc");
  }
  const writer = new BitWriter();
  const moveToFront = Array.from({ length: 256 }, (_, index) => index);
  for (const character of expected.subarray(0, 3)) writePxaMtf(writer, moveToFront, character);
  writer.write(1, 0);
  writer.write(1, 1);
  writer.write(1, 1);
  writer.write(5, 2);
  writer.write(3, 0);
  return writer.finish(expected.length);
}

export function makePxaLiteralCode(code) {
  if (code.includes(0)) throw new Error("PXA literal sequence uses zero as its terminator");
  const writer = new BitWriter();
  writer.write(1, 0);
  writer.write(1, 1);
  writer.write(1, 0);
  writer.write(10, 0);
  for (const character of code) writer.write(8, character);
  writer.write(8, 0);
  return writer.finish(code.length);
}

function makeLegacyBackrefCode(code) {
  const expected = bytesFromHex("616263616263616263");
  if (!Buffer.from(code).equals(Buffer.from(expected))) {
    throw new Error("The synthetic legacy vector is intentionally fixed to abcabcabc");
  }
  return Uint8Array.from([
    0x3a, 0x63, 0x3a, 0,
    0, expected.length,
    0, 0,
    0, 0x61, 0, 0x62, 0, 0x63,
    0x3c, 0x43,
  ]);
}

export function makeCodeBlock(vector, override) {
  const block = new Uint8Array(ROM_BYTES - CODE_OFFSET);
  if (override) {
    block.set(override.subarray(0, block.length));
    return block;
  }
  const code = bytesFromHex(vector.codeHex);
  if (vector.compression === "raw") {
    block.set(code);
    block[code.length] = 0;
  } else if (vector.compression === "legacy") {
    block.set(makeLegacyBackrefCode(code));
  } else if (vector.compression === "pxa") {
    block.set(makePxaBackrefCode(code));
  } else {
    throw new Error(`Unknown fixture compression: ${vector.compression}`);
  }
  return block;
}

export function makeRom(vector, codeBlockOverride) {
  const rom = new Uint8Array(ROM_BYTES);
  for (let index = 0; index < CODE_OFFSET; index += 1) {
    rom[index] = (Math.imul(index, vector.romPatternSeed) + 23) & 0xff;
  }
  rom.set(makeCodeBlock(vector, codeBlockOverride), CODE_OFFSET);
  return rom;
}

function makeRgba(payload, highBitsVariant) {
  const rgba = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel += 1) {
    const byte = payload[pixel] ?? ((pixel * 31 + 7) & 0xff);
    const offset = pixel * 4;
    rgba[offset] = ((pixel * (13 + highBitsVariant) + 0x80) & 0xfc) | ((byte >>> 4) & 3);
    rgba[offset + 1] = ((pixel * (29 + highBitsVariant) + 0x40) & 0xfc) | ((byte >>> 2) & 3);
    rgba[offset + 2] = ((pixel * (47 + highBitsVariant) + 0x20) & 0xfc) | (byte & 3);
    rgba[offset + 3] = ((pixel * (7 + highBitsVariant) + 0xfc) & 0xfc) | ((byte >>> 6) & 3);
  }
  return rgba;
}

function paeth(left, up, upperLeft) {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  return upDistance <= upperLeftDistance ? up : upperLeft;
}

function filteredScanlines(rgba, mode, invalidFilter = false) {
  const rowBytes = WIDTH * 4;
  const output = new Uint8Array(HEIGHT * (rowBytes + 1));
  for (let row = 0; row < HEIGHT; row += 1) {
    const filter = invalidFilter
      ? row === 0 ? 5 : 0
      : mode === "cycle" ? row % 5 : mode === "sub" ? 1 : mode === "paeth" ? 4 : 0;
    const outputRow = row * (rowBytes + 1);
    output[outputRow] = filter;
    for (let column = 0; column < rowBytes; column += 1) {
      const sourceOffset = row * rowBytes + column;
      const value = rgba[sourceOffset] ?? 0;
      const left = column < 4 ? 0 : (rgba[sourceOffset - 4] ?? 0);
      const up = row === 0 ? 0 : (rgba[sourceOffset - rowBytes] ?? 0);
      const upperLeft = row === 0 || column < 4 ? 0 : (rgba[sourceOffset - rowBytes - 4] ?? 0);
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) predictor = paeth(left, up, upperLeft);
      output[outputRow + 1 + column] = (value - predictor) & 0xff;
    }
  }
  return output;
}

function makeIhdr(overrides = {}) {
  const data = new Uint8Array(13);
  data.set(u32(overrides.width ?? WIDTH), 0);
  data.set(u32(overrides.height ?? HEIGHT), 4);
  data[8] = overrides.bitDepth ?? 8;
  data[9] = overrides.colorType ?? 6;
  data[10] = overrides.compression ?? 0;
  data[11] = overrides.filter ?? 0;
  data[12] = overrides.interlace ?? 0;
  return data;
}

function deflateOptions(mode) {
  if (mode === "stored") return { level: 0 };
  if (mode === "fixed") return { level: 6, strategy: zlibConstants.Z_FIXED };
  return { level: 9 };
}

export function makeP8Png(vector, options = {}) {
  const rom = makeRom(vector, options.codeBlockOverride);
  const payload = new Uint8Array(PAYLOAD_BYTES);
  payload.set(rom);
  payload[ROM_BYTES] = options.cartVersion ?? vector.cartVersion;
  for (let index = ROM_BYTES + 1; index < payload.length; index += 1) payload[index] = (index * 19) & 0xff;
  const rgba = makeRgba(payload, options.highBitsVariant ?? 0);
  const scanlines = filteredScanlines(rgba, vector.filterMode, options.invalidFilter);
  const inflateInput = options.inflateSuffixBytes
    ? join([scanlines, new Uint8Array(options.inflateSuffixBytes)])
    : scanlines;
  let compressed = Uint8Array.from(deflateSync(inflateInput, deflateOptions(vector.zlibMode)));
  if (options.mutateZlib) compressed = options.mutateZlib(compressed);
  const ihdr = makeChunk("IHDR", makeIhdr(options.ihdr));
  const text = makeChunk("tEXt", ascii("phase0d\0project-owned"));
  const idatChunks = [];
  if (vector.splitIdat && compressed.length > 3) {
    const first = Math.floor(compressed.length / 3);
    const second = Math.floor((compressed.length * 2) / 3);
    idatChunks.push(makeChunk("IDAT", compressed.subarray(0, first)));
    idatChunks.push(makeChunk("IDAT", compressed.subarray(first, second)));
    idatChunks.push(makeChunk("IDAT", compressed.subarray(second)));
  } else {
    idatChunks.push(makeChunk("IDAT", compressed));
  }
  const chunks = [ihdr, text, ...idatChunks, makeChunk("IEND")];
  if (options.insertChunk) chunks.splice(options.insertChunk.index, 0, options.insertChunk.chunk);
  const png = join([PNG_SIGNATURE, ...chunks]);
  return {
    png,
    rom,
    code: bytesFromHex(vector.codeHex),
    compressed,
    deflateBlockType: ((compressed[2] ?? 0) >>> 1) & 3,
  };
}

export function makeLiteralOnlyDynamicPng() {
  const writer = new DeflateBitWriter();
  writer.write(1, 1); // BFINAL
  writer.write(2, 2); // dynamic Huffman
  writer.write(5, 0); // 257 literal/length symbols
  writer.write(5, 0); // one distance symbol, encoded with length zero
  writer.write(4, 14); // 18 code-length symbols
  const codeLengthCodeLengths = [0, 0, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2];
  for (const length of codeLengthCodeLengths) writer.write(3, length);

  writer.write(2, 3); // literal/length symbol 0 has length 1
  writer.write(1, 0); // repeat 138 zero lengths
  writer.write(7, 127);
  writer.write(1, 0); // repeat another 117 zero lengths
  writer.write(7, 106);
  writer.write(2, 3); // end-of-block symbol 256 has length 1
  writer.write(2, 1); // the sole distance symbol has length zero

  const inflatedBytes = HEIGHT * (WIDTH * 4 + 1);
  for (let index = 0; index < inflatedBytes; index += 1) writer.write(1, 0);
  writer.write(1, 1); // end-of-block
  const zlib = join([
    Uint8Array.of(0x78, 0x01),
    writer.finish(),
    Uint8Array.of(0x01, 0x6b, 0, 1), // Adler-32 of 131,405 zero bytes
  ]);
  return join([
    PNG_SIGNATURE,
    makeChunk("IHDR", makeIhdr()),
    makeChunk("IDAT", zlib),
    makeChunk("IEND"),
  ]);
}

export function corruptByte(bytes, offset, value = ((bytes[offset] ?? 0) ^ 1)) {
  const result = bytes.slice();
  result[offset] = value;
  return result;
}

export function chunkOffsets(png) {
  const chunks = [];
  let offset = 8;
  while (offset < png.length) {
    const length = ((png[offset] ?? 0) * 0x1_000000) + ((png[offset + 1] ?? 0) << 16) + ((png[offset + 2] ?? 0) << 8) + (png[offset + 3] ?? 0);
    const type = Buffer.from(png.subarray(offset + 4, offset + 8)).toString("ascii");
    chunks.push({ offset, type, length, dataOffset: offset + 8, crcOffset: offset + 8 + length });
    offset += 12 + length;
  }
  return chunks;
}
