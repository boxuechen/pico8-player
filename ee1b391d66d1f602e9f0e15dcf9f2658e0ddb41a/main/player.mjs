// packages/contracts/dist/public.js
var PICO_RAM_SIZE = 65536;
var PICO_CART_ROM_SIZE = 32768;
var PICO_CART_DATA_ROM_SIZE = 17152;
var PICO8_0_2_7_CART_VERSION = 43;
var PICO_CONTROLLER_COUNT = 8;
var PICO_CONTROLLER_BUTTON_COUNT = 6;
var PICO_CONTROLLER_BUTTON_MASK = 63;
var PICO_DEVKIT_KEYPRESS_BATCH_LIMIT = 64;
var PICO_CART_DATA_BYTES = 256;
var PICO_CART_DATA_MAX_RECORDS = 4096;
var PICO_CART_DATA_NUMBER_COUNT = 64;
var PICO_CART_DATA_ID_MAX_BYTES = 64;
var PICO_CART_INPUT_MAX_BYTES = 1048576;
var PICO_CART_REF_MAX_BYTES = 256;
var PICO_LOCAL_CART_BUNDLE_MAX_ENTRIES = 64;
var PICO_HOST_REQUEST_MAX_BYTES = 4096;
var PICO_EMPTY_INPUT = Object.freeze({
  controllers: Object.freeze(new Array(PICO_CONTROLLER_COUNT).fill(0)),
  devkit: Object.freeze({
    mouseXRaw: 0,
    mouseYRaw: 0,
    mouseButtons: 0,
    wheelRaw: 0,
    movementXRaw: 0,
    movementYRaw: 0,
    keypresses: Object.freeze([])
  })
});

// packages/cart-codec/dist/errors.js
var CartCodecError = class extends Error {
  name = "CartCodecError";
  code;
  offset;
  details;
  constructor(code, message2, options = {}) {
    super(message2);
    this.code = code;
    if (options.offset !== void 0)
      this.offset = options.offset;
    if (options.details !== void 0)
      this.details = options.details;
  }
};
function codecFailure(code, message2, options = {}) {
  throw new CartCodecError(code, message2, options);
}

// packages/cart-codec/dist/code.js
var LEGACY_LOOKUP = "\n 0123456789abcdefghijklmnopqrstuvwxyz!#%(){}[]<>+=/*:;.,~_";
function bigEndianU16(bytes, offset) {
  return (bytes[offset] ?? 0) << 8 | (bytes[offset + 1] ?? 0);
}
function trimAtNul(bytes) {
  const nul = bytes.indexOf(0);
  return nul === -1 ? bytes : bytes.slice(0, nul);
}
function checkOutputLimit(length, maximumCodeBytes) {
  if (length > maximumCodeBytes) {
    codecFailure("E_CART_CODE_TOO_LARGE", "Decoded Lua source exceeds configured byte limit", {
      details: { declared: length, maximum: maximumCodeBytes }
    });
  }
}
function decodeLegacy(input, maximumCodeBytes) {
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
      if (inputOffset >= input.length)
        codecFailure("E_CART_CODE_CORRUPT", "Truncated legacy literal");
      output[outputOffset] = input[inputOffset] ?? 0;
      outputOffset += 1;
      inputOffset += 1;
    } else if (token < 60) {
      const character = LEGACY_LOOKUP.charCodeAt(token - 1);
      if (!Number.isFinite(character))
        codecFailure("E_CART_CODE_CORRUPT", "Invalid legacy lookup token");
      output[outputOffset] = character;
      outputOffset += 1;
    } else {
      if (inputOffset >= input.length)
        codecFailure("E_CART_CODE_CORRUPT", "Truncated legacy back-reference");
      const second = input[inputOffset] ?? 0;
      inputOffset += 1;
      const distance = (token - 60) * 16 + (second & 15);
      const length = (second >>> 4) + 2;
      if (distance <= 0 || distance > outputOffset) {
        codecFailure("E_CART_CODE_CORRUPT", "Invalid legacy back-reference distance", {
          details: { distance, outputOffset }
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
    compressedBytes: inputOffset
  };
}
var PxaBitReader = class {
  #bytes;
  #bitLimit;
  #position = 64;
  constructor(bytes, compressedBytes) {
    this.#bytes = bytes;
    this.#bitLimit = compressedBytes * 8;
  }
  read(count) {
    if (count < 0 || count > 24 || this.#position + count > this.#bitLimit) {
      codecFailure("E_CART_CODE_CORRUPT", "Truncated PXA bitstream", {
        offset: this.#position >>> 3
      });
    }
    let value = 0;
    for (let bit = 0; bit < count; bit += 1) {
      const byte = this.#bytes[this.#position >>> 3] ?? 0;
      value |= (byte >>> (this.#position & 7) & 1) << bit;
      this.#position += 1;
    }
    return value >>> 0;
  }
};
function decodePxa(input, maximumCodeBytes) {
  const declaredBytes = bigEndianU16(input, 4);
  const compressedBytes = bigEndianU16(input, 6);
  checkOutputLimit(declaredBytes, maximumCodeBytes);
  if (compressedBytes < 8 || compressedBytes > input.length) {
    codecFailure("E_CART_CODE_CORRUPT", "PXA compressed length is outside the code block", {
      details: { compressedBytes, codeBlockBytes: input.length }
    });
  }
  const reader = new PxaBitReader(input, compressedBytes);
  const output = new Uint8Array(declaredBytes);
  let outputOffset = 0;
  const moveToFront = Array.from({ length: 256 }, (_, index) => index);
  const write = (value) => {
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
        if (bitCount > 8)
          codecFailure("E_CART_CODE_CORRUPT", "PXA move-to-front index is too large");
      }
      const index = reader.read(bitCount) + 2 ** bitCount - 16;
      if (index < 0 || index >= moveToFront.length) {
        codecFailure("E_CART_CODE_CORRUPT", "Invalid PXA move-to-front index", { details: { index } });
      }
      const character = moveToFront[index];
      if (character === void 0)
        codecFailure("E_CART_CODE_CORRUPT", "Missing PXA move-to-front value");
      moveToFront.splice(index, 1);
      moveToFront.unshift(character);
      if (character === 0)
        codecFailure("E_CART_CODE_CORRUPT", "PXA terminator precedes declared output length");
      write(character);
    } else {
      const distanceBits = reader.read(1) === 0 ? 15 : reader.read(1) === 0 ? 10 : 5;
      const distance = reader.read(distanceBits) + 1;
      if (distanceBits === 10 && distance === 1) {
        for (; ; ) {
          const character = reader.read(8);
          if (character === 0)
            break;
          write(character);
        }
      } else {
        let length = 3;
        let group;
        do {
          group = reader.read(3);
          length += group;
          if (length > declaredBytes)
            codecFailure("E_CART_CODE_CORRUPT", "PXA match length exceeds output limit");
        } while (group === 7);
        if (distance <= 0 || distance > outputOffset || outputOffset + length > declaredBytes) {
          codecFailure("E_CART_CODE_CORRUPT", "Invalid PXA back-reference", {
            details: { distance, length, outputOffset }
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
function decodeP8Code(input, maximumCodeBytes) {
  if (input.length < 8)
    codecFailure("E_CART_CODE_CORRUPT", "Code block is too short");
  if (input[0] === 0 && input[1] === 112 && input[2] === 120 && input[3] === 97) {
    return decodePxa(input, maximumCodeBytes);
  }
  if (input[0] === 58 && input[1] === 99 && input[2] === 58 && input[3] === 0) {
    return decodeLegacy(input, maximumCodeBytes);
  }
  const bytes = trimAtNul(input).slice();
  checkOutputLimit(bytes.length, maximumCodeBytes);
  return {
    compression: "raw",
    bytes,
    declaredBytes: bytes.length,
    compressedBytes: bytes.length + (bytes.length < input.length ? 1 : 0)
  };
}

// packages/cart-codec/dist/sha256.js
var ROUND_CONSTANTS = Uint32Array.from([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
function rotateRight(value, bits) {
  return value >>> bits | value << 32 - bits;
}
function sha256Hex(input) {
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 128;
  const bitLength = input.length * 8;
  const high = Math.floor(bitLength / 4294967296);
  const low = bitLength >>> 0;
  const lengthOffset = padded.length - 8;
  padded[lengthOffset] = high >>> 24;
  padded[lengthOffset + 1] = high >>> 16;
  padded[lengthOffset + 2] = high >>> 8;
  padded[lengthOffset + 3] = high;
  padded[lengthOffset + 4] = low >>> 24;
  padded[lengthOffset + 5] = low >>> 16;
  padded[lengthOffset + 6] = low >>> 8;
  padded[lengthOffset + 7] = low;
  const state = Uint32Array.from([
    1779033703,
    3144134277,
    1013904242,
    2773480762,
    1359893119,
    2600822924,
    528734635,
    1541459225
  ]);
  const words = new Uint32Array(64);
  for (let block = 0; block < padded.length; block += 64) {
    for (let index = 0; index < 16; index += 1) {
      const offset = block + index * 4;
      words[index] = (padded[offset] ?? 0) << 24 | (padded[offset + 1] ?? 0) << 16 | (padded[offset + 2] ?? 0) << 8 | (padded[offset + 3] ?? 0);
    }
    for (let index = 16; index < 64; index += 1) {
      const word15 = words[index - 15] ?? 0;
      const word2 = words[index - 2] ?? 0;
      const sigma0 = rotateRight(word15, 7) ^ rotateRight(word15, 18) ^ word15 >>> 3;
      const sigma1 = rotateRight(word2, 17) ^ rotateRight(word2, 19) ^ word2 >>> 10;
      words[index] = (words[index - 16] ?? 0) + sigma0 + (words[index - 7] ?? 0) + sigma1 >>> 0;
    }
    let a = state[0] ?? 0;
    let b = state[1] ?? 0;
    let c = state[2] ?? 0;
    let d = state[3] ?? 0;
    let e = state[4] ?? 0;
    let f = state[5] ?? 0;
    let g = state[6] ?? 0;
    let h = state[7] ?? 0;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = e & f ^ ~e & g;
      const temporary1 = h + sum1 + choose + (ROUND_CONSTANTS[index] ?? 0) + (words[index] ?? 0) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = a & b ^ a & c ^ b & c;
      const temporary2 = sum0 + majority >>> 0;
      h = g;
      g = f;
      f = e;
      e = d + temporary1 >>> 0;
      d = c;
      c = b;
      b = a;
      a = temporary1 + temporary2 >>> 0;
    }
    state[0] = (state[0] ?? 0) + a >>> 0;
    state[1] = (state[1] ?? 0) + b >>> 0;
    state[2] = (state[2] ?? 0) + c >>> 0;
    state[3] = (state[3] ?? 0) + d >>> 0;
    state[4] = (state[4] ?? 0) + e >>> 0;
    state[5] = (state[5] ?? 0) + f >>> 0;
    state[6] = (state[6] ?? 0) + g >>> 0;
    state[7] = (state[7] ?? 0) + h >>> 0;
  }
  return Array.from(state, (word) => word.toString(16).padStart(8, "0")).join("");
}

// packages/cart-codec/dist/model.js
function createParsedCart(input, fields, metadata) {
  const rom = fields.rom.slice();
  const code = fields.code.slice();
  const warnings = Object.freeze((fields.warnings ?? []).map((warning) => Object.freeze({ ...warning })));
  const identity = Object.freeze({ contentSha256: sha256Hex(input) });
  return Object.freeze({
    ...metadata,
    identity,
    format: fields.format,
    version: fields.version,
    rom,
    code,
    warnings,
    sourceBytes: input.length
  });
}

// packages/cart-codec/dist/p8scii.js
var UNICODE_TO_P8SCII = /* @__PURE__ */ new Map();
function mapGlyphs(start, glyphs) {
  let code = start;
  for (const glyph of glyphs) {
    const codePoint = glyph.codePointAt(0);
    if (codePoint !== void 0)
      UNICODE_TO_P8SCII.set(codePoint, code);
    code += 1;
  }
}
mapGlyphs(1, "\xB9\xB2\xB3\u2074\u2075\u2076\u2077\u2078");
UNICODE_TO_P8SCII.set("\u1D47".codePointAt(0) ?? 0, 11);
UNICODE_TO_P8SCII.set("\u1D9C".codePointAt(0) ?? 0, 12);
UNICODE_TO_P8SCII.set("\u1D49".codePointAt(0) ?? 0, 14);
UNICODE_TO_P8SCII.set("\u1DA0".codePointAt(0) ?? 0, 15);
mapGlyphs(16, "\u25AE\u25A0\u25A1\u2059\u2058\u2016\u25C0\u25B6\u300C\u300D\xA5\u2022\u3001\u3002\u309B\u309C");
UNICODE_TO_P8SCII.set("\u25CB".codePointAt(0) ?? 0, 127);
mapGlyphs(128, "\u2588\u2592\u{1F431}\u2B07\u2591\u273D\u25CF\u2665\u2609\uC6C3\u2302\u2B05\u{1F610}\u266A\u{1F17E}\u25C6\u2026\u27A1\u2605\u29D7\u2B06\u02C7\u2227\u274E\u25A4\u25A5\u3042\u3044\u3046\u3048\u304A\u304B\u304D\u304F\u3051\u3053\u3055\u3057\u3059\u305B\u305D\u305F\u3061\u3064\u3066\u3068\u306A\u306B\u306C\u306D\u306E\u306F\u3072\u3075\u3078\u307B\u307E\u307F\u3080\u3081\u3082\u3084\u3086\u3088\u3089\u308A\u308B\u308C\u308D\u308F\u3092\u3093\u3063\u3083\u3085\u3087\u30A2\u30A4\u30A6\u30A8\u30AA\u30AB\u30AD\u30AF\u30B1\u30B3\u30B5\u30B7\u30B9\u30BB\u30BD\u30BF\u30C1\u30C4\u30C6\u30C8\u30CA\u30CB\u30CC\u30CD\u30CE\u30CF\u30D2\u30D5\u30D8\u30DB\u30DE\u30DF\u30E0\u30E1\u30E2\u30E4\u30E6\u30E8\u30E9\u30EA\u30EB\u30EC\u30ED\u30EF\u30F2\u30F3\u30C3\u30E3\u30E5\u30E7\u25DC\u25DD");
var VARIATION_SELECTOR_BYTES = [239, 184, 143];
var VARIATION_GLYPHS = /* @__PURE__ */ new Set([11015, 11013, 127358, 10145, 11014]);
function isContinuation(value) {
  return (value & 192) === 128;
}
function decodeCodePoint(input, index, sourceOffset) {
  const first = input[index] ?? 0;
  let length;
  let codePoint;
  let minimum;
  if (first >= 194 && first <= 223) {
    length = 2;
    codePoint = first & 31;
    minimum = 128;
  } else if (first >= 224 && first <= 239) {
    length = 3;
    codePoint = first & 15;
    minimum = 2048;
  } else if (first >= 240 && first <= 244) {
    length = 4;
    codePoint = first & 7;
    minimum = 65536;
  } else {
    codecFailure("E_CART_TEXT_ENCODING", "Invalid UTF-8 leading byte", {
      offset: sourceOffset + index
    });
  }
  if (index + length > input.length) {
    codecFailure("E_CART_TEXT_ENCODING", "Truncated UTF-8 sequence", {
      offset: sourceOffset + index
    });
  }
  for (let cursor = 1; cursor < length; cursor += 1) {
    const byte = input[index + cursor] ?? 0;
    if (!isContinuation(byte)) {
      codecFailure("E_CART_TEXT_ENCODING", "Invalid UTF-8 continuation byte", {
        offset: sourceOffset + index + cursor
      });
    }
    codePoint = codePoint << 6 | byte & 63;
  }
  if (codePoint < minimum || codePoint > 1114111 || codePoint >= 55296 && codePoint <= 57343) {
    codecFailure("E_CART_TEXT_ENCODING", "Invalid UTF-8 scalar value", {
      offset: sourceOffset + index
    });
  }
  return { codePoint, length };
}
function hasVariationSelector(input, index) {
  return VARIATION_SELECTOR_BYTES.every((byte, offset) => input[index + offset] === byte);
}
function encodeP8sciiLine(input, sourceOffset) {
  const output = [];
  for (let index = 0; index < input.length; ) {
    const byte = input[index] ?? 0;
    if (byte < 128) {
      if (byte !== 9 && (byte < 32 || byte === 127)) {
        codecFailure("E_CART_TEXT_ENCODING", "Control byte is not valid external cart text", {
          offset: sourceOffset + index
        });
      }
      output.push(byte);
      index += 1;
      continue;
    }
    const decoded = decodeCodePoint(input, index, sourceOffset);
    const mapped = UNICODE_TO_P8SCII.get(decoded.codePoint);
    if (mapped === void 0) {
      codecFailure("E_CART_TEXT_ENCODING", "Unicode scalar is not representable in P8SCII", {
        offset: sourceOffset + index,
        details: { codePoint: decoded.codePoint }
      });
    }
    output.push(mapped);
    index += decoded.length;
    if (VARIATION_GLYPHS.has(decoded.codePoint) && hasVariationSelector(input, index)) {
      index += VARIATION_SELECTOR_BYTES.length;
    }
  }
  return Uint8Array.from(output);
}

// packages/cart-codec/dist/p8.js
var UTF8_BOM = [239, 187, 191];
var OFFICIAL_HEADER_PREFIX = "pico-8 cartridge";
var GFX_OFFSET = 0;
var GFX_BYTES = 8192;
var MAP_OFFSET = 8192;
var MAP_BYTES = 4096;
var GFF_OFFSET = 12288;
var GFF_BYTES = 256;
var MUSIC_OFFSET = 12544;
var MUSIC_BYTES = 256;
var SFX_OFFSET = 12800;
var SFX_BYTES = 4352;
var GFX_ROW_CHARS = 128;
var GFF_MAP_ROW_CHARS = 256;
var SFX_ROW_CHARS = 168;
var MUSIC_ROW_CHARS = 11;
var LABEL_ROW_CHARS = 128;
var P8_SECTION_NAMES = [
  "lua",
  "gfx",
  "gff",
  "map",
  "sfx",
  "music",
  "label"
];
var DEFAULT_P8_LIMITS = Object.freeze({
  maximumInputBytes: 1048576,
  maximumCodeBytes: 65535,
  maximumLines: 32768,
  maximumCartVersion: PICO8_0_2_7_CART_VERSION
});
function positiveInteger(name, value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    codecFailure("E_CART_LIMITS", `${name} must be a positive safe integer`, {
      details: { name, value }
    });
  }
  return value;
}
function nonNegativeByte(name, value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 255) {
    codecFailure("E_CART_LIMITS", `${name} must be an integer from 0 to 255`, {
      details: { name, value }
    });
  }
  return value;
}
function normalizeLimits(options) {
  const candidate = { ...DEFAULT_P8_LIMITS, ...options.limits };
  return {
    maximumInputBytes: positiveInteger("maximumInputBytes", candidate.maximumInputBytes),
    maximumCodeBytes: positiveInteger("maximumCodeBytes", candidate.maximumCodeBytes),
    maximumLines: positiveInteger("maximumLines", candidate.maximumLines),
    maximumCartVersion: nonNegativeByte("maximumCartVersion", candidate.maximumCartVersion)
  };
}
function hasBom(input) {
  return UTF8_BOM.every((byte, index) => input[index] === byte);
}
function scanLines(input, start, maximumLines) {
  const lines = [];
  let lf = 0;
  let crlf = 0;
  let cursor = start;
  while (cursor < input.length) {
    if (lines.length >= maximumLines) {
      codecFailure("E_CART_TEXT_CAPACITY", "Text cart exceeds the configured line limit", {
        offset: cursor,
        details: { maximumLines }
      });
    }
    const lineStart = cursor;
    while (cursor < input.length && input[cursor] !== 10 && input[cursor] !== 13) {
      cursor += 1;
    }
    const lineEnd = cursor;
    let terminatorBytes = 0;
    if (cursor < input.length) {
      if (input[cursor] === 10) {
        terminatorBytes = 1;
        lf += 1;
        cursor += 1;
      } else if (input[cursor + 1] === 10) {
        terminatorBytes = 2;
        crlf += 1;
        cursor += 2;
      } else {
        codecFailure("E_CART_TEXT_LINE_ENDING", "Lone CR is not a valid cart line ending", {
          offset: cursor
        });
      }
    }
    lines.push({ start: lineStart, end: lineEnd, terminatorBytes });
  }
  return {
    lines,
    lineEndings: lf > 0 && crlf > 0 ? "mixed" : crlf > 0 ? "crlf" : lf > 0 ? "lf" : "none"
  };
}
function lineBytes(input, line) {
  return input.subarray(line.start, line.end);
}
function asciiText(bytes, offset, code) {
  let result = "";
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    if (byte > 127 || byte === 0) {
      codecFailure(code, "Cart structure line must be ASCII", { offset: offset + index });
    }
    result += String.fromCharCode(byte);
  }
  return result;
}
function sectionMarker(bytes) {
  if (bytes.length < 5 || bytes[0] !== 95 || bytes[1] !== 95 || bytes[bytes.length - 2] !== 95 || bytes[bytes.length - 1] !== 95) {
    return void 0;
  }
  let name = "";
  for (let index = 2; index < bytes.length - 2; index += 1) {
    const byte = bytes[index] ?? 0;
    const valid = byte >= 48 && byte <= 57 || byte >= 65 && byte <= 90 || byte === 45 || byte === 46 || byte === 58 || byte === 95 || byte >= 97 && byte <= 122;
    if (!valid)
      return void 0;
    name += String.fromCharCode(byte);
  }
  return name;
}
function isKnownSection(name) {
  return P8_SECTION_NAMES.includes(name);
}
function hexNibble(bytes, index, sourceOffset) {
  const byte = bytes[index] ?? 0;
  if (byte >= 48 && byte <= 57)
    return byte - 48;
  if (byte >= 97 && byte <= 102)
    return byte - 97 + 10;
  if (byte >= 65 && byte <= 70)
    return byte - 65 + 10;
  codecFailure("E_CART_TEXT_ROW", "Section row contains a non-hex character", {
    offset: sourceOffset + index
  });
}
function hexByte(bytes, index, sourceOffset) {
  return hexNibble(bytes, index, sourceOffset) << 4 | hexNibble(bytes, index + 1, sourceOffset);
}
function requireRowLength(section, bytes, expected, sourceOffset) {
  if (bytes.length !== expected) {
    codecFailure("E_CART_TEXT_ROW", `__${section}__ row has an invalid encoded width`, {
      offset: sourceOffset,
      details: { section, actualChars: bytes.length, expectedChars: expected }
    });
  }
}
function requireCapacity(section, row, maximumRows, sourceOffset) {
  if (row >= maximumRows) {
    codecFailure("E_CART_TEXT_CAPACITY", `__${section}__ exceeds its row capacity`, {
      offset: sourceOffset,
      details: { section, maximumRows }
    });
  }
}
function decodeHexChunk(section, bytes, maximumChars, sourceOffset, target, targetOffset, swapNibbles = false) {
  if (bytes.length < 2 || bytes.length > maximumChars || bytes.length % 2 !== 0) {
    codecFailure("E_CART_TEXT_ROW", `__${section}__ row has an invalid encoded width`, {
      offset: sourceOffset,
      details: { section, actualChars: bytes.length, maximumChars }
    });
  }
  const decodedBytes = bytes.length / 2;
  if (targetOffset + decodedBytes > target.length) {
    codecFailure("E_CART_TEXT_CAPACITY", `__${section}__ exceeds its byte capacity`, {
      offset: sourceOffset,
      details: { section, maximumBytes: target.length }
    });
  }
  for (let index = 0; index < bytes.length; index += 2) {
    const first = hexNibble(bytes, index, sourceOffset);
    const second = hexNibble(bytes, index + 1, sourceOffset);
    target[targetOffset + index / 2] = swapNibbles ? first | second << 4 : first << 4 | second;
  }
  return decodedBytes;
}
function decodeSfxRow(bytes, sourceOffset, target, row) {
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
        details: { key, waveform, volume, effect }
      });
    }
    const packed = key | (waveform & 7) << 6 | volume << 9 | effect << 12 | (waveform > 7 ? 32768 : 0);
    target[targetOffset + note * 2] = packed;
    target[targetOffset + note * 2 + 1] = packed >>> 8;
  }
}
function decodeMusicRow(bytes, sourceOffset, target, row) {
  requireRowLength("music", bytes, MUSIC_ROW_CHARS, sourceOffset);
  if (bytes[2] !== 32) {
    codecFailure("E_CART_TEXT_ROW", "Music row must separate flags and channels with one space", {
      offset: sourceOffset + 2
    });
  }
  const flags = hexByte(bytes, 0, sourceOffset);
  if (flags > 15) {
    codecFailure("E_CART_TEXT_ROW", "Music flags exceed four packed bits", {
      offset: sourceOffset,
      details: { flags }
    });
  }
  const targetOffset = row * 4;
  for (let channel = 0; channel < 4; channel += 1) {
    const textOffset = 3 + channel * 2;
    const pattern = hexByte(bytes, textOffset, sourceOffset);
    if (pattern > 127) {
      codecFailure("E_CART_TEXT_ROW", "Music channel pattern uses the reserved flag bit", {
        offset: sourceOffset + textOffset,
        details: { channel, pattern }
      });
    }
    target[targetOffset + channel] = pattern | (flags >>> channel & 1) << 7;
  }
}
function validateLabelRow(bytes, sourceOffset) {
  requireRowLength("label", bytes, LABEL_ROW_CHARS, sourceOffset);
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    const valid = byte >= 48 && byte <= 57 || byte >= 97 && byte <= 118 || byte >= 65 && byte <= 86;
    if (!valid) {
      codecFailure("E_CART_TEXT_ROW", "Label row contains a non-base32 palette character", {
        offset: sourceOffset + index
      });
    }
  }
}
function includeDirective(bytes, sourceOffset) {
  let cursor = 0;
  while (bytes[cursor] === 32 || bytes[cursor] === 9)
    cursor += 1;
  const directive = "#include";
  for (let index = 0; index < directive.length; index += 1) {
    if (bytes[cursor + index] !== directive.charCodeAt(index))
      return void 0;
  }
  const separator = bytes[cursor + directive.length];
  if (separator !== 32 && separator !== 9)
    return void 0;
  let start = cursor + directive.length;
  while (bytes[start] === 32 || bytes[start] === 9)
    start += 1;
  let end = bytes.length;
  while (bytes[end - 1] === 32 || bytes[end - 1] === 9)
    end -= 1;
  if (start >= end) {
    codecFailure("E_CART_INCLUDE_UNRESOLVED", "Text cart include has no specifier", {
      offset: sourceOffset + cursor
    });
  }
  let specifier = "";
  for (let index = start; index < end; index += 1) {
    const byte = bytes[index] ?? 0;
    if (byte < 32 || byte > 126) {
      codecFailure("E_CART_INCLUDE_UNRESOLVED", "Text cart include specifier must be printable ASCII", {
        offset: sourceOffset + index
      });
    }
    specifier += String.fromCharCode(byte);
  }
  return { offset: cursor, specifier };
}
function appendCode(output, bytes, line, options, limits) {
  const include = includeDirective(bytes, line.start);
  if (include !== void 0) {
    const resolved = options.includeResolver?.(include.specifier);
    if (!(resolved instanceof Uint8Array)) {
      codecFailure("E_CART_INCLUDE_UNRESOLVED", "Text cart include requires an authorized resolver entry", {
        offset: line.start + include.offset
      });
    }
    if (resolved.length > limits.maximumInputBytes) {
      codecFailure("E_CART_INPUT_TOO_LARGE", "Resolved include exceeds the configured input limit", {
        offset: line.start + include.offset,
        details: { inputBytes: resolved.length, maximumInputBytes: limits.maximumInputBytes }
      });
    }
    const included = scanLines(resolved, hasBom(resolved) ? UTF8_BOM.length : 0, limits.maximumLines);
    for (const includedLine of included.lines) {
      const encoded2 = encodeP8sciiLine(lineBytes(resolved, includedLine), line.start + include.offset);
      const terminator = includedLine.terminatorBytes > 0 ? 1 : 0;
      if (output.length + encoded2.length + terminator > limits.maximumCodeBytes) {
        codecFailure("E_CART_CODE_TOO_LARGE", "Text cart code exceeds the configured byte limit", {
          offset: line.start + include.offset,
          details: { maximumCodeBytes: limits.maximumCodeBytes }
        });
      }
      for (const byte of encoded2)
        output.push(byte);
      if (terminator > 0)
        output.push(10);
    }
    const lastIncludedLine = included.lines.at(-1);
    if (line.terminatorBytes > 0 && lastIncludedLine?.terminatorBytes !== 1 && lastIncludedLine?.terminatorBytes !== 2) {
      if (output.length + 1 > limits.maximumCodeBytes) {
        codecFailure("E_CART_CODE_TOO_LARGE", "Text cart code exceeds the configured byte limit", {
          offset: line.start + include.offset,
          details: { maximumCodeBytes: limits.maximumCodeBytes }
        });
      }
      output.push(10);
    }
    return;
  }
  const encoded = encodeP8sciiLine(bytes, line.start);
  const nextLength = output.length + encoded.length + (line.terminatorBytes > 0 ? 1 : 0);
  if (nextLength > limits.maximumCodeBytes) {
    codecFailure("E_CART_CODE_TOO_LARGE", "Text cart code exceeds the configured byte limit", {
      offset: line.start,
      details: { maximumCodeBytes: limits.maximumCodeBytes }
    });
  }
  for (const byte of encoded)
    output.push(byte);
  if (line.terminatorBytes > 0)
    output.push(10);
}
function decodeTextP8(input, options = {}) {
  const limits = normalizeLimits(options);
  if (input.length > limits.maximumInputBytes) {
    codecFailure("E_CART_INPUT_TOO_LARGE", "Text cart exceeds the configured input limit", {
      details: { inputBytes: input.length, maximumInputBytes: limits.maximumInputBytes }
    });
  }
  const start = hasBom(input) ? UTF8_BOM.length : 0;
  const scanned = scanLines(input, start, limits.maximumLines);
  if (scanned.lines.length < 2) {
    codecFailure("E_CART_TEXT_HEADER", "Text cart is missing its header or version line", {
      offset: start
    });
  }
  const headerLine = scanned.lines[0];
  const versionLine = scanned.lines[1];
  if (headerLine === void 0 || versionLine === void 0) {
    codecFailure("E_CART_TEXT_HEADER", "Text cart is missing its header or version line", {
      offset: start
    });
  }
  const header = asciiText(lineBytes(input, headerLine), headerLine.start, "E_CART_TEXT_HEADER");
  if (header !== OFFICIAL_HEADER_PREFIX && !header.startsWith(`${OFFICIAL_HEADER_PREFIX} `)) {
    codecFailure("E_CART_TEXT_HEADER", "Text cart header does not identify a PICO-8 cartridge", {
      offset: headerLine.start
    });
  }
  const versionText = asciiText(lineBytes(input, versionLine), versionLine.start, "E_CART_TEXT_VERSION");
  const versionMatch = /^version ([0-9]{1,3})$/.exec(versionText);
  if (versionMatch === null) {
    codecFailure("E_CART_TEXT_VERSION", "Text cart version line is malformed", {
      offset: versionLine.start
    });
  }
  const version = Number(versionMatch[1]);
  if (version > 255) {
    codecFailure("E_CART_TEXT_VERSION", "Text cart version is outside the byte range", {
      offset: versionLine.start + "version ".length,
      details: { version }
    });
  }
  if (version > limits.maximumCartVersion) {
    codecFailure("E_CART_FUTURE_VERSION", "Cart version is newer than the configured target", {
      offset: versionLine.start + "version ".length,
      details: { cartVersion: version, maximumCartVersion: limits.maximumCartVersion }
    });
  }
  const gfx = new Uint8Array(GFX_BYTES);
  const map = new Uint8Array(MAP_BYTES * 2);
  const gff = new Uint8Array(GFF_BYTES);
  const music = new Uint8Array(MUSIC_BYTES);
  const sfx = new Uint8Array(SFX_BYTES);
  for (let row = 0; row < 64; row += 1) {
    const musicOffset = row * 4;
    music[musicOffset] = 65;
    music[musicOffset + 1] = 66;
    music[musicOffset + 2] = 67;
    music[musicOffset + 3] = 68;
    sfx[row * 68 + 65] = 16;
  }
  const code = [];
  const warnings = [];
  const rows = {
    lua: 0,
    gfx: 0,
    gff: 0,
    map: 0,
    sfx: 0,
    music: 0,
    label: 0
  };
  const seen = /* @__PURE__ */ new Set();
  const hexOffsets = { gfx: 0, gff: 0, map: 0 };
  let current;
  for (let lineIndex = 2; lineIndex < scanned.lines.length; lineIndex += 1) {
    const line = scanned.lines[lineIndex];
    if (line === void 0)
      continue;
    const bytes = lineBytes(input, line);
    const marker = sectionMarker(bytes);
    if (marker !== void 0) {
      if (!isKnownSection(marker)) {
        warnings.push({
          code: "W_CART_UNKNOWN_SECTION",
          message: `Unknown text cart section __${marker}__ was ignored`,
          offset: line.start,
          section: marker
        });
        current = "unknown";
      } else {
        if (seen.has(marker)) {
          codecFailure("E_CART_TEXT_SECTION", `Duplicate __${marker}__ section`, {
            offset: line.start,
            details: { section: marker }
          });
        }
        seen.add(marker);
        current = marker;
      }
      continue;
    }
    if (current === void 0) {
      if (bytes.length > 0) {
        codecFailure("E_CART_TEXT_SECTION", "Unexpected data before the first cart section", {
          offset: line.start
        });
      }
      continue;
    }
    if (current === "unknown")
      continue;
    if (current === "lua") {
      appendCode(code, bytes, line, options, limits);
      rows.lua += 1;
      continue;
    }
    if (bytes.length === 0)
      continue;
    const row = rows[current];
    switch (current) {
      case "gfx":
        hexOffsets.gfx += decodeHexChunk(current, bytes, GFX_ROW_CHARS, line.start, gfx, hexOffsets.gfx, true);
        break;
      case "gff":
        hexOffsets.gff += decodeHexChunk(current, bytes, GFF_MAP_ROW_CHARS, line.start, gff, hexOffsets.gff);
        break;
      case "map":
        hexOffsets.map += decodeHexChunk(current, bytes, GFF_MAP_ROW_CHARS, line.start, map, hexOffsets.map);
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
    rom[4096 + index] = (rom[4096 + index] ?? 0) | (map[MAP_BYTES + index] ?? 0);
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
    sectionRows: Object.freeze({ ...rows })
  };
}

// packages/cart-codec/dist/inflate.js
var BitReader = class {
  #bytes;
  #bitOffset = 0;
  constructor(bytes) {
    this.#bytes = bytes;
  }
  get bitOffset() {
    return this.#bitOffset;
  }
  read(count) {
    if (count < 0 || count > 24 || this.#bitOffset + count > this.#bytes.length * 8) {
      codecFailure("E_CART_PNG_DEFLATE", "Truncated DEFLATE bitstream", {
        offset: this.#bitOffset >>> 3
      });
    }
    let value = 0;
    for (let bit = 0; bit < count; bit += 1) {
      const byte = this.#bytes[this.#bitOffset >>> 3] ?? 0;
      value |= (byte >>> (this.#bitOffset & 7) & 1) << bit;
      this.#bitOffset += 1;
    }
    return value >>> 0;
  }
  alignToByte() {
    this.#bitOffset = this.#bitOffset + 7 & ~7;
  }
};
var BoundedOutput = class {
  #bytes;
  #length = 0;
  constructor(expectedLength, maximumLength) {
    if (expectedLength > maximumLength) {
      codecFailure("E_CART_PNG_INFLATE_LIMIT", "Inflated PNG exceeds configured output limit", {
        details: { expectedLength, maximumLength }
      });
    }
    this.#bytes = new Uint8Array(expectedLength);
  }
  get length() {
    return this.#length;
  }
  write(value) {
    if (this.#length >= this.#bytes.length) {
      codecFailure("E_CART_PNG_INFLATE_LIMIT", "DEFLATE output exceeds expected PNG size");
    }
    this.#bytes[this.#length] = value;
    this.#length += 1;
  }
  copy(distance, length) {
    if (distance <= 0 || distance > this.#length) {
      codecFailure("E_CART_PNG_DEFLATE", "Invalid DEFLATE back-reference distance", {
        details: { distance, outputLength: this.#length }
      });
    }
    if (this.#length + length > this.#bytes.length) {
      codecFailure("E_CART_PNG_INFLATE_LIMIT", "DEFLATE back-reference exceeds expected PNG size");
    }
    for (let index = 0; index < length; index += 1) {
      this.write(this.#bytes[this.#length - distance] ?? 0);
    }
  }
  finish() {
    if (this.#length !== this.#bytes.length) {
      codecFailure("E_CART_PNG_DEFLATE", "DEFLATE output length does not match PNG dimensions", {
        details: { actual: this.#length, expected: this.#bytes.length }
      });
    }
    return this.#bytes;
  }
};
function reverseBits(value, count) {
  let reversed = 0;
  for (let bit = 0; bit < count; bit += 1) {
    reversed = reversed << 1 | value >>> bit & 1;
  }
  return reversed >>> 0;
}
function buildHuffman(codeLengths, label) {
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
    code = code + (counts[bits - 1] ?? 0) << 1;
    nextCode[bits] = code;
  }
  const byLength = Array.from({ length: 16 }, () => /* @__PURE__ */ new Map());
  for (let symbol = 0; symbol < codeLengths.length; symbol += 1) {
    const length = codeLengths[symbol] ?? 0;
    if (length === 0)
      continue;
    const canonical = nextCode[length] ?? 0;
    nextCode[length] = canonical + 1;
    byLength[length]?.set(reverseBits(canonical, length), symbol);
  }
  return { byLength, maximumBits };
}
function readHuffman(reader, table) {
  let code = 0;
  for (let length = 1; length <= table.maximumBits; length += 1) {
    code |= reader.read(1) << length - 1;
    const symbol = table.byLength[length]?.get(code);
    if (symbol !== void 0)
      return symbol;
  }
  codecFailure("E_CART_PNG_DEFLATE", "Invalid Huffman symbol", {
    offset: reader.bitOffset >>> 3
  });
}
var LENGTH_BASE = [
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  13,
  15,
  17,
  19,
  23,
  27,
  31,
  35,
  43,
  51,
  59,
  67,
  83,
  99,
  115,
  131,
  163,
  195,
  227,
  258
];
var LENGTH_EXTRA = [
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  1,
  1,
  1,
  1,
  2,
  2,
  2,
  2,
  3,
  3,
  3,
  3,
  4,
  4,
  4,
  4,
  5,
  5,
  5,
  5,
  0
];
var DISTANCE_BASE = [
  1,
  2,
  3,
  4,
  5,
  7,
  9,
  13,
  17,
  25,
  33,
  49,
  65,
  97,
  129,
  193,
  257,
  385,
  513,
  769,
  1025,
  1537,
  2049,
  3073,
  4097,
  6145,
  8193,
  12289,
  16385,
  24577
];
var DISTANCE_EXTRA = [
  0,
  0,
  0,
  0,
  1,
  1,
  2,
  2,
  3,
  3,
  4,
  4,
  5,
  5,
  6,
  6,
  7,
  7,
  8,
  8,
  9,
  9,
  10,
  10,
  11,
  11,
  12,
  12,
  13,
  13
];
function fixedTables() {
  const literalLengths = new Uint8Array(288);
  literalLengths.fill(8, 0, 144);
  literalLengths.fill(9, 144, 256);
  literalLengths.fill(7, 256, 280);
  literalLengths.fill(8, 280);
  const distanceLengths = new Uint8Array(32);
  distanceLengths.fill(5);
  return {
    literal: buildHuffman(literalLengths, "fixed literal/length"),
    distance: buildHuffman(distanceLengths, "fixed distance")
  };
}
function dynamicTables(reader) {
  const literalCount = reader.read(5) + 257;
  const distanceCount = reader.read(5) + 1;
  const codeLengthCount = reader.read(4) + 4;
  const order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  const codeLengthLengths = new Uint8Array(19);
  for (let index = 0; index < codeLengthCount; index += 1) {
    const symbol = order[index];
    if (symbol === void 0)
      codecFailure("E_CART_PNG_DEFLATE", "Invalid code-length alphabet");
    codeLengthLengths[symbol] = reader.read(3);
  }
  const codeLengthTable = buildHuffman(codeLengthLengths, "code-length");
  const total = literalCount + distanceCount;
  const lengths = [];
  while (lengths.length < total) {
    const symbol = readHuffman(reader, codeLengthTable);
    if (symbol <= 15) {
      lengths.push(symbol);
      continue;
    }
    let repeat;
    let value;
    if (symbol === 16) {
      if (lengths.length === 0)
        codecFailure("E_CART_PNG_DEFLATE", "Repeat code has no previous length");
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
    for (let index = 0; index < repeat; index += 1)
      lengths.push(value);
  }
  const literalLengths = lengths.slice(0, literalCount);
  if ((literalLengths[256] ?? 0) === 0) {
    codecFailure("E_CART_PNG_DEFLATE", "Dynamic literal tree is missing end-of-block");
  }
  const distanceLengths = lengths.slice(literalCount);
  const distance = distanceLengths.some((length) => length !== 0) ? buildHuffman(distanceLengths, "dynamic distance") : null;
  return { literal: buildHuffman(literalLengths, "dynamic literal/length"), distance };
}
function inflateCompressed(reader, output, literal, distance) {
  for (; ; ) {
    const symbol = readHuffman(reader, literal);
    if (symbol < 256) {
      output.write(symbol);
      continue;
    }
    if (symbol === 256)
      return;
    if (symbol < 257 || symbol > 285) {
      codecFailure("E_CART_PNG_DEFLATE", "Reserved DEFLATE length symbol");
    }
    const lengthIndex = symbol - 257;
    const lengthBase = LENGTH_BASE[lengthIndex];
    const lengthExtra = LENGTH_EXTRA[lengthIndex];
    if (lengthBase === void 0 || lengthExtra === void 0) {
      codecFailure("E_CART_PNG_DEFLATE", "Invalid DEFLATE length symbol");
    }
    const length = lengthBase + reader.read(lengthExtra);
    if (distance === null) {
      codecFailure("E_CART_PNG_DEFLATE", "Length symbol used without a distance alphabet");
    }
    const distanceSymbol = readHuffman(reader, distance);
    const distanceBase = DISTANCE_BASE[distanceSymbol];
    const distanceExtra = DISTANCE_EXTRA[distanceSymbol];
    if (distanceBase === void 0 || distanceExtra === void 0) {
      codecFailure("E_CART_PNG_DEFLATE", "Reserved DEFLATE distance symbol");
    }
    output.copy(distanceBase + reader.read(distanceExtra), length);
  }
}
function readBigEndianU32(bytes, offset) {
  return (bytes[offset] ?? 0) * 16777216 + ((bytes[offset + 1] ?? 0) << 16) + ((bytes[offset + 2] ?? 0) << 8) + (bytes[offset + 3] ?? 0) >>> 0;
}
function adler32(bytes) {
  let first = 1;
  let second = 0;
  for (let offset = 0; offset < bytes.length; offset += 5552) {
    const end = Math.min(offset + 5552, bytes.length);
    for (let index = offset; index < end; index += 1) {
      first += bytes[index] ?? 0;
      second += first;
    }
    first %= 65521;
    second %= 65521;
  }
  return (second << 16 | first) >>> 0;
}
function inflateZlib(input, expectedOutputBytes, maximumOutputBytes) {
  if (input.length < 6)
    codecFailure("E_CART_PNG_ZLIB", "Truncated zlib stream");
  const cmf = input[0] ?? 0;
  const flags = input[1] ?? 0;
  if ((cmf & 15) !== 8 || cmf >>> 4 > 7 || (cmf << 8 | flags) % 31 !== 0) {
    codecFailure("E_CART_PNG_ZLIB", "Invalid zlib header");
  }
  if ((flags & 32) !== 0)
    codecFailure("E_CART_PNG_ZLIB", "Preset zlib dictionaries are unsupported");
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
      if (((length ^ 65535) & 65535) !== complement) {
        codecFailure("E_CART_PNG_DEFLATE", "Stored DEFLATE block length check failed");
      }
      for (let index = 0; index < length; index += 1)
        output.write(reader.read(8));
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
      details: { expected: expectedAdler, actual: actualAdler }
    });
  }
  return bytes;
}

// packages/cart-codec/dist/png.js
var PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
var CART_WIDTH = 160;
var CART_HEIGHT = 205;
var BYTES_PER_PIXEL = 4;
var SCANLINE_BYTES = CART_WIDTH * BYTES_PER_PIXEL;
var INFLATED_BYTES = CART_HEIGHT * (SCANLINE_BYTES + 1);
function readU32(bytes, offset) {
  return (bytes[offset] ?? 0) * 16777216 + ((bytes[offset + 1] ?? 0) << 16) + ((bytes[offset + 2] ?? 0) << 8) + (bytes[offset + 3] ?? 0) >>> 0;
}
function chunkType(bytes, offset) {
  let type = "";
  for (let index = 0; index < 4; index += 1) {
    const value = bytes[offset + index] ?? 0;
    if (!(value >= 65 && value <= 90 || value >= 97 && value <= 122)) {
      codecFailure("E_CART_PNG_ORDER", "PNG chunk type must contain ASCII letters", {
        offset
      });
    }
    type += String.fromCharCode(value);
  }
  return type;
}
function crc32(bytes, start, end) {
  let crc = 4294967295;
  for (let index = start; index < end; index += 1) {
    crc ^= bytes[index] ?? 0;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc >>> 1 ^ ((crc & 1) === 0 ? 0 : 3988292384);
    }
  }
  return (crc ^ 4294967295) >>> 0;
}
function concatenate(parts, totalBytes) {
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
function paeth(left, up, upperLeft) {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance)
    return left;
  return upDistance <= upperLeftDistance ? up : upperLeft;
}
function unfilter(scanlines) {
  if (scanlines.length !== INFLATED_BYTES) {
    codecFailure("E_CART_PNG_DEFLATE", "Inflated PNG scanline length is invalid", {
      details: { actual: scanlines.length, expected: INFLATED_BYTES }
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
        details: { filter, row }
      });
    }
    const rowOffset = row * SCANLINE_BYTES;
    for (let column = 0; column < SCANLINE_BYTES; column += 1) {
      const encoded = scanlines[inputOffset] ?? 0;
      inputOffset += 1;
      const outputOffset = rowOffset + column;
      const left = column < BYTES_PER_PIXEL ? 0 : rgba[outputOffset - BYTES_PER_PIXEL] ?? 0;
      const up = row === 0 ? 0 : rgba[outputOffset - SCANLINE_BYTES] ?? 0;
      const upperLeft = row === 0 || column < BYTES_PER_PIXEL ? 0 : rgba[outputOffset - SCANLINE_BYTES - BYTES_PER_PIXEL] ?? 0;
      let predictor = 0;
      if (filter === 1)
        predictor = left;
      else if (filter === 2)
        predictor = up;
      else if (filter === 3)
        predictor = Math.floor((left + up) / 2);
      else if (filter === 4)
        predictor = paeth(left, up, upperLeft);
      rgba[outputOffset] = encoded + predictor & 255;
    }
  }
  return rgba;
}
function decodeCartPng(input, limits) {
  if (input.length > limits.maximumInputBytes) {
    codecFailure("E_CART_INPUT_TOO_LARGE", "PNG input exceeds configured byte limit", {
      details: { actual: input.length, maximum: limits.maximumInputBytes }
    });
  }
  if (input.length < PNG_SIGNATURE.length)
    codecFailure("E_CART_PNG_SIGNATURE", "Truncated PNG signature");
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (input[index] !== PNG_SIGNATURE[index]) {
      codecFailure("E_CART_PNG_SIGNATURE", "Input is not a PNG file", { offset: index });
    }
  }
  let offset = PNG_SIGNATURE.length;
  let chunkCount = 0;
  let seenHeader = false;
  let seenPalette = false;
  let seenIdat = false;
  let idatClosed = false;
  let seenEnd = false;
  let idatBytes = 0;
  const idatParts = [];
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
        details: { type, length }
      });
    }
    const expectedCrc = readU32(input, crcOffset);
    const actualCrc = crc32(input, typeOffset, crcOffset);
    if (expectedCrc !== actualCrc) {
      codecFailure("E_CART_PNG_CRC", `PNG ${type} CRC mismatch`, {
        offset: crcOffset,
        details: { expected: expectedCrc, actual: actualCrc }
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
          details: { width, height }
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
          details: { bitDepth, colorType, compression, filter, interlace }
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
      if (idatClosed)
        codecFailure("E_CART_PNG_ORDER", "IDAT chunks must be consecutive", { offset });
      seenIdat = true;
      idatBytes += length;
      if (idatBytes > limits.maximumIdatBytes) {
        codecFailure("E_CART_PNG_IDAT_LIMIT", "PNG IDAT data exceeds configured byte limit", {
          offset,
          details: { actual: idatBytes, maximum: limits.maximumIdatBytes }
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
      if (seenIdat)
        idatClosed = true;
      const critical = ((input[typeOffset] ?? 0) & 32) === 0;
      if (critical) {
        codecFailure("E_CART_PNG_CRITICAL_CHUNK", `Unsupported critical PNG chunk ${type}`, {
          offset
        });
      }
    }
    offset = nextOffset;
    if (seenEnd)
      break;
  }
  if (!seenHeader || !seenIdat || !seenEnd) {
    codecFailure("E_CART_PNG_ORDER", "PNG is missing IHDR, IDAT, or IEND");
  }
  const compressed = concatenate(idatParts, idatBytes);
  const scanlines = inflateZlib(compressed, INFLATED_BYTES, limits.maximumInflatedBytes);
  return { rgba: unfilter(scanlines), chunkCount, idatBytes };
}

// packages/cart-codec/dist/public.js
var P8PNG_WIDTH = 160;
var P8PNG_HEIGHT = 205;
var P8PNG_PAYLOAD_BYTES = 32800;
var P8PNG_CODE_OFFSET = 17152;
var DEFAULT_P8PNG_LIMITS = Object.freeze({
  maximumInputBytes: 1048576,
  maximumChunks: 128,
  maximumIdatBytes: 262144,
  maximumInflatedBytes: P8PNG_HEIGHT * (P8PNG_WIDTH * 4 + 1),
  maximumCodeBytes: 65535,
  maximumCartVersion: PICO8_0_2_7_CART_VERSION
});
function positiveInteger2(name, value, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    codecFailure("E_CART_LIMITS", `${name} must be a positive safe integer`, {
      details: { name, value, maximum }
    });
  }
  return value;
}
function nonNegativeInteger(name, value, maximum) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    codecFailure("E_CART_LIMITS", `${name} must be a non-negative safe integer`, {
      details: { name, value, maximum }
    });
  }
  return value;
}
function normalizeLimits2(options) {
  const candidate = { ...DEFAULT_P8PNG_LIMITS, ...options.limits };
  return {
    maximumInputBytes: positiveInteger2("maximumInputBytes", candidate.maximumInputBytes),
    maximumChunks: positiveInteger2("maximumChunks", candidate.maximumChunks, 65535),
    maximumIdatBytes: positiveInteger2("maximumIdatBytes", candidate.maximumIdatBytes),
    maximumInflatedBytes: positiveInteger2("maximumInflatedBytes", candidate.maximumInflatedBytes),
    maximumCodeBytes: positiveInteger2("maximumCodeBytes", candidate.maximumCodeBytes, 65535),
    maximumCartVersion: nonNegativeInteger("maximumCartVersion", candidate.maximumCartVersion, 255)
  };
}
function extractPayload(rgba) {
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
    payload[pixel] = (alpha & 3) << 6 | (red & 3) << 4 | (green & 3) << 2 | blue & 3;
  }
  return payload;
}
function decodeP8Png(input, options = {}) {
  if (!(input instanceof Uint8Array)) {
    codecFailure("E_CART_ARGUMENT", "decodeP8Png expects Uint8Array input");
  }
  const limits = normalizeLimits2(options);
  const png = decodeCartPng(input, limits);
  const payload = extractPayload(png.rgba);
  const cartVersion = payload[PICO_CART_ROM_SIZE] ?? 0;
  if (cartVersion > limits.maximumCartVersion) {
    codecFailure("E_CART_FUTURE_VERSION", "Cart version is newer than the configured target", {
      details: { cartVersion, maximumCartVersion: limits.maximumCartVersion }
    });
  }
  const rom = payload.slice(0, PICO_CART_ROM_SIZE);
  const code = decodeP8Code(rom.subarray(P8PNG_CODE_OFFSET), limits.maximumCodeBytes);
  return createParsedCart(input, {
    format: "p8.png",
    version: cartVersion,
    rom,
    code: code.bytes
  }, {
    width: P8PNG_WIDTH,
    height: P8PNG_HEIGHT,
    codeCompression: code.compression,
    declaredCodeBytes: code.declaredBytes,
    compressedCodeBytes: code.compressedBytes,
    pngChunkCount: png.chunkCount,
    pngIdatBytes: png.idatBytes
  });
}
function decodeP8(input, options = {}) {
  if (!(input instanceof Uint8Array)) {
    codecFailure("E_CART_ARGUMENT", "decodeP8 expects Uint8Array input");
  }
  const decoded = decodeTextP8(input, options);
  return createParsedCart(input, {
    format: "p8",
    version: decoded.version,
    rom: decoded.rom,
    code: decoded.code,
    warnings: decoded.warnings
  }, {
    lineEndings: decoded.lineEndings,
    sectionRows: decoded.sectionRows
  });
}
var PNG_SIGNATURE2 = [137, 80, 78, 71, 13, 10, 26, 10];
var TEXT_MAGIC = "pico-8 cartridge";
function hasBytes(input, expected, offset = 0) {
  return expected.every((byte, index) => input[offset + index] === byte);
}
function hasTextMagic(input) {
  const offset = hasBytes(input, [239, 187, 191]) ? 3 : 0;
  for (let index = 0; index < TEXT_MAGIC.length; index += 1) {
    if (input[offset + index] !== TEXT_MAGIC.charCodeAt(index))
      return false;
  }
  return true;
}
function decodeCart(input, options = {}) {
  if (!(input instanceof Uint8Array)) {
    codecFailure("E_CART_ARGUMENT", "decodeCart expects Uint8Array input");
  }
  if (hasBytes(input, PNG_SIGNATURE2))
    return decodeP8Png(input, options.p8Png ?? {});
  if (hasTextMagic(input))
    return decodeP8(input, options.p8 ?? {});
  codecFailure("E_CART_FORMAT", "Cart bytes do not match a supported format", { offset: 0 });
}

// apps/web-player/dist/transport/audio-protocol.js
var AUDIO_PROTOCOL_VERSION = 1;
var PICO_CANONICAL_SAMPLE_RATE = 22050;

// apps/web-player/dist/transport/validators.js
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function isUint(value) {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 4294967295;
}
function isPositiveUint(value) {
  return isUint(value) && Number(value) > 0;
}
function isInt32(value) {
  return Number.isInteger(value) && Number(value) >= -2147483648 && Number(value) <= 2147483647;
}
function isPicoInputSnapshot(value) {
  return isRecord(value) && Array.isArray(value.controllers) && value.controllers.length === PICO_CONTROLLER_COUNT && value.controllers.every((buttons) => isUint(buttons) && Number(buttons) <= PICO_CONTROLLER_BUTTON_MASK) && isRecord(value.devkit) && isInt32(value.devkit.mouseXRaw) && isInt32(value.devkit.mouseYRaw) && isUint(value.devkit.mouseButtons) && Number(value.devkit.mouseButtons) <= 7 && isInt32(value.devkit.wheelRaw) && isInt32(value.devkit.movementXRaw) && isInt32(value.devkit.movementYRaw) && Array.isArray(value.devkit.keypresses) && value.devkit.keypresses.length <= PICO_DEVKIT_KEYPRESS_BATCH_LIMIT && value.devkit.keypresses.every((byte) => isUint(byte) && Number(byte) <= 255);
}
function isPlayerEnvelope(value) {
  return isRecord(value) && value.v === 1 && isUint(value.requestId) && isPositiveUint(value.workerGeneration) && isUint(value.sessionGeneration);
}
function isPlayerError(value) {
  if (!isRecord(value))
    return false;
  const codes = /* @__PURE__ */ new Set([
    "E_VM_SYNTAX",
    "E_VM_RUNTIME",
    "E_VM_INSTRUCTION_BUDGET",
    "E_VM_OOM",
    "E_VM_WATCHDOG",
    "E_CART_PARSE",
    "E_TIME_DISCONTINUITY",
    "E_FEATURE_UNSUPPORTED",
    "E_HOST_REQUEST",
    "E_HOST_API",
    "E_PERSISTENCE_READ",
    "E_PERSISTENCE_WRITE",
    "E_INVALID_STATE",
    "E_INVARIANT"
  ]);
  const phases = /* @__PURE__ */ new Set([
    "none",
    "compile",
    "boot",
    "init",
    "update",
    "update60",
    "draw",
    "custom-loop",
    "host-call",
    "menuitem"
  ]);
  const detailsValid = value.details === void 0 || isRecord(value.details) && Object.values(value.details).every((detail) => typeof detail === "string" || typeof detail === "boolean" || typeof detail === "number" && Number.isFinite(detail));
  return typeof value.code === "string" && codes.has(value.code) && typeof value.message === "string" && typeof value.phase === "string" && phases.has(value.phase) && typeof value.recoverable === "boolean" && (value.line === void 0 || Number.isSafeInteger(value.line)) && (value.trace === void 0 || typeof value.trace === "string") && detailsValid;
}
function isCartAccess(value) {
  return isRecord(value) && typeof value.load === "boolean" && typeof value.reloadData === "boolean" && typeof value.cstoreData === "boolean" && typeof value.include === "boolean";
}
function utf8ByteLength(value) {
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 127)
      length += 1;
    else if (unit <= 2047)
      length += 2;
    else if (unit >= 55296 && unit <= 56319 && index + 1 < value.length && value.charCodeAt(index + 1) >= 56320 && value.charCodeAt(index + 1) <= 57343) {
      length += 4;
      index += 1;
    } else
      length += 3;
  }
  return length;
}
function isLocalCartBundle(value, wire = false) {
  if (value === void 0)
    return true;
  if (!Array.isArray(value) || value.length > PICO_LOCAL_CART_BUNDLE_MAX_ENTRIES)
    return false;
  const refs = /* @__PURE__ */ new Set();
  for (const entry of value) {
    if (!isRecord(entry))
      return false;
    const bytes = wire ? entry.cartBytes : entry.bytes;
    if (typeof entry.ref !== "string" || entry.ref.length === 0 || utf8ByteLength(entry.ref) > PICO_CART_REF_MAX_BYTES || !(wire ? bytes instanceof ArrayBuffer : bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > PICO_CART_INPUT_MAX_BYTES || !isCartAccess(entry.access) || refs.has(entry.ref))
      return false;
    refs.add(entry.ref);
  }
  return true;
}
function isHostCartData(value, wire = false) {
  if (value === void 0)
    return true;
  if (!Array.isArray(value) || value.length > PICO_CART_DATA_MAX_RECORDS)
    return false;
  const ids = /* @__PURE__ */ new Set();
  return value.every((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length < 1 || utf8ByteLength(entry.id) > PICO_CART_DATA_ID_MAX_BYTES || !/^[a-z0-9_-]+$/u.test(entry.id) || ids.has(entry.id) || !(wire ? entry.bytes instanceof ArrayBuffer : entry.bytes instanceof Uint8Array) || entry.bytes.byteLength !== PICO_CART_DATA_BYTES) {
      return false;
    }
    ids.add(entry.id);
    return true;
  });
}
function isCartLoad(source, budget, bundle, host) {
  return source instanceof Uint8Array && source.byteLength > 0 && source.byteLength <= PICO_CART_INPUT_MAX_BYTES && (budget === void 0 || isPositiveUint(budget)) && isLocalCartBundle(bundle) && isHostCartData(host);
}
function isPlayerRuntimeToHost(value) {
  if (!isPlayerEnvelope(value))
    return false;
  if (!isPositiveUint(value.requestId) && !(value.requestId === 0 && value.type === "diagnostic"))
    return false;
  if (value.type === "cartdata-commit") {
    return typeof value.id === "string" && value.id.length >= 1 && utf8ByteLength(value.id) <= PICO_CART_DATA_ID_MAX_BYTES && /^[a-z0-9_-]+$/u.test(value.id) && isPositiveUint(value.revision) && value.bytes instanceof ArrayBuffer && value.bytes.byteLength === PICO_CART_DATA_BYTES;
  }
  if (value.type === "persistence-flushed") {
    return typeof value.durable === "boolean" && (value.message === void 0 || typeof value.message === "string");
  }
  if (value.type === "session-replaced") {
    return isPositiveUint(value.previousSessionGeneration) && isPositiveUint(value.nextSessionGeneration) && Number(value.nextSessionGeneration) === Number(value.previousSessionGeneration) + 1 && value.sessionGeneration === value.nextSessionGeneration && typeof value.cartRef === "string" && value.cartRef.length > 0 && value.breadcrumb instanceof ArrayBuffer && value.breadcrumb.byteLength <= 4096 && isUint(value.breadcrumbDepth);
  }
  if (value.type === "pause-menu") {
    return typeof value.open === "boolean" && ["opened", "keep-open", "closed", "removed"].includes(String(value.outcome)) && Array.isArray(value.items) && value.items.length <= 5 && value.items.every((item) => isRecord(item) && isUint(item.slot) && Number(item.slot) >= 1 && Number(item.slot) <= 5 && item.label instanceof ArrayBuffer && item.label.byteLength <= 16 && isUint(item.filter) && (Number(item.filter) & 4294902015) === 0);
  }
  if (value.type === "state") {
    if (!isUint(value.devkitFlags) || Number(value.devkitFlags) > 7)
      return false;
    if (value.state === "disposed") {
      return value.mode === "none" && value.targetFps === 0;
    }
    if (value.state === "stopped" && value.mode === "none") {
      return value.targetFps === 0;
    }
    if (value.state === "waiting-host" && value.mode === "none") {
      return value.targetFps === 0;
    }
    return ["ready", "running", "waiting-host", "paused", "stopped"].includes(String(value.state)) && (value.mode === "callback" || value.mode === "custom") && (value.targetFps === 30 || value.targetFps === 60);
  }
  if (value.type === "frame") {
    return isUint(value.frameId) && isDecimalUint(value.completedSlices) && Number.isInteger(value.timeRawBeforeStep) && Number(value.timeRawBeforeStep) >= -2147483648 && Number(value.timeRawBeforeStep) <= 2147483647 && (value.targetFps === 30 || value.targetFps === 60) && isUint(value.cpuInstructions) && isUint(value.cpuFractionRaw) && Number(value.cpuFractionRaw) <= 2147483647 && typeof value.slowFrame === "boolean" && isUint(value.devkitFlags) && Number(value.devkitFlags) <= 7 && value.packedScreen instanceof ArrayBuffer && value.packedScreen.byteLength === 8192 && value.displayPalette instanceof ArrayBuffer && value.displayPalette.byteLength === 16;
  }
  if (value.type === "heartbeat") {
    return isUint(value.vsyncSequence) && isUint(value.tickCount) && Number(value.tickCount) <= 5 && isUint(value.droppedTicks);
  }
  if (value.type === "runtime-control") {
    return (value.control === "run" || value.control === "stop") && value.payload instanceof ArrayBuffer && value.payload.byteLength <= 4096;
  }
  if (value.type === "diagnostic" || value.type === "fault") {
    return isPlayerError(value.error);
  }
  return false;
}
function isDecimalUint(value) {
  return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value);
}
function isAudioEnvelope(value) {
  return isRecord(value) && value.v === AUDIO_PROTOCOL_VERSION && isUint(value.sessionGeneration);
}
function isAudioDeviceStatsMessage(value) {
  if (!isAudioEnvelope(value) || value.type !== "audioStats")
    return false;
  const uintFields = [
    "queuedSourceFrames",
    "queueHighWaterFrames",
    "configuredLowWaterFrames",
    "configuredHighWaterFrames",
    "startupUnderruns",
    "steadyUnderruns",
    "overruns",
    "droppedSourceFrames",
    "discontinuities",
    "staleChunks",
    "receivedChunks",
    "renderedDeviceFrames"
  ];
  return typeof value.deviceSampleRate === "number" && Number.isFinite(value.deviceSampleRate) && value.deviceSampleRate > 0 && uintFields.every((field) => isUint(value[field])) && typeof value.playing === "boolean";
}

// apps/web-player/dist/transport/runtime-error.js
var RuntimeClientError = class extends Error {
  record;
  constructor(record) {
    super(record.message);
    this.name = "RuntimeClientError";
    this.record = record;
  }
};

// packages/runtime-core/dist/audio/sfx-synth.js
var PICO_AUDIO_SAMPLE_RATE = 22050;
var PICO_AUDIO_CHANNELS = 4;
var SFX_BASE = 12800;
var SFX_COUNT = 64;
var SFX_BYTES2 = 68;
var MUSIC_BASE = 12544;
var MUSIC_COUNT = 64;
var MUSIC_CHANNELS = 4;
var NOTES_PER_SFX = 32;
var NOTE_BYTES = 2;
var NOTE_SAMPLES_PER_SPEED = 183;
var SOUND_PAUSE = 24367;
var AUDIO_HALF_RATE = 24384;
var AUDIO_REVERB = 24385;
var AUDIO_DISTORT = 24386;
var AUDIO_LOWPASS = 24387;
var MAX_RENDER_SLICES = 120;
var MASTER_SFX_GAIN = 0.5;
var BASE_NOISE_SEED = 1831565813;
function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}
function q16Integer(raw) {
  return raw >> 16;
}
function keyToFrequency(key) {
  return 440 * 2 ** ((key - 33) / 12);
}
function p8sciiParameter(byte) {
  if (byte >= 48 && byte <= 57)
    return byte - 48;
  if (byte >= 97 && byte <= 122)
    return byte - 87;
  if (byte >= 65 && byte <= 90)
    return byte - 55;
  return 0;
}
function noteSemitone(byte) {
  switch (byte) {
    case 99:
      return 0;
    case 100:
      return 2;
    case 101:
      return 4;
    case 102:
      return 5;
    case 103:
      return 7;
    case 97:
      return 9;
    case 98:
      return 11;
    default:
      return -1;
  }
}
function mixSeed(channel, custom) {
  const mixed = (BASE_NOISE_SEED ^ Math.imul(channel + 1, 2654435769) ^ (custom ? 2769414579 : 0)) >>> 0;
  return mixed === 0 ? BASE_NOISE_SEED : mixed;
}
function createVoice(channel, custom) {
  return {
    sfx: -1,
    offset: 0,
    time: 0,
    elapsed: 0,
    previousKey: 24,
    previousVolume: 0,
    phase: 0,
    noiseState: mixSeed(channel, custom),
    noiseValue: 0,
    loopEpoch: 0
  };
}
var BiquadFilter = class {
  #c1;
  #c2;
  #c3;
  #c4;
  #c5;
  #lastInput = 0;
  #previousInput = 0;
  #lastOutput = 0;
  #previousOutput = 0;
  constructor(frequency, q, gain) {
    const w0 = Math.PI * 2 * frequency / PICO_AUDIO_SAMPLE_RATE;
    const cosine = Math.cos(w0);
    const a = 10 ** (gain / 40);
    const alpha = Math.sin(w0) / 2 * Math.sqrt((a + 1 / a) * (1 / q - 1) + 2);
    const squareRootA = 2 * Math.sqrt(a) * alpha;
    const a0 = a + 1 - (a - 1) * cosine + squareRootA;
    const a1 = 2 * (a - 1 - (a + 1) * cosine);
    const a2 = a + 1 - (a - 1) * cosine - squareRootA;
    const b0 = a * (a + 1 + (a - 1) * cosine + squareRootA);
    const b1 = -2 * a * (a - 1 + (a + 1) * cosine);
    const b2 = a * (a + 1 + (a - 1) * cosine - squareRootA);
    this.#c1 = b0 / a0;
    this.#c2 = b1 / a0;
    this.#c3 = b2 / a0;
    this.#c4 = a1 / a0;
    this.#c5 = a2 / a0;
  }
  reset() {
    this.#lastInput = 0;
    this.#previousInput = 0;
    this.#lastOutput = 0;
    this.#previousOutput = 0;
  }
  run(input) {
    const output = this.#c1 * input + this.#c2 * this.#lastInput + this.#c3 * this.#previousInput - this.#c4 * this.#lastOutput - this.#c5 * this.#previousOutput;
    this.#previousInput = this.#lastInput;
    this.#lastInput = input;
    this.#previousOutput = this.#lastOutput;
    this.#lastOutput = output;
    return output;
  }
};
function createChannel(channel) {
  return {
    main: createVoice(channel, false),
    custom: createVoice(channel, true),
    length: 0,
    canLoop: true,
    isMusic: false,
    parkedMusicSfx: -1,
    lastMainNote: -1,
    lastMainKey: -1,
    lastMainVolume: 0,
    lastMainLoopEpoch: 0,
    reverb2: new Float64Array(366),
    reverb4: new Float64Array(732),
    reverbIndex: 0,
    damp1: new BiquadFilter(2400, 1, -6),
    damp2: new BiquadFilter(1e3, 1, -12)
  };
}
var PicoSfxSynth = class {
  #ram;
  #channels;
  #music = {
    pattern: -1,
    patternsPlayed: -1,
    channelMask: 0,
    tick: -1,
    lengthTicks: 0,
    fadeVolume: 0,
    fadeStepPerSample: 0
  };
  #sampleIndex = 0n;
  #sampleRemainder = 0;
  #targetFps = 0;
  constructor(ram) {
    if (!(ram instanceof Uint8Array) || ram.byteLength !== 65536) {
      throw new RangeError("PicoSfxSynth requires the physical 64 KiB Pico RAM view");
    }
    this.#ram = ram;
    this.#channels = Array.from({ length: PICO_AUDIO_CHANNELS }, (_, channel) => createChannel(channel));
  }
  reset() {
    this.#sampleIndex = 0n;
    this.#sampleRemainder = 0;
    this.#targetFps = 0;
    for (let index = 0; index < this.#channels.length; index += 1) {
      this.#resetChannel(this.#channels[index], index);
    }
    Object.assign(this.#music, {
      pattern: -1,
      patternsPlayed: -1,
      channelMask: 0,
      tick: -1,
      lengthTicks: 0,
      fadeVolume: 0,
      fadeStepPerSample: 0
    });
  }
  sfx(sfxRaw, channelRaw, offsetRaw, lengthRaw) {
    const sfx = q16Integer(sfxRaw);
    let channel = channelRaw === void 0 ? -1 : q16Integer(channelRaw);
    const offset = offsetRaw === void 0 ? 0 : q16Integer(offsetRaw);
    const length = lengthRaw === void 0 ? 0 : q16Integer(lengthRaw);
    if (sfx < -2 || sfx >= SFX_COUNT || channel < -2 || channel >= PICO_AUDIO_CHANNELS || offset > 31) {
      return;
    }
    if (channel === -2) {
      if (sfx < 0)
        return;
      for (const state2 of this.#channels) {
        if (state2.main.sfx === sfx)
          this.#silenceChannel(state2);
      }
      return;
    }
    if (sfx === -1) {
      if (channel === -1) {
        for (const state2 of this.#channels)
          this.#stopManualSfx(state2);
      } else {
        this.#stopManualSfx(this.#channels[channel]);
      }
      return;
    }
    if (sfx === -2) {
      if (channel === -1) {
        for (const state2 of this.#channels)
          state2.canLoop = false;
      } else {
        this.#channels[channel].canLoop = false;
      }
      return;
    }
    if (channel === -1) {
      channel = this.#selectChannel(sfx);
      if (channel < 0)
        return;
    }
    for (const state2 of this.#channels) {
      if (state2.main.sfx === sfx)
        this.#silenceChannel(state2);
    }
    const state = this.#channels[channel];
    if (state.main.sfx >= 0 && state.isMusic)
      state.parkedMusicSfx = state.main.sfx;
    this.#launch(state, channel, sfx, Math.max(0, offset), Math.max(0, length), false);
  }
  music(patternRaw, fadeLengthRaw, channelMaskRaw) {
    const pattern = q16Integer(patternRaw);
    const fadeLengthMs = Math.max(0, fadeLengthRaw === void 0 ? 0 : q16Integer(fadeLengthRaw));
    const channelMask = channelMaskRaw === void 0 ? 0 : q16Integer(channelMaskRaw) & 15;
    if (pattern < -1 || pattern >= MUSIC_COUNT)
      return;
    if (pattern === -1) {
      if (this.#music.pattern < 0)
        return;
      if (fadeLengthMs === 0) {
        this.#setMusicPattern(-1);
      } else {
        this.#music.fadeStepPerSample = -this.#music.fadeVolume / (fadeLengthMs * PICO_AUDIO_SAMPLE_RATE / 1e3);
      }
      return;
    }
    this.#music.patternsPlayed = 0;
    this.#music.channelMask = channelMask;
    this.#music.fadeVolume = fadeLengthMs === 0 ? 1 : 0;
    this.#music.fadeStepPerSample = fadeLengthMs === 0 ? 0 : 1 / (fadeLengthMs * PICO_AUDIO_SAMPLE_RATE / 1e3);
    this.#setMusicPattern(pattern);
  }
  playP8sciiAudio(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > 256)
      return;
    this.#playP8sciiAudio(bytes);
  }
  renderSlices(sliceCount, targetFps) {
    if (!Number.isInteger(sliceCount) || sliceCount < 0 || sliceCount > MAX_RENDER_SLICES) {
      throw new RangeError(`audio sliceCount must be an integer in 0..${MAX_RENDER_SLICES}`);
    }
    if (targetFps !== 30 && targetFps !== 60) {
      throw new RangeError("audio targetFps must be 30 or 60");
    }
    this.#targetFps = targetFps;
    const canonicalSlices = sliceCount * (60 / targetFps);
    const numerator = this.#sampleRemainder + canonicalSlices * PICO_AUDIO_SAMPLE_RATE;
    const frameCount = Math.floor(numerator / 60);
    this.#sampleRemainder = numerator % 60;
    const pcm16le = new Uint8Array(frameCount * 2);
    const view = new DataView(pcm16le.buffer);
    for (let frame = 0; frame < frameCount; frame += 1) {
      view.setInt16(frame * 2, this.#renderSample(), true);
    }
    const firstSample = this.#sampleIndex.toString();
    this.#sampleIndex += BigInt(frameCount);
    return { firstSample, frameCount, pcm16le };
  }
  snapshotChannels() {
    return this.#channels.map((state, channel) => ({
      channel,
      active: state.main.sfx >= 0,
      sfx: state.main.sfx,
      note: state.main.sfx < 0 ? -1 : Math.min(31, Math.floor(state.main.offset)),
      offset: state.main.offset,
      looping: state.main.sfx >= 0 && state.canLoop && this.#hasLoop(state.main.sfx)
    }));
  }
  snapshotMusic() {
    return {
      playing: this.#music.pattern >= 0,
      pattern: this.#music.pattern,
      patternsPlayed: this.#music.patternsPlayed,
      tick: this.#music.pattern < 0 ? -1 : Math.floor(this.#music.tick),
      channelMask: this.#music.channelMask,
      fadeVolume: this.#music.fadeVolume,
      musicChannels: this.#channels.map((state) => state.isMusic)
    };
  }
  #resetChannel(state, channel) {
    Object.assign(state.main, createVoice(channel, false));
    Object.assign(state.custom, createVoice(channel, true));
    state.length = 0;
    state.canLoop = true;
    state.isMusic = false;
    state.parkedMusicSfx = -1;
    state.lastMainNote = -1;
    state.lastMainKey = -1;
    state.lastMainVolume = 0;
    state.lastMainLoopEpoch = 0;
    state.reverb2.fill(0);
    state.reverb4.fill(0);
    state.reverbIndex = 0;
    state.damp1.reset();
    state.damp2.reset();
  }
  #silenceChannel(state) {
    state.main.sfx = -1;
    state.custom.sfx = -1;
    state.length = 0;
    state.canLoop = true;
    state.isMusic = false;
    state.lastMainNote = -1;
    state.lastMainKey = -1;
    state.lastMainVolume = 0;
  }
  #stopManualSfx(state) {
    if (state.main.sfx < 0 || state.isMusic)
      return;
    this.#silenceChannel(state);
  }
  #launch(state, channel, sfx, offset, length, isMusic) {
    const phase = state.main.phase;
    const noiseState = state.main.noiseState;
    Object.assign(state.main, createVoice(channel, false), {
      sfx,
      offset,
      phase,
      noiseState
    });
    state.custom.sfx = -1;
    state.length = length;
    state.canLoop = true;
    state.isMusic = isMusic;
    state.lastMainNote = -1;
    state.lastMainKey = -1;
    state.lastMainVolume = 0;
    state.lastMainLoopEpoch = 0;
  }
  #launchCustom(state, channel, sfx) {
    const phase = state.custom.phase;
    const noiseState = state.custom.noiseState;
    Object.assign(state.custom, createVoice(channel, true), {
      sfx,
      phase,
      noiseState
    });
  }
  #advanceMusic() {
    if (this.#music.pattern < 0)
      return;
    if (this.#music.fadeStepPerSample !== 0) {
      this.#music.fadeVolume = clamp(this.#music.fadeVolume + this.#music.fadeStepPerSample, 0, 1);
      if (this.#music.fadeStepPerSample < 0 && this.#music.fadeVolume === 0) {
        this.#setMusicPattern(-1);
        return;
      }
      if (this.#music.fadeStepPerSample > 0 && this.#music.fadeVolume === 1) {
        this.#music.fadeStepPerSample = 0;
      }
    }
    const rateScale = (this.#ram[AUDIO_HALF_RATE] & 1) !== 0 ? 0.5 : 1;
    this.#music.tick += rateScale / NOTE_SAMPLES_PER_SPEED;
    if (this.#music.tick < this.#music.lengthTicks)
      return;
    const pattern = this.#music.pattern;
    const address = MUSIC_BASE + pattern * MUSIC_CHANNELS;
    let nextPattern = pattern + 1;
    if ((this.#ram[address + 2] & 128) !== 0) {
      nextPattern = -1;
    } else if ((this.#ram[address + 1] & 128) !== 0) {
      nextPattern = pattern + 1;
      do {
        nextPattern -= 1;
      } while (nextPattern > 0 && (this.#ram[MUSIC_BASE + nextPattern * MUSIC_CHANNELS] & 128) === 0);
    }
    this.#music.patternsPlayed += 1;
    this.#setMusicPattern(nextPattern);
  }
  #setMusicPattern(pattern) {
    for (const state of this.#channels) {
      if (state.isMusic)
        this.#silenceChannel(state);
      state.parkedMusicSfx = -1;
    }
    if (pattern < 0 || pattern >= MUSIC_COUNT) {
      Object.assign(this.#music, {
        pattern: -1,
        patternsPlayed: -1,
        channelMask: 0,
        tick: -1,
        lengthTicks: 0,
        fadeVolume: 0,
        fadeStepPerSample: 0
      });
      return;
    }
    const songAddress = MUSIC_BASE + pattern * MUSIC_CHANNELS;
    const songChannels = Array.from({ length: MUSIC_CHANNELS }, (_, channel) => this.#ram[songAddress + channel] & 127);
    let loopingDuration = -1;
    let nonLoopingDuration = -1;
    for (const encoded of songChannels) {
      if ((encoded & 64) !== 0)
        continue;
      const sfx = encoded & 63;
      const base = this.#sfxAddress(sfx);
      const speed = Math.max(1, this.#ram[base + 65]);
      const loopStart = this.#ram[base + 66];
      const loopEnd = this.#ram[base + 67];
      if (loopEnd > loopStart) {
        loopingDuration = Math.max(loopingDuration, NOTES_PER_SFX * speed);
      } else {
        const end = loopEnd === 0 && loopStart > 0 ? Math.min(NOTES_PER_SFX, loopStart) : NOTES_PER_SFX;
        nonLoopingDuration = end * speed;
        break;
      }
    }
    const duration = nonLoopingDuration > 0 ? nonLoopingDuration : loopingDuration;
    this.#music.pattern = pattern;
    this.#music.tick = 0;
    this.#music.lengthTicks = duration > 0 ? duration : NOTES_PER_SFX;
    for (let channel = 0; channel < MUSIC_CHANNELS; channel += 1) {
      const encoded = songChannels[channel];
      if ((encoded & 64) !== 0)
        continue;
      const sfx = encoded & 63;
      const state = this.#channels[channel];
      if (state.main.sfx < 0) {
        this.#launch(state, channel, sfx, 0, 0, true);
      } else {
        state.parkedMusicSfx = sfx;
      }
    }
  }
  #resumeParkedMusic(state, channel) {
    if (state.main.sfx >= 0 || state.parkedMusicSfx < 0 || this.#music.pattern < 0)
      return;
    const sfx = state.parkedMusicSfx;
    const base = this.#sfxAddress(sfx);
    const speed = Math.max(1, this.#ram[base + 65]);
    let offset = this.#music.tick / speed;
    const loopStart = this.#ram[base + 66];
    const loopEnd = this.#ram[base + 67];
    if (loopEnd > loopStart && offset > loopStart) {
      offset = (offset - loopStart) % (loopEnd - loopStart) + loopStart;
    }
    state.parkedMusicSfx = -1;
    if (offset > NOTES_PER_SFX)
      return;
    this.#launch(state, channel, sfx, offset, 0, true);
  }
  #playP8sciiAudio(bytes) {
    let cursor = 0;
    let selected = -1;
    if (bytes[cursor] !== void 0 && bytes[cursor] >= 48 && bytes[cursor] <= 57) {
      selected = 0;
      for (let digits = 0; digits < 2; digits += 1) {
        const byte = bytes[cursor];
        if (byte === void 0 || byte < 48 || byte > 57)
          break;
        selected = selected * 10 + byte - 48;
        cursor += 1;
      }
      if (selected >= SFX_COUNT)
        return;
      if (cursor === bytes.byteLength) {
        this.sfx(selected << 16);
        return;
      }
    } else {
      selected = this.#selectEphemeralSfx();
      if (selected < 0)
        return;
    }
    const base = this.#sfxAddress(selected);
    this.#ram.fill(0, base, base + SFX_BYTES2);
    let speed = 16;
    let loopStart = 0;
    let loopEnd = 0;
    let instrument = 5;
    let volume = 5;
    let effect = 0;
    let octave = 3;
    let note = 0;
    while (cursor < bytes.byteLength && note < NOTES_PER_SFX) {
      const byte = bytes[cursor++];
      const lower = byte >= 65 && byte <= 90 ? byte + 32 : byte;
      if (lower === 115 && note === 0) {
        const value = bytes[cursor++];
        if (value !== void 0)
          speed = clamp(p8sciiParameter(value), 1, 255);
        continue;
      }
      if (lower === 108 && note === 0) {
        const start = bytes[cursor++];
        const end = bytes[cursor++];
        if (start !== void 0)
          loopStart = clamp(p8sciiParameter(start), 0, 31);
        if (end !== void 0)
          loopEnd = clamp(p8sciiParameter(end), 0, 32);
        continue;
      }
      if (lower === 105 || lower === 118 || lower === 120) {
        const value = bytes[cursor++];
        if (value === void 0)
          continue;
        const parsed = p8sciiParameter(value);
        if (lower === 105)
          instrument = clamp(parsed, 0, 7);
        else if (lower === 118)
          volume = clamp(parsed, 0, 7);
        else
          effect = clamp(parsed, 0, 7);
        continue;
      }
      if (lower === 60) {
        volume = Math.max(0, volume - 1);
        continue;
      }
      if (lower === 62) {
        volume = Math.min(7, volume + 1);
        continue;
      }
      if (lower === 46) {
        this.#writeP8sciiNote(base, note++, 0, instrument, 0, effect);
        continue;
      }
      const semitone = noteSemitone(lower);
      if (semitone < 0)
        continue;
      let adjusted = semitone;
      if (bytes[cursor] === 35) {
        adjusted += 1;
        cursor += 1;
      } else if (bytes[cursor] === 45) {
        adjusted -= 1;
        cursor += 1;
      }
      const octaveByte = bytes[cursor];
      if (octaveByte !== void 0 && octaveByte >= 48 && octaveByte <= 53) {
        octave = octaveByte - 48;
        cursor += 1;
      }
      this.#writeP8sciiNote(base, note++, clamp(octave * 12 + adjusted, 0, 63), instrument, volume, effect);
    }
    if (note === 0)
      this.#writeP8sciiNote(base, 0, octave * 12, instrument, volume, effect);
    this.#ram[base + 65] = speed;
    this.#ram[base + 66] = loopStart;
    this.#ram[base + 67] = loopEnd;
    this.sfx(selected << 16);
  }
  #selectEphemeralSfx() {
    for (let sfx = 60; sfx < 64; sfx += 1) {
      if (this.#channels.every((state) => state.main.sfx !== sfx))
        return sfx;
    }
    return -1;
  }
  #writeP8sciiNote(base, note, key, instrument, volume, effect) {
    const address = base + note * NOTE_BYTES;
    this.#ram[address] = key & 63 | (instrument & 3) << 6;
    this.#ram[address + 1] = instrument >>> 2 & 1 | (volume & 7) << 1 | (effect & 7) << 4;
  }
  #selectChannel(sfx) {
    for (let channel = 0; channel < this.#channels.length; channel += 1) {
      if ((this.#music.channelMask & 1 << channel) !== 0)
        continue;
      const playing = this.#channels[channel].main.sfx;
      if (playing === -1 || playing === sfx)
        return channel;
    }
    for (let channel = 0; channel < this.#channels.length; channel += 1) {
      if ((this.#music.channelMask & 1 << channel) !== 0)
        continue;
      if (this.#channels[channel].isMusic)
        return channel;
    }
    let selected = -1;
    let fastest = 256;
    for (let channel = 0; channel < this.#channels.length; channel += 1) {
      if ((this.#music.channelMask & 1 << channel) !== 0)
        continue;
      const playing = this.#channels[channel].main.sfx;
      if (playing < 0)
        continue;
      const speed = this.#ram[this.#sfxAddress(playing) + 65];
      if (speed <= fastest) {
        fastest = speed;
        selected = channel;
      }
    }
    return selected;
  }
  #renderSample() {
    if (this.#ram[SOUND_PAUSE] === 1)
      return 0;
    this.#advanceMusic();
    let mixed = 0;
    for (let channel = 0; channel < this.#channels.length; channel += 1) {
      mixed += this.#renderChannel(this.#channels[channel], channel);
    }
    return Math.trunc(clamp(mixed, -32767, 32767));
  }
  #renderChannel(state, channel) {
    this.#resumeParkedMusic(state, channel);
    const main = this.#prepareVoice(state.main, channel, 1, state.length, state.canLoop, false);
    let value = 0;
    let filters = 0;
    if (main !== void 0) {
      filters = main.filters;
      if (main.volume > 0) {
        if (main.custom) {
          const noteChanged = main.note !== state.lastMainNote || state.main.loopEpoch !== state.lastMainLoopEpoch;
          const retrigger = state.custom.sfx !== main.instrument || noteChanged && (main.key !== state.lastMainKey || state.lastMainVolume === 0 || main.effect === 3 || state.main.loopEpoch !== state.lastMainLoopEpoch);
          if (retrigger)
            this.#launchCustom(state, channel, main.instrument);
          const custom = this.#prepareVoice(state.custom, channel, main.frequency / keyToFrequency(24), 0, true, true);
          if (custom !== void 0 && custom.volume > 0) {
            filters = custom.filters;
            value = this.#sampleWaveform(custom, state.custom) * custom.volume * main.volume;
          }
          this.#advanceVoice(state.custom, channel, 0, true, false);
        } else {
          state.custom.sfx = -1;
          value = this.#sampleWaveform(main, state.main) * main.volume;
        }
      }
      state.lastMainNote = main.note;
      state.lastMainKey = main.key;
      state.lastMainVolume = main.volume;
      state.lastMainLoopEpoch = state.main.loopEpoch;
      this.#advanceVoice(state.main, channel, state.length, state.canLoop, state.isMusic);
    }
    const gain = state.isMusic ? MASTER_SFX_GAIN * this.#music.fadeVolume : MASTER_SFX_GAIN;
    value = clamp(value * gain, -1, 1);
    const reverbMode = Math.floor(filters / 24) % 3;
    const dampenMode = Math.floor(filters / 72) % 3;
    const hardwareReverb = this.#ram[AUDIO_REVERB];
    const hardwareLowpass = this.#ram[AUDIO_LOWPASS];
    const useReverb2 = reverbMode === 1 || (hardwareReverb & 1 << channel + 4) !== 0;
    const useReverb4 = reverbMode === 2 || (hardwareReverb & 1 << channel) !== 0;
    const reverbIndex2 = state.reverbIndex % state.reverb2.length;
    const reverbIndex4 = state.reverbIndex % state.reverb4.length;
    if (useReverb2)
      value += state.reverb2[reverbIndex2] * 0.5;
    if (useReverb4)
      value += state.reverb4[reverbIndex4] * 0.5;
    state.reverb2[reverbIndex2] = value;
    state.reverb4[reverbIndex4] = value;
    state.reverbIndex += 1;
    const damp1 = state.damp1.run(value);
    const damp2 = state.damp2.run(value);
    if (dampenMode === 1 || (hardwareLowpass & 1 << channel + 4) !== 0)
      value = damp1;
    if (dampenMode === 2 || (hardwareLowpass & 1 << channel) !== 0)
      value = damp2;
    let sample = Math.trunc(32767.99 * clamp(value, -0.99, 0.99));
    const distort = this.#ram[AUDIO_DISTORT];
    if ((distort & 1 << channel) !== 0) {
      sample = Math.trunc(sample / 4096) * 4681;
    } else if ((distort & 1 << channel + 4) !== 0) {
      sample = Math.trunc((sample - (sample < 0 ? 4096 : 0)) / 4096) * 4681;
    }
    return sample;
  }
  #prepareVoice(voice, channel, frequencyFactor, length, canLoop, ignoreCustom) {
    if (voice.sfx < 0 || voice.sfx >= SFX_COUNT || voice.offset < 0 || voice.offset >= NOTES_PER_SFX) {
      voice.sfx = -1;
      return void 0;
    }
    const note = Math.floor(voice.offset);
    const address = this.#sfxAddress(voice.sfx) + note * NOTE_BYTES;
    const byte0 = this.#ram[address];
    const byte1 = this.#ram[address + 1];
    const key = byte0 & 63;
    const instrument = byte0 >>> 6 | (byte1 & 1) << 2;
    const volumeValue = byte1 >>> 1 & 7;
    const effect = byte1 >>> 4 & 7;
    const filters = this.#ram[this.#sfxAddress(voice.sfx) + 64];
    const fraction = voice.offset - note;
    let volume = volumeValue / 7;
    let frequency = keyToFrequency(key) * frequencyFactor;
    if (volume > 0) {
      switch (effect) {
        case 1:
          frequency = keyToFrequency(voice.previousKey) * frequencyFactor * (1 - fraction) + frequency * fraction;
          if (voice.previousVolume > 0) {
            volume = voice.previousVolume * (1 - fraction) + volume * fraction;
          }
          break;
        case 2: {
          const cycle = voice.elapsed * 7.5 / PICO_AUDIO_SAMPLE_RATE;
          const triangle = 1 - 4 * Math.abs(cycle % 1 - 0.5);
          frequency *= 2 ** (triangle * 0.5 / 12);
          break;
        }
        case 3:
          frequency *= 1 - fraction;
          break;
        case 4:
          volume *= fraction;
          break;
        case 5:
          volume *= 1 - fraction;
          break;
        case 6:
        case 7: {
          const speed = Math.max(1, this.#ram[this.#sfxAddress(voice.sfx) + 65]);
          const subdivisions = effect === 6 ? speed <= 8 ? 2 : 4 : speed <= 8 ? 4 : 8;
          const arpNote = note & ~3 | Math.floor(fraction * subdivisions) & 3;
          const arpAddress = this.#sfxAddress(voice.sfx) + arpNote * NOTE_BYTES;
          frequency = keyToFrequency(this.#ram[arpAddress] & 63) * frequencyFactor;
          break;
        }
      }
    }
    if ((this.#ram[AUDIO_HALF_RATE] & 1 << channel + 4) !== 0)
      frequency *= 0.5;
    return {
      note,
      key,
      instrument,
      custom: !ignoreCustom && (byte1 & 128) !== 0,
      effect,
      filters,
      frequency,
      volume
    };
  }
  #advanceVoice(voice, channel, length, canLoop, isMusic) {
    if (voice.sfx < 0)
      return;
    const base = this.#sfxAddress(voice.sfx);
    const speed = Math.max(1, this.#ram[base + 65]);
    const rateScale = (this.#ram[AUDIO_HALF_RATE] & 1 << channel) !== 0 ? 0.5 : 1;
    const step = rateScale / (NOTE_SAMPLES_PER_SPEED * speed);
    const oldNote = Math.floor(voice.offset);
    let nextOffset = voice.offset + step;
    voice.time += step;
    voice.elapsed += 1;
    const loopStart = this.#ram[base + 66];
    const loopEnd = this.#ram[base + 67];
    if (canLoop && loopEnd > loopStart && nextOffset >= loopEnd) {
      nextOffset = (nextOffset - loopStart) % (loopEnd - loopStart) + loopStart;
      voice.loopEpoch += 1;
    }
    if (Math.floor(nextOffset) !== oldNote && oldNote >= 0 && oldNote < NOTES_PER_SFX) {
      const noteAddress = base + oldNote * NOTE_BYTES;
      voice.previousKey = this.#ram[noteAddress] & 63;
      voice.previousVolume = (this.#ram[noteAddress + 1] >>> 1 & 7) / 7;
    }
    voice.offset = nextOffset;
    let end = NOTES_PER_SFX;
    if (length > 0)
      end = Math.min(end, length);
    if (!isMusic && loopEnd === 0 && loopStart > 0)
      end = Math.min(end, loopStart);
    if (!isMusic && !(canLoop && loopEnd > loopStart)) {
      end = Math.min(end, this.#lastAudibleNote(voice.sfx));
    }
    if (voice.time >= end || voice.offset >= NOTES_PER_SFX)
      voice.sfx = -1;
  }
  #sampleWaveform(parameters, voice) {
    const primary = this.#waveform(parameters.instrument, parameters.key, parameters.filters, voice, 1);
    const detune = Math.floor(parameters.filters / 8) % 3;
    let waveform = primary;
    if (detune !== 0 && parameters.instrument !== 6) {
      let factor;
      if (parameters.instrument === 0)
        factor = detune === 1 ? 3 / 4 : 3 / 2;
      else if (parameters.instrument === 5)
        factor = detune === 1 ? 200 / 199 : 800 / 199;
      else if (parameters.instrument === 7)
        factor = detune === 1 ? 49 / 50 : 400 / 199;
      else
        factor = detune === 1 ? 200 / 199 : 400 / 199;
      const secondInstrument = detune === 2 && parameters.instrument === 5 ? 0 : parameters.instrument;
      waveform += this.#waveform(secondInstrument, parameters.key, parameters.filters, voice, factor) * 0.5;
    }
    voice.phase += parameters.frequency / PICO_AUDIO_SAMPLE_RATE;
    if (voice.phase >= 4096)
      voice.phase %= 1;
    return waveform;
  }
  #waveform(instrument, key, filters, voice, phaseFactor) {
    const phase = voice.phase * phaseFactor;
    const t = phase - Math.floor(phase);
    const noiseMode = (filters & 2) !== 0;
    const buzz = (filters & 4) !== 0;
    switch (instrument) {
      case 0: {
        let result = 1 - Math.abs(4 * t - 2);
        if (buzz) {
          const edge = 0.875;
          const tilted = t < edge ? 2 * t / edge - 1 : 2 * (1 - t) / (1 - edge) - 1;
          result = result * 0.75 + tilted * 0.25;
        }
        return result * 0.5;
      }
      case 1: {
        const edge = buzz ? 0.975 : 0.875;
        return (t < edge ? 2 * t / edge - 1 : 2 * (1 - t) / (1 - edge) - 1) * 0.5;
      }
      case 2: {
        let result = t < 0.5 ? t : t - 1;
        if (buzz)
          result = result * 0.83 - (Math.abs(phase % 2 - 1) < 0.5 ? 0.085 : 0);
        return result * 0.653;
      }
      case 3:
        return t < (buzz ? 0.4 : 0.5) ? 0.25 : -0.25;
      case 4:
        return t < (buzz ? 0.255 : 0.316) ? 0.25 : -0.25;
      case 5: {
        let result = t < 0.5 ? 3 - Math.abs(24 * t - 6) : 1 - Math.abs(16 * t - 12);
        if (buzz) {
          result = t < 0.5 ? result * 2 + 3 : result;
          result = t < 0.5 && result > -1.875 ? result * 0.2 - 1 : result + 0.5;
        }
        return result / 9;
      }
      case 6: {
        let state = voice.noiseState >>> 0;
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        voice.noiseState = state >>> 0 || BASE_NOISE_SEED;
        const random = voice.noiseState / 2147483647 - 1;
        const smoothing = clamp(keyToFrequency(key) * 8.858923 / PICO_AUDIO_SAMPLE_RATE, 0, 1);
        voice.noiseValue += (random - voice.noiseValue) * smoothing;
        let result = voice.noiseValue * 1.5 * (1 + (1 - key / 63) ** 2);
        if (noiseMode)
          result *= 2 * (t < 0.5 ? t : t - 1);
        return result;
      }
      case 7: {
        let result = 2 - Math.abs(8 * t - 4);
        result += 1 - Math.abs(4 * (phase * 109 / 110 % 1) - 2);
        if (buzz) {
          result += 0.25 - Math.abs((phase * 2 + 0.5) % 1 - 0.5);
          result += 0.125 - Math.abs(0.5 * (phase * 4 % 1) - 0.25);
        }
        return result / 6;
      }
      default:
        return 0;
    }
  }
  #sfxAddress(sfx) {
    return SFX_BASE + sfx * SFX_BYTES2;
  }
  #hasLoop(sfx) {
    const base = this.#sfxAddress(sfx);
    return this.#ram[base + 67] > this.#ram[base + 66];
  }
  #lastAudibleNote(sfx) {
    const base = this.#sfxAddress(sfx);
    let last = 0;
    for (let note = 0; note < NOTES_PER_SFX; note += 1) {
      if ((this.#ram[base + note * NOTE_BYTES + 1] >>> 1 & 7) !== 0)
        last = note + 1;
    }
    return last;
  }
};

// packages/runtime-core/dist/cart/cart-data-range.js
function rawInteger(raw, fallback) {
  return raw === void 0 ? fallback : raw >> 16;
}
function ramAddress(raw) {
  return rawInteger(raw, 0) & 65535;
}
function cartOffset(raw) {
  return rawInteger(raw, 0);
}
function byteLength(raw) {
  return rawInteger(raw, PICO_CART_DATA_ROM_SIZE);
}
function assertRange(label, offset, length, limit) {
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset > limit || length > limit - offset) {
    throw new RangeError(`${label} range is out of bounds`);
  }
}
function normalizeReloadRange(destinationRaw, sourceRaw, lengthRaw) {
  const destination = ramAddress(destinationRaw);
  const source = cartOffset(sourceRaw);
  const length = byteLength(lengthRaw);
  assertRange("reload Base RAM destination", destination, length, PICO_RAM_SIZE);
  assertRange("reload cart ROM source", source, length, PICO_CART_DATA_ROM_SIZE);
  return Object.freeze({ destination, source, length });
}
function normalizeCstoreRange(destinationRaw, sourceRaw, lengthRaw) {
  const destination = cartOffset(destinationRaw);
  const source = ramAddress(sourceRaw);
  const length = byteLength(lengthRaw);
  assertRange("cstore cart ROM destination", destination, length, PICO_CART_DATA_ROM_SIZE);
  assertRange("cstore Base RAM source", source, length, PICO_RAM_SIZE);
  return Object.freeze({ destination, source, length });
}

// packages/runtime-core/dist/cart/cart-resolution.js
var CART_RESOLUTION_ERROR_CODES = Object.freeze({
  invalidRef: "E_CART_REF_INVALID",
  invalidSource: "E_CART_SOURCE_INVALID",
  sourceTooLarge: "E_CART_SOURCE_TOO_LARGE",
  bundleLimit: "E_CART_BUNDLE_LIMIT",
  duplicateRef: "E_CART_DUPLICATE_REF",
  notFound: "E_CART_NOT_FOUND",
  accessDenied: "E_CART_ACCESS_DENIED",
  cancelled: "E_CART_CANCELLED",
  disposed: "E_CART_RESOLVER_DISPOSED"
});
var CartResolutionError = class extends Error {
  code;
  constructor(code, message2) {
    super(message2);
    this.name = "CartResolutionError";
    this.code = code;
  }
};
function utf8ByteLength2(value) {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 127) {
      bytes += 1;
    } else if (unit <= 2047) {
      bytes += 2;
    } else if (unit >= 55296 && unit <= 56319 && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 56320 && next <= 57343) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
    if (bytes > PICO_CART_REF_MAX_BYTES)
      return bytes;
  }
  return bytes;
}
function assertCartRef(ref) {
  if (typeof ref !== "string" || ref.length === 0 || ref.includes("\0")) {
    throw new CartResolutionError(CART_RESOLUTION_ERROR_CODES.invalidRef, "cart ref must be a non-empty string without NUL bytes");
  }
  if (utf8ByteLength2(ref) > PICO_CART_REF_MAX_BYTES) {
    throw new CartResolutionError(CART_RESOLUTION_ERROR_CODES.invalidRef, `cart ref exceeds ${PICO_CART_REF_MAX_BYTES} UTF-8 bytes`);
  }
  return ref;
}
function assertCartResolvePurpose(purpose) {
  if (!["load", "reload", "cstore", "include"].includes(purpose)) {
    throw new CartResolutionError(CART_RESOLUTION_ERROR_CODES.accessDenied, "cart resolve purpose is not recognized");
  }
  return purpose;
}
function copyCartAccess(access) {
  if (access === null || typeof access !== "object" || typeof access.load !== "boolean" || typeof access.reloadData !== "boolean" || typeof access.cstoreData !== "boolean" || typeof access.include !== "boolean") {
    throw new CartResolutionError(CART_RESOLUTION_ERROR_CODES.accessDenied, "cart access must contain four explicit boolean capabilities");
  }
  return Object.freeze({
    load: access.load,
    reloadData: access.reloadData,
    cstoreData: access.cstoreData,
    include: access.include
  });
}
function assertCartAccessForPurpose(access, purpose) {
  const checkedPurpose = assertCartResolvePurpose(purpose);
  const allowed = checkedPurpose === "load" ? access.load : checkedPurpose === "reload" ? access.reloadData : checkedPurpose === "cstore" ? access.cstoreData : access.include;
  if (!allowed) {
    throw new CartResolutionError(CART_RESOLUTION_ERROR_CODES.accessDenied, `cart access denies ${checkedPurpose}`);
  }
}
function copyResolvedCartSource(source) {
  if (source === null || typeof source !== "object") {
    throw new CartResolutionError(CART_RESOLUTION_ERROR_CODES.invalidSource, "resolver must return a cart source object");
  }
  const ref = assertCartRef(source.ref);
  if (!(source.bytes instanceof Uint8Array) || source.bytes.byteLength === 0) {
    throw new CartResolutionError(CART_RESOLUTION_ERROR_CODES.invalidSource, "resolved cart source must contain bytes");
  }
  if (source.bytes.byteLength > PICO_CART_INPUT_MAX_BYTES) {
    throw new CartResolutionError(CART_RESOLUTION_ERROR_CODES.sourceTooLarge, `resolved cart source exceeds ${PICO_CART_INPUT_MAX_BYTES} bytes`);
  }
  return Object.freeze({
    ref,
    bytes: source.bytes.slice(),
    access: copyCartAccess(source.access)
  });
}
function throwIfCartCancelled(cancellation) {
  if (cancellation.cancelled) {
    throw new CartResolutionError(CART_RESOLUTION_ERROR_CODES.cancelled, "cart resolution was cancelled");
  }
}
var CartCancellationSource = class {
  token;
  #listeners = /* @__PURE__ */ new Set();
  #cancelled = false;
  constructor() {
    const owner = this;
    this.token = Object.freeze({
      get cancelled() {
        return owner.#cancelled;
      },
      onCancel(listener) {
        return owner.#subscribe(listener);
      }
    });
  }
  cancel() {
    if (this.#cancelled)
      return;
    this.#cancelled = true;
    const listeners = [...this.#listeners];
    this.#listeners.clear();
    for (const listener of listeners) {
      try {
        listener();
      } catch {
      }
    }
  }
  #subscribe(listener) {
    if (typeof listener !== "function") {
      throw new TypeError("cart cancellation listener must be a function");
    }
    if (this.#cancelled) {
      listener();
      return () => void 0;
    }
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
};

// packages/runtime-core/dist/cart/cart-loader.js
var CartLoader = class {
  #resolver;
  #repository;
  constructor(resolver, repository) {
    this.#resolver = resolver;
    this.#repository = repository;
  }
  async load(ref, context, cancellation) {
    const requestedRef = assertCartRef(ref);
    const purpose = assertCartResolvePurpose(context.purpose);
    throwIfCartCancelled(cancellation);
    const resolved = copyResolvedCartSource(await this.#resolver.resolve(requestedRef, context, cancellation));
    throwIfCartCancelled(cancellation);
    if (resolved.ref !== requestedRef) {
      throw new CartResolutionError(CART_RESOLUTION_ERROR_CODES.invalidRef, "resolver returned bytes for a different cart ref");
    }
    const access = copyCartAccess(resolved.access);
    assertCartAccessForPurpose(access, purpose);
    const decoded = decodeCart(resolved.bytes);
    throwIfCartCancelled(cancellation);
    this.#repository.put(decoded);
    const cart = this.#repository.get(decoded.identity);
    if (cart === void 0) {
      throw new Error("cart repository did not retain the decoded cart");
    }
    return Object.freeze({ ref: requestedRef, cart, access });
  }
};

// packages/runtime-core/dist/cart/cart-request-codec.js
function invalidCartRequest(kind, message2) {
  throw new RangeError(`invalid ${kind} request: ${message2}`);
}
function decodeCartRequestRef(kind, bytes) {
  const invalid4 = (message2) => invalidCartRequest(kind, message2);
  const output = [];
  const continuation = (index) => {
    const byte = bytes[index];
    if (byte === void 0 || (byte & 192) !== 128) {
      return invalid4("ref is not valid UTF-8");
    }
    return byte & 63;
  };
  for (let index = 0; index < bytes.length; ) {
    const first = bytes[index++];
    let codePoint = 0;
    if (first <= 127) {
      codePoint = first;
    } else if (first >= 194 && first <= 223) {
      codePoint = (first & 31) << 6 | continuation(index++);
    } else if (first >= 224 && first <= 239) {
      const second = continuation(index++);
      const third = continuation(index++);
      if (first === 224 && second < 32 || first === 237 && second >= 32) {
        invalid4("ref is not valid UTF-8");
      }
      codePoint = (first & 15) << 12 | second << 6 | third;
    } else if (first >= 240 && first <= 244) {
      const second = continuation(index++);
      const third = continuation(index++);
      const fourth = continuation(index++);
      if (first === 240 && second < 16 || first === 244 && second >= 16) {
        invalid4("ref is not valid UTF-8");
      }
      codePoint = (first & 7) << 18 | second << 12 | third << 6 | fourth;
    } else {
      invalid4("ref is not valid UTF-8");
    }
    output.push(String.fromCodePoint(codePoint));
  }
  const ref = output.join("");
  if (ref.length === 0 || ref.includes("\0"))
    invalid4("ref is empty or contains NUL");
  return ref;
}

// packages/runtime-core/dist/cart/external-cart-data-request.js
var EXTERNAL_CART_DATA_REQUEST_MAGIC = Object.freeze([80, 56, 87, 68]);
var EXTERNAL_CART_DATA_REQUEST_VERSION = 1;
var EXTERNAL_CART_DATA_REQUEST_HEADER_BYTES = 24;
var RELOAD_OPERATION = 1;
var CSTORE_OPERATION = 2;
var DESTINATION_PRESENT = 1 << 0;
var SOURCE_PRESENT = 1 << 1;
var LENGTH_PRESENT = 1 << 2;
var REFERENCE_PRESENT = 1 << 3;
var KNOWN_FLAGS = DESTINATION_PRESENT | SOURCE_PRESENT | LENGTH_PRESENT | REFERENCE_PRESENT;
function invalid(message2) {
  return invalidCartRequest("external cart-data", message2);
}
function isExternalCartDataRequestPayload(bytes) {
  return bytes.byteLength >= EXTERNAL_CART_DATA_REQUEST_MAGIC.length && EXTERNAL_CART_DATA_REQUEST_MAGIC.every((byte, index) => bytes[index] === byte);
}
function decodeExternalCartDataRequest(bytes) {
  if (!(bytes instanceof Uint8Array))
    invalid("payload must be a Uint8Array");
  if (bytes.byteLength > PICO_HOST_REQUEST_MAX_BYTES)
    invalid("payload exceeds 4096 bytes");
  if (bytes.byteLength < EXTERNAL_CART_DATA_REQUEST_HEADER_BYTES)
    invalid("payload is truncated");
  if (!isExternalCartDataRequestPayload(bytes))
    invalid("magic does not match");
  if (bytes[4] !== EXTERNAL_CART_DATA_REQUEST_VERSION)
    invalid("version is unsupported");
  const operation = bytes[5] === RELOAD_OPERATION ? "reload" : bytes[5] === CSTORE_OPERATION ? "cstore" : invalid("operation is unsupported");
  const flags = bytes[6];
  if ((flags & ~KNOWN_FLAGS) !== 0 || (flags & REFERENCE_PRESENT) === 0 || bytes[7] !== 0) {
    invalid("flags are not canonical");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rawSlots = [view.getInt32(8, true), view.getInt32(12, true), view.getInt32(16, true)];
  const scalarFlags = [DESTINATION_PRESENT, SOURCE_PRESENT, LENGTH_PRESENT];
  for (let index = 0; index < rawSlots.length; index += 1) {
    if ((flags & scalarFlags[index]) === 0 && rawSlots[index] !== 0) {
      invalid("absent scalar slot is not zero");
    }
  }
  const refLength = view.getUint16(20, true);
  if (view.getUint16(22, true) !== 0)
    invalid("reserved field is not zero");
  if (refLength === 0 || refLength > PICO_CART_REF_MAX_BYTES)
    invalid("ref length is invalid");
  if (EXTERNAL_CART_DATA_REQUEST_HEADER_BYTES + refLength !== bytes.byteLength) {
    invalid("payload length is not canonical");
  }
  const ref = decodeCartRequestRef("external cart-data", bytes.subarray(EXTERNAL_CART_DATA_REQUEST_HEADER_BYTES));
  return Object.freeze({
    operation,
    ref,
    ...(flags & DESTINATION_PRESENT) === 0 ? {} : { destinationRaw: rawSlots[0] },
    ...(flags & SOURCE_PRESENT) === 0 ? {} : { sourceRaw: rawSlots[1] },
    ...(flags & LENGTH_PRESENT) === 0 ? {} : { lengthRaw: rawSlots[2] }
  });
}

// packages/runtime-core/dist/cart/guest-cart-request.js
var GUEST_CART_REQUEST_MAGIC = Object.freeze([80, 56, 87, 76]);
var GUEST_CART_REQUEST_VERSION = 1;
var GUEST_CART_REQUEST_HEADER_BYTES = 16;
var LOAD_OPERATION = 1;
var BREADCRUMB_PRESENT = 1 << 0;
var PARAMETER_PRESENT = 1 << 1;
var KNOWN_FLAGS2 = BREADCRUMB_PRESENT | PARAMETER_PRESENT;
function invalid2(message2) {
  return invalidCartRequest("guest cart", message2);
}
function isGuestCartRequestPayload(bytes) {
  return bytes.byteLength >= GUEST_CART_REQUEST_MAGIC.length && GUEST_CART_REQUEST_MAGIC.every((byte, index) => bytes[index] === byte);
}
function decodeGuestCartLoadRequest(bytes) {
  if (!(bytes instanceof Uint8Array))
    invalid2("payload must be a Uint8Array");
  if (bytes.byteLength > PICO_HOST_REQUEST_MAX_BYTES)
    invalid2("payload exceeds 4096 bytes");
  if (bytes.byteLength < GUEST_CART_REQUEST_HEADER_BYTES)
    invalid2("payload is truncated");
  if (!isGuestCartRequestPayload(bytes))
    invalid2("magic does not match");
  if (bytes[4] !== GUEST_CART_REQUEST_VERSION)
    invalid2("version is unsupported");
  if (bytes[5] !== LOAD_OPERATION)
    invalid2("operation is unsupported");
  const flags = bytes[6];
  if ((flags & ~KNOWN_FLAGS2) !== 0 || bytes[7] !== 0)
    invalid2("flags are not canonical");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const refLength = view.getUint16(8, true);
  const breadcrumbLength = view.getUint16(10, true);
  const parameterLength = view.getUint16(12, true);
  if (view.getUint16(14, true) !== 0)
    invalid2("reserved field is not zero");
  if (refLength === 0 || refLength > PICO_CART_REF_MAX_BYTES)
    invalid2("ref length is invalid");
  if ((flags & BREADCRUMB_PRESENT) === 0 && breadcrumbLength !== 0) {
    invalid2("breadcrumb presence is inconsistent");
  }
  if ((flags & PARAMETER_PRESENT) === 0 && parameterLength !== 0) {
    invalid2("parameter presence is inconsistent");
  }
  const expectedLength = GUEST_CART_REQUEST_HEADER_BYTES + refLength + breadcrumbLength + parameterLength;
  if (expectedLength !== bytes.byteLength)
    invalid2("payload length is not canonical");
  const refStart = GUEST_CART_REQUEST_HEADER_BYTES;
  const ref = decodeCartRequestRef("guest cart", bytes.subarray(refStart, refStart + refLength));
  const breadcrumbStart = refStart + refLength;
  const parameterStart = breadcrumbStart + breadcrumbLength;
  return Object.freeze({
    operation: "load",
    ref,
    ...(flags & BREADCRUMB_PRESENT) === 0 ? {} : {
      breadcrumb: bytes.slice(breadcrumbStart, parameterStart)
    },
    ...(flags & PARAMETER_PRESENT) === 0 ? {} : {
      parameter: bytes.slice(parameterStart)
    }
  });
}

// packages/runtime-core/dist/input/l1-input.js
var DEVKIT_MODE = 24365;
var PLAYER_ZERO_BUTTONS = 24396;
var BTNP_REPEAT_DELAY = 24412;
var BTNP_REPEAT_INTERVAL = 24413;
var DEFAULT_REPEAT_DELAY = 15;
var DEFAULT_REPEAT_INTERVAL = 4;
var DISABLE_REPEAT = 255;
var DEVKIT_ENABLE = 1;
var DEVKIT_MOUSE_BUTTONS = 2;
var DEVKIT_FLAG_MASK = 7;
var DEVKIT_BUTTON_COUNT = 7;
function normalizeControllers(input) {
  if (!Array.isArray(input.controllers) || input.controllers.length !== PICO_CONTROLLER_COUNT) {
    throw new RangeError("input controllers must contain exactly eight player masks");
  }
  for (const buttons of input.controllers) {
    if (!Number.isInteger(buttons) || buttons < 0 || buttons > PICO_CONTROLLER_BUTTON_MASK) {
      throw new RangeError("each input controller must be a six-bit button mask");
    }
  }
  return input.controllers;
}
function signedInt32(value) {
  return Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
}
function normalizeDevkitInput(input) {
  const devkit = input.devkit;
  if (typeof devkit !== "object" || devkit === null || !signedInt32(devkit.mouseXRaw) || !signedInt32(devkit.mouseYRaw) || !Number.isInteger(devkit.mouseButtons) || devkit.mouseButtons < 0 || devkit.mouseButtons > 7 || !signedInt32(devkit.wheelRaw) || !signedInt32(devkit.movementXRaw) || !signedInt32(devkit.movementYRaw) || !Array.isArray(devkit.keypresses) || devkit.keypresses.length > PICO_DEVKIT_KEYPRESS_BATCH_LIMIT || devkit.keypresses.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new RangeError("input devkit batch is malformed");
  }
  return devkit;
}
function normalizeInputSnapshot(input) {
  normalizeControllers(input);
  normalizeDevkitInput(input);
  return input;
}
var L1Input = class {
  #ram;
  #heldTicks = Array.from({ length: PICO_CONTROLLER_COUNT }, () => new Array(DEVKIT_BUTTON_COUNT).fill(0));
  #pressedMasks = new Uint8Array(PICO_CONTROLLER_COUNT);
  #keypressQueue = [];
  #devkitFlags = 0;
  #mouseXRaw = 0;
  #mouseYRaw = 0;
  #mouseButtons = 0;
  #wheelRaw = 0;
  #movementXRaw = 0;
  #movementYRaw = 0;
  #targetFps = 30;
  constructor(ram) {
    this.#ram = ram;
  }
  reset() {
    for (const player of this.#heldTicks)
      player.fill(0);
    this.#pressedMasks.fill(0);
    this.#ram.fill(0, PLAYER_ZERO_BUTTONS, PLAYER_ZERO_BUTTONS + PICO_CONTROLLER_COUNT);
    this.#ram[BTNP_REPEAT_DELAY] = 0;
    this.#ram[BTNP_REPEAT_INTERVAL] = 0;
    this.#ram[DEVKIT_MODE] = 0;
    this.#clearDevkitState();
    this.#targetFps = 30;
  }
  beginTick(input, targetFps) {
    const controllers = normalizeControllers(input);
    const devkit = normalizeDevkitInput(input);
    if (targetFps !== 30 && targetFps !== 60) {
      throw new RangeError("input targetFps must be 30 or 60");
    }
    this.#targetFps = targetFps;
    const configuredDelay = this.#ram[BTNP_REPEAT_DELAY];
    const configuredInterval = this.#ram[BTNP_REPEAT_INTERVAL];
    const rateScale = targetFps / 30;
    const repeatDisabled = configuredDelay === DISABLE_REPEAT;
    const delay = (configuredDelay === 0 ? DEFAULT_REPEAT_DELAY : configuredDelay) * rateScale;
    const interval = (configuredInterval === 0 ? DEFAULT_REPEAT_INTERVAL : configuredInterval) * rateScale;
    this.#devkitFlags = this.#ram[DEVKIT_MODE] & DEVKIT_FLAG_MASK;
    if ((this.#devkitFlags & DEVKIT_ENABLE) !== 0) {
      this.#mouseXRaw = devkit.mouseXRaw | 0;
      this.#mouseYRaw = devkit.mouseYRaw | 0;
      this.#mouseButtons = devkit.mouseButtons;
      this.#wheelRaw = devkit.wheelRaw | 0;
      this.#movementXRaw = devkit.movementXRaw | 0;
      this.#movementYRaw = devkit.movementYRaw | 0;
      for (const byte of devkit.keypresses) {
        if (this.#keypressQueue.length >= PICO_DEVKIT_KEYPRESS_BATCH_LIMIT)
          break;
        this.#keypressQueue.push(byte);
      }
    } else {
      this.#clearDevkitState();
    }
    for (let player = 0; player < PICO_CONTROLLER_COUNT; player += 1) {
      const mouseOverlay = player === 0 && (this.#devkitFlags & (DEVKIT_ENABLE | DEVKIT_MOUSE_BUTTONS)) === (DEVKIT_ENABLE | DEVKIT_MOUSE_BUTTONS) ? this.#mouseButtons << 4 : 0;
      const buttons = controllers[player] | mouseOverlay;
      const heldTicksForPlayer = this.#heldTicks[player];
      let pressedMask = 0;
      const buttonCount = player === 0 ? DEVKIT_BUTTON_COUNT : PICO_CONTROLLER_BUTTON_COUNT;
      for (let button2 = 0; button2 < buttonCount; button2 += 1) {
        const bit = 1 << button2;
        if ((buttons & bit) === 0) {
          heldTicksForPlayer[button2] = 0;
          continue;
        }
        const heldTicks = (heldTicksForPlayer[button2] ?? 0) + 1;
        heldTicksForPlayer[button2] = heldTicks;
        if (heldTicks === 1 || !repeatDisabled && heldTicks > delay && (heldTicks - delay - 1) % interval === 0) {
          pressedMask |= bit;
        }
      }
      this.#pressedMasks[player] = pressedMask;
      this.#ram[PLAYER_ZERO_BUTTONS + player] = buttons;
    }
  }
  btn(buttonRaw, playerRaw) {
    if (buttonRaw === void 0) {
      const playerZeroMask = this.#mouseButtonsEnabled() ? (1 << DEVKIT_BUTTON_COUNT) - 1 : PICO_CONTROLLER_BUTTON_MASK;
      return this.#ram[PLAYER_ZERO_BUTTONS] & playerZeroMask | (this.#ram[PLAYER_ZERO_BUTTONS + 1] & PICO_CONTROLLER_BUTTON_MASK) << 8;
    }
    const button2 = q16Integer2(buttonRaw);
    const player = playerRaw === void 0 ? 0 : q16Integer2(playerRaw);
    return this.#validButton(button2, player) && (this.#ram[PLAYER_ZERO_BUTTONS + player] & 1 << button2) !== 0 ? 1 : 0;
  }
  btnp(buttonRaw, playerRaw) {
    if (buttonRaw === void 0) {
      return this.#pressedMasks[0] | (this.#pressedMasks[1] & PICO_CONTROLLER_BUTTON_MASK) << 8;
    }
    const button2 = q16Integer2(buttonRaw);
    const player = playerRaw === void 0 ? 0 : q16Integer2(playerRaw);
    return this.#validButton(button2, player) && (this.#pressedMasks[player] & 1 << button2) !== 0 ? 1 : 0;
  }
  stat(selectorRaw) {
    const selector = q16Integer2(selectorRaw);
    if (selector === 8 || selector === 9)
      return this.#targetFps << 16;
    if ((this.#devkitFlags & DEVKIT_ENABLE) === 0) {
      return selector === 31 ? -1 : 0;
    }
    switch (selector) {
      case 30:
        return this.#keypressQueue.length === 0 ? 0 : 1;
      case 31:
        return this.#keypressQueue.shift() ?? -1;
      case 32:
        return this.#mouseXRaw;
      case 33:
        return this.#mouseYRaw;
      case 34:
        return this.#mouseButtons;
      case 36:
        return this.#wheelRaw;
      case 38:
        return this.#movementXRaw;
      case 39:
        return this.#movementYRaw;
      default:
        return 0;
    }
  }
  get devkitFlags() {
    return this.#ram[DEVKIT_MODE] & DEVKIT_FLAG_MASK;
  }
  #mouseButtonsEnabled() {
    return (this.#devkitFlags & (DEVKIT_ENABLE | DEVKIT_MOUSE_BUTTONS)) === (DEVKIT_ENABLE | DEVKIT_MOUSE_BUTTONS);
  }
  #validButton(button2, player) {
    if (player < 0 || player >= PICO_CONTROLLER_COUNT || button2 < 0)
      return false;
    if (button2 < PICO_CONTROLLER_BUTTON_COUNT)
      return true;
    return player === 0 && button2 === 6 && this.#mouseButtonsEnabled();
  }
  #clearDevkitState() {
    this.#keypressQueue.length = 0;
    this.#devkitFlags = 0;
    this.#mouseXRaw = 0;
    this.#mouseYRaw = 0;
    this.#mouseButtons = 0;
    this.#wheelRaw = 0;
    this.#movementXRaw = 0;
    this.#movementYRaw = 0;
  }
};
function q16Integer2(raw) {
  return raw >> 16;
}

// packages/runtime-core/dist/graphics/map-memory.js
var MAP_BASE_REGISTER = 24406;
var MAP_WIDTH_REGISTER = 24407;
var LOWER_MAP_START = 4096;
var LOWER_MAP_BYTES = 8192;
var RAM_END = 65536;
var DEFAULT_MAP_BASE_PAGE = 32;
var PicoMapMemory = class {
  #ram;
  constructor(memory) {
    this.#ram = memory.physicalBytes;
  }
  layout() {
    const configuredBase = this.#ram[MAP_BASE_REGISTER];
    const width = this.#ram[MAP_WIDTH_REGISTER] || 256;
    if (configuredBase >= 128) {
      const byteLength2 = RAM_END - configuredBase * 256;
      return {
        basePage: configuredBase,
        width,
        height: Math.floor(byteLength2 / width),
        byteLength: byteLength2,
        upper: true
      };
    }
    const basePage = normalizeLowerBase(configuredBase);
    return {
      basePage,
      width,
      height: Math.floor(LOWER_MAP_BYTES / width),
      byteLength: LOWER_MAP_BYTES,
      upper: false
    };
  }
  read(x, y) {
    const address = this.address(x, y);
    return address === void 0 ? void 0 : this.#ram[address];
  }
  write(x, y, value) {
    const address = this.address(x, y);
    if (address === void 0)
      return false;
    this.#ram[address] = value & 255;
    return true;
  }
  address(x, y) {
    const layout = this.layout();
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= layout.width || y < 0 || y >= layout.height) {
      return void 0;
    }
    const index = y * layout.width + x;
    if (layout.upper)
      return layout.basePage * 256 + index;
    const baseOffset = (layout.basePage - 16) * 256;
    return LOWER_MAP_START + (baseOffset + index & LOWER_MAP_BYTES - 1);
  }
};
function normalizeLowerBase(configuredBase) {
  if (configuredBase >= 16 && configuredBase <= 47)
    return configuredBase;
  if (configuredBase >= 48 && configuredBase <= 63)
    return configuredBase - 32;
  return DEFAULT_MAP_BASE_PAGE;
}

// packages/runtime-core/dist/graphics/p8scii-font.js
var DEFAULT_FONT_HEX = `
04080500000001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
07070707070000000007070700000000000705070000000000050205000000000005000500000000000505050000000004060706040000000103070301000000
07010101000000000004040407000000050702070200000000000200000000000000000102000000000000030300000005050000000000000205020000000000
00000000000000000202020002000000050500000000000005070507050000000703060702000000050402010500000003030305070000000201000000000000
02010101020000000204040402000000050207020500000000020702000000000000000201000000000007000000000000000000020000000402020201000000
07050505070000000302020207000000070407010700000007040604070000000505070404000000070107040700000001010705070000000704040404000000
07050705070000000705070404000000000200020000000000020002010000000402010204000000000700070000000001020402010000000704060002000000
02050501060000000007050705000000000303050700000000070101070000000003050503000000000703010700000000070301010000000007010507000000
00050507050000000007020207000000000702020300000000050305050000000001010107000000000707050500000000030505050000000006050503000000
00070507010000000002050306000000000705030500000000060104030000000007020202000000000505050600000000050507020000000005050707000000
00050205050000000005070407000000000704010700000003010101030000000102020204000000060404040600000002050000000000000000000007000000
02040000000000000705070505000000070503050700000006010101060000000305050507000000070103010700000007010301010000000601010507000000
05050705050000000702020207000000070202020300000005050305050000000101010107000000070705050500000003050505050000000605050503000000
07050701010000000205050306000000070503050500000006010704030000000702020202000000050505050600000005050507020000000505050707000000
05050205050000000505070407000000070402010700000006020302060000000202020202000000030206020300000000040701000000000002050507000000
7f7f7f7f7f000000552a552a55000000417f5d5d3e0000003e6363773e0000001144114411000000043c1c1e100000001c2e3e3e1c000000363e3e1c08000000
1c3677361c0000001c1c3e1c140000001c3e7f2a3a0000003e6763673e0000007f5d7f417f0000003808080e0e0000003e636b633e000000081c3e1c08000000
00005500000000003e7363733e000000081c7f3e220000003e1c081c3e0000003e7763633e000000000552200000000000112a44000000003e6b776b3e000000
7f007f007f00000055555555550000000e041e2d2600000001112125020000001c003e2018000000081e08241a0000004e043e4526000000225f12120a000000
1c3e1c021c000000300c020c30000000227a2222120000000e1000023c0000003e080e011e000000020202221c000000083e080c08000000123e12021c000000
3c107e0870000000040e340272000000043f1c301e0000003c434020180000003e10080810000000083804023c000000620f2239580000007a42020a72000000
093e4b6d66000000324b4663620000003c4a494926000000123a123a5a000000236222221c0000000c00082a4d000000000c1221400000003d113d196d000000
1c3e081e2c00000006247e2610000000244e04463c0000000a3c5a46300000001e041e4438000000247e6408080000003a565230080000000838081e26000000
08023e201c00000002222224100000003c107c723000000004362c26640000003c107c4230000000324b4623120000000e641c2878000000020e125131000000
00000e1008000000000a1f1a0400000000040f150d00000000020e021d0000003e20140402000000300e080808000000083e20100c0000001c0808083e000000
107e181618000000043e242232000000041e083e08000000043c221008000000047c1210080000003e2020203e000000247e242010000000081204601c000000
3e20101826000000047e24043800000022242010080000007c445260100000001c083e08040000004a4a20100c0000001c003e080400000004041c2404000000
083e080804000000001c00003e0000003e2028300c000000083e205f080000002020100806000000102424424200000002320e023c0000003e2020100c000000
0c12214000000000083e082a4d0000003e201408100000003c003e001e000000080424625e00000040281068060000003e087e0870000000744e240808000000
784020207c0000001e103e101e0000001c003e201800000024242420180000001414145432000000020202320e0000007e4242427e0000003e22201008000000
3e203e20180000000102100807000000001510080600000000021f120400000000000e081e000000000e1e080e00000008046310080000000810630408000000
`;
function decodeFont(hexWithWhitespace) {
  const hex = hexWithWhitespace.replace(/\s/gu, "");
  if (hex.length !== 4096)
    throw new Error("default P8SCII font data is corrupt");
  const bytes = new Uint8Array(2048);
  for (let index = 0; index < bytes.length; index += 1) {
    const value = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    if (!Number.isInteger(value))
      throw new Error("default P8SCII font data is corrupt");
    bytes[index] = value;
  }
  return bytes;
}
var DEFAULT_P8SCII_FONT = decodeFont(DEFAULT_FONT_HEX);

// packages/runtime-core/dist/graphics/p8scii-text.js
var PRINT_START_X = 24356;
var PEN_REGISTER = 24357;
var TEXT_CURSOR_X = 24358;
var TEXT_CURSOR_Y = 24359;
var MISC_FEATURES = 24374;
var DEFAULT_ATTRIBUTES = 24408;
var CUSTOM_FONT = 22016;
var NO_AUTOMATIC_NEWLINE = 4;
var NO_PRINT_SCROLL = 64;
var CHARACTER_WRAP = 128;
var MAX_PRINT_BYTES = 65536;
var MAX_GLYPHS_PER_PRINT = 65536;
var MAX_PIXEL_WRITES_PER_PRINT = 8388608;
var MAX_NESTED_CONTROLS_PER_PRINT = 256;
var ByteCursor = class {
  bytes;
  index = 0;
  constructor(bytes) {
    this.bytes = bytes;
  }
  read() {
    if (this.index >= this.bytes.byteLength)
      return void 0;
    return this.bytes[this.index++];
  }
  remaining() {
    return this.bytes.byteLength - this.index;
  }
  readUntil(terminator) {
    const start = this.index;
    while (this.index < this.bytes.byteLength && this.bytes[this.index] !== terminator) {
      this.index += 1;
    }
    const result = this.bytes.slice(start, this.index);
    if (this.bytes[this.index] === terminator)
      this.index += 1;
    return result;
  }
};
var P8sciiText = class {
  #memory;
  #ram;
  #raster;
  #audio;
  #glyphCount = 0;
  #pixelWrites = 0;
  #nestedControlDepth = 0;
  constructor(memory, raster, audio = { play() {
  } }) {
    this.#memory = memory;
    this.#ram = memory.physicalBytes;
    this.#raster = raster;
    this.#audio = audio;
  }
  cursor(xRaw, yRaw, colorRaw) {
    const x = q16Integer3(xRaw);
    const y = q16Integer3(yRaw);
    this.#ram[TEXT_CURSOR_X] = x & 255;
    this.#ram[TEXT_CURSOR_Y] = y & 255;
    this.#ram[PRINT_START_X] = x & 255;
    if (colorRaw !== void 0)
      this.#ram[PEN_REGISTER] = q16Color(colorRaw);
  }
  print(bytes, xOrColorRaw, yRaw, colorRaw) {
    if (!(bytes instanceof Uint8Array))
      throw new TypeError("print expects a byte string");
    if (bytes.byteLength > MAX_PRINT_BYTES) {
      throw new RangeError(`print byte string exceeds ${MAX_PRINT_BYTES} bytes`);
    }
    this.#glyphCount = 0;
    this.#pixelWrites = 0;
    this.#nestedControlDepth = 0;
    const hasCoordinates = yRaw !== void 0;
    const explicitColor = hasCoordinates ? colorRaw : xOrColorRaw;
    if (explicitColor !== void 0)
      this.#ram[PEN_REGISTER] = q16Color(explicitColor);
    const x = hasCoordinates ? q16Integer3(xOrColorRaw ?? 0) : this.#ram[TEXT_CURSOR_X];
    const y = hasCoordinates ? q16Integer3(yRaw) : this.#ram[TEXT_CURSOR_Y];
    const homeX = hasCoordinates ? x : this.#ram[PRINT_START_X];
    const style = this.#initialStyle();
    const cursor = {
      x,
      y,
      homeX,
      homeY: y,
      lastGlyphX: x,
      lastGlyphY: y,
      lastAdvance: this.#baseWidth(style, 32) * (style.wide ? 2 : 1),
      lineHeight: 0,
      rightmostX: x,
      wrapEnabled: (this.#ram[MISC_FEATURES] & CHARACTER_WRAP) !== 0,
      wrapLimit: 128,
      implicit: !hasCoordinates,
      automaticNewline: !hasCoordinates && (this.#ram[MISC_FEATURES] & NO_AUTOMATIC_NEWLINE) === 0,
      terminated: false
    };
    const input = new ByteCursor(bytes);
    while (!cursor.terminated) {
      const byte = input.read();
      if (byte === void 0)
        break;
      this.#processByte(byte, input, cursor, style);
    }
    if (cursor.automaticNewline && !cursor.terminated) {
      this.#newline(cursor, style);
      this.#scrollFinalCursor(cursor);
    }
    this.#ram[TEXT_CURSOR_X] = cursor.x & 255;
    this.#ram[TEXT_CURSOR_Y] = cursor.y & 255;
    this.#ram[PRINT_START_X] = cursor.homeX & 255;
    return toInt16(cursor.rightmostX);
  }
  #initialStyle() {
    const flags = this.#ram[DEFAULT_ATTRIBUTES];
    const enabled = (flags & 1) !== 0;
    const dimensions = this.#ram[DEFAULT_ATTRIBUTES + 1];
    const widthsAndTabs = this.#ram[DEFAULT_ATTRIBUTES + 2];
    const offsets = this.#ram[DEFAULT_ATTRIBUTES + 3];
    const charWidth = dimensions & 15;
    const charHeight = dimensions >>> 4;
    const extendedWidth = widthsAndTabs & 15;
    const tabWidth = widthsAndTabs >>> 4;
    return {
      padding: enabled ? (flags & 2) !== 0 : true,
      wide: enabled && (flags & 4) !== 0,
      tall: enabled && (flags & 8) !== 0,
      solid: enabled && (flags & 16) !== 0,
      invert: enabled && (flags & 32) !== 0,
      stripey: enabled && (flags & 64) !== 0,
      custom: enabled && (flags & 128) !== 0,
      charWidth: charWidth === 0 ? void 0 : charWidth,
      extendedWidth: extendedWidth === 0 ? void 0 : extendedWidth,
      charHeight: charHeight === 0 ? void 0 : charHeight,
      offsetX: offsets & 15,
      offsetY: offsets >>> 4,
      tabWidth: tabWidth === 0 ? 16 : (tabWidth + 1) * 4,
      tabOverridden: false,
      foreground: this.#ram[PEN_REGISTER],
      background: 0,
      underline: false,
      outlineMask: 0,
      outlineColor: 0,
      outlineUsesForeground: false,
      outlineSkipsInterior: false
    };
  }
  #processByte(byte, input, cursor, style) {
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
        if (parameter !== void 0) {
          style.background = p8sciiValue(parameter);
          style.solid = true;
        }
        return;
      }
      case 3: {
        const parameter = input.read();
        if (parameter !== void 0)
          this.#moveX(cursor, p8sciiValue(parameter) - 16);
        return;
      }
      case 4: {
        const parameter = input.read();
        if (parameter !== void 0)
          cursor.y += p8sciiValue(parameter) - 16;
        return;
      }
      case 5: {
        const x = input.read();
        const y = input.read();
        if (x !== void 0)
          this.#moveX(cursor, p8sciiValue(x) - 16);
        if (y !== void 0)
          cursor.y += p8sciiValue(y) - 16;
        return;
      }
      case 6:
        this.#special(input, cursor, style);
        return;
      case 7:
        this.#audio.play(input.readUntil(32));
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
        if (parameter !== void 0) {
          style.foreground = p8sciiValue(parameter);
          this.#ram[PEN_REGISTER] = style.foreground & 255;
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
  #repeat(input, cursor, style) {
    const countByte = input.read();
    if (countByte === void 0) {
      cursor.automaticNewline = false;
      return;
    }
    const count = p8sciiValue(countByte);
    const repeated = input.read();
    if (repeated === void 0) {
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
  #special(input, cursor, style) {
    let command = input.read();
    if (command === void 0)
      return;
    let enable = true;
    if (command === 45) {
      enable = false;
      command = input.read();
      if (command === void 0)
        return;
    }
    if (command >= 49 && command <= 57)
      return;
    switch (command) {
      case 99: {
        const color = input.read();
        if (color === void 0)
          return;
        this.#raster.clear(p8sciiValue(color));
        cursor.x = 0;
        cursor.y = 0;
        cursor.homeX = 0;
        cursor.homeY = 0;
        cursor.lineHeight = 0;
        this.#touchRight(cursor);
        return;
      }
      case 100:
        input.read();
        return;
      case 103:
        cursor.x = cursor.homeX;
        cursor.y = cursor.homeY;
        this.#touchRight(cursor);
        return;
      case 104:
        cursor.homeX = cursor.x;
        cursor.homeY = cursor.y;
        return;
      case 106: {
        const x = input.read();
        const y = input.read();
        if (x !== void 0)
          cursor.x = p8sciiValue(x) * 4;
        if (y !== void 0)
          cursor.y = p8sciiValue(y) * 4;
        this.#touchRight(cursor);
        return;
      }
      case 114: {
        const boundary = input.read();
        if (boundary !== void 0) {
          cursor.wrapLimit = p8sciiValue(boundary) * 4;
          cursor.wrapEnabled = cursor.wrapLimit > 0;
        }
        return;
      }
      case 115: {
        const width = input.read();
        if (width !== void 0) {
          style.tabWidth = p8sciiValue(width);
          style.tabOverridden = true;
        }
        return;
      }
      case 117:
        style.underline = enable;
        return;
      case 120: {
        const width = input.read();
        if (width !== void 0) {
          style.charWidth = p8sciiValue(width);
          style.extendedWidth = style.charWidth + (style.custom ? 0 : 4);
        }
        return;
      }
      case 121: {
        const height = input.read();
        if (height !== void 0)
          style.charHeight = p8sciiValue(height);
        return;
      }
      case 119:
        style.wide = enable;
        return;
      case 116:
        style.tall = enable;
        return;
      case 61:
        style.stripey = enable;
        return;
      case 112:
        style.wide = enable;
        style.tall = enable;
        style.stripey = enable;
        return;
      case 105:
        style.invert = enable;
        return;
      case 98:
        style.padding = enable;
        return;
      case 35:
        style.solid = enable;
        return;
      case 46:
      case 44:
        this.#oneOffRaw(input, cursor, style, command === 44);
        return;
      case 58:
      case 59:
        this.#oneOffHex(input, cursor, style, command === 59);
        return;
      case 111:
        this.#outline(input, style);
        return;
      case 64:
        this.#rawWriteCounted(input);
        return;
      case 33:
        this.#rawWriteRemaining(input, cursor);
        return;
      default:
        return;
    }
  }
  #drawCharacter(byte, cursor, style) {
    const source = this.#fontGlyph(byte, style);
    this.#drawGlyph(source, cursor, style);
  }
  #fontGlyph(byte, style) {
    const custom = style.custom;
    const baseWidth = custom ? this.#memory.readU8(CUSTOM_FONT + (byte >= 128 ? 1 : 0)) : byte >= 128 ? 8 : 4;
    const baseHeight = custom ? this.#memory.readU8(CUSTOM_FONT + 2) : 6;
    const requestedWidth = byte >= 128 ? style.extendedWidth ?? baseWidth : style.charWidth ?? baseWidth;
    let advance = requestedWidth;
    let verticalAdjustment = 0;
    if (custom && (this.#memory.readU8(CUSTOM_FONT + 5) & 1) !== 0) {
      const adjustmentIndex = byte - 16;
      if (adjustmentIndex >= 0) {
        const packed = this.#memory.readU8(CUSTOM_FONT + 8 + (adjustmentIndex >> 1));
        const nibble = (adjustmentIndex & 1) === 0 ? packed & 15 : packed >>> 4;
        const widthAdjustment = (nibble & 7) < 4 ? nibble & 7 : (nibble & 7) - 8;
        advance += widthAdjustment;
        if ((nibble & 8) !== 0)
          verticalAdjustment = -1;
      }
    }
    advance = Math.max(0, advance);
    const cellHeight = Math.max(0, style.charHeight ?? baseHeight);
    const rows = custom ? this.#memory.copy(CUSTOM_FONT + byte * 8, 8) : DEFAULT_P8SCII_FONT.subarray(byte * 8, byte * 8 + 8);
    return {
      rows,
      metrics: {
        advance,
        cellHeight,
        glyphWidth: Math.min(8, Math.max(0, Math.min(baseWidth, requestedWidth))),
        glyphHeight: Math.min(8, custom ? cellHeight : Math.min(cellHeight, 5)),
        offsetX: style.offsetX + (custom ? this.#memory.readU8(CUSTOM_FONT + 3) : 0),
        offsetY: style.offsetY + (custom ? this.#memory.readU8(CUSTOM_FONT + 4) : 0) + verticalAdjustment
      },
      padding: style.padding
    };
  }
  #drawGlyph(source, cursor, style) {
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
        [-1, -1],
        [0, -1],
        [1, -1],
        [-1, 0],
        [1, 0],
        [-1, 1],
        [0, 1],
        [1, 1]
      ];
      this.#forEachForegroundPixel(source, baseX, baseY, style, (x, y) => {
        for (let index = 0; index < offsets.length; index += 1) {
          if ((style.outlineMask & 1 << index) === 0)
            continue;
          const offset = offsets[index];
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
  #forEachForegroundPixel(source, baseX, baseY, style, visit) {
    const scaleX = style.wide ? 2 : 1;
    const scaleY = style.tall ? 2 : 1;
    const first = source.padding ? -1 : 0;
    for (let dy = first; dy < source.metrics.cellHeight; dy += 1) {
      for (let dx = first; dx < source.metrics.advance; dx += 1) {
        if (this.#glyphBit(source, dx, dy) === style.invert)
          continue;
        for (let sy = 0; sy < scaleY; sy += 1) {
          for (let sx = 0; sx < scaleX; sx += 1) {
            if (style.stripey && (sx !== 0 || sy !== 0))
              continue;
            visit(baseX + dx * scaleX + sx, baseY + dy * scaleY + sy);
          }
        }
      }
    }
  }
  #glyphBit(source, x, y) {
    if (x < 0 || y < 0 || x >= source.metrics.glyphWidth || y >= source.metrics.glyphHeight) {
      return false;
    }
    return (source.rows[y] >>> x & 1) !== 0;
  }
  #oneOffRaw(input, cursor, style, respectPadding) {
    if (input.remaining() < 8) {
      input.index = input.bytes.byteLength;
      return;
    }
    const rows = input.bytes.slice(input.index, input.index + 8);
    input.index += 8;
    this.#drawOneOff(rows, cursor, style, respectPadding);
  }
  #oneOffHex(input, cursor, style, respectPadding) {
    if (input.remaining() < 16) {
      input.index = input.bytes.byteLength;
      return;
    }
    const rows = new Uint8Array(8);
    for (let index = 0; index < 8; index += 1) {
      const high = hexValue(input.read());
      const low = hexValue(input.read());
      rows[index] = high < 0 || low < 0 ? 0 : high << 4 | low;
    }
    this.#drawOneOff(rows, cursor, style, respectPadding);
  }
  #drawOneOff(rows, cursor, style, respectPadding) {
    this.#drawGlyph({
      rows,
      metrics: {
        advance: 8,
        cellHeight: 8,
        glyphWidth: 8,
        glyphHeight: 8,
        offsetX: style.offsetX,
        offsetY: style.offsetY
      },
      padding: respectPadding && style.padding
    }, cursor, style);
  }
  #outline(input, style) {
    const color = input.read();
    const high = input.read();
    const low = input.read();
    if (color === void 0 || high === void 0 || low === void 0)
      return;
    const highValue = hexValue(high);
    const lowValue = hexValue(low);
    style.outlineMask = highValue < 0 || lowValue < 0 ? 0 : highValue << 4 | lowValue;
    style.outlineUsesForeground = color === 36 || color === 33;
    style.outlineSkipsInterior = color === 33;
    style.outlineColor = style.outlineUsesForeground ? style.foreground : p8sciiValue(color);
  }
  #rawWriteCounted(input) {
    if (input.remaining() < 8) {
      input.index = input.bytes.byteLength;
      return;
    }
    const address = this.#readHexWord(input);
    const count = this.#readHexWord(input);
    if (address < 0 || count < 0)
      return;
    const available = Math.min(count, input.remaining());
    for (let index = 0; index < available; index += 1) {
      this.#memory.writeU8(address + index, input.read());
    }
  }
  #rawWriteRemaining(input, cursor) {
    if (input.remaining() < 4) {
      input.index = input.bytes.byteLength;
      return;
    }
    const address = this.#readHexWord(input);
    if (address >= 0) {
      let index = 0;
      while (input.remaining() > 0)
        this.#memory.writeU8(address + index++, input.read());
    } else {
      input.index = input.bytes.byteLength;
    }
    cursor.automaticNewline = false;
    cursor.terminated = true;
  }
  #readHexWord(input) {
    let result = 0;
    let valid = true;
    for (let index = 0; index < 4; index += 1) {
      const value = hexValue(input.read());
      if (value < 0) {
        valid = false;
      } else {
        result = result << 4 | value;
      }
    }
    return valid ? result : -1;
  }
  #decorate(input, cursor, style) {
    const position = input.read();
    const character = input.read();
    if (position === void 0 || character === void 0)
      return;
    const savedX = cursor.x;
    const savedY = cursor.y;
    const value = p8sciiValue(position);
    cursor.x = cursor.lastGlyphX + (value & 3) - 2;
    cursor.y = cursor.lastGlyphY + (value >>> 2) - 8;
    this.#processNestedByte(character, input, cursor, style);
    cursor.x = savedX;
    cursor.y = savedY;
  }
  #processNestedByte(byte, input, cursor, style) {
    this.#nestedControlDepth += 1;
    if (this.#nestedControlDepth > MAX_NESTED_CONTROLS_PER_PRINT) {
      throw new RangeError(`print control nesting exceeds ${MAX_NESTED_CONTROLS_PER_PRINT}`);
    }
    try {
      this.#processByte(byte, input, cursor, style);
    } finally {
      this.#nestedControlDepth -= 1;
    }
  }
  #tab(cursor, style) {
    let width = style.tabWidth;
    let origin = 0;
    if (style.custom && !style.tabOverridden) {
      const customWidth = this.#memory.readU8(CUSTOM_FONT + 6);
      if (customWidth !== 0)
        width = customWidth;
      if ((this.#memory.readU8(CUSTOM_FONT + 5) & 2) !== 0)
        origin = cursor.homeX;
    }
    if (width <= 0)
      return;
    const relative = positiveModulo(cursor.x - origin, width);
    this.#moveX(cursor, width - relative);
  }
  #newline(cursor, style) {
    const height = Math.max(cursor.lineHeight, this.#baseHeight(style));
    cursor.x = cursor.homeX;
    cursor.y += height;
    cursor.lineHeight = 0;
    this.#touchRight(cursor);
  }
  #baseWidth(style, byte) {
    const fallback = style.custom ? this.#memory.readU8(CUSTOM_FONT + (byte >= 128 ? 1 : 0)) : byte >= 128 ? 8 : 4;
    return byte >= 128 ? style.extendedWidth ?? fallback : style.charWidth ?? fallback;
  }
  #baseHeight(style) {
    const fallback = style.custom ? this.#memory.readU8(CUSTOM_FONT + 2) : 6;
    return Math.max(0, style.charHeight ?? fallback) * (style.tall ? 2 : 1);
  }
  #scrollForGlyph(cursor, glyphHeight) {
    if (!cursor.implicit || (this.#ram[MISC_FEATURES] & NO_PRINT_SCROLL) !== 0)
      return;
    const overflow = cursor.y + glyphHeight - 128;
    if (overflow <= 0)
      return;
    this.#raster.scroll(Math.min(128, overflow));
    cursor.y -= overflow;
    cursor.homeY -= overflow;
    cursor.lastGlyphY -= overflow;
  }
  #scrollFinalCursor(cursor) {
    if (!cursor.implicit || (this.#ram[MISC_FEATURES] & NO_PRINT_SCROLL) !== 0)
      return;
    const overflow = cursor.y - 122;
    if (overflow <= 0)
      return;
    this.#raster.scroll(Math.min(128, overflow));
    cursor.y -= overflow;
    cursor.homeY -= overflow;
    cursor.lastGlyphY -= overflow;
  }
  #moveX(cursor, delta) {
    cursor.x += delta;
    this.#touchRight(cursor);
  }
  #touchRight(cursor) {
    cursor.rightmostX = Math.max(cursor.rightmostX, cursor.x);
  }
  #plot(x, y, color) {
    this.#pixelWrites += 1;
    if (this.#pixelWrites > MAX_PIXEL_WRITES_PER_PRINT) {
      throw new RangeError(`print raster work exceeds ${MAX_PIXEL_WRITES_PER_PRINT} pixels`);
    }
    this.#raster.plot(x, y, color & 15);
  }
};
function q16Integer3(raw) {
  return raw >> 16;
}
function q16Color(raw) {
  return raw >>> 16 & 255;
}
function p8sciiValue(byte) {
  if (byte >= 48 && byte <= 57)
    return byte - 48;
  if (byte >= 97 && byte <= 153)
    return byte - 87;
  if (byte >= 65 && byte <= 90)
    return byte - 55;
  return 0;
}
function hexValue(byte) {
  if (byte >= 48 && byte <= 57)
    return byte - 48;
  if (byte >= 97 && byte <= 102)
    return byte - 87;
  if (byte >= 65 && byte <= 70)
    return byte - 55;
  return -1;
}
function positiveModulo(value, modulus) {
  return (value % modulus + modulus) % modulus;
}
function toInt16(value) {
  return value << 16 >> 16;
}

// packages/runtime-core/dist/graphics/l1-graphics.js
var SCREEN_WIDTH = 128;
var SCREEN_HEIGHT = 128;
var SCREEN_BYTES = 8192;
var GFX_ADDRESS = 0;
var SCREEN_ADDRESS = 24576;
var DRAW_PALETTE = 24320;
var DISPLAY_PALETTE = 24336;
var CLIP_LEFT = 24352;
var CLIP_TOP = 24353;
var CLIP_RIGHT = 24354;
var CLIP_BOTTOM = 24355;
var PRINT_START_X2 = 24356;
var TEXT_CURSOR_X2 = 24358;
var TEXT_CURSOR_Y2 = 24359;
var PEN_REGISTER2 = 24357;
var CAMERA_X = 24360;
var CAMERA_Y = 24362;
var FILL_PATTERN = 24369;
var FILL_FLAGS = 24371;
var COLOR_SETTING_FLAGS = 24372;
var POLYLINE_FLAG = 24373;
var MISC_FEATURES2 = 24374;
var TLINE_MASK_X = 24376;
var TLINE_MASK_Y = 24377;
var TLINE_OFFSET_X = 24378;
var TLINE_OFFSET_Y = 24379;
var POLYLINE_X = 24380;
var POLYLINE_Y = 24382;
var SGET_OUT_OF_BOUNDS = 24409;
var MGET_OUT_OF_BOUNDS = 24410;
var PGET_OUT_OF_BOUNDS = 24411;
var SECONDARY_PALETTE = 24416;
var SPRITE_FLAGS = 12288;
var L1Graphics = class {
  #memory;
  #mapMemory;
  #ram;
  #view;
  #text;
  #shapeMask = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT);
  #maskingShape = false;
  #tlineFractionalBits = 13;
  constructor(memory, audio) {
    this.#memory = memory;
    this.#mapMemory = new PicoMapMemory(memory);
    this.#ram = memory.physicalBytes;
    this.#view = new DataView(this.#ram.buffer, this.#ram.byteOffset, this.#ram.byteLength);
    this.#text = new P8sciiText(memory, {
      plot: (worldX, worldY, sourceColor) => {
        this.#plotTextPixel(worldX, worldY, sourceColor);
      },
      clear: (sourceColor) => {
        this.cls((sourceColor & 15) << 16);
      },
      scroll: (rows) => {
        this.#scrollScreen(rows);
      }
    }, audio);
  }
  reset() {
    this.#tlineFractionalBits = 13;
    this.#resetPalette(0);
    this.#resetPalette(1);
    this.#resetPalette(2);
    this.#ram[PEN_REGISTER2] = 6;
    this.#view.setInt16(CAMERA_X, 0, true);
    this.#view.setInt16(CAMERA_Y, 0, true);
    this.#view.setUint16(FILL_PATTERN, 0, true);
    this.#ram[FILL_FLAGS] = 0;
    this.#ram[COLOR_SETTING_FLAGS] = 0;
    this.#resetClipAndCursor();
    this.#invalidatePolyline();
  }
  cls(colorRaw) {
    const color = colorRaw === void 0 ? 0 : q16Integer4(colorRaw) & 15;
    const packed = color | color << 4;
    this.#memory.fill(SCREEN_ADDRESS, SCREEN_BYTES, packed);
    this.#resetClipAndCursor();
  }
  color(colorRaw) {
    const previous = this.#ram[PEN_REGISTER2];
    this.#ram[PEN_REGISTER2] = colorRaw === void 0 ? 6 : colorRaw >>> 16 & 255;
    return previous;
  }
  camera(xRaw, yRaw) {
    this.#view.setInt16(CAMERA_X, xRaw === void 0 ? 0 : toInt162(q16Integer4(xRaw)), true);
    this.#view.setInt16(CAMERA_Y, yRaw === void 0 ? 0 : toInt162(q16Integer4(yRaw)), true);
  }
  clip(xRaw, yRaw, widthRaw, heightRaw, clipPrevious = false) {
    if (xRaw === void 0 || yRaw === void 0 || widthRaw === void 0 || heightRaw === void 0) {
      this.#resetClip();
      return;
    }
    const x = toInt162(q16Integer4(xRaw));
    const y = toInt162(q16Integer4(yRaw));
    const width = Math.max(0, toInt162(q16Integer4(widthRaw)));
    const height = Math.max(0, toInt162(q16Integer4(heightRaw)));
    let left = clamp2(x, 0, SCREEN_WIDTH);
    let top = clamp2(y, 0, SCREEN_HEIGHT);
    let right = clamp2(x + width, 0, SCREEN_WIDTH);
    let bottom = clamp2(y + height, 0, SCREEN_HEIGHT);
    if (clipPrevious) {
      left = Math.max(left, this.#ram[CLIP_LEFT]);
      top = Math.max(top, this.#ram[CLIP_TOP]);
      right = Math.min(right, this.#ram[CLIP_RIGHT]);
      bottom = Math.min(bottom, this.#ram[CLIP_BOTTOM]);
    }
    this.#ram[CLIP_LEFT] = Math.min(left, right);
    this.#ram[CLIP_TOP] = Math.min(top, bottom);
    this.#ram[CLIP_RIGHT] = Math.max(left, right);
    this.#ram[CLIP_BOTTOM] = Math.max(top, bottom);
  }
  pal(sourceRaw, targetRaw, paletteRaw) {
    if (sourceRaw === void 0) {
      this.#resetPalette(0);
      this.#resetPalette(1);
      this.#resetPalette(2);
      return 0;
    }
    if (targetRaw === void 0) {
      this.#resetPalette(q16Integer4(sourceRaw));
      return 0;
    }
    const palette = paletteRaw === void 0 ? 0 : q16Integer4(paletteRaw);
    if (palette < 0 || palette > 2)
      return 0;
    const source = q16Integer4(sourceRaw) & 15;
    const address = palette === 0 ? DRAW_PALETTE + source : palette === 1 ? DISPLAY_PALETTE + source : SECONDARY_PALETTE + source;
    const previous = this.#ram[address];
    const target = q16Integer4(targetRaw);
    this.#ram[address] = palette === 0 ? previous & 16 | target & 15 : palette === 1 ? target & 143 : target & 255;
    return palette === 0 ? previous & 15 : previous;
  }
  palt(colorOrMaskRaw, transparent) {
    if (transparent === void 0) {
      let previous2 = 0;
      const mask = colorOrMaskRaw === void 0 ? 32768 : q16Integer4(colorOrMaskRaw) & 65535;
      for (let color2 = 0; color2 < 16; color2 += 1) {
        const address2 = DRAW_PALETTE + color2;
        if ((this.#ram[address2] & 16) !== 0)
          previous2 |= 1 << 15 - color2;
        this.#ram[address2] = this.#ram[address2] & 15 | ((mask & 1 << 15 - color2) !== 0 ? 16 : 0);
      }
      return toInt162(previous2);
    }
    const color = q16Integer4(colorOrMaskRaw ?? 0) & 15;
    const address = DRAW_PALETTE + color;
    const previous = (this.#ram[address] & 16) !== 0;
    this.#ram[address] = this.#ram[address] & 15 | (transparent ? 16 : 0);
    return previous ? 1 : 0;
  }
  fillp(patternRaw) {
    const previous = this.#view.getUint16(FILL_PATTERN, true) << 16 | (this.#ram[FILL_FLAGS] & 1) << 15 | (this.#ram[FILL_FLAGS] & 2) << 13 | (this.#ram[FILL_FLAGS] & 4) << 11 | 0;
    const pattern = patternRaw ?? 0;
    this.#view.setUint16(FILL_PATTERN, pattern >>> 16 & 65535, true);
    this.#ram[FILL_FLAGS] = pattern >>> 15 & 1 | pattern >>> 13 & 2 | pattern >>> 11 & 4;
    return previous;
  }
  pget(xRaw, yRaw) {
    const x = toInt162(q16Integer4(xRaw)) - this.#view.getInt16(CAMERA_X, true);
    const y = toInt162(q16Integer4(yRaw)) - this.#view.getInt16(CAMERA_Y, true);
    if (!this.#insideClip(x, y))
      return this.#outOfBoundsPixel();
    const address = SCREEN_ADDRESS + y * 64 + (x >> 1);
    return this.#memory.readU8(address) >>> ((x & 1) << 2) & 15;
  }
  sget(xRaw, yRaw) {
    const x = toInt162(q16Integer4(xRaw));
    const y = toInt162(q16Integer4(yRaw));
    if (!insideSpriteSheet(x, y))
      return this.#outOfBoundsSpritePixel();
    return this.#readSpritePixel(x, y);
  }
  sset(xRaw, yRaw, colorRaw) {
    const x = toInt162(q16Integer4(xRaw));
    const y = toInt162(q16Integer4(yRaw));
    if (!insideSpriteSheet(x, y))
      return;
    const color = colorRaw === void 0 ? this.#ram[PEN_REGISTER2] : colorRaw >>> 16 & 255;
    const mapped = this.#ram[DRAW_PALETTE + (color & 15)] & 15;
    this.#writeSpritePixel(x, y, mapped);
  }
  spr(spriteRaw, xRaw, yRaw, widthRaw, heightRaw, flipX = false, flipY = false) {
    const sprite = toInt162(q16Integer4(spriteRaw));
    const sourceX = sprite % 16 * 8;
    const sourceY = Math.trunc(sprite / 16) * 8;
    const width = q16ScaledInteger(widthRaw ?? 65536, 8);
    const height = q16ScaledInteger(heightRaw ?? 65536, 8);
    const destinationX = toInt162(q16Integer4(xRaw)) - this.#cameraX();
    const destinationY = toInt162(q16Integer4(yRaw)) - this.#cameraY();
    this.#blitSprite(sourceX, sourceY, width, height, destinationX, destinationY, width, height, flipX, flipY);
  }
  sspr(sourceXRaw, sourceYRaw, sourceWidthRaw, sourceHeightRaw, destinationXRaw, destinationYRaw, destinationWidthRaw, destinationHeightRaw, flipX = false, flipY = false) {
    const sourceX = toInt162(q16Integer4(sourceXRaw));
    const sourceY = toInt162(q16Integer4(sourceYRaw));
    const sourceWidth = toInt162(q16Integer4(sourceWidthRaw));
    const sourceHeight = toInt162(q16Integer4(sourceHeightRaw));
    let destinationX = toInt162(q16Integer4(destinationXRaw)) - this.#cameraX();
    let destinationY = toInt162(q16Integer4(destinationYRaw)) - this.#cameraY();
    let destinationWidth = destinationWidthRaw === void 0 ? sourceWidth : toInt162(q16Integer4(destinationWidthRaw));
    let destinationHeight = destinationHeightRaw === void 0 ? sourceHeight : toInt162(q16Integer4(destinationHeightRaw));
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
    this.#blitSprite(sourceX, sourceY, sourceWidth, sourceHeight, destinationX, destinationY, destinationWidth, destinationHeight, flipX, flipY);
  }
  mget(xRaw, yRaw) {
    return this.#readMapTile(toInt162(q16Integer4(xRaw)), toInt162(q16Integer4(yRaw)));
  }
  mset(xRaw, yRaw, valueRaw) {
    this.#mapMemory.write(toInt162(q16Integer4(xRaw)), toInt162(q16Integer4(yRaw)), q16Integer4(valueRaw));
  }
  fget(spriteRaw, flagRaw) {
    const sprite = toInt162(q16Integer4(spriteRaw));
    if (sprite < 0 || sprite > 255)
      return 0;
    const flags = this.#ram[SPRITE_FLAGS + sprite];
    if (flagRaw === void 0)
      return flags;
    const flag = toInt162(q16Integer4(flagRaw));
    return flag >= 0 && flag < 8 && (flags & 1 << flag) !== 0 ? 1 : 0;
  }
  fset(spriteRaw, flagOrValueRaw, value) {
    const sprite = toInt162(q16Integer4(spriteRaw));
    if (sprite < 0 || sprite > 255)
      return;
    const address = SPRITE_FLAGS + sprite;
    if (value === void 0) {
      this.#ram[address] = q16Integer4(flagOrValueRaw) & 255;
      return;
    }
    const flag = toInt162(q16Integer4(flagOrValueRaw));
    if (flag < 0 || flag >= 8)
      return;
    this.#ram[address] = value ? this.#ram[address] | 1 << flag : this.#ram[address] & ~(1 << flag);
  }
  map(tileXRaw, tileYRaw, screenXRaw, screenYRaw, tileWidthRaw, tileHeightRaw, layersRaw) {
    const layout = this.#mapMemory.layout();
    const tileX = toInt162(q16Integer4(tileXRaw ?? 0));
    const tileY = toInt162(q16Integer4(tileYRaw ?? 0));
    const destinationX = toInt162(q16Integer4(screenXRaw ?? 0)) - this.#cameraX();
    const destinationY = toInt162(q16Integer4(screenYRaw ?? 0)) - this.#cameraY();
    const tileWidth = tileWidthRaw === void 0 ? layout.width : toInt162(q16Integer4(tileWidthRaw));
    const tileHeight = tileHeightRaw === void 0 ? layout.height : toInt162(q16Integer4(tileHeightRaw));
    if (tileWidth <= 0 || tileHeight <= 0)
      return;
    const layers = layersRaw === void 0 ? 0 : q16Integer4(layersRaw) & 255;
    const firstTileX = Math.max(0, Math.floor((this.#ram[CLIP_LEFT] - destinationX) / 8));
    const finalTileX = Math.min(tileWidth, Math.ceil((this.#ram[CLIP_RIGHT] - destinationX) / 8));
    const firstTileY = Math.max(0, Math.floor((this.#ram[CLIP_TOP] - destinationY) / 8));
    const finalTileY = Math.min(tileHeight, Math.ceil((this.#ram[CLIP_BOTTOM] - destinationY) / 8));
    for (let offsetY = firstTileY; offsetY < finalTileY; offsetY += 1) {
      for (let offsetX = firstTileX; offsetX < finalTileX; offsetX += 1) {
        const sprite = this.#readMapTile(tileX + offsetX, tileY + offsetY);
        if (!this.#tileSelected(sprite, layers))
          continue;
        this.#blitSprite((sprite & 15) * 8, (sprite >>> 4) * 8, 8, 8, destinationX + offsetX * 8, destinationY + offsetY * 8, 8, 8, false, false);
      }
    }
  }
  tline(x0Raw, y0Raw, x1Raw, y1Raw, mxRaw, myRaw, mdxRaw, mdyRaw, layersRaw) {
    if (x0Raw !== void 0 && y0Raw === void 0 && x1Raw === void 0 && y1Raw === void 0 && mxRaw === void 0 && myRaw === void 0 && mdxRaw === void 0 && mdyRaw === void 0 && layersRaw === void 0) {
      this.#tlineFractionalBits = clamp2(q16Integer4(x0Raw), 0, 16);
      return;
    }
    if (x0Raw === void 0 || y0Raw === void 0 || x1Raw === void 0 || y1Raw === void 0 || mxRaw === void 0 || myRaw === void 0) {
      return;
    }
    const x0 = toInt162(q16Integer4(x0Raw)) - this.#cameraX();
    const y0 = toInt162(q16Integer4(y0Raw)) - this.#cameraY();
    const x1 = toInt162(q16Integer4(x1Raw)) - this.#cameraX();
    const y1 = toInt162(q16Integer4(y1Raw)) - this.#cameraY();
    const mapStartX = scaleTlineCoordinate(mxRaw, this.#tlineFractionalBits);
    const mapStartY = scaleTlineCoordinate(myRaw, this.#tlineFractionalBits);
    const deltaX = scaleTlineCoordinate(mdxRaw ?? 8192, this.#tlineFractionalBits);
    const deltaY = scaleTlineCoordinate(mdyRaw ?? 0, this.#tlineFractionalBits);
    const layers = layersRaw === void 0 ? 0 : q16Integer4(layersRaw) & 255;
    const maskX = tlineMask(this.#ram[TLINE_MASK_X]);
    const maskY = tlineMask(this.#ram[TLINE_MASK_Y]);
    const horizontal = Math.abs(x1 - x0) >= Math.abs(y1 - y0);
    const major0 = horizontal ? x0 : y0;
    const major1 = horizontal ? x1 : y1;
    const minor0 = horizontal ? y0 : x0;
    const minor1 = horizontal ? y1 : x1;
    const direction = major0 <= major1 ? 1 : -1;
    let major = clamp2(major0, -1, SCREEN_WIDTH);
    const majorEnd = clamp2(major1, -1, SCREEN_WIDTH);
    const skipped = Math.abs(major - major0);
    let mapX = advanceTlineQ16(mapStartX, deltaX, skipped, maskX);
    let mapY = advanceTlineQ16(mapStartY, deltaY, skipped, maskY);
    for (; ; ) {
      const minor = major0 === major1 ? minor0 : roundAwayFromZero(minor0 + (minor1 - minor0) * (major - major0) / (major1 - major0));
      const x = horizontal ? major : minor;
      const y = horizontal ? minor : major;
      this.#plotTlineSample(x, y, mapX, mapY, maskX, maskY, layers);
      if (major === majorEnd)
        break;
      major += direction;
      mapX = advanceTlineQ16(mapX, deltaX, 1, maskX);
      mapY = advanceTlineQ16(mapY, deltaY, 1, maskY);
    }
  }
  print(bytes, xOrColorRaw, yRaw, colorRaw) {
    return this.#text.print(bytes, xOrColorRaw, yRaw, colorRaw);
  }
  cursor(xRaw, yRaw, colorRaw) {
    this.#text.cursor(xRaw, yRaw, colorRaw);
  }
  pset(xRaw, yRaw, colorRaw) {
    const color = this.#resolveColor(colorRaw);
    const [x, y] = this.#cameraPoint(xRaw, yRaw);
    this.#plot(x, y, color);
  }
  line(x0Raw, y0Raw, x1OrColorRaw, y1Raw, colorRaw) {
    if (x0Raw === void 0 || y0Raw === void 0) {
      if (x0Raw !== void 0)
        this.#resolveColor(x0Raw);
      this.#invalidatePolyline();
      return;
    }
    const destinationX = toInt162(q16Integer4(x0Raw));
    const destinationY = toInt162(q16Integer4(y0Raw));
    if (y1Raw === void 0) {
      const color2 = this.#resolveColor(x1OrColorRaw);
      const sourceX = this.#view.getInt16(POLYLINE_X, true);
      const sourceY = this.#view.getInt16(POLYLINE_Y, true);
      this.#writePolylineEndpoint(destinationX, destinationY);
      if (this.#polylineInvalid()) {
        this.#setPolylineInvalid(false);
        return;
      }
      this.#drawLine(sourceX - this.#cameraX(), sourceY - this.#cameraY(), destinationX - this.#cameraX(), destinationY - this.#cameraY(), color2);
      return;
    }
    if (x1OrColorRaw === void 0) {
      this.#invalidatePolyline();
      return;
    }
    const x1 = toInt162(q16Integer4(x1OrColorRaw));
    const y1 = toInt162(q16Integer4(y1Raw));
    const color = this.#resolveColor(colorRaw);
    this.#writePolylineEndpoint(x1, y1);
    this.#setPolylineInvalid(false);
    this.#drawLine(destinationX - this.#cameraX(), destinationY - this.#cameraY(), x1 - this.#cameraX(), y1 - this.#cameraY(), color);
  }
  rect(x0Raw, y0Raw, x1Raw, y1Raw, colorRaw) {
    const color = this.#resolveColor(colorRaw);
    const [left, right] = ordered(toInt162(q16Integer4(x0Raw)) - this.#cameraX(), toInt162(q16Integer4(x1Raw)) - this.#cameraX());
    const [top, bottom] = ordered(toInt162(q16Integer4(y0Raw)) - this.#cameraY(), toInt162(q16Integer4(y1Raw)) - this.#cameraY());
    this.#horizontal(left, right, top, color);
    this.#horizontal(left, right, bottom, color);
    if (top + 1 < bottom) {
      this.#vertical(top + 1, bottom - 1, left, color);
      this.#vertical(top + 1, bottom - 1, right, color);
    }
  }
  rectfill(x0Raw, y0Raw, x1Raw, y1Raw, colorRaw) {
    const color = this.#resolveColor(colorRaw);
    const [left, right] = ordered(toInt162(q16Integer4(x0Raw)) - this.#cameraX(), toInt162(q16Integer4(x1Raw)) - this.#cameraX());
    const [top, bottom] = ordered(toInt162(q16Integer4(y0Raw)) - this.#cameraY(), toInt162(q16Integer4(y1Raw)) - this.#cameraY());
    this.#drawFilled(color, color.inverted, () => {
      for (let y = top; y <= bottom; y += 1)
        this.#horizontal(left, right, y, color);
    });
  }
  rrect(xRaw, yRaw, widthRaw, heightRaw, radiusRaw, colorRaw) {
    const color = this.#resolveColor(colorRaw);
    const bounds = roundedRectBounds(xRaw, yRaw, widthRaw, heightRaw, radiusRaw, this.#cameraX(), this.#cameraY());
    if (bounds === void 0)
      return;
    const [left, top, right, bottom, radius] = bounds;
    const firstX = Math.max(0, left);
    const finalX = Math.min(SCREEN_WIDTH - 1, right);
    const firstY = Math.max(0, top);
    const finalY = Math.min(SCREEN_HEIGHT - 1, bottom);
    for (let y = firstY; y <= finalY; y += 1) {
      for (let x = firstX; x <= finalX; x += 1) {
        if (insideRoundedRect(x, y, left, top, right, bottom, radius) && (!insideRoundedRect(x - 1, y, left, top, right, bottom, radius) || !insideRoundedRect(x + 1, y, left, top, right, bottom, radius) || !insideRoundedRect(x, y - 1, left, top, right, bottom, radius) || !insideRoundedRect(x, y + 1, left, top, right, bottom, radius))) {
          this.#plot(x, y, color);
        }
      }
    }
  }
  rrectfill(xRaw, yRaw, widthRaw, heightRaw, radiusRaw, colorRaw) {
    const color = this.#resolveColor(colorRaw);
    const bounds = roundedRectBounds(xRaw, yRaw, widthRaw, heightRaw, radiusRaw, this.#cameraX(), this.#cameraY());
    if (bounds === void 0)
      return;
    const [left, top, right, bottom, radius] = bounds;
    if (!color.inverted && (right < 0 || left >= SCREEN_WIDTH || bottom < 0 || top >= SCREEN_HEIGHT)) {
      return;
    }
    this.#drawFilled(color, color.inverted, () => {
      const firstY = Math.max(0, top);
      const finalY = Math.min(SCREEN_HEIGHT - 1, bottom);
      for (let y = firstY; y <= finalY; y += 1) {
        const inset = roundedRectInset(y, top, bottom, radius);
        this.#horizontal(left + inset, right - inset, y, color);
      }
    });
  }
  circ(xRaw, yRaw, radiusRaw, colorRaw) {
    const color = this.#resolveColor(colorRaw);
    const [centerX, centerY] = this.#cameraPoint(xRaw, yRaw);
    const radius = radiusRaw === void 0 ? 4 : toInt162(q16Integer4(radiusRaw));
    if (radius < 0 || !circleBoundsTouchScreen(centerX, centerY, radius))
      return;
    let x = radius;
    let y = 0;
    let decision = 1 - x;
    while (y <= x) {
      this.#plotCircleOctants(centerX, centerY, x, y, color);
      y += 1;
      if (decision < 0)
        decision += 2 * y + 1;
      else {
        x -= 1;
        decision += 2 * (y - x) + 1;
      }
    }
  }
  circfill(xRaw, yRaw, radiusRaw, colorRaw) {
    const color = this.#resolveColor(colorRaw);
    const [centerX, centerY] = this.#cameraPoint(xRaw, yRaw);
    const requestedRadius = radiusRaw === void 0 ? 4 : toInt162(q16Integer4(radiusRaw));
    if (requestedRadius < 0)
      return;
    if (!color.inverted && !circleBoundsTouchScreen(centerX, centerY, requestedRadius))
      return;
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
        if (radius > x)
          error += ++x * 2 + 1;
        if (radius <= y)
          error += ++y * 2 + 1;
      } while (x < 0);
    });
  }
  oval(x0Raw, y0Raw, x1Raw, y1Raw, colorRaw) {
    const color = this.#resolveColor(colorRaw);
    const [x0, x1] = ordered(toInt162(q16Integer4(x0Raw)) - this.#cameraX(), toInt162(q16Integer4(x1Raw)) - this.#cameraX());
    const [y0, y1] = ordered(toInt162(q16Integer4(y0Raw)) - this.#cameraY(), toInt162(q16Integer4(y1Raw)) - this.#cameraY());
    if (x1 < 0 || x0 >= SCREEN_WIDTH || y1 < 0 || y0 >= SCREEN_HEIGHT)
      return;
    const centerX = (x0 + x1) / 2;
    const centerY = (y0 + y1) / 2;
    const radiusX = Math.max(1, (x1 - x0) / 2);
    const radiusY = Math.max(1, (y1 - y0) / 2);
    const plotSymmetric = (x, y) => {
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
  ovalfill(x0Raw, y0Raw, x1Raw, y1Raw, colorRaw) {
    const color = this.#resolveColor(colorRaw);
    const [x0, x1] = ordered(toInt162(q16Integer4(x0Raw)) - this.#cameraX(), toInt162(q16Integer4(x1Raw)) - this.#cameraX());
    const [y0, y1] = ordered(toInt162(q16Integer4(y0Raw)) - this.#cameraY(), toInt162(q16Integer4(y1Raw)) - this.#cameraY());
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
  #resetPalette(palette) {
    if (palette === 0) {
      for (let color = 0; color < 16; color += 1) {
        this.#ram[DRAW_PALETTE + color] = color | (color === 0 ? 16 : 0);
      }
    } else if (palette === 1) {
      for (let color = 0; color < 16; color += 1) {
        this.#ram[DISPLAY_PALETTE + color] = color;
      }
    } else if (palette === 2) {
      for (let color = 0; color < 16; color += 1) {
        this.#ram[SECONDARY_PALETTE + color] = color | color << 4;
      }
    }
  }
  #resolveColor(colorRaw) {
    let pen = this.#ram[PEN_REGISTER2];
    let inverted = false;
    if (colorRaw !== void 0) {
      pen = colorRaw >>> 16 & 255;
      this.#ram[PEN_REGISTER2] = pen;
      if ((colorRaw & 268435456) !== 0 && (this.#ram[COLOR_SETTING_FLAGS] & 1) !== 0) {
        this.#view.setUint16(FILL_PATTERN, colorRaw & 65535, true);
        this.#ram[FILL_FLAGS] = colorRaw >>> 24 & 7;
        inverted = (colorRaw & 134217728) !== 0 && (this.#ram[COLOR_SETTING_FLAGS] & 2) !== 0;
      }
    }
    let primary = this.#ram[DRAW_PALETTE + (pen & 15)] & 15;
    let alternate = this.#ram[DRAW_PALETTE + (pen >>> 4 & 15)] & 15;
    const flags = this.#ram[FILL_FLAGS];
    if ((flags & 4) !== 0) {
      const secondary = this.#ram[SECONDARY_PALETTE + primary];
      primary = secondary & 15;
      alternate = secondary >>> 4 & 15;
    }
    return {
      primary,
      alternate,
      pattern: this.#view.getUint16(FILL_PATTERN, true),
      alternateTransparent: (flags & 1) !== 0,
      inverted
    };
  }
  #cameraPoint(xRaw, yRaw) {
    return [
      toInt162(q16Integer4(xRaw)) - this.#cameraX(),
      toInt162(q16Integer4(yRaw)) - this.#cameraY()
    ];
  }
  #cameraX() {
    return this.#view.getInt16(CAMERA_X, true);
  }
  #cameraY() {
    return this.#view.getInt16(CAMERA_Y, true);
  }
  #blitSprite(sourceX, sourceY, sourceWidth, sourceHeight, destinationX, destinationY, destinationWidth, destinationHeight, flipX, flipY) {
    if (destinationWidth <= 0 || destinationHeight <= 0 || sourceWidth === 0 || sourceHeight === 0 || destinationX + destinationWidth <= 0 || destinationX >= SCREEN_WIDTH || destinationY + destinationHeight <= 0 || destinationY >= SCREEN_HEIGHT) {
      return;
    }
    const firstDestinationOffsetX = Math.max(0, -destinationX, this.#ram[CLIP_LEFT] - destinationX);
    const finalDestinationOffsetX = Math.min(destinationWidth, SCREEN_WIDTH - destinationX, this.#ram[CLIP_RIGHT] - destinationX);
    const firstDestinationOffsetY = Math.max(0, -destinationY, this.#ram[CLIP_TOP] - destinationY);
    const finalDestinationOffsetY = Math.min(destinationHeight, SCREEN_HEIGHT - destinationY, this.#ram[CLIP_BOTTOM] - destinationY);
    for (let destinationOffsetY = firstDestinationOffsetY; destinationOffsetY < finalDestinationOffsetY; destinationOffsetY += 1) {
      const sampleOffsetY = flipY ? destinationHeight - 1 - destinationOffsetY : destinationOffsetY;
      const sampleY = sourceY + Math.floor(sourceHeight * sampleOffsetY / destinationHeight);
      const y = destinationY + destinationOffsetY;
      for (let destinationOffsetX = firstDestinationOffsetX; destinationOffsetX < finalDestinationOffsetX; destinationOffsetX += 1) {
        const sampleOffsetX = flipX ? destinationWidth - 1 - destinationOffsetX : destinationOffsetX;
        const sampleX = sourceX + Math.floor(sourceWidth * sampleOffsetX / destinationWidth);
        const x = destinationX + destinationOffsetX;
        this.#plotSprite(x, y, this.#readSpritePixelSafe(sampleX, sampleY));
      }
    }
  }
  #readSpritePixelSafe(x, y) {
    return insideSpriteSheet(x, y) ? this.#readSpritePixel(x, y) : 0;
  }
  #readMapTile(x, y) {
    const tile = this.#mapMemory.read(x, y);
    if (tile !== void 0)
      return tile;
    return (this.#ram[MISC_FEATURES2] & 16) !== 0 ? this.#ram[MGET_OUT_OF_BOUNDS] : 0;
  }
  #tileSelected(sprite, layers) {
    if (sprite === 0 && (this.#ram[MISC_FEATURES2] & 8) === 0)
      return false;
    return layers === 0 || (this.#ram[SPRITE_FLAGS + sprite] & layers) !== 0;
  }
  #plotTlineSample(x, y, mapXRaw, mapYRaw, maskX, maskY, layers) {
    if (!this.#insideClip(x, y))
      return;
    const maskedX = (mapXRaw & maskX) >>> 0;
    const maskedY = (mapYRaw & maskY) >>> 0;
    const mapX = (maskedX >>> 16) + this.#ram[TLINE_OFFSET_X];
    const mapY = (maskedY >>> 16) + this.#ram[TLINE_OFFSET_Y];
    const sprite = this.#readMapTile(mapX, mapY);
    if (!this.#tileSelected(sprite, layers))
      return;
    const sourceX = (sprite & 15) * 8 + (maskedX >>> 13 & 7);
    const sourceY = (sprite >>> 4) * 8 + (maskedY >>> 13 & 7);
    this.#plotSprite(x, y, this.#readSpritePixel(sourceX, sourceY));
  }
  #readSpritePixel(x, y) {
    const address = GFX_ADDRESS + y * 64 + (x >> 1);
    return this.#memory.readU8(address) >>> ((x & 1) << 2) & 15;
  }
  #writeSpritePixel(x, y, color) {
    const address = GFX_ADDRESS + y * 64 + (x >> 1);
    const shift = (x & 1) << 2;
    const mask = 15 << shift;
    const packed = this.#memory.readU8(address);
    this.#memory.writeU8(address, packed & ~mask | (color & 15) << shift);
  }
  #plotSprite(x, y, sourceColor) {
    if (!this.#insideClip(x, y))
      return;
    const drawEntry = this.#ram[DRAW_PALETTE + (sourceColor & 15)];
    if ((drawEntry & 16) !== 0)
      return;
    let color = drawEntry & 15;
    const flags = this.#ram[FILL_FLAGS];
    if ((flags & 2) !== 0) {
      const secondary = this.#ram[SECONDARY_PALETTE + color];
      const patternBit = this.#view.getUint16(FILL_PATTERN, true) >>> 15 - (x & 3) - 4 * (y & 3) & 1;
      if (patternBit !== 0 && (flags & 1) !== 0)
        return;
      color = patternBit === 0 ? secondary & 15 : secondary >>> 4 & 15;
    }
    this.#writeScreenPixel(x, y, color);
  }
  #plotTextPixel(worldX, worldY, sourceColor) {
    const x = worldX - this.#cameraX();
    const y = worldY - this.#cameraY();
    if (!this.#insideClip(x, y))
      return;
    const color = this.#ram[DRAW_PALETTE + (sourceColor & 15)] & 15;
    this.#writeScreenPixel(x, y, color);
  }
  #scrollScreen(rows) {
    const amount = clamp2(Math.trunc(rows), 0, SCREEN_HEIGHT);
    if (amount === 0)
      return;
    const remainingBytes = (SCREEN_HEIGHT - amount) * (SCREEN_WIDTH >> 1);
    const snapshot = this.#memory.copy(SCREEN_ADDRESS + amount * (SCREEN_WIDTH >> 1), remainingBytes);
    for (let index = 0; index < snapshot.byteLength; index += 1) {
      this.#memory.writeU8(SCREEN_ADDRESS + index, snapshot[index]);
    }
    this.#memory.fill(SCREEN_ADDRESS + remainingBytes, SCREEN_BYTES - remainingBytes, 0);
  }
  #drawFilled(color, inverted, drawShape) {
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
    const left = this.#ram[CLIP_LEFT];
    const top = this.#ram[CLIP_TOP];
    const right = this.#ram[CLIP_RIGHT];
    const bottom = this.#ram[CLIP_BOTTOM];
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        if (this.#shapeMask[y * SCREEN_WIDTH + x] === 0)
          this.#plot(x, y, color);
      }
    }
  }
  #drawLine(x0, y0, x1, y1, color) {
    const horizontal = Math.abs(x1 - x0) >= Math.abs(y1 - y0);
    const dx = x0 <= x1 ? 1 : -1;
    const dy = y0 <= y1 ? 1 : -1;
    let x = clamp2(x0, -1, SCREEN_WIDTH);
    let y = clamp2(y0, -1, SCREEN_HEIGHT);
    const xEnd = clamp2(x1, -1, SCREEN_WIDTH);
    const yEnd = clamp2(y1, -1, SCREEN_HEIGHT);
    for (; ; ) {
      this.#plot(x, y, color);
      if (horizontal) {
        if (x === xEnd)
          break;
        x += dx;
        y = roundAwayFromZero(y0 + (y1 - y0) * (x - x0) / (x1 - x0));
      } else {
        if (y === yEnd)
          break;
        y += dy;
        x = roundAwayFromZero(x0 + (x1 - x0) * (y - y0) / (y1 - y0));
      }
    }
  }
  #horizontal(x0, x1, y, color) {
    if (y < 0 || y >= SCREEN_HEIGHT)
      return;
    const first = Math.max(0, Math.min(x0, x1));
    const last = Math.min(SCREEN_WIDTH - 1, Math.max(x0, x1));
    for (let x = first; x <= last; x += 1)
      this.#plot(x, y, color);
  }
  #vertical(y0, y1, x, color) {
    if (x < 0 || x >= SCREEN_WIDTH)
      return;
    const first = Math.max(0, Math.min(y0, y1));
    const last = Math.min(SCREEN_HEIGHT - 1, Math.max(y0, y1));
    for (let y = first; y <= last; y += 1)
      this.#plot(x, y, color);
  }
  #plotCircleOctants(centerX, centerY, x, y, color) {
    this.#plot(centerX + x, centerY + y, color);
    this.#plot(centerX + y, centerY + x, color);
    this.#plot(centerX - x, centerY + y, color);
    this.#plot(centerX - y, centerY + x, color);
    this.#plot(centerX - x, centerY - y, color);
    this.#plot(centerX - y, centerY - x, color);
    this.#plot(centerX + x, centerY - y, color);
    this.#plot(centerX + y, centerY - x, color);
  }
  #plot(x, y, color) {
    if (x < 0 || x >= SCREEN_WIDTH || y < 0 || y >= SCREEN_HEIGHT)
      return;
    if (this.#maskingShape) {
      this.#shapeMask[y * SCREEN_WIDTH + x] = 1;
      return;
    }
    if (!this.#insideClip(x, y))
      return;
    const patternBit = color.pattern >>> 15 - (x & 3) - 4 * (y & 3) & 1;
    if (patternBit !== 0 && color.alternateTransparent)
      return;
    const pixel = patternBit === 0 ? color.primary : color.alternate;
    this.#writeScreenPixel(x, y, pixel);
  }
  #writeScreenPixel(x, y, pixel) {
    const address = SCREEN_ADDRESS + y * 64 + (x >> 1);
    const shift = (x & 1) << 2;
    const mask = 15 << shift;
    const packed = this.#memory.readU8(address);
    this.#memory.writeU8(address, packed & ~mask | pixel << shift);
  }
  #insideClip(x, y) {
    return x >= 0 && x < SCREEN_WIDTH && y >= 0 && y < SCREEN_HEIGHT && x >= this.#ram[CLIP_LEFT] && x < this.#ram[CLIP_RIGHT] && y >= this.#ram[CLIP_TOP] && y < this.#ram[CLIP_BOTTOM];
  }
  #outOfBoundsPixel() {
    return (this.#ram[MISC_FEATURES2] & 16) !== 0 ? this.#ram[PGET_OUT_OF_BOUNDS] : 0;
  }
  #outOfBoundsSpritePixel() {
    return (this.#ram[MISC_FEATURES2] & 16) !== 0 ? this.#ram[SGET_OUT_OF_BOUNDS] : 0;
  }
  #resetClip() {
    this.#ram[CLIP_LEFT] = 0;
    this.#ram[CLIP_TOP] = 0;
    this.#ram[CLIP_RIGHT] = SCREEN_WIDTH;
    this.#ram[CLIP_BOTTOM] = SCREEN_HEIGHT;
  }
  #resetClipAndCursor() {
    this.#resetClip();
    this.#ram[PRINT_START_X2] = 0;
    this.#ram[TEXT_CURSOR_X2] = 0;
    this.#ram[TEXT_CURSOR_Y2] = 0;
  }
  #invalidatePolyline() {
    this.#writePolylineEndpoint(0, 0);
    this.#setPolylineInvalid(true);
  }
  #polylineInvalid() {
    return (this.#ram[POLYLINE_FLAG] & 1) !== 0;
  }
  #setPolylineInvalid(invalid4) {
    const value = this.#ram[POLYLINE_FLAG];
    this.#ram[POLYLINE_FLAG] = invalid4 ? value | 1 : value & ~1;
  }
  #writePolylineEndpoint(x, y) {
    this.#view.setInt16(POLYLINE_X, x, true);
    this.#view.setInt16(POLYLINE_Y, y, true);
  }
};
function q16Integer4(raw) {
  return raw >> 16;
}
function q16ScaledInteger(raw, scale) {
  return Math.floor((raw | 0) * scale / 65536);
}
function advanceTlineQ16(value, delta, count, mask) {
  return value & ~mask | value + Math.imul(delta, count) & mask | 0;
}
function tlineMask(register) {
  const tiles = register === 0 ? 256 : register;
  return tiles * 65536 - 1 >>> 0;
}
function scaleTlineCoordinate(raw, fractionalBits) {
  const shift = fractionalBits - 13;
  return shift >= 0 ? (raw | 0) >> shift : (raw | 0) << -shift | 0;
}
function roundedRectBounds(xRaw, yRaw, widthRaw, heightRaw, radiusRaw, cameraX, cameraY) {
  const width = toInt162(q16Integer4(widthRaw));
  const height = toInt162(q16Integer4(heightRaw));
  if (width <= 0 || height <= 0)
    return void 0;
  const left = toInt162(q16Integer4(xRaw)) - cameraX;
  const top = toInt162(q16Integer4(yRaw)) - cameraY;
  const right = left + width - 1;
  const bottom = top + height - 1;
  const requestedRadius = radiusRaw === void 0 ? 0 : toInt162(q16Integer4(radiusRaw));
  const radius = clamp2(requestedRadius, 0, Math.floor(Math.min(width, height) / 2));
  return [left, top, right, bottom, radius];
}
function roundedRectInset(y, top, bottom, radius) {
  if (radius === 0)
    return 0;
  const cornerY = Math.min(y - top, bottom - y);
  if (cornerY >= radius)
    return 0;
  const dy = radius - cornerY;
  return Math.ceil(radius - Math.sqrt(radius * radius - dy * dy));
}
function insideRoundedRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom)
    return false;
  if (radius === 0)
    return true;
  const cornerX = x < left + radius ? left + radius : x > right - radius ? right - radius : x;
  const cornerY = y < top + radius ? top + radius : y > bottom - radius ? bottom - radius : y;
  const dx = x - cornerX;
  const dy = y - cornerY;
  return dx * dx + dy * dy <= radius * radius;
}
function toInt162(value) {
  return value << 16 >> 16;
}
function insideSpriteSheet(x, y) {
  return x >= 0 && x < SCREEN_WIDTH && y >= 0 && y < SCREEN_HEIGHT;
}
function ordered(first, second) {
  return first <= second ? [first, second] : [second, first];
}
function clamp2(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
function roundAwayFromZero(value) {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}
function circleBoundsTouchScreen(centerX, centerY, radius) {
  return centerX + radius >= 0 && centerX - radius < SCREEN_WIDTH && centerY + radius >= 0 && centerY - radius < SCREEN_HEIGHT;
}

// packages/runtime-core/dist/memory/pico-ram.js
var PicoRam = class {
  physicalBytes;
  #mapper;
  constructor(memory, mapper) {
    if (!(memory.buffer instanceof ArrayBuffer) || memory.byteLength !== PICO_RAM_SIZE || memory.byteOffset < 0 || memory.byteOffset + memory.byteLength > memory.buffer.byteLength) {
      throw new RangeError("PicoRam requires a valid 64 KiB memory lease");
    }
    if (mapper.memoryLeaseId !== memory.leaseId) {
      throw new Error("logical memory port is bound to a different memory lease");
    }
    this.physicalBytes = new Uint8Array(memory.buffer, memory.byteOffset, memory.byteLength);
    this.#mapper = mapper;
  }
  mapAddress(logicalAddress) {
    if (!Number.isInteger(logicalAddress) || !Number.isSafeInteger(logicalAddress)) {
      throw new RangeError("logical Pico RAM address must be a safe integer");
    }
    const mapped = this.#mapper.mapAddress(logicalAddress);
    if (!Number.isInteger(mapped) || mapped < 0 || mapped >= PICO_RAM_SIZE) {
      throw new RangeError("logical memory port returned an invalid physical address");
    }
    return mapped;
  }
  readU8(logicalAddress) {
    return this.physicalBytes[this.mapAddress(logicalAddress)];
  }
  writeU8(logicalAddress, value) {
    this.physicalBytes[this.mapAddress(logicalAddress)] = value & 255;
  }
  readU16LE(logicalAddress) {
    return this.readU8(logicalAddress) | this.readU8(logicalAddress + 1) << 8;
  }
  readI32LE(logicalAddress) {
    return this.readU8(logicalAddress) | this.readU8(logicalAddress + 1) << 8 | this.readU8(logicalAddress + 2) << 16 | this.readU8(logicalAddress + 3) << 24;
  }
  writeU16LE(logicalAddress, value) {
    this.writeU8(logicalAddress, value);
    this.writeU8(logicalAddress + 1, value >>> 8);
  }
  writeI32LE(logicalAddress, value) {
    this.writeU8(logicalAddress, value);
    this.writeU8(logicalAddress + 1, value >>> 8);
    this.writeU8(logicalAddress + 2, value >>> 16);
    this.writeU8(logicalAddress + 3, value >>> 24);
  }
  fill(logicalAddress, length, value) {
    assertLength(length);
    if (length === 0)
      return;
    const normalizedStart = logicalAddress & 65535;
    const normalizedEnd = normalizedStart + length - 1;
    const changesVideoMapping = normalizedStart <= 24407 && normalizedEnd >= 24404;
    if (normalizedEnd < PICO_RAM_SIZE && !changesVideoMapping) {
      const physicalStart = this.mapAddress(normalizedStart);
      const physicalEnd = this.mapAddress(normalizedEnd);
      if (physicalEnd === physicalStart + length - 1) {
        this.physicalBytes.fill(value & 255, physicalStart, physicalEnd + 1);
        return;
      }
    }
    for (let index = 0; index < length; index += 1) {
      this.writeU8(logicalAddress + index, value);
    }
  }
  copy(logicalAddress, length) {
    assertLength(length);
    const result = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      result[index] = this.readU8(logicalAddress + index);
    }
    return result;
  }
};
function assertLength(length) {
  if (!Number.isInteger(length) || length < 0 || length > PICO_RAM_SIZE) {
    throw new RangeError("logical Pico RAM length must be between 0 and 65536");
  }
}

// packages/runtime-core/dist/persistence/cart-data-core.js
var PICO_CART_DATA_ADDRESS = 24064;
var CART_DATA_ID_PATTERN = /^[a-z0-9_-]+$/u;
function validId(id) {
  return id.length >= 1 && id.length <= PICO_CART_DATA_ID_MAX_BYTES && CART_DATA_ID_PATTERN.test(id);
}
function copySeedRecords(seeds) {
  const records = /* @__PURE__ */ new Map();
  for (const seed of seeds) {
    if (typeof seed !== "object" || seed === null || !validId(seed.id)) {
      throw new RangeError("cartdata seed id must contain 1..64 lower-case ASCII id bytes, underscore or hyphen");
    }
    if (!(seed.bytes instanceof Uint8Array) || seed.bytes.byteLength !== PICO_CART_DATA_BYTES) {
      throw new RangeError("cartdata seed must contain exactly 256 bytes");
    }
    if (records.has(seed.id)) {
      throw new RangeError(`duplicate cartdata seed id: ${seed.id}`);
    }
    records.set(seed.id, seed.bytes.slice());
  }
  return records;
}
function idFromBytes(bytes) {
  if (bytes.byteLength < 1 || bytes.byteLength > PICO_CART_DATA_ID_MAX_BYTES || bytes.some((byte) => !(byte >= 97 && byte <= 122 || byte >= 48 && byte <= 57 || byte === 45 || byte === 95))) {
    throw new RangeError("cartdata id must contain 1..64 lower-case ASCII id bytes, underscore or hyphen");
  }
  return String.fromCharCode(...bytes);
}
function cartDataIndex(indexRaw) {
  const index = indexRaw >> 16;
  if (index < 0 || index >= PICO_CART_DATA_NUMBER_COUNT)
    return void 0;
  return index;
}
function bytesEqual(left, right) {
  for (let index = 0; index < PICO_CART_DATA_BYTES; index += 1) {
    if (left[index] !== right[index])
      return false;
  }
  return true;
}
var CartDataCore = class {
  #ram;
  #seeds;
  #openCalled = false;
  #id;
  #committedBytes;
  #revision = 0;
  constructor(ram, seeds = []) {
    if (!Array.isArray(seeds)) {
      throw new TypeError("cartdata seeds must be an array");
    }
    this.#ram = ram;
    this.#seeds = copySeedRecords(seeds);
  }
  reset() {
    this.#openCalled = false;
    this.#id = void 0;
    this.#committedBytes = void 0;
    this.#revision = 0;
    this.#ram.fill(PICO_CART_DATA_ADDRESS, PICO_CART_DATA_BYTES, 0);
  }
  cartdata(idBytes) {
    if (this.#openCalled) {
      throw new RangeError("cartdata may only be called once per cart execution");
    }
    const id = idFromBytes(idBytes);
    this.#openCalled = true;
    this.#id = id;
    this.#ram.fill(PICO_CART_DATA_ADDRESS, PICO_CART_DATA_BYTES, 0);
    const seed = this.#seeds.get(id);
    if (seed !== void 0) {
      for (let index = 0; index < PICO_CART_DATA_BYTES; index += 1) {
        this.#ram.writeU8(PICO_CART_DATA_ADDRESS + index, seed[index]);
      }
    }
    this.#committedBytes = this.#ram.copy(PICO_CART_DATA_ADDRESS, PICO_CART_DATA_BYTES);
    return seed === void 0 ? 0 : 1;
  }
  dget(indexRaw) {
    this.#assertOpen();
    const index = cartDataIndex(indexRaw);
    return index === void 0 ? 0 : this.#ram.readI32LE(PICO_CART_DATA_ADDRESS + index * 4);
  }
  dset(indexRaw, valueRaw) {
    this.#assertOpen();
    const index = cartDataIndex(indexRaw);
    if (index !== void 0) {
      this.#ram.writeI32LE(PICO_CART_DATA_ADDRESS + index * 4, valueRaw);
    }
  }
  takeCommit() {
    const id = this.#id;
    const committedBytes = this.#committedBytes;
    if (id === void 0 || committedBytes === void 0)
      return void 0;
    const bytes = this.#ram.copy(PICO_CART_DATA_ADDRESS, PICO_CART_DATA_BYTES);
    if (bytesEqual(bytes, committedBytes))
      return void 0;
    this.#revision += 1;
    this.#committedBytes = bytes.slice();
    return Object.freeze({ id, bytes: bytes.slice(), revision: this.#revision });
  }
  #assertOpen() {
    if (this.#id === void 0) {
      throw new RangeError("cartdata must select a slot before dget or dset");
    }
  }
};

// packages/runtime-core/dist/persistence/current-cart-data-core.js
var SHA256_PATTERN = /^[0-9a-f]{64}$/u;
var PicoFeatureUnsupportedError = class extends Error {
  name = "PicoFeatureUnsupportedError";
};
function assertNoReference(reference) {
  if (reference !== void 0) {
    throw new PicoFeatureUnsupportedError("reload/cstore external cart references are not supported");
  }
}
var CurrentCartDataCore = class {
  #ram;
  #identity;
  #repository;
  constructor(ram, identity, repository) {
    if (!SHA256_PATTERN.test(identity.contentSha256)) {
      throw new RangeError("current-cart identity must be a lower-case SHA-256 digest");
    }
    this.#ram = ram;
    this.#identity = Object.freeze({ contentSha256: identity.contentSha256 });
    this.#repository = repository;
  }
  reload(destinationRaw, sourceRaw, lengthRaw, reference) {
    assertNoReference(reference);
    const { destination, source, length } = normalizeReloadRange(destinationRaw, sourceRaw, lengthRaw);
    const bytes = this.#repository.readData(this.#identity, source, length);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) {
      throw new Error("current-cart repository returned an invalid reload snapshot");
    }
    for (let index = 0; index < length; index += 1) {
      this.#ram.writeU8(destination + index, bytes[index]);
    }
  }
  cstore(destinationRaw, sourceRaw, lengthRaw, reference) {
    assertNoReference(reference);
    const { destination, source, length } = normalizeCstoreRange(destinationRaw, sourceRaw, lengthRaw);
    const bytes = this.#ram.copy(source, length);
    this.#repository.writeDataOverlay(this.#identity, destination, bytes);
  }
};

// packages/runtime-core/dist/pico-api/pico-api-host.js
var LEGACY_CHANNEL_ZERO_NOTE_SELECTOR = 20;
var Q16_ONE = 65536;
var AUDIO_EVENT_LIMIT = 64;
var RuntimePicoApiHost = class {
  #audioEvents = [];
  #audioDropped = 0;
  memoryLeaseId;
  #graphics;
  #input;
  #audio;
  #cartData;
  #currentCart;
  #ram;
  constructor(memory, logicalMemory, options) {
    if (!(memory.buffer instanceof ArrayBuffer) || memory.byteLength !== PICO_RAM_SIZE || memory.byteOffset < 0 || memory.byteOffset + memory.byteLength > memory.buffer.byteLength) {
      throw new RangeError("PicoApiHost requires a valid 64 KiB memory lease");
    }
    this.memoryLeaseId = memory.leaseId;
    const picoRam = new PicoRam(memory, logicalMemory);
    this.#ram = picoRam;
    const ram = picoRam.physicalBytes;
    this.#audio = new PicoSfxSynth(ram);
    this.#graphics = new L1Graphics(picoRam, {
      play: (bytes) => this.#audio.playP8sciiAudio(bytes)
    });
    this.#input = new L1Input(ram);
    this.#cartData = new CartDataCore(picoRam, options.cartDataSeeds ?? []);
    this.#currentCart = options.currentCart === void 0 ? void 0 : new CurrentCartDataCore(picoRam, options.currentCart.identity, options.currentCart.repository);
  }
  reset() {
    this.#graphics.reset();
    this.#input.reset();
    this.#audio.reset();
    this.#cartData.reset();
  }
  resetSystem() {
    this.#ram.fill(24320, 128, 0);
    this.#graphics.reset();
  }
  resetAudio() {
    this.#audio.reset();
  }
  beginTick(input, targetFps) {
    this.#input.beginTick(input, targetFps);
  }
  get devkitFlags() {
    return this.#input.devkitFlags;
  }
  takeCartDataCommit() {
    return this.#cartData.takeCommit();
  }
  renderAudioSlices(sliceCount, targetFps) {
    return this.#audio.renderSlices(sliceCount, targetFps);
  }
  snapshotAudioChannels() {
    return this.#audio.snapshotChannels();
  }
  snapshotAudioMusic() {
    return this.#audio.snapshotMusic();
  }
  cls(colorRaw) {
    this.#graphics.cls(colorRaw);
  }
  color(colorRaw) {
    return this.#graphics.color(colorRaw);
  }
  camera(xRaw, yRaw) {
    this.#graphics.camera(xRaw, yRaw);
  }
  clip(xRaw, yRaw, widthRaw, heightRaw, clipPrevious) {
    this.#graphics.clip(xRaw, yRaw, widthRaw, heightRaw, clipPrevious);
  }
  pal(sourceRaw, targetRaw, paletteRaw) {
    return this.#graphics.pal(sourceRaw, targetRaw, paletteRaw);
  }
  palt(colorOrMaskRaw, transparent) {
    return this.#graphics.palt(colorOrMaskRaw, transparent);
  }
  fillp(patternRaw) {
    return this.#graphics.fillp(patternRaw);
  }
  pget(xRaw, yRaw) {
    return this.#graphics.pget(xRaw, yRaw);
  }
  sget(xRaw, yRaw) {
    return this.#graphics.sget(xRaw, yRaw);
  }
  sset(xRaw, yRaw, colorRaw) {
    this.#graphics.sset(xRaw, yRaw, colorRaw);
  }
  spr(spriteRaw, xRaw, yRaw, widthRaw, heightRaw, flipX, flipY) {
    this.#graphics.spr(spriteRaw, xRaw, yRaw, widthRaw, heightRaw, flipX, flipY);
  }
  sspr(sourceXRaw, sourceYRaw, sourceWidthRaw, sourceHeightRaw, destinationXRaw, destinationYRaw, destinationWidthRaw, destinationHeightRaw, flipX, flipY) {
    this.#graphics.sspr(sourceXRaw, sourceYRaw, sourceWidthRaw, sourceHeightRaw, destinationXRaw, destinationYRaw, destinationWidthRaw, destinationHeightRaw, flipX, flipY);
  }
  mget(xRaw, yRaw) {
    return this.#graphics.mget(xRaw, yRaw);
  }
  mset(xRaw, yRaw, valueRaw) {
    this.#graphics.mset(xRaw, yRaw, valueRaw);
  }
  fget(spriteRaw, flagRaw) {
    return this.#graphics.fget(spriteRaw, flagRaw);
  }
  fset(spriteRaw, flagOrValueRaw, value) {
    this.#graphics.fset(spriteRaw, flagOrValueRaw, value);
  }
  map(tileXRaw, tileYRaw, screenXRaw, screenYRaw, tileWidthRaw, tileHeightRaw, layersRaw) {
    this.#graphics.map(tileXRaw, tileYRaw, screenXRaw, screenYRaw, tileWidthRaw, tileHeightRaw, layersRaw);
  }
  tline(x0Raw, y0Raw, x1Raw, y1Raw, mxRaw, myRaw, mdxRaw, mdyRaw, layersRaw) {
    this.#graphics.tline(x0Raw, y0Raw, x1Raw, y1Raw, mxRaw, myRaw, mdxRaw, mdyRaw, layersRaw);
  }
  print(bytes, xOrColorRaw, yRaw, colorRaw) {
    return this.#graphics.print(bytes, xOrColorRaw, yRaw, colorRaw);
  }
  cursor(xRaw, yRaw, colorRaw) {
    this.#graphics.cursor(xRaw, yRaw, colorRaw);
  }
  pset(xRaw, yRaw, colorRaw) {
    this.#graphics.pset(xRaw, yRaw, colorRaw);
  }
  line(x0Raw, y0Raw, x1OrColorRaw, y1Raw, colorRaw) {
    this.#graphics.line(x0Raw, y0Raw, x1OrColorRaw, y1Raw, colorRaw);
  }
  rect(x0Raw, y0Raw, x1Raw, y1Raw, colorRaw) {
    this.#graphics.rect(x0Raw, y0Raw, x1Raw, y1Raw, colorRaw);
  }
  rectfill(x0Raw, y0Raw, x1Raw, y1Raw, colorRaw) {
    this.#graphics.rectfill(x0Raw, y0Raw, x1Raw, y1Raw, colorRaw);
  }
  rrect(xRaw, yRaw, widthRaw, heightRaw, radiusRaw, colorRaw) {
    this.#graphics.rrect(xRaw, yRaw, widthRaw, heightRaw, radiusRaw, colorRaw);
  }
  rrectfill(xRaw, yRaw, widthRaw, heightRaw, radiusRaw, colorRaw) {
    this.#graphics.rrectfill(xRaw, yRaw, widthRaw, heightRaw, radiusRaw, colorRaw);
  }
  circ(xRaw, yRaw, radiusRaw, colorRaw) {
    this.#graphics.circ(xRaw, yRaw, radiusRaw, colorRaw);
  }
  circfill(xRaw, yRaw, radiusRaw, colorRaw) {
    this.#graphics.circfill(xRaw, yRaw, radiusRaw, colorRaw);
  }
  oval(x0Raw, y0Raw, x1Raw, y1Raw, colorRaw) {
    this.#graphics.oval(x0Raw, y0Raw, x1Raw, y1Raw, colorRaw);
  }
  ovalfill(x0Raw, y0Raw, x1Raw, y1Raw, colorRaw) {
    this.#graphics.ovalfill(x0Raw, y0Raw, x1Raw, y1Raw, colorRaw);
  }
  btn(buttonRaw, playerRaw) {
    return this.#input.btn(buttonRaw, playerRaw);
  }
  btnp(buttonRaw, playerRaw) {
    return this.#input.btnp(buttonRaw, playerRaw);
  }
  sfx(sfxRaw, channelRaw, offsetRaw, lengthRaw) {
    const before = this.#audio.snapshotChannels();
    const musicChannels = this.#audio.snapshotMusic().musicChannels;
    this.#audio.sfx(sfxRaw, channelRaw, offsetRaw, lengthRaw);
    const id = sfxRaw >> 16;
    if (!(id >= 0))
      return;
    const after = this.#audio.snapshotChannels();
    const started = after.find((voice, channel) => voice.sfx === id && (before[channel].sfx !== id || voice.offset < before[channel].offset || voice.offset === 0));
    if (started !== void 0)
      this.#recordAudio({ sfx: id, channel: started.channel, music: musicChannels[started.channel] === true });
  }
  music(patternRaw, fadeLengthRaw, channelMaskRaw) {
    this.#audio.music(patternRaw, fadeLengthRaw, channelMaskRaw);
    const pattern = patternRaw >> 16;
    this.#recordAudio({ music: pattern >= 0 && this.#audio.snapshotMusic().playing ? pattern : -1 });
  }
  takeAudioEvents() {
    const log = { events: this.#audioEvents, dropped: this.#audioDropped };
    this.#audioEvents = [];
    this.#audioDropped = 0;
    return log;
  }
  #recordAudio(event) {
    if (this.#audioEvents.length < AUDIO_EVENT_LIMIT)
      this.#audioEvents.push(event);
    else
      this.#audioDropped++;
  }
  stat(selectorRaw) {
    const selector = selectorRaw >> 16;
    const channels = this.#audio.snapshotChannels();
    if (selector >= 16 && selector <= 19) {
      return channels[selector - 16].sfx * Q16_ONE;
    }
    if (selector >= 20 && selector <= 23) {
      return channels[selector - 20].note * Q16_ONE;
    }
    if (selector >= 46 && selector <= 49) {
      return channels[selector - 46].sfx * Q16_ONE;
    }
    if (selector >= 50 && selector <= 53) {
      return channels[selector - 50].note * Q16_ONE;
    }
    const music = this.#audio.snapshotMusic();
    if (selector === 24 || selector === 54)
      return music.pattern * Q16_ONE;
    if (selector === 25 || selector === 55)
      return music.patternsPlayed * Q16_ONE;
    if (selector === 26 || selector === 56)
      return music.tick * Q16_ONE;
    if (selector === 57)
      return music.playing ? 1 : 0;
    if (selector === LEGACY_CHANNEL_ZERO_NOTE_SELECTOR) {
      return channels[0].note * Q16_ONE;
    }
    return this.#input.stat(selectorRaw);
  }
  cartdata(idBytes) {
    return this.#cartData.cartdata(idBytes);
  }
  dget(indexRaw) {
    return this.#cartData.dget(indexRaw);
  }
  dset(indexRaw, valueRaw) {
    this.#cartData.dset(indexRaw, valueRaw);
  }
  reload(destinationRaw, sourceRaw, lengthRaw, reference) {
    if (this.#currentCart === void 0) {
      throw new PicoFeatureUnsupportedError("reload requires a current-cart repository");
    }
    this.#currentCart.reload(destinationRaw, sourceRaw, lengthRaw, reference);
  }
  cstore(destinationRaw, sourceRaw, lengthRaw, reference) {
    if (this.#currentCart === void 0) {
      throw new PicoFeatureUnsupportedError("cstore requires a current-cart repository");
    }
    this.#currentCart.cstore(destinationRaw, sourceRaw, lengthRaw, reference);
  }
};
function createPicoApiHost(memory, logicalMemory, options = {}) {
  return new RuntimePicoApiHost(memory, logicalMemory, options);
}

// packages/runtime-core/dist/frame-runtime.js
var PICO_VM_INSTRUCTIONS_PER_SECOND = 4e6;
var PICO_CPU_ONE_RAW = 65536;
var DEFAULT_SAFETY_INSTRUCTION_LIMIT = 32e6;
var CART_ROM_BYTES = 32768;
var SCREEN_OFFSET = 24576;
var SCREEN_BYTES2 = 8192;
var DISPLAY_PALETTE_OFFSET = 24336;
var DISPLAY_PALETTE_BYTES = 16;
var STARTUP_TIME_RAW = Math.floor(65536 / 30);
function picoCpuSliceBudget(targetFps) {
  if (targetFps !== 30 && targetFps !== 60) {
    throw new RangeError("targetFps must be 30 or 60");
  }
  return Object.freeze({
    floor: Math.floor(PICO_VM_INSTRUCTIONS_PER_SECOND / targetFps),
    ceiling: Math.ceil(PICO_VM_INSTRUCTIONS_PER_SECOND / targetFps)
  });
}
function runtimeCpuCost(cpuInstructions, accountingFps) {
  if (!Number.isSafeInteger(cpuInstructions) || cpuInstructions < 0 || cpuInstructions > 4294967295) {
    throw new RangeError("cpuInstructions must be a uint32");
  }
  picoCpuSliceBudget(accountingFps);
  const raw = BigInt(cpuInstructions) * BigInt(accountingFps) * 65536n / BigInt(PICO_VM_INSTRUCTIONS_PER_SECOND);
  const cpuFractionRaw = Number(raw > 0x7fffffffn ? 0x7fffffffn : raw);
  return Object.freeze({
    cpuInstructions,
    cpuFractionRaw,
    slowFrame: cpuFractionRaw > PICO_CPU_ONE_RAW
  });
}
function invalidState(message2) {
  return {
    code: "E_INVALID_STATE",
    message: message2,
    phase: "none",
    recoverable: false
  };
}
function serializeFault(record) {
  return {
    code: record.code,
    message: record.message,
    phase: record.phase,
    ...record.line === void 0 ? {} : { line: record.line },
    ...record.trace === void 0 ? {} : { trace: record.trace },
    recoverable: record.code === "E_VM_SYNTAX",
    ...record.details === void 0 ? {} : { details: record.details }
  };
}
function logicalTimeRaw(completedSlices, targetFps) {
  if (completedSlices < 0n)
    throw new RangeError("completedSlices must be non-negative");
  const raw = completedSlices * 65536n / BigInt(targetFps);
  return Number(BigInt.asIntN(32, raw)) | 0;
}
var FrameSliceRuntime = class {
  inspect(request) {
    if (this.#state !== "ready" || this.#pending !== void 0)
      throw new Error("inspection requires a ready frame boundary");
    return this.#vm.inspect(request);
  }
  snapshotLogs() {
    return this.#vm.snapshotLogs();
  }
  /** Drain guest sfx()/music() starts since the last call. Does not run guest code. */
  takeAudioEvents() {
    return this.#picoApiHost.takeAudioEvents();
  }
  #vm;
  #picoApiHost;
  #ram;
  #instructionBudget;
  #currentCart;
  #runParameter;
  #state = "empty";
  #mode = "none";
  #targetFps = 0;
  #completedSlices = 0n;
  #frameId = 0;
  #pending;
  constructor(vm, options = {}) {
    const budget = options.instructionBudget ?? DEFAULT_SAFETY_INSTRUCTION_LIMIT;
    if (!Number.isSafeInteger(budget) || budget <= 0 || budget > 4294967295) {
      throw new RangeError("instructionBudget must be a positive uint32");
    }
    this.#vm = vm;
    this.#instructionBudget = budget;
    this.#ram = new PicoRam(vm.memory, vm.logicalMemory);
    if (options.picoApiHost !== void 0 && (options.cartDataSeeds !== void 0 || options.currentCart !== void 0)) {
      throw new TypeError("cartDataSeeds/currentCart cannot be combined with a custom PicoApiHost");
    }
    this.#currentCart = options.currentCart;
    if (options.runParameter !== void 0 && (!(options.runParameter instanceof Uint8Array) || options.runParameter.byteLength > 4096)) {
      throw new RangeError("runParameter must be a Uint8Array of at most 4096 bytes");
    }
    this.#runParameter = options.runParameter?.slice() ?? new Uint8Array();
    const host = options.picoApiHost ?? createPicoApiHost(vm.memory, vm.logicalMemory, {
      ...options.cartDataSeeds === void 0 ? {} : { cartDataSeeds: options.cartDataSeeds },
      ...options.currentCart === void 0 ? {} : { currentCart: options.currentCart }
    });
    if (host.memoryLeaseId !== vm.memory.leaseId) {
      throw new Error("PicoApiHost is bound to a different memory lease");
    }
    vm.bindHost(host);
    this.#picoApiHost = host;
  }
  get state() {
    return this.#state;
  }
  get mode() {
    return this.#mode;
  }
  get completedSlices() {
    return this.#completedSlices;
  }
  boot(cart, input = PICO_EMPTY_INPUT) {
    if (this.#state !== "empty") {
      return { ok: false, error: invalidState("runtime session is not empty") };
    }
    let normalizedInput;
    try {
      normalizedInput = normalizeInputSnapshot(input);
    } catch (error) {
      return {
        ok: false,
        error: invalidState(error instanceof Error ? error.message : String(error))
      };
    }
    if (cart.rom.byteLength !== CART_ROM_BYTES) {
      return { ok: false, error: invalidState("cart ROM must be exactly 0x8000 bytes") };
    }
    let bootRom = cart.rom;
    if (this.#currentCart !== void 0) {
      try {
        const data = this.#currentCart.repository.readData(this.#currentCart.identity, 0, PICO_CART_DATA_ROM_SIZE);
        if (!(data instanceof Uint8Array) || data.byteLength !== PICO_CART_DATA_ROM_SIZE) {
          throw new Error("current-cart repository returned an invalid boot snapshot");
        }
        bootRom = cart.rom.slice();
        bootRom.set(data, 0);
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "E_INVARIANT",
            message: `current-cart boot snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
            phase: "none",
            recoverable: false
          }
        };
      }
    }
    this.#vm.resetRam();
    this.#picoApiHost.reset();
    this.#vm.writeCartRom(bootRom);
    this.#vm.setRunParameter(this.#runParameter);
    const compiled = this.#vm.compile(cart.code);
    if (compiled.kind === "fault")
      return this.#acceptFault(compiled.error);
    const controllers = normalizedInput.controllers;
    this.#picoApiHost.beginTick(normalizedInput, 30);
    const buttons = controllers[0];
    const outcome = this.#vm.boot(this.#instructionBudget, buttons, STARTUP_TIME_RAW);
    return this.#acceptBootOutcome(outcome, buttons, STARTUP_TIME_RAW, this.#instructionBudget, 0);
  }
  step(input = PICO_EMPTY_INPUT) {
    if (this.#state !== "ready" || this.#targetFps === 0) {
      return { ok: false, error: invalidState("runtime session is not ready to step") };
    }
    let normalizedInput;
    try {
      normalizedInput = normalizeInputSnapshot(input);
    } catch (error) {
      return {
        ok: false,
        error: invalidState(error instanceof Error ? error.message : String(error))
      };
    }
    const timeRaw = logicalTimeRaw(this.#completedSlices + 1n, this.#targetFps);
    const controllers = normalizedInput.controllers;
    this.#picoApiHost.beginTick(normalizedInput, this.#targetFps);
    const buttons = controllers[0];
    const outcome = this.#vm.step(this.#instructionBudget, buttons, timeRaw);
    return this.#acceptStepOutcome(outcome, buttons, timeRaw, this.#instructionBudget, 0);
  }
  completeHostRequest(requestId, response, isError = false) {
    const pending = this.#pending;
    if (this.#state !== "waiting-host" || pending === void 0) {
      return { ok: false, error: invalidState("no host request is pending") };
    }
    const outcome = this.#vm.completeHostRequest(requestId, response, isError, pending.remainingBudget);
    if (pending.operation === "boot") {
      return this.#acceptBootOutcome(outcome, pending.buttons, pending.timeRaw, pending.remainingBudget, pending.consumedInstructions);
    }
    return this.#acceptStepOutcome(outcome, pending.buttons, pending.timeRaw, pending.remainingBudget, pending.consumedInstructions);
  }
  snapshotMenuItems() {
    if (this.#state !== "ready") {
      return { ok: false, error: invalidState("runtime session is not ready for menu snapshot") };
    }
    try {
      const snapshot = this.#vm.snapshotMenuItems();
      return {
        ok: true,
        value: {
          items: snapshot.items.map((item) => ({
            slot: item.slot,
            label: item.label.slice(),
            filter: item.filter
          }))
        }
      };
    } catch (error) {
      return this.#acceptFault({
        code: "E_INVARIANT",
        message: `menu snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
        phase: "menuitem"
      });
    }
  }
  invokeMenuItem(slot, button2) {
    if (this.#state !== "ready") {
      return { ok: false, error: invalidState("runtime session is not ready for menu invocation") };
    }
    const outcome = this.#vm.invokeMenuItem(slot, button2, this.#instructionBudget);
    if (outcome.kind === "rejected") {
      return { ok: false, error: invalidState(outcome.message) };
    }
    if (outcome.kind === "fault")
      return this.#acceptFault(outcome.error);
    const snapshot = this.snapshotMenuItems();
    if (!snapshot.ok)
      return snapshot;
    const cartDataCommit = this.#takeCartDataCommit();
    if (!cartDataCommit.ok)
      return cartDataCommit;
    return {
      ok: true,
      value: {
        kind: outcome.kind,
        snapshot: snapshot.value,
        ...cartDataCommit.value === void 0 ? {} : { cartDataCommit: cartDataCommit.value }
      }
    };
  }
  copyRam(offset, length) {
    return this.#vm.copyRam(offset, length);
  }
  /** Copy live logical Base RAM only while a root HostRequest is suspended. */
  copySuspendedLogicalRam(offset, length) {
    if (this.#state !== "waiting-host" || this.#pending === void 0) {
      throw new Error("logical RAM snapshot requires a suspended host request");
    }
    if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset > 65536 || length > 65536 - offset) {
      throw new RangeError("logical RAM snapshot range is out of bounds");
    }
    return this.#ram.copy(offset, length);
  }
  /** Atomically apply bytes to live logical Base RAM before guest continuation. */
  writeSuspendedLogicalRam(offset, bytes) {
    if (this.#state !== "waiting-host" || this.#pending === void 0) {
      throw new Error("logical RAM write requires a suspended host request");
    }
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("logical RAM write bytes must be a Uint8Array");
    }
    if (!Number.isInteger(offset) || offset < 0 || offset > 65536 || bytes.byteLength > 65536 - offset) {
      throw new RangeError("logical RAM write range is out of bounds");
    }
    const snapshot = bytes.slice();
    for (let index = 0; index < snapshot.byteLength; index += 1) {
      this.#ram.writeU8(offset + index, snapshot[index]);
    }
  }
  dispose() {
    if (this.#state === "disposed")
      return;
    this.#picoApiHost.resetAudio();
    this.#vm.destroy();
    this.#pending = void 0;
    this.#state = "disposed";
  }
  #acceptFault(fault) {
    this.#picoApiHost.resetAudio();
    this.#pending = void 0;
    this.#state = "faulted";
    return { ok: false, error: serializeFault(fault) };
  }
  #captureMode(outcome) {
    this.#mode = outcome.mode;
    this.#targetFps = outcome.targetFps;
    return outcome.mode !== "none" && outcome.targetFps !== 0;
  }
  #acceptBootOutcome(outcome, buttons, timeRaw, availableBudget, consumedBefore) {
    if (outcome.kind === "fault")
      return this.#acceptFault(outcome.error);
    if (outcome.kind === "host-request") {
      const remainingBudget = availableBudget - outcome.consumedInstructions;
      if (remainingBudget <= 0) {
        return this.#acceptFault({
          code: "E_VM_INSTRUCTION_BUDGET",
          message: "instruction budget exhausted before host response",
          phase: "host-call"
        });
      }
      this.#pending = {
        operation: "boot",
        buttons,
        timeRaw,
        remainingBudget,
        consumedInstructions: consumedBefore + outcome.consumedInstructions
      };
      this.#state = "waiting-host";
      return {
        ok: true,
        value: {
          kind: "host-request",
          request: { ...outcome.request, operation: "boot" }
        }
      };
    }
    if (outcome.kind === "stopped" || outcome.kind === "restart") {
      this.#picoApiHost.resetAudio();
      const cartDataCommit2 = this.#takeCartDataCommit();
      if (!cartDataCommit2.ok)
        return cartDataCommit2;
      this.#state = "stopped";
      return {
        ok: true,
        value: outcome.kind === "stopped" ? {
          kind: "stopped",
          message: outcome.message.slice(),
          ...cartDataCommit2.value === void 0 ? {} : { cartDataCommit: cartDataCommit2.value }
        } : {
          kind: "restart",
          parameter: outcome.parameter.slice(),
          ...cartDataCommit2.value === void 0 ? {} : { cartDataCommit: cartDataCommit2.value }
        }
      };
    }
    if (!this.#captureMode(outcome)) {
      this.#state = "stopped";
      return {
        ok: false,
        error: invalidState("cart stopped before establishing a frame loop")
      };
    }
    this.#pending = void 0;
    this.#completedSlices = BigInt(this.#targetFps / 30);
    const targetFps = this.#targetFps;
    const cpuCost = runtimeCpuCost(consumedBefore + outcome.consumedInstructions, 30);
    const audio = this.#picoApiHost.renderAudioSlices(targetFps / 30, targetFps);
    const cartDataCommit = this.#takeCartDataCommit();
    if (!cartDataCommit.ok)
      return cartDataCommit;
    this.#state = "ready";
    return {
      ok: true,
      value: {
        kind: "ready",
        mode: this.#mode,
        targetFps,
        ...cpuCost,
        audio,
        devkitFlags: this.#picoApiHost.devkitFlags,
        ...cartDataCommit.value === void 0 ? {} : { cartDataCommit: cartDataCommit.value }
      }
    };
  }
  #acceptStepOutcome(outcome, buttons, timeRaw, availableBudget, consumedBefore) {
    if (outcome.kind === "fault")
      return this.#acceptFault(outcome.error);
    if (outcome.kind === "host-request") {
      const remainingBudget = availableBudget - outcome.consumedInstructions;
      if (remainingBudget <= 0) {
        return this.#acceptFault({
          code: "E_VM_INSTRUCTION_BUDGET",
          message: "instruction budget exhausted before host response",
          phase: "host-call"
        });
      }
      this.#pending = {
        operation: "step",
        buttons,
        timeRaw,
        remainingBudget,
        consumedInstructions: consumedBefore + outcome.consumedInstructions
      };
      this.#state = "waiting-host";
      return {
        ok: true,
        value: {
          kind: "host-request",
          request: { ...outcome.request, operation: "step" }
        }
      };
    }
    if (outcome.kind === "stopped") {
      this.#picoApiHost.resetAudio();
      const cartDataCommit2 = this.#takeCartDataCommit();
      if (!cartDataCommit2.ok)
        return cartDataCommit2;
      this.#pending = void 0;
      this.#state = "stopped";
      return {
        ok: true,
        value: {
          kind: "stopped",
          message: outcome.message.slice(),
          ...cartDataCommit2.value === void 0 ? {} : { cartDataCommit: cartDataCommit2.value }
        }
      };
    }
    if (outcome.kind === "restart") {
      this.#picoApiHost.resetAudio();
      const cartDataCommit2 = this.#takeCartDataCommit();
      if (!cartDataCommit2.ok)
        return cartDataCommit2;
      this.#pending = void 0;
      this.#state = "stopped";
      return {
        ok: true,
        value: {
          kind: "restart",
          parameter: outcome.parameter.slice(),
          ...cartDataCommit2.value === void 0 ? {} : { cartDataCommit: cartDataCommit2.value }
        }
      };
    }
    if (outcome.kind !== "frame" || !this.#captureMode(outcome)) {
      return this.#acceptFault({
        code: "E_INVARIANT",
        message: "VM step did not complete exactly one frame slice",
        phase: "none"
      });
    }
    this.#pending = void 0;
    this.#completedSlices += 1n;
    const targetFps = this.#targetFps;
    const cpuCost = runtimeCpuCost(consumedBefore + outcome.consumedInstructions, targetFps);
    const audio = this.#picoApiHost.renderAudioSlices(1, targetFps);
    const cartDataCommit = this.#takeCartDataCommit();
    if (!cartDataCommit.ok)
      return cartDataCommit;
    const frame = {
      frameId: this.#frameId++,
      completedSlices: this.#completedSlices.toString(),
      timeRawBeforeStep: timeRaw,
      targetFps,
      ...cpuCost,
      screen: this.#ram.copy(SCREEN_OFFSET, SCREEN_BYTES2),
      displayPalette: this.#ram.copy(DISPLAY_PALETTE_OFFSET, DISPLAY_PALETTE_BYTES),
      devkitFlags: this.#picoApiHost.devkitFlags,
      audio,
      ...cartDataCommit.value === void 0 ? {} : { cartDataCommit: cartDataCommit.value }
    };
    this.#state = "ready";
    return { ok: true, value: { kind: "frame", frame } };
  }
  #takeCartDataCommit() {
    try {
      return { ok: true, value: this.#picoApiHost.takeCartDataCommit() };
    } catch (error) {
      return this.#acceptFault({
        code: "E_INVARIANT",
        message: `cartdata commit snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
        phase: "none"
      });
    }
  }
};

// packages/runtime-core/dist/scheduler/frame-scheduler.js
var EMPTY_DECISION = Object.freeze({
  tickCount: 0,
  discontinuity: false,
  droppedTicks: 0
});
function assertTimestamp(timestampMs) {
  if (!Number.isFinite(timestampMs) || timestampMs < 0) {
    throw new RangeError("scheduler timestamp must be a non-negative finite number");
  }
}
var FrameScheduler = class {
  #maximumCatchUpTicks;
  #targetFps = 30;
  #running = false;
  #anchorMs;
  #accumulatorMs = 0;
  constructor(options = {}) {
    const maximumCatchUpTicks = options.maximumCatchUpTicks ?? 5;
    if (!Number.isSafeInteger(maximumCatchUpTicks) || maximumCatchUpTicks <= 0) {
      throw new RangeError("maximumCatchUpTicks must be a positive safe integer");
    }
    this.#maximumCatchUpTicks = maximumCatchUpTicks;
  }
  get targetFps() {
    return this.#targetFps;
  }
  get running() {
    return this.#running;
  }
  configure(targetFps) {
    if (targetFps !== 30 && targetFps !== 60) {
      throw new RangeError("targetFps must be 30 or 60");
    }
    this.#targetFps = targetFps;
    this.reset();
  }
  start() {
    this.#running = true;
    this.#anchorMs = void 0;
    this.#accumulatorMs = 0;
  }
  pause() {
    this.#running = false;
    this.#anchorMs = void 0;
    this.#accumulatorMs = 0;
  }
  resume() {
    this.start();
  }
  reset() {
    this.pause();
  }
  pulse(timestampMs) {
    assertTimestamp(timestampMs);
    if (!this.#running)
      return EMPTY_DECISION;
    const previous = this.#anchorMs;
    this.#anchorMs = timestampMs;
    if (previous === void 0)
      return EMPTY_DECISION;
    if (timestampMs < previous) {
      this.#accumulatorMs = 0;
      return Object.freeze({ tickCount: 0, discontinuity: true, droppedTicks: 0 });
    }
    this.#accumulatorMs += timestampMs - previous;
    const tickDurationMs = 1e3 / this.#targetFps;
    const availableTicks = Math.floor((this.#accumulatorMs + Number.EPSILON * timestampMs) / tickDurationMs);
    if (availableTicks <= 0)
      return EMPTY_DECISION;
    const tickCount = Math.min(availableTicks, this.#maximumCatchUpTicks);
    const droppedTicks = Math.min(Math.max(0, availableTicks - tickCount), 4294967295);
    if (droppedTicks > 0) {
      this.#accumulatorMs = 0;
    } else {
      this.#accumulatorMs -= tickCount * tickDurationMs;
      if (Math.abs(this.#accumulatorMs) < 1e-9)
        this.#accumulatorMs = 0;
    }
    return Object.freeze({
      tickCount,
      discontinuity: droppedTicks > 0,
      droppedTicks
    });
  }
};

// packages/runtime-core/dist/session/cart-session.js
var MAX_GENERATION = 4294967295;
var SHA256_PATTERN2 = /^[0-9a-f]{64}$/;
function lifecycleError(code, message2, details) {
  return {
    code,
    message: message2,
    phase: "none",
    recoverable: false,
    ...details === void 0 ? {} : { details }
  };
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function invalid3(message2, details) {
  return { ok: false, error: lifecycleError("E_INVALID_STATE", message2, details) };
}
function snapshotCart(cart) {
  if (!(cart.rom instanceof Uint8Array) || cart.rom.byteLength !== PICO_CART_ROM_SIZE) {
    throw new RangeError("cart ROM must be exactly 0x8000 bytes");
  }
  if (!(cart.code instanceof Uint8Array)) {
    throw new TypeError("cart code must be a Uint8Array");
  }
  if (!SHA256_PATTERN2.test(cart.identity.contentSha256)) {
    throw new RangeError("cart identity must be a lower-case SHA-256 digest");
  }
  if (cart.format !== "p8" && cart.format !== "p8.png") {
    throw new RangeError("cart format must be p8 or p8.png");
  }
  if (!Number.isInteger(cart.version) || cart.version < 0 || cart.version > 255) {
    throw new RangeError("cart version must be a uint8");
  }
  const identity = Object.freeze({ contentSha256: cart.identity.contentSha256 });
  return {
    identity,
    format: cart.format,
    version: cart.version,
    rom: cart.rom.slice(),
    code: cart.code.slice()
  };
}
function metadataOf(cart) {
  return Object.freeze({
    identity: cart.identity,
    format: cart.format,
    version: cart.version
  });
}
function copyCartDataCommit(commit) {
  return Object.freeze({
    id: commit.id,
    bytes: commit.bytes.slice(),
    revision: commit.revision
  });
}
function copyRunParameter(parameter) {
  if (!(parameter instanceof Uint8Array) || parameter.byteLength > 4096) {
    throw new RangeError("run parameter must be a Uint8Array of at most 4096 bytes");
  }
  return parameter.slice();
}
function isRuntimePort(value) {
  if (typeof value !== "object" || value === null)
    return false;
  const candidate = value;
  return typeof candidate.boot === "function" && typeof candidate.step === "function" && typeof candidate.completeHostRequest === "function" && typeof candidate.copyRam === "function" && typeof candidate.dispose === "function";
}
var CartSession = class {
  inspect(request) {
    if (this.#state !== "ready" || this.#runtime === void 0 || this.#pendingRequest !== void 0)
      throw new Error("inspection requires a ready session");
    return this.#runtime.inspect(request);
  }
  #retiredLogs = { sequence: 0, entries: [] };
  snapshotLogs() {
    return this.#runtime?.snapshotLogs() ?? this.#retiredLogs;
  }
  takeAudioEvents() {
    return this.#runtime?.takeAudioEvents?.() ?? { events: [], dropped: 0 };
  }
  #createRuntime;
  #usedRuntimes = /* @__PURE__ */ new WeakSet();
  #state = "empty";
  #generation = 0;
  #cart;
  #runtime;
  #pendingRequest;
  #lastError;
  constructor(options) {
    if (typeof options?.createRuntime !== "function") {
      throw new TypeError("CartSession requires a createRuntime factory");
    }
    this.#createRuntime = options.createRuntime;
  }
  get state() {
    return this.#state;
  }
  get generation() {
    return this.#generation;
  }
  get cart() {
    return this.#cart === void 0 ? void 0 : metadataOf(this.#cart);
  }
  get lastError() {
    return this.#lastError;
  }
  load(cart, parameter = new Uint8Array()) {
    if (this.#state === "disposed") {
      return invalid3("cart session is disposed");
    }
    if (this.#state === "loading") {
      return invalid3("cart session is already loading");
    }
    let snapshot;
    try {
      snapshot = snapshotCart(cart);
    } catch (error) {
      return invalid3(errorMessage(error));
    }
    let runParameter;
    try {
      runParameter = copyRunParameter(parameter);
    } catch (error) {
      return invalid3(errorMessage(error));
    }
    return this.#start(snapshot, runParameter);
  }
  reset() {
    if (this.#state === "disposed") {
      return invalid3("cart session is disposed");
    }
    if (this.#state === "loading") {
      return invalid3("cart session is already loading");
    }
    if (this.#cart === void 0) {
      return invalid3("cart session has no cart to reset");
    }
    return this.#start(this.#cart, new Uint8Array());
  }
  /** Start a fresh execution of the retained cart with a guest run() parameter. */
  restart(parameter = new Uint8Array()) {
    if (this.#state === "disposed") {
      return invalid3("cart session is disposed");
    }
    if (this.#state === "loading") {
      return invalid3("cart session is already loading");
    }
    if (this.#cart === void 0) {
      return invalid3("cart session has no cart to restart");
    }
    let snapshot;
    try {
      snapshot = copyRunParameter(parameter);
    } catch (error) {
      return invalid3(errorMessage(error));
    }
    return this.#start(this.#cart, snapshot);
  }
  step(input = PICO_EMPTY_INPUT) {
    const runtime = this.#runtime;
    if (this.#state !== "ready" || runtime === void 0) {
      return invalid3("cart session is not ready to step");
    }
    let result;
    try {
      result = runtime.step(input);
    } catch (error) {
      return this.#faultCurrent(lifecycleError("E_INVARIANT", `runtime step threw: ${errorMessage(error)}`));
    }
    if (!result.ok) {
      if (result.error.code === "E_INVALID_STATE")
        return result;
      return this.#faultCurrent(result.error);
    }
    return this.#acceptStepResult(result.value);
  }
  completeHostRequest(generation, requestId, response, isError = false) {
    if (generation !== this.#generation) {
      return invalid3("host response belongs to a stale generation", {
        activeGeneration: this.#generation,
        responseGeneration: generation
      });
    }
    const runtime = this.#runtime;
    const pending = this.#pendingRequest;
    if (this.#state !== "waiting-host" || runtime === void 0 || pending === void 0) {
      return invalid3("cart session has no pending host request");
    }
    if (requestId !== pending.id) {
      return invalid3("host response request id does not match the pending request", {
        pendingRequestId: pending.id,
        responseRequestId: requestId
      });
    }
    if (!(response instanceof Uint8Array)) {
      return invalid3("host response must be a Uint8Array");
    }
    let result;
    try {
      result = runtime.completeHostRequest(requestId, response, isError);
    } catch (error) {
      return this.#faultCurrent(lifecycleError("E_INVARIANT", `host completion threw: ${errorMessage(error)}`));
    }
    if (!result.ok) {
      if (result.error.code === "E_INVALID_STATE") {
        return this.#faultCurrent(lifecycleError("E_INVARIANT", "active runtime rejected a validated host completion"));
      }
      return this.#faultCurrent(result.error);
    }
    if (pending.operation === "boot") {
      if (result.value.kind === "frame") {
        return this.#faultCurrent(lifecycleError("E_INVARIANT", "boot host completion returned a step outcome"));
      }
      return this.#acceptBootResult(result.value);
    }
    if (result.value.kind === "ready") {
      return this.#faultCurrent(lifecycleError("E_INVARIANT", "step host completion returned a boot outcome"));
    }
    return this.#acceptStepResult(result.value);
  }
  snapshotMenuItems(generation) {
    if (generation !== this.#generation) {
      return invalid3("menu snapshot belongs to a stale generation", {
        activeGeneration: this.#generation,
        requestGeneration: generation
      });
    }
    const runtime = this.#runtime;
    if (this.#state !== "ready" || runtime === void 0) {
      return invalid3("cart session is not ready for menu snapshot");
    }
    let result;
    try {
      result = runtime.snapshotMenuItems();
    } catch (error) {
      return this.#faultCurrent(lifecycleError("E_INVARIANT", `menu snapshot threw: ${errorMessage(error)}`));
    }
    if (!result.ok) {
      if (result.error.code === "E_INVALID_STATE")
        return result;
      return this.#faultCurrent(result.error);
    }
    return {
      ok: true,
      value: {
        generation: this.#generation,
        items: result.value.items.map((item) => ({
          slot: item.slot,
          label: item.label.slice(),
          filter: item.filter
        }))
      }
    };
  }
  invokeMenuItem(generation, slot, button2) {
    if (generation !== this.#generation) {
      return invalid3("menu invocation belongs to a stale generation", {
        activeGeneration: this.#generation,
        requestGeneration: generation
      });
    }
    const runtime = this.#runtime;
    if (this.#state !== "ready" || runtime === void 0) {
      return invalid3("cart session is not ready for menu invocation");
    }
    let result;
    try {
      result = runtime.invokeMenuItem(slot, button2);
    } catch (error) {
      return this.#faultCurrent(lifecycleError("E_INVARIANT", `menu invocation threw: ${errorMessage(error)}`));
    }
    if (!result.ok) {
      if (result.error.code === "E_INVALID_STATE")
        return result;
      return this.#faultCurrent(result.error);
    }
    return {
      ok: true,
      value: {
        generation: this.#generation,
        kind: result.value.kind,
        snapshot: {
          generation: this.#generation,
          items: result.value.snapshot.items.map((item) => ({
            slot: item.slot,
            label: item.label.slice(),
            filter: item.filter
          }))
        },
        ...result.value.cartDataCommit === void 0 ? {} : { cartDataCommit: copyCartDataCommit(result.value.cartDataCommit) }
      }
    };
  }
  copyRam(offset, length) {
    const runtime = this.#runtime;
    if (this.#state !== "ready" && this.#state !== "waiting-host" || runtime === void 0) {
      return invalid3("cart session has no readable active RAM");
    }
    if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > PICO_RAM_SIZE) {
      return invalid3("RAM copy range is outside the 64 KiB address space");
    }
    try {
      return { ok: true, value: runtime.copyRam(offset, length).slice() };
    } catch (error) {
      return this.#faultCurrent(lifecycleError("E_INVARIANT", `RAM copy threw: ${errorMessage(error)}`));
    }
  }
  copySuspendedLogicalRam(generation, offset, length) {
    const checked = this.#validateSuspendedRamAccess(generation, offset, length);
    if (!checked.ok)
      return checked;
    try {
      return {
        ok: true,
        value: checked.value.copySuspendedLogicalRam(offset, length).slice()
      };
    } catch (error) {
      return this.#faultCurrent(lifecycleError("E_INVARIANT", `suspended logical RAM snapshot threw: ${errorMessage(error)}`));
    }
  }
  writeSuspendedLogicalRam(generation, offset, bytes) {
    if (!(bytes instanceof Uint8Array)) {
      return invalid3("suspended logical RAM write requires a Uint8Array");
    }
    const checked = this.#validateSuspendedRamAccess(generation, offset, bytes.byteLength);
    if (!checked.ok)
      return checked;
    try {
      checked.value.writeSuspendedLogicalRam(offset, bytes.slice());
      return { ok: true, value: void 0 };
    } catch (error) {
      return this.#faultCurrent(lifecycleError("E_INVARIANT", `suspended logical RAM write threw: ${errorMessage(error)}`));
    }
  }
  stop() {
    if (this.#state === "disposed")
      return invalid3("cart session is disposed");
    if (this.#state === "loading")
      return invalid3("cart session is loading");
    if (this.#cart === void 0)
      return invalid3("cart session has no cart to stop");
    if (this.#state === "stopped") {
      return { ok: true, value: { kind: "stopped", generation: this.#generation } };
    }
    const teardownError = this.#releaseRuntime();
    if (teardownError !== void 0)
      return this.#enterFault(teardownError);
    this.#pendingRequest = void 0;
    this.#state = "stopped";
    return { ok: true, value: { kind: "stopped", generation: this.#generation } };
  }
  dispose() {
    if (this.#state === "disposed") {
      return { ok: true, value: { kind: "disposed", generation: this.#generation } };
    }
    const teardownError = this.#releaseRuntime();
    this.#pendingRequest = void 0;
    this.#cart = void 0;
    this.#state = "disposed";
    if (teardownError !== void 0) {
      this.#lastError = teardownError;
      return { ok: false, error: teardownError };
    }
    return { ok: true, value: { kind: "disposed", generation: this.#generation } };
  }
  #validateSuspendedRamAccess(generation, offset, length) {
    if (generation !== this.#generation) {
      return invalid3("logical RAM access belongs to a stale generation", {
        activeGeneration: this.#generation,
        accessGeneration: generation
      });
    }
    const runtime = this.#runtime;
    if (this.#state !== "waiting-host" || runtime === void 0 || this.#pendingRequest === void 0) {
      return invalid3("logical RAM access requires a suspended host request");
    }
    if (typeof runtime.copySuspendedLogicalRam !== "function" || typeof runtime.writeSuspendedLogicalRam !== "function") {
      return invalid3("active runtime does not expose suspended logical RAM access");
    }
    if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset > PICO_RAM_SIZE || length > PICO_RAM_SIZE - offset) {
      return invalid3("logical RAM access range is outside the 64 KiB address space");
    }
    return { ok: true, value: runtime };
  }
  #start(cart, runParameter) {
    if (this.#generation >= MAX_GENERATION) {
      return this.#faultCurrent(lifecycleError("E_INVARIANT", "cart session generation space is exhausted"));
    }
    this.#generation += 1;
    this.#state = "loading";
    this.#lastError = void 0;
    this.#pendingRequest = void 0;
    const teardownError = this.#releaseRuntime();
    this.#cart = cart;
    if (teardownError !== void 0)
      return this.#enterFault(teardownError);
    const metadata = metadataOf(cart);
    let runtime;
    try {
      const context = Object.freeze({
        generation: this.#generation,
        cart: metadata,
        runParameter: runParameter.slice()
      });
      const candidate = this.#createRuntime(context);
      if (!isRuntimePort(candidate)) {
        throw new TypeError("runtime factory returned an invalid runtime port");
      }
      if (this.#usedRuntimes.has(candidate)) {
        throw new Error("runtime factory reused an object from an earlier generation");
      }
      runtime = candidate;
      this.#usedRuntimes.add(runtime);
    } catch (error) {
      return this.#enterFault(lifecycleError("E_INVARIANT", `runtime factory failed: ${errorMessage(error)}`));
    }
    this.#runtime = runtime;
    let result;
    try {
      result = runtime.boot({ rom: cart.rom.slice(), code: cart.code.slice() }, PICO_EMPTY_INPUT);
    } catch (error) {
      return this.#faultCurrent(lifecycleError("E_INVARIANT", `runtime boot threw: ${errorMessage(error)}`));
    }
    if (!result.ok)
      return this.#faultCurrent(result.error);
    return this.#acceptBootResult(result.value);
  }
  #acceptBootResult(result) {
    if (result.kind === "host-request") {
      if (result.request.operation !== "boot") {
        return this.#faultCurrent(lifecycleError("E_INVARIANT", "runtime boot yielded a step host request"));
      }
      this.#state = "waiting-host";
      return { ok: true, value: this.#decorateHostRequest(result.request) };
    }
    if (result.kind === "stopped" || result.kind === "restart") {
      const teardownError = this.#releaseRuntime();
      if (teardownError !== void 0)
        return this.#enterFault(teardownError);
      this.#pendingRequest = void 0;
      this.#state = "stopped";
      return {
        ok: true,
        value: result.kind === "stopped" ? {
          kind: "stopped",
          generation: this.#generation,
          message: result.message.slice(),
          ...result.cartDataCommit === void 0 ? {} : { cartDataCommit: copyCartDataCommit(result.cartDataCommit) }
        } : {
          kind: "restart",
          generation: this.#generation,
          parameter: result.parameter.slice(),
          ...result.cartDataCommit === void 0 ? {} : { cartDataCommit: copyCartDataCommit(result.cartDataCommit) }
        }
      };
    }
    this.#pendingRequest = void 0;
    this.#state = "ready";
    return {
      ok: true,
      value: {
        kind: "ready",
        generation: this.#generation,
        mode: result.mode,
        targetFps: result.targetFps,
        cpuInstructions: result.cpuInstructions,
        cpuFractionRaw: result.cpuFractionRaw,
        slowFrame: result.slowFrame,
        audio: result.audio,
        devkitFlags: result.devkitFlags,
        ...result.cartDataCommit === void 0 ? {} : { cartDataCommit: copyCartDataCommit(result.cartDataCommit) }
      }
    };
  }
  #acceptStepResult(result) {
    if (result.kind === "host-request") {
      if (result.request.operation !== "step") {
        return this.#faultCurrent(lifecycleError("E_INVARIANT", "runtime step yielded a boot host request"));
      }
      this.#state = "waiting-host";
      return { ok: true, value: this.#decorateHostRequest(result.request) };
    }
    if (result.kind === "stopped") {
      const teardownError = this.#releaseRuntime();
      if (teardownError !== void 0)
        return this.#enterFault(teardownError);
      this.#pendingRequest = void 0;
      this.#state = "stopped";
      return {
        ok: true,
        value: {
          kind: "stopped",
          generation: this.#generation,
          message: result.message.slice(),
          ...result.cartDataCommit === void 0 ? {} : { cartDataCommit: copyCartDataCommit(result.cartDataCommit) }
        }
      };
    }
    if (result.kind === "restart") {
      const teardownError = this.#releaseRuntime();
      if (teardownError !== void 0)
        return this.#enterFault(teardownError);
      this.#pendingRequest = void 0;
      this.#state = "stopped";
      return {
        ok: true,
        value: {
          kind: "restart",
          generation: this.#generation,
          parameter: result.parameter.slice(),
          ...result.cartDataCommit === void 0 ? {} : { cartDataCommit: copyCartDataCommit(result.cartDataCommit) }
        }
      };
    }
    this.#pendingRequest = void 0;
    this.#state = "ready";
    return {
      ok: true,
      value: {
        kind: "frame",
        generation: this.#generation,
        frame: {
          ...result.frame,
          screen: result.frame.screen.slice(),
          ...result.frame.cartDataCommit === void 0 ? {} : { cartDataCommit: copyCartDataCommit(result.frame.cartDataCommit) }
        }
      }
    };
  }
  #decorateHostRequest(request) {
    this.#pendingRequest = {
      generation: this.#generation,
      id: request.id,
      operation: request.operation
    };
    return {
      kind: "host-request",
      request: {
        generation: this.#generation,
        id: request.id,
        bytes: request.bytes.slice(),
        operation: request.operation
      }
    };
  }
  #faultCurrent(error) {
    this.#releaseRuntime();
    return this.#enterFault(error);
  }
  #enterFault(error) {
    this.#pendingRequest = void 0;
    this.#lastError = error;
    this.#state = "faulted";
    return { ok: false, error };
  }
  #releaseRuntime() {
    const runtime = this.#runtime;
    this.#runtime = void 0;
    if (runtime === void 0)
      return void 0;
    try {
      try {
        this.#retiredLogs = runtime.snapshotLogs();
      } catch {
      }
      runtime.dispose();
      return void 0;
    } catch (error) {
      return lifecycleError("E_INVARIANT", `runtime dispose threw: ${errorMessage(error)}`);
    }
  }
};

// packages/runtime-core/dist/inspection.js
var INSPECTION_LIMITS = Object.freeze({
  paths: 16,
  segments: 16,
  keyBytes: 128,
  inputBytes: 4096,
  outputBytes: 16384,
  depth: 4,
  entries: 512,
  instructions: 5e4
});
function prepareInspection(request) {
  if (!request || typeof request !== "object" || Array.isArray(request))
    throw new TypeError("inspection requires an object");
  const bytes = [];
  const word = (n) => {
    for (let i = 0; i < 4; i++)
      bytes.push(n >>> i * 8 & 255);
  };
  if (request.mode === "debug") {
    if (Object.keys(request).some((k) => !["mode", "code"].includes(k)) || typeof request.code !== "string")
      throw new TypeError("debug requires only mode and code");
    if (request.code.length > INSPECTION_LIMITS.inputBytes)
      throw new RangeError("debug code exceeds 4096 bytes");
    for (let i = 0; i < request.code.length; i++) {
      const byte = request.code.charCodeAt(i);
      if (byte > 255)
        throw new TypeError("debug code uses Lua byte strings (code points 0..255)");
      bytes.push(byte);
    }
  } else if (request.mode === "read") {
    if (Object.keys(request).some((k) => !["mode", "paths"].includes(k)) || !Array.isArray(request.paths) || request.paths.length < 1 || request.paths.length > INSPECTION_LIMITS.paths)
      throw new TypeError("read requires 1-16 paths");
    word(request.paths.length);
    for (const path of request.paths) {
      if (!Array.isArray(path) || path.length < 1 || path.length > INSPECTION_LIMITS.segments || typeof path[0] !== "string")
        throw new TypeError("path requires a global name and at most 16 segments");
      word(path.length);
      for (const key of path) {
        if (typeof key === "string" && key.length <= INSPECTION_LIMITS.keyBytes && [...key].every((c) => c.charCodeAt(0) <= 255)) {
          word(0);
          word(key.length);
          for (let i = 0; i < key.length; i++)
            bytes.push(key.charCodeAt(i));
        } else if (typeof key === "number" && Number.isInteger(key) && key >= -32768 && key <= 32767) {
          word(1);
          word(key);
        } else
          throw new TypeError("path keys must be byte strings of at most 128 bytes or signed 16-bit integers");
      }
    }
  } else
    throw new TypeError("inspection mode must be read or debug");
  if (bytes.length < 1 || bytes.length > INSPECTION_LIMITS.inputBytes)
    throw new RangeError("inspection input must be 1-4096 bytes");
  return { mode: request.mode, payload: Uint8Array.from(bytes) };
}

// packages/z8lua-bridge/dist/generated/pico-host-bindings.js
var PICO_HOST_CALL_FRAME = Object.freeze({
  BYTE_SIZE: 80,
  OPERATION_ID: 4,
  PRESENCE_BITS: 8,
  FLAGS: 12,
  SCALAR_COUNT: 16,
  SCALAR_SLOTS: 20,
  SCALAR_CAPACITY: 12,
  BYTE_BUFFER_POINTER: 68,
  BYTE_BUFFER_LENGTH: 72,
  RESULT: 76
});
var PICO_HOST_OPERATION = Object.freeze({
  CLS: 1,
  PSET: 2,
  BTN: 3,
  LINE: 4,
  RECT: 5,
  RECTFILL: 6,
  CIRC: 7,
  CIRCFILL: 8,
  BTNP: 9,
  COLOR: 10,
  CAMERA: 11,
  CLIP: 12,
  PAL: 13,
  PALT: 14,
  FILLP: 15,
  PGET: 16,
  OVAL: 17,
  OVALFILL: 18,
  SGET: 19,
  SSET: 20,
  SPR: 21,
  SSPR: 22,
  MGET: 23,
  MSET: 24,
  FGET: 25,
  FSET: 26,
  MAP: 27,
  TLINE: 28,
  PRINT: 29,
  CURSOR: 30,
  SFX: 31,
  MUSIC: 32,
  STAT: 33,
  CARTDATA: 34,
  DGET: 35,
  DSET: 36,
  RELOAD: 37,
  CSTORE: 38,
  RRECT: 39,
  RRECTFILL: 40,
  RESET_SYSTEM: 41
});
function dispatchPicoHostCall(host, operationId, argumentMask, args, byteString) {
  switch (operationId >>> 0) {
    case 1:
      host.cls((argumentMask & 1) !== 0 ? args[0] : void 0);
      return 0;
    case 2:
      host.pset(args[0], args[1], (argumentMask & 4) !== 0 ? args[2] : void 0);
      return 0;
    case 3:
      return host.btn((argumentMask & 1) !== 0 ? args[0] : void 0, (argumentMask & 2) !== 0 ? args[1] : void 0) | 0;
    case 4:
      host.line((argumentMask & 1) !== 0 ? args[0] : void 0, (argumentMask & 2) !== 0 ? args[1] : void 0, (argumentMask & 4) !== 0 ? args[2] : void 0, (argumentMask & 8) !== 0 ? args[3] : void 0, (argumentMask & 16) !== 0 ? args[4] : void 0);
      return 0;
    case 5:
      host.rect(args[0], args[1], args[2], args[3], (argumentMask & 16) !== 0 ? args[4] : void 0);
      return 0;
    case 6:
      host.rectfill(args[0], args[1], args[2], args[3], (argumentMask & 16) !== 0 ? args[4] : void 0);
      return 0;
    case 7:
      host.circ(args[0], args[1], (argumentMask & 4) !== 0 ? args[2] : void 0, (argumentMask & 8) !== 0 ? args[3] : void 0);
      return 0;
    case 8:
      host.circfill(args[0], args[1], (argumentMask & 4) !== 0 ? args[2] : void 0, (argumentMask & 8) !== 0 ? args[3] : void 0);
      return 0;
    case 9:
      return host.btnp((argumentMask & 1) !== 0 ? args[0] : void 0, (argumentMask & 2) !== 0 ? args[1] : void 0) | 0;
    case 10:
      return host.color((argumentMask & 1) !== 0 ? args[0] : void 0) | 0;
    case 11:
      host.camera((argumentMask & 1) !== 0 ? args[0] : void 0, (argumentMask & 2) !== 0 ? args[1] : void 0);
      return 0;
    case 12:
      host.clip((argumentMask & 1) !== 0 ? args[0] : void 0, (argumentMask & 2) !== 0 ? args[1] : void 0, (argumentMask & 4) !== 0 ? args[2] : void 0, (argumentMask & 8) !== 0 ? args[3] : void 0, (argumentMask & 16) !== 0 ? args[4] !== 0 : void 0);
      return 0;
    case 13:
      return host.pal((argumentMask & 1) !== 0 ? args[0] : void 0, (argumentMask & 2) !== 0 ? args[1] : void 0, (argumentMask & 4) !== 0 ? args[2] : void 0) | 0;
    case 14:
      return host.palt((argumentMask & 1) !== 0 ? args[0] : void 0, (argumentMask & 2) !== 0 ? args[1] !== 0 : void 0) | 0;
    case 15:
      return host.fillp((argumentMask & 1) !== 0 ? args[0] : void 0) | 0;
    case 16:
      return host.pget(args[0], args[1]) | 0;
    case 17:
      host.oval(args[0], args[1], args[2], args[3], (argumentMask & 16) !== 0 ? args[4] : void 0);
      return 0;
    case 18:
      host.ovalfill(args[0], args[1], args[2], args[3], (argumentMask & 16) !== 0 ? args[4] : void 0);
      return 0;
    case 19:
      return host.sget(args[0], args[1]) | 0;
    case 20:
      host.sset(args[0], args[1], (argumentMask & 4) !== 0 ? args[2] : void 0);
      return 0;
    case 21:
      host.spr(args[0], args[1], args[2], (argumentMask & 8) !== 0 ? args[3] : void 0, (argumentMask & 16) !== 0 ? args[4] : void 0, (argumentMask & 32) !== 0 ? args[5] !== 0 : void 0, (argumentMask & 64) !== 0 ? args[6] !== 0 : void 0);
      return 0;
    case 22:
      host.sspr(args[0], args[1], args[2], args[3], args[4], args[5], (argumentMask & 64) !== 0 ? args[6] : void 0, (argumentMask & 128) !== 0 ? args[7] : void 0, (argumentMask & 256) !== 0 ? args[8] !== 0 : void 0, (argumentMask & 512) !== 0 ? args[9] !== 0 : void 0);
      return 0;
    case 23:
      return host.mget(args[0], args[1]) | 0;
    case 24:
      host.mset(args[0], args[1], args[2]);
      return 0;
    case 25:
      return host.fget(args[0], (argumentMask & 2) !== 0 ? args[1] : void 0) | 0;
    case 26:
      host.fset(args[0], args[1], (argumentMask & 4) !== 0 ? args[2] !== 0 : void 0);
      return 0;
    case 27:
      host.map((argumentMask & 1) !== 0 ? args[0] : void 0, (argumentMask & 2) !== 0 ? args[1] : void 0, (argumentMask & 4) !== 0 ? args[2] : void 0, (argumentMask & 8) !== 0 ? args[3] : void 0, (argumentMask & 16) !== 0 ? args[4] : void 0, (argumentMask & 32) !== 0 ? args[5] : void 0, (argumentMask & 64) !== 0 ? args[6] : void 0);
      return 0;
    case 28:
      host.tline((argumentMask & 1) !== 0 ? args[0] : void 0, (argumentMask & 2) !== 0 ? args[1] : void 0, (argumentMask & 4) !== 0 ? args[2] : void 0, (argumentMask & 8) !== 0 ? args[3] : void 0, (argumentMask & 16) !== 0 ? args[4] : void 0, (argumentMask & 32) !== 0 ? args[5] : void 0, (argumentMask & 64) !== 0 ? args[6] : void 0, (argumentMask & 128) !== 0 ? args[7] : void 0, (argumentMask & 256) !== 0 ? args[8] : void 0);
      return 0;
    case 29:
      return host.print(byteString, (argumentMask & 2) !== 0 ? args[1] : void 0, (argumentMask & 4) !== 0 ? args[2] : void 0, (argumentMask & 8) !== 0 ? args[3] : void 0) | 0;
    case 30:
      host.cursor(args[0], args[1], (argumentMask & 4) !== 0 ? args[2] : void 0);
      return 0;
    case 31:
      host.sfx(args[0], (argumentMask & 2) !== 0 ? args[1] : void 0, (argumentMask & 4) !== 0 ? args[2] : void 0, (argumentMask & 8) !== 0 ? args[3] : void 0);
      return 0;
    case 32:
      host.music(args[0], (argumentMask & 2) !== 0 ? args[1] : void 0, (argumentMask & 4) !== 0 ? args[2] : void 0);
      return 0;
    case 33:
      return host.stat(args[0]) | 0;
    case 34:
      return host.cartdata(byteString) | 0;
    case 35:
      return host.dget(args[0]) | 0;
    case 36:
      host.dset(args[0], args[1]);
      return 0;
    case 37:
      host.reload((argumentMask & 1) !== 0 ? args[0] : void 0, (argumentMask & 2) !== 0 ? args[1] : void 0, (argumentMask & 4) !== 0 ? args[2] : void 0, (argumentMask & 8) !== 0 ? byteString : void 0);
      return 0;
    case 38:
      host.cstore((argumentMask & 1) !== 0 ? args[0] : void 0, (argumentMask & 2) !== 0 ? args[1] : void 0, (argumentMask & 4) !== 0 ? args[2] : void 0, (argumentMask & 8) !== 0 ? byteString : void 0);
      return 0;
    case 39:
      host.rrect(args[0], args[1], args[2], args[3], (argumentMask & 16) !== 0 ? args[4] : void 0, (argumentMask & 32) !== 0 ? args[5] : void 0);
      return 0;
    case 40:
      host.rrectfill(args[0], args[1], args[2], args[3], (argumentMask & 16) !== 0 ? args[4] : void 0, (argumentMask & 32) !== 0 ? args[5] : void 0);
      return 0;
    case 41:
      host.resetSystem();
      return 0;
    default:
      throw new RangeError(`unknown PicoApiHost operation ${operationId >>> 0}`);
  }
}

// packages/z8lua-bridge/dist/public.js
var INVALID_MAPPED_ADDRESS = 4294967295;
var moduleIds = /* @__PURE__ */ new WeakMap();
var nextModuleId = 1;
var hostDispatcherState = /* @__PURE__ */ Symbol("p8w.host-dispatcher-state");
var HOST_DISPATCH_OK = 0;
var HOST_DISPATCH_FAILED = 1;
function moduleId(module) {
  const existing = moduleIds.get(module);
  if (existing !== void 0)
    return existing;
  const assigned = nextModuleId++;
  moduleIds.set(module, assigned);
  return assigned;
}
var FRAME_ABI_VERSION = 65542;
var STATUS_OK = 0;
var STATUS_YIELDED = 1;
var STATUS_INVALID_HANDLE = 2;
var STATUS_INVALID_STATE = 3;
var STATUS_BAD_ARGUMENT = 4;
var STATUS_LOAD_ERROR = 5;
var STATUS_RUNTIME_ERROR = 6;
var STATUS_BUDGET = 7;
var STATUS_OOM = 8;
var STATUS_UNSUPPORTED = 9;
var STATUS_HOST_ERROR = 10;
var STATUS_STOPPED = 11;
var STATUS_HOST_API_ERROR = 13;
var STATUS_RESTART = 14;
var MENU_OUTCOME_CLOSE = 1;
var MENU_OUTCOME_KEEP_OPEN = 2;
var MENU_OUTCOME_REMOVED = 3;
var MENU_SNAPSHOT_BYTES = 104;
var YIELD_FRAME_END = 1;
var YIELD_FLIP = 2;
var YIELD_HOST_REQUEST = 3;
var CART_ROM_BYTES2 = 32768;
var CART_ROM_RUNTIME_BYTES = 17152;
var TextDecoderConstructor = globalThis.TextDecoder;
var textDecoder = new TextDecoderConstructor("utf-8", { fatal: false });
function safeErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function dispatcherState(module) {
  const carrier = module;
  const existing = carrier[hostDispatcherState];
  if (existing !== void 0)
    return existing;
  if (module.p8wHostCall !== void 0) {
    throw new Error("frame runtime module already owns a foreign host dispatcher");
  }
  const state = {
    nextBindingId: 1,
    slots: /* @__PURE__ */ new Map(),
    memoryView: new DataView(module.HEAPU8.buffer),
    scalarArguments: new Int32Array(PICO_HOST_CALL_FRAME.SCALAR_CAPACITY)
  };
  const callback = (bindingId, callFramePointer) => {
    const slot = state.slots.get(bindingId >>> 0);
    if (slot === void 0 || slot.state !== "bound" || slot.host === void 0) {
      if (slot !== void 0) {
        slot.error = { message: `host binding ${bindingId >>> 0} is ${slot.state}` };
      }
      return HOST_DISPATCH_FAILED;
    }
    try {
      const pointer = callFramePointer >>> 0;
      if (pointer === 0 || pointer + PICO_HOST_CALL_FRAME.BYTE_SIZE > module.HEAPU8.byteLength || state.memoryView.getUint32(pointer, true) !== PICO_HOST_CALL_FRAME.BYTE_SIZE) {
        throw new RangeError("host dispatch received an invalid call frame");
      }
      const scalarCount = state.memoryView.getUint32(pointer + PICO_HOST_CALL_FRAME.SCALAR_COUNT, true);
      if (scalarCount > PICO_HOST_CALL_FRAME.SCALAR_CAPACITY) {
        throw new RangeError("host dispatch scalar count exceeds call-frame capacity");
      }
      for (let index = 0; index < PICO_HOST_CALL_FRAME.SCALAR_CAPACITY; index += 1) {
        state.scalarArguments[index] = state.memoryView.getInt32(pointer + PICO_HOST_CALL_FRAME.SCALAR_SLOTS + index * 4, true);
      }
      const bytePointer = state.memoryView.getUint32(pointer + PICO_HOST_CALL_FRAME.BYTE_BUFFER_POINTER, true);
      const byteLength2 = state.memoryView.getUint32(pointer + PICO_HOST_CALL_FRAME.BYTE_BUFFER_LENGTH, true);
      if (bytePointer === 0 && byteLength2 !== 0 || bytePointer + byteLength2 > module.HEAPU8.byteLength) {
        throw new RangeError("host dispatch received an invalid byte-string view");
      }
      const byteString = bytePointer === 0 ? void 0 : module.HEAPU8.subarray(bytePointer, bytePointer + byteLength2);
      const result = dispatchPicoHostCall(slot.host, state.memoryView.getUint32(pointer + PICO_HOST_CALL_FRAME.OPERATION_ID, true), state.memoryView.getUint32(pointer + PICO_HOST_CALL_FRAME.PRESENCE_BITS, true), state.scalarArguments, byteString);
      state.memoryView.setInt32(pointer + PICO_HOST_CALL_FRAME.RESULT, result | 0, true);
      slot.error = void 0;
      return HOST_DISPATCH_OK;
    } catch (error) {
      slot.error = {
        message: safeErrorMessage(error),
        ...error instanceof Error && error.name === "PicoFeatureUnsupportedError" ? { code: "E_FEATURE_UNSUPPORTED" } : {}
      };
      return HOST_DISPATCH_FAILED;
    }
  };
  Object.defineProperty(carrier, hostDispatcherState, { value: state });
  module.p8wHostCall = callback;
  return state;
}
var PicoApiHostRouter = class {
  bindingId;
  #module;
  #dispatcher;
  #slot;
  constructor(module) {
    const state = dispatcherState(module);
    const bindingId = state.nextBindingId++;
    if (bindingId === 0 || bindingId > 4294967295) {
      throw new Error("frame runtime host binding ids are exhausted");
    }
    this.bindingId = bindingId >>> 0;
    this.#module = module;
    this.#dispatcher = state;
    this.#slot = { state: "unbound", host: void 0, error: void 0 };
    state.slots.set(this.bindingId, this.#slot);
  }
  get state() {
    return this.#slot.state;
  }
  assertModule(module) {
    if (module !== this.#module)
      throw new Error("host router belongs to a different WASM module");
  }
  bind(host) {
    if (this.#slot.state !== "unbound") {
      throw new Error(`host router cannot bind from ${this.#slot.state}`);
    }
    this.#slot.host = host;
    this.#slot.error = void 0;
    this.#slot.state = "bound";
  }
  release() {
    if (this.#slot.state === "released")
      return;
    this.#slot.host = void 0;
    this.#slot.error = void 0;
    this.#slot.state = "released";
    this.#dispatcher.slots.delete(this.bindingId);
  }
  consumeError() {
    return this.consumeFailure()?.message;
  }
  consumeFailure() {
    const failure = this.#slot.error;
    this.#slot.error = void 0;
    return failure;
  }
};
function createPicoApiHostRouter(module) {
  return new PicoApiHostRouter(module);
}
function frameState(raw) {
  return [
    "empty",
    "compiled",
    "booting",
    "callback-loop",
    "custom-loop",
    "waiting-host",
    "faulted",
    "stopped"
  ][raw] ?? "faulted";
}
function frameMode(raw) {
  return ["none", "callback", "custom"][raw] ?? "none";
}
function runtimePhase(raw) {
  return [
    "none",
    "compile",
    "boot",
    "init",
    "update",
    "update60",
    "draw",
    "custom-loop",
    "host-call",
    "menuitem"
  ][raw] ?? "none";
}
function failureCode(status) {
  switch (status) {
    case STATUS_LOAD_ERROR:
      return "E_VM_SYNTAX";
    case STATUS_RUNTIME_ERROR:
      return "E_VM_RUNTIME";
    case STATUS_BUDGET:
      return "E_VM_INSTRUCTION_BUDGET";
    case STATUS_OOM:
      return "E_VM_OOM";
    case STATUS_UNSUPPORTED:
      return "E_FEATURE_UNSUPPORTED";
    case STATUS_HOST_ERROR:
      return "E_HOST_REQUEST";
    case STATUS_HOST_API_ERROR:
      return "E_HOST_API";
    case STATUS_INVALID_HANDLE:
    case STATUS_INVALID_STATE:
    case STATUS_BAD_ARGUMENT:
      return "E_INVALID_STATE";
    default:
      return "E_INVARIANT";
  }
}
function checkedUint32(name, value, positive = false) {
  if (!Number.isInteger(value) || value < (positive ? 1 : 0) || value > 4294967295) {
    throw new RangeError(`${name} must be ${positive ? "a positive " : "an "}uint32`);
  }
  return value >>> 0;
}
function checkedTimeRaw(value) {
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) {
    throw new RangeError("timeRaw must be a signed Q16.16 int32");
  }
  return value | 0;
}
function checkedButtons(value) {
  if (!Number.isInteger(value) || value < 0 || value > 63) {
    throw new RangeError("buttons must be a six-bit P1 bitmask");
  }
  return value;
}
var FrameRuntimeMemoryBinding = class {
  bytes;
  lease;
  #module;
  #handle;
  constructor(module, handle) {
    const pointer = module._p8w_ram_ptr(handle) >>> 0;
    const size = module._p8w_ram_size(handle) >>> 0;
    const buffer = module.HEAPU8.buffer;
    if (!(buffer instanceof ArrayBuffer)) {
      throw new TypeError("frame runtime requires a non-shared ArrayBuffer");
    }
    if (pointer === 0 || size !== PICO_RAM_SIZE || pointer + size > module.HEAPU8.byteLength) {
      throw new RangeError("invalid or stale frame runtime Pico RAM allocation");
    }
    this.#module = module;
    this.#handle = handle;
    this.bytes = module.HEAPU8.subarray(pointer, pointer + size);
    this.lease = Object.freeze({
      buffer,
      byteOffset: pointer,
      byteLength: PICO_RAM_SIZE,
      leaseId: `p8w:${moduleId(module)}:${handle >>> 0}:${pointer}`
    });
  }
  assertBound() {
    if (this.#module.HEAPU8.buffer !== this.lease.buffer || this.#module._p8w_ram_ptr(this.#handle) >>> 0 !== this.lease.byteOffset || this.#module._p8w_ram_size(this.#handle) >>> 0 !== PICO_RAM_SIZE) {
      throw new Error("stale or detached frame runtime Pico RAM lease");
    }
  }
  get memoryLeaseId() {
    return this.lease.leaseId;
  }
  mapAddress(logicalAddress) {
    this.assertBound();
    if (!Number.isInteger(logicalAddress) || !Number.isSafeInteger(logicalAddress)) {
      throw new RangeError("logical Pico RAM address must be a safe integer");
    }
    const mapped = this.#module._p8w_map_address(this.#handle, logicalAddress >>> 0) >>> 0;
    if (mapped === INVALID_MAPPED_ADDRESS || mapped >= PICO_RAM_SIZE) {
      throw new RangeError("unable to map frame runtime Pico RAM address");
    }
    return mapped;
  }
};
var Z8LuaFrameVm = class {
  memory;
  logicalMemory;
  #module;
  #binding;
  #hostRouter;
  #handle;
  constructor(module, hostRouter, options = {}) {
    hostRouter.assertModule(module);
    if (module._p8w_abi_version() >>> 0 !== FRAME_ABI_VERSION) {
      hostRouter.release();
      throw new Error("unsupported p8w frame runtime ABI version");
    }
    const heapLimit = options.luaHeapLimit ?? 0;
    if (!Number.isInteger(heapLimit) || heapLimit < 0 || heapLimit > 4294967295) {
      hostRouter.release();
      throw new RangeError("luaHeapLimit must be a uint32");
    }
    const handle = module._p8w_create(heapLimit) >>> 0;
    if (handle === 0) {
      hostRouter.release();
      throw new Error("unable to create z8lua frame VM");
    }
    try {
      this.#module = module;
      this.#handle = handle;
      this.#hostRouter = hostRouter;
      this.#binding = new FrameRuntimeMemoryBinding(module, handle);
      this.memory = this.#binding.lease;
      this.logicalMemory = this.#binding;
    } catch (error) {
      module._p8w_destroy(handle);
      hostRouter.release();
      throw error;
    }
  }
  get hostBindingState() {
    return this.#hostRouter.state;
  }
  get liveLuaBytes() {
    this.#assertLive();
    return this.#module._p8w_lua_live_bytes(this.#handle) >>> 0;
  }
  get luaHeapLimit() {
    this.#assertLive();
    return this.#module._p8w_lua_heap_limit(this.#handle) >>> 0;
  }
  bindHost(host) {
    this.#assertLive();
    if (host.memoryLeaseId !== this.memory.leaseId) {
      throw new Error("PicoApiHost is bound to a different memory lease");
    }
    this.#hostRouter.bind(host);
    const status = this.#module._p8w_bind_host(this.#handle, this.#hostRouter.bindingId) >>> 0;
    if (status !== STATUS_OK) {
      this.#hostRouter.release();
      throw new Error(`unable to bind PicoApiHost: p8w status ${status}`);
    }
  }
  setRunParameter(parameter) {
    this.#assertLive();
    if (!(parameter instanceof Uint8Array) || parameter.byteLength > 4096) {
      throw new RangeError("run parameter must be a Uint8Array of at most 4096 bytes");
    }
    const status = this.#withBytes(parameter, (pointer, length) => this.#module._p8w_set_run_parameter(this.#handle, pointer, length));
    if (status !== STATUS_OK) {
      throw new Error(`unable to set run parameter: p8w status ${status}`);
    }
  }
  resetRam() {
    this.#assertLive();
    if (this.#module._p8w_ram_reset(this.#handle) !== STATUS_OK) {
      throw new Error("unable to reset frame runtime Pico RAM");
    }
  }
  writeCartRom(rom) {
    this.#assertLive();
    if (!(rom instanceof Uint8Array) || rom.byteLength !== CART_ROM_BYTES2) {
      throw new RangeError("cart ROM must be exactly 0x8000 bytes");
    }
    this.#binding.bytes.set(rom.subarray(0, CART_ROM_RUNTIME_BYTES), 0);
  }
  copyRam(offset, length) {
    this.#assertLive();
    if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > PICO_RAM_SIZE) {
      throw new RangeError("Pico RAM copy range is out of bounds");
    }
    return this.#binding.bytes.slice(offset, offset + length);
  }
  compile(source) {
    this.#assertLive();
    const status = this.#withBytes(source, (pointer, length) => this.#module._p8w_compile(this.#handle, pointer, length));
    return this.#outcome(status, "compile");
  }
  boot(instructionBudget, buttons, timeRaw) {
    this.#assertLive();
    return this.#outcome(this.#module._p8w_boot(this.#handle, checkedUint32("instructionBudget", instructionBudget, true), checkedButtons(buttons), checkedTimeRaw(timeRaw)), "boot");
  }
  step(instructionBudget, buttons, timeRaw) {
    this.#assertLive();
    return this.#outcome(this.#module._p8w_step(this.#handle, checkedUint32("instructionBudget", instructionBudget, true), checkedButtons(buttons), checkedTimeRaw(timeRaw)), "step");
  }
  completeHostRequest(requestId, response, isError, instructionBudget) {
    this.#assertLive();
    const status = this.#withBytes(response, (pointer, length) => this.#module._p8w_complete_host_request(this.#handle, checkedUint32("requestId", requestId, true), pointer, length, isError ? 1 : 0, checkedUint32("instructionBudget", instructionBudget, true)));
    return this.#outcome(status, "complete-host");
  }
  inspect(request) {
    this.#assertLive();
    if (!["read", "debug"].includes(request.mode) || !(request.payload instanceof Uint8Array) || request.payload.length < 1 || request.payload.length > 4096)
      throw new TypeError("invalid prepared inspection");
    const size = 4096 + 16384;
    const pointer = this.#module._p8w_alloc(size) >>> 0;
    if (pointer === 0)
      throw new Error("unable to allocate inspection buffer");
    try {
      this.#module.HEAPU8.set(request.payload, pointer);
      const status = this.#module._p8w_inspect(this.#handle, request.mode === "debug" ? 1 : 0, pointer, request.payload.length, pointer + 4096, 16384);
      if (status !== STATUS_OK)
        throw new Error(`inspection rejected: p8w status ${status}; reads remain available after a failed debug execution; reset before more input or debug`);
      const bytes = this.#module.HEAPU8.subarray(pointer + 4096, pointer + size);
      const end = bytes.indexOf(0);
      if (end < 0)
        throw new Error("unterminated inspection response");
      const result = JSON.parse(textDecoder.decode(bytes.subarray(0, end)));
      if (typeof result.ok !== "boolean" || typeof result.executed !== "boolean" || !Array.isArray(result.values))
        throw new Error("invalid inspection result");
      return result;
    } finally {
      this.#module._p8w_free(pointer);
    }
  }
  snapshotLogs() {
    this.#assertLive();
    const size = 12 + 64 * 1040;
    const pointer = this.#module._p8w_alloc(size) >>> 0;
    if (pointer === 0)
      throw new Error("unable to allocate log snapshot");
    try {
      const status = this.#module._p8w_log_snapshot(this.#handle, pointer, size);
      if (status !== STATUS_OK)
        throw new Error(`log snapshot rejected: ${status}`);
      const bytes = this.#module.HEAPU8.slice(pointer, pointer + size);
      const view = new DataView(bytes.buffer);
      const count = view.getUint32(4, true);
      if (view.getUint32(0, true) !== 1 || count > 64)
        throw new Error("invalid log snapshot");
      const entries = [];
      for (let i = 0; i < count; i++) {
        const offset = 12 + i * 1040, length = view.getUint32(offset + 8, true);
        if (length > 1024)
          throw new Error("invalid log length");
        const frame = view.getInt32(offset + 4, true);
        entries.push({
          sequence: view.getUint32(offset, true),
          frameId: frame < 0 ? null : frame,
          bytes: bytes.slice(offset + 16, offset + 16 + length),
          truncated: view.getUint32(offset + 12, true) !== 0
        });
      }
      return { sequence: view.getUint32(8, true), entries };
    } finally {
      this.#module._p8w_free(pointer);
    }
  }
  snapshotMenuItems() {
    this.#assertLive();
    const pointer = this.#module._p8w_alloc(MENU_SNAPSHOT_BYTES) >>> 0;
    if (pointer === 0 || pointer + MENU_SNAPSHOT_BYTES > this.#module.HEAPU8.byteLength) {
      if (pointer !== 0)
        this.#module._p8w_free(pointer);
      throw new Error("unable to allocate menu snapshot buffer");
    }
    let bytes;
    try {
      const status = this.#module._p8w_menu_snapshot(this.#handle, pointer, MENU_SNAPSHOT_BYTES) >>> 0;
      if (status !== STATUS_OK) {
        throw new Error(`menu snapshot rejected: p8w status ${status}`);
      }
      bytes = this.#module.HEAPU8.slice(pointer, pointer + MENU_SNAPSHOT_BYTES);
    } finally {
      this.#module._p8w_free(pointer);
    }
    if (bytes[0] !== 1 || bytes[1] !== 5 || bytes[2] !== 20 || bytes[3] !== 0) {
      throw new Error("unsupported or malformed menu snapshot codec");
    }
    const items = [];
    for (let index = 0; index < 5; index += 1) {
      const offset = 4 + index * 20;
      const occupied = bytes[offset];
      const length = bytes[offset + 1];
      const filter = bytes[offset + 2] | bytes[offset + 3] << 8;
      if (occupied !== 0 && occupied !== 1 || length > 16 || occupied === 0 && (length !== 0 || filter !== 0)) {
        throw new Error("malformed menu snapshot slot record");
      }
      if (occupied === 1) {
        items.push({
          slot: index + 1,
          label: bytes.slice(offset + 4, offset + 4 + length),
          filter
        });
      }
    }
    return { items };
  }
  invokeMenuItem(slot, button2, instructionBudget) {
    this.#assertLive();
    const status = this.#module._p8w_menu_invoke(this.#handle, slot, button2, checkedUint32("instructionBudget", instructionBudget, true)) >>> 0;
    if (status === STATUS_INVALID_STATE || status === STATUS_BAD_ARGUMENT) {
      return { kind: "rejected", message: `menu invocation rejected: p8w status ${status}` };
    }
    if (status !== STATUS_OK)
      return { kind: "fault", error: this.#fault(status) };
    const outcome = this.#module._p8w_menu_outcome(this.#handle) >>> 0;
    if (outcome === MENU_OUTCOME_CLOSE)
      return { kind: "close" };
    if (outcome === MENU_OUTCOME_KEEP_OPEN)
      return { kind: "keep-open" };
    if (outcome === MENU_OUTCOME_REMOVED)
      return { kind: "removed" };
    return {
      kind: "fault",
      error: {
        code: "E_INVARIANT",
        message: `unknown menu invocation outcome ${outcome}`,
        phase: "menuitem"
      }
    };
  }
  destroy() {
    if (this.#handle === 0)
      return;
    const handle = this.#handle;
    this.#handle = 0;
    try {
      if (this.#module._p8w_destroy(handle) !== STATUS_OK) {
        throw new Error("unable to destroy z8lua frame VM");
      }
    } finally {
      this.#hostRouter.release();
    }
  }
  #assertLive() {
    if (this.#handle === 0)
      throw new Error("z8lua frame VM is destroyed");
    this.#binding.assertBound();
  }
  #withBytes(bytes, call) {
    if (!(bytes instanceof Uint8Array))
      throw new TypeError("expected Uint8Array");
    if (bytes.byteLength === 0)
      return call(0, 0) >>> 0;
    const pointer = this.#module._p8w_alloc(bytes.byteLength) >>> 0;
    if (pointer === 0 || pointer + bytes.byteLength > this.#module.HEAPU8.byteLength) {
      if (pointer !== 0)
        this.#module._p8w_free(pointer);
      throw new Error("unable to allocate bridge byte buffer");
    }
    try {
      this.#module.HEAPU8.set(bytes, pointer);
      return call(pointer, bytes.byteLength) >>> 0;
    } finally {
      this.#module._p8w_free(pointer);
    }
  }
  #copyBytes(pointer, length) {
    const start = pointer >>> 0;
    const size = length >>> 0;
    if (size === 0)
      return new Uint8Array();
    if (start === 0 || start + size > this.#module.HEAPU8.byteLength) {
      throw new Error("bridge returned an invalid byte range");
    }
    return this.#module.HEAPU8.slice(start, start + size);
  }
  #text(pointer, length) {
    return textDecoder.decode(this.#copyBytes(pointer, length));
  }
  #fault(status) {
    const bridgeMessage = this.#text(this.#module._p8w_error_message_ptr(this.#handle), this.#module._p8w_error_message_length(this.#handle));
    const hostFailure = status === STATUS_HOST_API_ERROR ? this.#hostRouter.consumeFailure() : void 0;
    const message2 = status === STATUS_HOST_API_ERROR ? (hostFailure?.message ?? bridgeMessage) || `p8w status ${status}` : bridgeMessage || `p8w status ${status}`;
    const trace = this.#text(this.#module._p8w_error_trace_ptr(this.#handle), this.#module._p8w_error_trace_length(this.#handle));
    const line = this.#module._p8w_error_line(this.#handle) | 0;
    const code = hostFailure?.code ?? failureCode(status);
    const oomDetails = code === "E_VM_OOM" ? {
      liveLuaBytes: this.#module._p8w_lua_live_bytes(this.#handle) >>> 0,
      luaHeapLimit: this.#module._p8w_lua_heap_limit(this.#handle) >>> 0
    } : void 0;
    return {
      code,
      message: message2,
      phase: runtimePhase(this.#module._p8w_phase(this.#handle) >>> 0),
      ...line < 0 ? {} : { line },
      ...trace.length === 0 ? {} : { trace },
      ...code === "E_FEATURE_UNSUPPORTED" && message2 === "nested-host-suspend" ? { details: { reason: "nested-host-suspend" } } : oomDetails === void 0 ? {} : { details: oomDetails }
    };
  }
  #outcome(statusValue, operation) {
    const status = statusValue >>> 0;
    const state = frameState(this.#module._p8w_state(this.#handle) >>> 0);
    const mode = frameMode(this.#module._p8w_mode(this.#handle) >>> 0);
    const rawFps = this.#module._p8w_target_fps(this.#handle) >>> 0;
    const targetFps = rawFps === 30 || rawFps === 60 ? rawFps : 0;
    const consumedInstructions = this.#module._p8w_consumed_instructions(this.#handle) >>> 0;
    const base = { mode, state, targetFps, consumedInstructions };
    const reason = this.#module._p8w_yield_reason(this.#handle) >>> 0;
    if (status === STATUS_STOPPED) {
      return {
        ...base,
        kind: "stopped",
        state: "stopped",
        message: this.#copyBytes(this.#module._p8w_control_bytes_ptr(this.#handle), this.#module._p8w_control_bytes_length(this.#handle))
      };
    }
    if (status === STATUS_RESTART) {
      return {
        ...base,
        kind: "restart",
        state: "stopped",
        parameter: this.#copyBytes(this.#module._p8w_control_bytes_ptr(this.#handle), this.#module._p8w_control_bytes_length(this.#handle))
      };
    }
    if (status !== STATUS_OK && status !== STATUS_YIELDED) {
      return {
        ...base,
        kind: "fault",
        state: "faulted",
        error: this.#fault(status)
      };
    }
    if (status === STATUS_YIELDED && reason === YIELD_HOST_REQUEST) {
      return {
        ...base,
        kind: "host-request",
        state: "waiting-host",
        request: {
          id: this.#module._p8w_pending_request_id(this.#handle) >>> 0,
          bytes: this.#copyBytes(this.#module._p8w_pending_request_ptr(this.#handle), this.#module._p8w_pending_request_length(this.#handle))
        }
      };
    }
    if ((operation === "step" || operation === "complete-host") && (reason === YIELD_FRAME_END || reason === YIELD_FLIP)) {
      return { ...base, kind: "frame" };
    }
    if (operation === "step" && reason !== YIELD_FRAME_END && reason !== YIELD_FLIP) {
      return {
        ...base,
        kind: "fault",
        state: "faulted",
        error: {
          code: "E_INVARIANT",
          message: "VM step returned without a frame boundary",
          phase: runtimePhase(this.#module._p8w_phase(this.#handle) >>> 0)
        }
      };
    }
    return { ...base, kind: "ready" };
  }
};

// apps/web-player/dist/runtime/adapters/cart-repository-adapter.js
var SHA256_PATTERN3 = /^[0-9a-f]{64}$/u;
var CURRENT_CART_REPOSITORY_MAX_CARTS = 64;
function keyOf(identity) {
  if (!SHA256_PATTERN3.test(identity.contentSha256)) {
    throw new RangeError("cart repository identity must be a lower-case SHA-256 digest");
  }
  return identity.contentSha256;
}
function assertRange2(offset, length) {
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset > PICO_CART_DATA_ROM_SIZE || length > PICO_CART_DATA_ROM_SIZE - offset) {
    throw new RangeError("cart data repository range is out of bounds");
  }
}
function equalBytes(left, right) {
  if (left.byteLength !== right.byteLength)
    return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index])
      return false;
  }
  return true;
}
function copyWarnings(warnings) {
  return Object.freeze(warnings.map((warning) => Object.freeze({
    code: warning.code,
    message: warning.message,
    offset: warning.offset,
    ...warning.section === void 0 ? {} : { section: warning.section }
  })));
}
function copyParsedCart(cart) {
  if (!(cart.rom instanceof Uint8Array) || cart.rom.byteLength !== PICO_CART_ROM_SIZE || !(cart.code instanceof Uint8Array) || !Array.isArray(cart.warnings) || cart.format !== "p8" && cart.format !== "p8.png" || !Number.isSafeInteger(cart.version) || cart.version < 0 || cart.version > 255 || !Number.isSafeInteger(cart.sourceBytes) || cart.sourceBytes < 0) {
    throw new TypeError("cart repository requires a valid ParsedCart snapshot");
  }
  const code = cart.code.slice();
  return Object.freeze({
    identity: Object.freeze({ contentSha256: keyOf(cart.identity) }),
    format: cart.format,
    version: cart.version,
    rom: cart.rom.slice(),
    code,
    warnings: copyWarnings(cart.warnings),
    sourceBytes: cart.sourceBytes
  });
}
function equalCart(left, right) {
  return left.format === right.format && left.version === right.version && left.sourceBytes === right.sourceBytes && equalBytes(left.rom, right.rom) && equalBytes(left.code, right.code) && JSON.stringify(left.warnings) === JSON.stringify(right.warnings);
}
var CartRepositoryAdapter = class {
  #records = /* @__PURE__ */ new Map();
  #disposed = false;
  registerCart(cart) {
    this.#assertLive();
    if (!(cart.rom instanceof Uint8Array) || cart.rom.byteLength !== PICO_CART_ROM_SIZE) {
      throw new RangeError("registered cart ROM must be exactly 0x8000 bytes");
    }
    const key = keyOf(cart.identity);
    const original = cart.rom.slice(0, PICO_CART_DATA_ROM_SIZE);
    const existing = this.#records.get(key);
    if (existing !== void 0) {
      if (!equalBytes(existing.rom, cart.rom)) {
        throw new Error("cart identity was registered with different ROM bytes");
      }
      return;
    }
    if (this.#records.size >= CURRENT_CART_REPOSITORY_MAX_CARTS) {
      throw new RangeError("current-cart repository reached its 64-cart Worker limit");
    }
    this.#records.set(key, { original, rom: cart.rom.slice() });
  }
  put(cart) {
    this.#assertLive();
    const owned = copyParsedCart(cart);
    const key = keyOf(owned.identity);
    const original = owned.rom.slice(0, PICO_CART_DATA_ROM_SIZE);
    const existing = this.#records.get(key);
    if (existing !== void 0) {
      if (!equalBytes(existing.rom, owned.rom)) {
        throw new Error("cart identity was registered with different ROM bytes");
      }
      if (existing.cart !== void 0 && !equalCart(existing.cart, owned)) {
        throw new Error("cart identity was registered with different parsed cart content");
      }
      existing.cart = owned;
      return;
    }
    if (this.#records.size >= CURRENT_CART_REPOSITORY_MAX_CARTS) {
      throw new RangeError("current-cart repository reached its 64-cart Worker limit");
    }
    this.#records.set(key, { original, rom: owned.rom, cart: owned });
  }
  get(identity) {
    this.#assertLive();
    const cart = this.#records.get(keyOf(identity))?.cart;
    return cart === void 0 ? void 0 : copyParsedCart(cart);
  }
  readData(identity, source, length) {
    this.#assertLive();
    assertRange2(source, length);
    const record = this.#record(identity);
    return (record.overlay ?? record.original).slice(source, source + length);
  }
  writeDataOverlay(identity, destination, bytes) {
    this.#assertLive();
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("cart data overlay bytes must be a Uint8Array");
    }
    assertRange2(destination, bytes.byteLength);
    const record = this.#record(identity);
    const overlay = record.overlay ?? record.original.slice();
    overlay.set(bytes.slice(), destination);
    record.overlay = overlay;
  }
  dispose() {
    if (this.#disposed)
      return;
    this.#records.clear();
    this.#disposed = true;
  }
  #record(identity) {
    const record = this.#records.get(keyOf(identity));
    if (record === void 0)
      throw new Error("cart is not registered in this Worker");
    return record;
  }
  #assertLive() {
    if (this.#disposed)
      throw new Error("cart repository is disposed");
  }
};

// apps/web-player/dist/runtime/adapters/host-cart-resolver-adapter.js
function assertLocalRef(ref) {
  const checked = assertCartRef(ref);
  if (checked.startsWith("/") || checked.startsWith("#") || checked.includes("://") || checked.includes("\\") || checked.split("/").some((part) => part === "." || part === ".." || part.length === 0)) {
    throw new CartResolutionError(CART_RESOLUTION_ERROR_CODES.invalidRef, "local bundle ref must be a canonical relative opaque name");
  }
  return checked;
}
function copyEntry(entry) {
  const ref = assertLocalRef(entry.ref);
  if (!(entry.bytes instanceof Uint8Array) || entry.bytes.byteLength === 0) {
    throw new CartResolutionError(CART_RESOLUTION_ERROR_CODES.invalidSource, "local bundle entry must contain cart bytes");
  }
  if (entry.bytes.byteLength > PICO_CART_INPUT_MAX_BYTES) {
    throw new CartResolutionError(CART_RESOLUTION_ERROR_CODES.sourceTooLarge, `local bundle entry exceeds ${PICO_CART_INPUT_MAX_BYTES} bytes`);
  }
  return Object.freeze({
    ref,
    bytes: entry.bytes.slice(),
    access: copyCartAccess(entry.access)
  });
}
var LocalCartBundleResolver = class {
  #entries = /* @__PURE__ */ new Map();
  #disposed = false;
  constructor(entries) {
    if (!Array.isArray(entries)) {
      throw new TypeError("local cart bundle must be an array");
    }
    if (entries.length > PICO_LOCAL_CART_BUNDLE_MAX_ENTRIES) {
      throw new CartResolutionError(CART_RESOLUTION_ERROR_CODES.bundleLimit, `local cart bundle exceeds ${PICO_LOCAL_CART_BUNDLE_MAX_ENTRIES} entries`);
    }
    for (const candidate of entries) {
      const entry = copyEntry(candidate);
      if (this.#entries.has(entry.ref)) {
        throw new CartResolutionError(CART_RESOLUTION_ERROR_CODES.duplicateRef, `local cart bundle contains duplicate ref: ${entry.ref}`);
      }
      this.#entries.set(entry.ref, entry);
    }
  }
  resolve(ref, context, cancellation) {
    const entry = this.#resolveEntry(ref, context.purpose);
    return new Promise((resolve, reject) => {
      let settled = false;
      let unsubscribe = () => void 0;
      const finish = (action) => {
        if (settled)
          return;
        settled = true;
        unsubscribe();
        action();
      };
      const cancel = () => {
        finish(() => reject(new CartResolutionError(CART_RESOLUTION_ERROR_CODES.cancelled, "cart resolution was cancelled")));
      };
      try {
        unsubscribe = cancellation.onCancel(cancel);
        if (cancellation.cancelled)
          cancel();
      } catch (error) {
        finish(() => reject(error));
      }
      void Promise.resolve().then(() => {
        if (settled)
          return;
        if (this.#disposed) {
          finish(() => reject(new CartResolutionError(CART_RESOLUTION_ERROR_CODES.disposed, "local cart bundle resolver is disposed")));
          return;
        }
        if (cancellation.cancelled) {
          cancel();
          return;
        }
        finish(() => resolve(Object.freeze({
          ref: entry.ref,
          bytes: entry.bytes.slice(),
          access: copyCartAccess(entry.access)
        })));
      });
    });
  }
  /** Synchronous lookup for codec-time include expansion over already-owned bytes. */
  resolveImmediate(ref, purpose) {
    const entry = this.#resolveEntry(ref, purpose);
    return Object.freeze({
      ref: entry.ref,
      bytes: entry.bytes.slice(),
      access: copyCartAccess(entry.access)
    });
  }
  dispose() {
    if (this.#disposed)
      return;
    this.#entries.clear();
    this.#disposed = true;
  }
  #assertLive() {
    if (this.#disposed) {
      throw new CartResolutionError(CART_RESOLUTION_ERROR_CODES.disposed, "local cart bundle resolver is disposed");
    }
  }
  #resolveEntry(ref, purpose) {
    this.#assertLive();
    const checkedRef = assertLocalRef(ref);
    const entry = this.#entries.get(checkedRef);
    if (entry === void 0) {
      throw new CartResolutionError(CART_RESOLUTION_ERROR_CODES.notFound, `local cart bundle does not contain ref: ${checkedRef}`);
    }
    assertCartAccessForPurpose(entry.access, assertCartResolvePurpose(purpose));
    return entry;
  }
};

// apps/web-player/dist/runtime/compose-session.js
function invariant(message2) {
  return {
    code: "E_INVARIANT",
    message: message2,
    phase: "none",
    recoverable: false
  };
}
function saturatingAddInt32(left, right) {
  const result = left + right;
  return Math.max(-2147483648, Math.min(2147483647, result)) | 0;
}
function playerBase(context) {
  return {
    sessionGeneration: context.sessionGeneration
  };
}
function playerBaseForGeneration(context, generation) {
  return { ...playerBase(context), sessionGeneration: generation };
}
function playerLifecycleError(message2, recoverable = false) {
  return {
    code: "E_INVALID_STATE",
    message: message2,
    phase: "none",
    recoverable
  };
}
function isSerializedRuntimeError(value) {
  return value !== null && typeof value === "object" && "code" in value && typeof value.code === "string" && "message" in value && typeof value.message === "string" && "phase" in value && typeof value.phase === "string" && "recoverable" in value && typeof value.recoverable === "boolean";
}
function createSessionController(module, options = {}) {
  const audioTransport = options.audioTransport;
  const persistence = options.persistence;
  const hostRequestHandler = options.hostRequestHandler;
  const luaHeapLimit = options.luaHeapLimit;
  const cartRepository = new CartRepositoryAdapter();
  let localCartResolver = new LocalCartBundleResolver([]);
  let cartLoader = new CartLoader(localCartResolver, cartRepository);
  const localPersistenceDiagnostics = [];
  let cartDataSeeds = [];
  let hostPersistence = false;
  const pendingHostCartDataCommits = [];
  let instructionBudget;
  const scheduler = new FrameScheduler({ maximumCatchUpTicks: 5 });
  function createSession() {
    return new CartSession({ createRuntime(context) {
      const router = createPicoApiHostRouter(module);
      const vm = new Z8LuaFrameVm(module, router, {
        ...luaHeapLimit === void 0 ? {} : { luaHeapLimit }
      });
      try {
        return new FrameSliceRuntime(vm, {
          ...instructionBudget === void 0 ? {} : { instructionBudget },
          cartDataSeeds,
          currentCart: {
            identity: context.cart.identity,
            repository: cartRepository
          },
          runParameter: context.runParameter
        });
      } catch (error) {
        vm.destroy();
        throw error;
      }
    } });
  }
  let session = createSession();
  let lifecycle = "empty";
  let sessionGeneration = 0;
  let inputSequence = -1;
  let inputControllers = new Array(PICO_CONTROLLER_COUNT).fill(0);
  let inputMouseXRaw = 0;
  let inputMouseYRaw = 0;
  let inputMouseButtons = 0;
  let pendingWheelRaw = 0;
  let pendingMovementXRaw = 0;
  let pendingMovementYRaw = 0;
  const pendingKeypresses = [];
  let mode = "none";
  let targetFps = 0;
  let devkitFlags = 0;
  let pendingRequest;
  let activeMenuSnapshot;
  const externalCstoreTargetIdentities = /* @__PURE__ */ new Set();
  let breadcrumbDepth = 0;
  function clearPendingDevkitEvents() {
    pendingWheelRaw = 0;
    pendingMovementXRaw = 0;
    pendingMovementYRaw = 0;
    pendingKeypresses.length = 0;
  }
  function clearInputState() {
    inputControllers = new Array(PICO_CONTROLLER_COUNT).fill(0);
    inputMouseXRaw = 0;
    inputMouseYRaw = 0;
    inputMouseButtons = 0;
    clearPendingDevkitEvents();
  }
  function simulationInput(includePendingEvents) {
    return {
      controllers: inputControllers,
      devkit: includePendingEvents ? {
        mouseXRaw: inputMouseXRaw,
        mouseYRaw: inputMouseYRaw,
        mouseButtons: inputMouseButtons,
        wheelRaw: pendingWheelRaw,
        movementXRaw: pendingMovementXRaw,
        movementYRaw: pendingMovementYRaw,
        keypresses: pendingKeypresses.slice()
      } : {
        ...PICO_EMPTY_INPUT.devkit,
        mouseXRaw: inputMouseXRaw,
        mouseYRaw: inputMouseYRaw,
        mouseButtons: inputMouseButtons
      }
    };
  }
  function beginAudioGeneration(generation) {
    audioTransport?.beginGeneration(generation);
  }
  function resetAudioQueue(generation) {
    if (audioTransport === void 0)
      return;
    if (audioTransport.sessionGeneration !== generation) {
      audioTransport.beginGeneration(generation);
    } else {
      audioTransport.reset();
    }
  }
  function sendAudio(slice) {
    audioTransport?.submit(slice);
  }
  function recordPersistenceFailure(code, message2, error) {
    if (localPersistenceDiagnostics.length >= 32) {
      localPersistenceDiagnostics.shift();
    }
    localPersistenceDiagnostics.push({
      code,
      message: message2,
      phase: "none",
      recoverable: true,
      ...error === void 0 ? {} : {
        details: {
          cause: error instanceof Error ? error.message : String(error)
        }
      }
    });
  }
  function enqueueCartDataCommit(commit) {
    cartDataSeeds = [
      ...cartDataSeeds.filter((seed) => seed.id !== commit.id),
      { id: commit.id, bytes: commit.bytes.slice() }
    ];
    if (hostPersistence) {
      pendingHostCartDataCommits.push({
        id: commit.id,
        revision: commit.revision,
        bytes: commit.bytes.slice()
      });
      return;
    }
    if (persistence === void 0)
      return;
    try {
      persistence.enqueue(commit);
    } catch (error) {
      recordPersistenceFailure("E_PERSISTENCE_WRITE", "Unable to queue committed cartdata for durable storage", error);
    }
  }
  function takePersistenceEvents(context) {
    const commits = pendingHostCartDataCommits.splice(0).map((commit) => ({
      ...playerBase(context),
      type: "cartdata-commit",
      id: commit.id,
      revision: commit.revision,
      bytes: commit.bytes.slice().buffer
    }));
    let diagnostics = [];
    if (persistence !== void 0 && !hostPersistence) {
      try {
        diagnostics = persistence.takeDiagnostics();
      } catch (error) {
        recordPersistenceFailure("E_PERSISTENCE_READ", "Unable to read persistence diagnostics", error);
      }
    }
    const combined = [...localPersistenceDiagnostics.splice(0), ...diagnostics];
    return [...commits, ...combined.map((error) => ({
      ...playerBase(context),
      type: "diagnostic",
      error
    }))];
  }
  async function flushPersistence() {
    if (hostPersistence)
      return { durable: true };
    if (persistence === void 0) {
      return { durable: false, message: "No durable persistence adapter is configured" };
    }
    try {
      const result = await persistence.flush();
      return result ?? { durable: false, message: "Persistence adapter did not confirm durability" };
    } catch (error) {
      recordPersistenceFailure("E_PERSISTENCE_WRITE", "Unable to durably flush committed cartdata", error);
      return { durable: false, message: error instanceof Error ? error.message : String(error) };
    }
  }
  async function hydratePersistence() {
    if (persistence === void 0)
      return;
    try {
      cartDataSeeds = await persistence.hydrate();
    } catch (error) {
      cartDataSeeds = [];
      recordPersistenceFailure("E_PERSISTENCE_READ", "Unable to hydrate cartdata; using an empty durable mirror", error);
    }
  }
  function useHostPersistence(records) {
    const ids = /* @__PURE__ */ new Set();
    if (records.length > PICO_CART_DATA_MAX_RECORDS)
      throw new RangeError("host cartdata exceeds 4096 records");
    cartDataSeeds = records.map((record) => {
      if (!/^[a-z0-9_-]+$/u.test(record.id) || record.id.length > PICO_CART_DATA_ID_MAX_BYTES || ids.has(record.id) || !(record.bytes instanceof Uint8Array) || record.bytes.byteLength !== PICO_CART_DATA_BYTES) {
        throw new RangeError("host cartdata contains an invalid record");
      }
      ids.add(record.id);
      return { id: record.id, bytes: record.bytes.slice() };
    });
    hostPersistence = true;
  }
  function fault(context, error) {
    cancelPendingRequest();
    activeMenuSnapshot = void 0;
    lifecycle = "faulted";
    scheduler.pause();
    clearInputState();
    devkitFlags = 0;
    resetAudioQueue(context.sessionGeneration);
    return { ...playerBase(context), type: "fault", error };
  }
  function state(context, next) {
    return {
      ...playerBase(context),
      type: "state",
      state: next,
      mode,
      targetFps,
      devkitFlags
    };
  }
  function pauseMenuEvent(context, open, outcome, snapshot) {
    return {
      ...playerBase(context),
      type: "pause-menu",
      open,
      outcome,
      items: (snapshot?.items ?? []).map((item) => ({
        slot: item.slot,
        label: item.label.slice().buffer,
        filter: item.filter
      }))
    };
  }
  function stateForGeneration(context, generation, next) {
    return state({ ...context, sessionGeneration: generation }, next);
  }
  function cancelPendingRequest() {
    const pending = pendingRequest;
    pendingRequest = void 0;
    pending?.cancellation.cancel();
  }
  function guestLoadFault(context, pending, error) {
    if (pendingRequest !== pending)
      return;
    pendingRequest = void 0;
    session.stop();
    const serialized = error instanceof CartCodecError ? {
      code: "E_CART_PARSE",
      message: `${error.code}: ${error.message}`,
      phase: "host-call",
      recoverable: false,
      details: {
        cartCodecCode: error.code,
        ...error.offset === void 0 ? {} : { byteOffset: error.offset }
      }
    } : error instanceof CartResolutionError ? {
      code: "E_HOST_REQUEST",
      message: error.message,
      phase: "host-call",
      recoverable: false,
      details: { cartResolutionCode: error.code }
    } : isSerializedRuntimeError(error) ? error : {
      code: "E_HOST_REQUEST",
      message: error instanceof Error ? error.message : String(error),
      phase: "host-call",
      recoverable: false
    };
    context.onResume([fault(context, serialized)]);
  }
  async function completeGuestLoad(context, pending, request) {
    try {
      await flushPersistence();
      const current2 = session.cart?.identity;
      const loaded = await cartLoader.load(request.ref, { ...current2 === void 0 ? {} : { current: current2 }, purpose: "load" }, pending.cancellation.token);
      if (pendingRequest !== pending || pending.cancellation.token.cancelled || pending.sessionGeneration !== sessionGeneration)
        return;
      const staged = createSession();
      const boot = staged.load(loaded.cart, request.parameter ?? new Uint8Array());
      if (!boot.ok) {
        staged.dispose();
        guestLoadFault(context, pending, boot.error);
        return;
      }
      if (boot.value.kind !== "ready") {
        staged.dispose();
        guestLoadFault(context, pending, {
          code: "E_FEATURE_UNSUPPORTED",
          message: "a load target must boot directly into callback or custom mode",
          phase: "host-call",
          recoverable: false
        });
        return;
      }
      if (sessionGeneration >= 4294967295) {
        staged.dispose();
        guestLoadFault(context, pending, invariant("session generation space is exhausted"));
        return;
      }
      const previousSessionGeneration = sessionGeneration;
      const nextSessionGeneration = previousSessionGeneration + 1;
      const oldSession = session;
      const oldDisposed = oldSession.dispose();
      if (!oldDisposed.ok) {
        staged.dispose();
        guestLoadFault(context, pending, oldDisposed.error);
        return;
      }
      pendingRequest = void 0;
      session = staged;
      sessionGeneration = nextSessionGeneration;
      externalCstoreTargetIdentities.clear();
      if (request.breadcrumb !== void 0)
        breadcrumbDepth++;
      inputSequence = -1;
      clearInputState();
      mode = boot.value.mode;
      targetFps = boot.value.targetFps;
      devkitFlags = boot.value.devkitFlags;
      scheduler.reset();
      scheduler.configure(targetFps);
      lifecycle = pending.continueRunning ? "running" : "ready";
      if (pending.continueRunning)
        scheduler.start();
      const breadcrumb = request.breadcrumb?.slice() ?? new Uint8Array();
      context.onResume([{
        ...playerBaseForGeneration(context, nextSessionGeneration),
        type: "session-replaced",
        previousSessionGeneration,
        nextSessionGeneration,
        cartRef: loaded.ref,
        breadcrumb: breadcrumb.buffer,
        breadcrumbDepth
      }]);
      beginAudioGeneration(nextSessionGeneration);
      sendAudio(boot.value.audio);
      context.onResume([
        stateForGeneration(context, nextSessionGeneration, pending.continueRunning ? "running" : "ready")
      ]);
    } catch (error) {
      guestLoadFault(context, pending, error);
    }
  }
  function suspendGuestLoad(context, request, continueRunning) {
    if (pendingRequest !== void 0) {
      return [fault(context, {
        code: "E_HOST_REQUEST",
        message: "root HostRequest violates the bounded single-pending contract",
        phase: "host-call",
        recoverable: false
      })];
    }
    let decoded;
    try {
      decoded = decodeGuestCartLoadRequest(request.bytes);
    } catch (error) {
      return [fault(context, {
        code: "E_HOST_REQUEST",
        message: error instanceof Error ? error.message : String(error),
        phase: "host-call",
        recoverable: false,
        details: { guestRequestKind: "load", malformed: true }
      })];
    }
    scheduler.pause();
    lifecycle = "waiting-host";
    const pending = {
      kind: "load",
      sessionGeneration,
      requestId: request.id,
      cancellation: new CartCancellationSource(),
      continueRunning
    };
    pendingRequest = pending;
    void completeGuestLoad(context, pending, decoded);
    return [state(context, "waiting-host")];
  }
  function externalCartDataIsCurrent(pending) {
    return pendingRequest === pending && !pending.cancellation.token.cancelled && pending.sessionGeneration === sessionGeneration && pending.runtimeGeneration === session.generation;
  }
  function failExternalCartData(pending) {
    if (!externalCartDataIsCurrent(pending))
      return;
    pendingRequest = void 0;
    pending.emit(pending.resume(new Uint8Array(), true));
  }
  async function completeExternalCartData(pending, request, range, cstoreSnapshot) {
    try {
      const current2 = session.cart?.identity;
      const loaded = await cartLoader.load(request.ref, {
        ...current2 === void 0 ? {} : { current: current2 },
        purpose: request.operation
      }, pending.cancellation.token);
      if (!externalCartDataIsCurrent(pending))
        return;
      if (request.operation === "reload") {
        const bytes = cartRepository.readData(loaded.cart.identity, range.source, range.length);
        if (!externalCartDataIsCurrent(pending))
          return;
        const written = session.writeSuspendedLogicalRam(pending.runtimeGeneration, range.destination, bytes);
        if (!written.ok)
          throw written.error;
      } else {
        if (cstoreSnapshot === void 0 || cstoreSnapshot.byteLength !== range.length) {
          throw new Error("external cstore snapshot invariant failed");
        }
        if (range.length !== 0) {
          const target = loaded.cart.identity.contentSha256;
          if (!externalCstoreTargetIdentities.has(target) && externalCstoreTargetIdentities.size >= 64) {
            throw new RangeError("external cstore reached its 64-target execution limit");
          }
          cartRepository.writeDataOverlay(loaded.cart.identity, range.destination, cstoreSnapshot);
          externalCstoreTargetIdentities.add(target);
        }
      }
      if (!externalCartDataIsCurrent(pending))
        return;
      pendingRequest = void 0;
      pending.emit(pending.resume(new Uint8Array(), false));
    } catch {
      failExternalCartData(pending);
    }
  }
  function suspendExternalCartData(context, hostRequest, resume) {
    if (pendingRequest !== void 0) {
      session.stop();
      return [fault(context, {
        code: "E_HOST_REQUEST",
        message: "root HostRequest violates the bounded single-pending contract",
        phase: "host-call",
        recoverable: false
      })];
    }
    try {
      const request = decodeExternalCartDataRequest(hostRequest.bytes);
      const range = request.operation === "reload" ? normalizeReloadRange(request.destinationRaw, request.sourceRaw, request.lengthRaw) : normalizeCstoreRange(request.destinationRaw, request.sourceRaw, request.lengthRaw);
      const cstoreSnapshot = request.operation === "cstore" ? session.copySuspendedLogicalRam(hostRequest.generation, range.source, range.length) : void 0;
      if (cstoreSnapshot !== void 0 && !cstoreSnapshot.ok) {
        throw cstoreSnapshot.error;
      }
      scheduler.pause();
      lifecycle = "waiting-host";
      const pending = {
        kind: "cart-data",
        sessionGeneration,
        runtimeGeneration: hostRequest.generation,
        requestId: hostRequest.id,
        cancellation: new CartCancellationSource(),
        resume,
        emit: context.onResume
      };
      pendingRequest = pending;
      void completeExternalCartData(pending, request, range, cstoreSnapshot?.value);
      return [state(context, "waiting-host")];
    } catch (error) {
      session.stop();
      return [fault(context, {
        code: "E_HOST_REQUEST",
        message: error instanceof Error ? error.message : String(error),
        phase: "host-call",
        recoverable: false,
        details: { externalCartDataMalformedOrOutOfRange: true }
      })];
    }
  }
  function completePendingHostRequest(pending, completion) {
    if (pendingRequest !== pending || pending.cancellation.token.cancelled || pending.sessionGeneration !== sessionGeneration)
      return;
    pendingRequest = void 0;
    const valid = completion !== void 0 && completion.generation === pending.runtimeGeneration && completion.requestId === pending.requestId && completion.bytes instanceof Uint8Array && completion.bytes.byteLength <= PICO_HOST_REQUEST_MAX_BYTES && typeof completion.isError === "boolean";
    const response = valid ? completion.bytes.slice() : new Uint8Array();
    const events = pending.resume(response, valid ? completion.isError : true);
    pending.emit(events);
  }
  function suspendHostRequest(context, request, resume) {
    if (isGuestCartRequestPayload(request.bytes)) {
      return suspendGuestLoad(context, request, lifecycle === "running");
    }
    if (isExternalCartDataRequestPayload(request.bytes)) {
      return suspendExternalCartData(context, request, resume);
    }
    if (hostRequestHandler === void 0) {
      return [unsupportedHostRequest(context)];
    }
    if (request.bytes.byteLength > PICO_HOST_REQUEST_MAX_BYTES || pendingRequest !== void 0) {
      return [fault(context, {
        code: "E_HOST_REQUEST",
        message: "root HostRequest violates the bounded single-pending contract",
        phase: "host-call",
        recoverable: false
      })];
    }
    scheduler.pause();
    lifecycle = "waiting-host";
    const cancellation = new CartCancellationSource();
    const pending = {
      kind: "host",
      sessionGeneration,
      runtimeGeneration: request.generation,
      requestId: request.id,
      cancellation,
      resume,
      emit: context.onResume
    };
    pendingRequest = pending;
    const handlerRequest = Object.freeze({
      generation: request.generation,
      requestId: request.id,
      operation: request.operation,
      bytes: request.bytes.slice()
    });
    void Promise.resolve().then(() => hostRequestHandler.handle(handlerRequest, cancellation.token)).then((completion) => completePendingHostRequest(pending, completion), () => completePendingHostRequest(pending, void 0));
    return [state(context, "waiting-host")];
  }
  function unsupportedHostRequest(context) {
    session.stop();
    return fault(context, {
      code: "E_FEATURE_UNSUPPORTED",
      message: "cart host requests are not supported by the player",
      phase: "host-call",
      recoverable: false
    });
  }
  function acceptBoot(context, result, continueRunning = false) {
    activeMenuSnapshot = void 0;
    let current2 = result;
    const events = [];
    for (let restartCount = 0; restartCount <= 8; restartCount += 1) {
      if (!current2.ok)
        return [...events, fault(context, current2.error)];
      if (current2.value.kind === "host-request") {
        const request = current2.value.request;
        return [...events, ...suspendHostRequest(context, request, (response, isError) => acceptBoot(context, session.completeHostRequest(request.generation, request.id, response, isError), continueRunning))];
      }
      if (current2.value.cartDataCommit !== void 0) {
        enqueueCartDataCommit(current2.value.cartDataCommit);
      }
      if (current2.value.kind === "stopped") {
        scheduler.pause();
        clearInputState();
        lifecycle = "stopped";
        mode = "none";
        targetFps = 0;
        devkitFlags = 0;
        resetAudioQueue(context.sessionGeneration);
        events.push(runtimeControlEvent(context, "stop", current2.value.message));
        events.push(state(context, "stopped"));
        return events;
      }
      if (current2.value.kind === "restart") {
        events.push(runtimeControlEvent(context, "run", current2.value.parameter));
        if (restartCount === 8) {
          events.push(fault(context, {
            code: "E_VM_INSTRUCTION_BUDGET",
            message: "guest run restart limit exceeded in one host context",
            phase: "none",
            recoverable: false,
            details: { restartCount: restartCount + 1 }
          }));
          return events;
        }
        externalCstoreTargetIdentities.clear();
        current2 = session.restart(current2.value.parameter);
        continue;
      }
      beginAudioGeneration(context.sessionGeneration);
      sendAudio(current2.value.audio);
      mode = current2.value.mode;
      targetFps = current2.value.targetFps;
      devkitFlags = current2.value.devkitFlags;
      scheduler.configure(targetFps);
      if (continueRunning) {
        scheduler.start();
        lifecycle = "running";
        events.push(state(context, "running"));
        return events;
      }
      lifecycle = "ready";
      events.push(state(context, "ready"));
      return events;
    }
    return [...events, fault(context, invariant("unreachable guest restart loop"))];
  }
  function runtimeControlEvent(context, control, payload) {
    return {
      ...playerBase(context),
      type: "runtime-control",
      control,
      payload: payload.slice().buffer
    };
  }
  function acceptInput(context) {
    if (context.sessionGeneration !== sessionGeneration || context.sequence <= inputSequence || lifecycle !== "running")
      return;
    inputSequence = context.sequence;
    inputControllers = context.input.controllers.slice();
    const devkit = context.input.devkit;
    inputMouseXRaw = devkit.mouseXRaw;
    inputMouseYRaw = devkit.mouseYRaw;
    inputMouseButtons = devkit.mouseButtons;
    pendingWheelRaw = saturatingAddInt32(pendingWheelRaw, devkit.wheelRaw);
    pendingMovementXRaw = saturatingAddInt32(pendingMovementXRaw, devkit.movementXRaw);
    pendingMovementYRaw = saturatingAddInt32(pendingMovementYRaw, devkit.movementYRaw);
    for (const byte of devkit.keypresses) {
      if (pendingKeypresses.length >= PICO_DEVKIT_KEYPRESS_BATCH_LIMIT)
        break;
      pendingKeypresses.push(byte);
    }
  }
  function frameEvent(context, result) {
    sendAudio(result.frame.audio);
    const packedScreen = result.frame.screen.slice().buffer;
    const displayPalette = result.frame.displayPalette.slice().buffer;
    devkitFlags = result.frame.devkitFlags;
    if (result.frame.cartDataCommit !== void 0) {
      enqueueCartDataCommit(result.frame.cartDataCommit);
    }
    return {
      ...playerBase(context),
      type: "frame",
      frameId: result.frame.frameId,
      completedSlices: result.frame.completedSlices,
      timeRawBeforeStep: result.frame.timeRawBeforeStep,
      targetFps: result.frame.targetFps,
      cpuInstructions: result.frame.cpuInstructions,
      cpuFractionRaw: result.frame.cpuFractionRaw,
      slowFrame: result.frame.slowFrame,
      devkitFlags,
      packedScreen,
      displayPalette
    };
  }
  function heartbeatEvent(context, tickCount, droppedTicks) {
    return {
      ...playerBase(context),
      type: "heartbeat",
      vsyncSequence: context.sequence,
      tickCount,
      droppedTicks
    };
  }
  function acceptCompletedStep(context, result) {
    const events = [];
    if (result.kind === "stopped") {
      if (result.cartDataCommit !== void 0) {
        enqueueCartDataCommit(result.cartDataCommit);
      }
      scheduler.pause();
      lifecycle = "stopped";
      clearInputState();
      devkitFlags = 0;
      resetAudioQueue(context.sessionGeneration);
      events.push(runtimeControlEvent(context, "stop", result.message));
      events.push(state(context, "stopped"));
    } else if (result.kind === "restart") {
      if (result.cartDataCommit !== void 0) {
        enqueueCartDataCommit(result.cartDataCommit);
      }
      clearInputState();
      events.push(runtimeControlEvent(context, "run", result.parameter));
      externalCstoreTargetIdentities.clear();
      events.push(...acceptBoot(context, session.restart(result.parameter), true));
    } else {
      events.push(frameEvent(context, result));
    }
    return events;
  }
  function acceptVsyncHostCompletion(context, result, executedBefore, droppedTicks) {
    if (!result.ok)
      return [fault(context, result.error)];
    if (result.value.kind === "host-request") {
      const request = result.value.request;
      return suspendHostRequest(context, request, (response, isError) => acceptVsyncHostCompletion(context, session.completeHostRequest(request.generation, request.id, response, isError), executedBefore, droppedTicks));
    }
    const executedTicks = executedBefore + 1;
    if (result.value.kind === "frame") {
      scheduler.resume();
      lifecycle = "running";
    }
    const events = acceptCompletedStep(context, result.value);
    events.push(heartbeatEvent(context, executedTicks, droppedTicks));
    return events;
  }
  function handleTicks(context, decide) {
    if (lifecycle !== "running") {
      return [heartbeatEvent(context, 0, 0)];
    }
    const decision = decide();
    const events = [];
    if (decision.discontinuity) {
      events.push({
        ...playerBase(context),
        type: "diagnostic",
        error: {
          code: "E_TIME_DISCONTINUITY",
          message: decision.droppedTicks > 0 ? "simulation backlog exceeded the catch-up limit and was dropped" : "non-monotonic wall-clock pulse reset the scheduler anchor",
          phase: "none",
          recoverable: true,
          details: { droppedTicks: decision.droppedTicks }
        }
      });
    }
    let executedTicks = 0;
    for (let index = 0; index < decision.tickCount; index += 1) {
      const result = session.step(simulationInput(index === 0));
      if (index === 0)
        clearPendingDevkitEvents();
      if (!result.ok) {
        events.push(fault(context, result.error));
        return events;
      }
      if (result.value.kind === "host-request") {
        const request = result.value.request;
        return [...events, ...suspendHostRequest(context, request, (response, isError) => acceptVsyncHostCompletion(context, session.completeHostRequest(request.generation, request.id, response, isError), executedTicks, decision.droppedTicks))];
      }
      executedTicks += 1;
      events.push(...acceptCompletedStep(context, result.value));
      if (result.value.kind !== "frame")
        break;
    }
    events.push(heartbeatEvent(context, executedTicks, decision.droppedTicks));
    return events;
  }
  function generationFault(context, message2) {
    return [{ ...playerBase(context), type: "fault", error: playerLifecycleError(message2) }];
  }
  function loadCartSync(context, load) {
    if (context.sessionGeneration <= sessionGeneration) {
      return generationFault(context, "loadCart requires a new session generation");
    }
    cancelPendingRequest();
    activeMenuSnapshot = void 0;
    sessionGeneration = context.sessionGeneration;
    instructionBudget = load.instructionBudget;
    scheduler.reset();
    inputSequence = -1;
    clearInputState();
    devkitFlags = 0;
    if (load.hostCartData !== void 0)
      useHostPersistence(load.hostCartData);
    let nextResolver;
    try {
      nextResolver = new LocalCartBundleResolver((load.localCartBundle ?? []).map((entry) => ({
        ref: entry.ref,
        bytes: entry.bytes,
        access: entry.access
      })));
      const cart = decodeCart(load.source, {
        p8: {
          includeResolver(specifier) {
            try {
              return nextResolver?.resolveImmediate(specifier, "include").bytes;
            } catch (error) {
              if (error instanceof CartResolutionError)
                return void 0;
              throw error;
            }
          }
        }
      });
      localCartResolver.dispose();
      localCartResolver = nextResolver;
      nextResolver = void 0;
      cartLoader = new CartLoader(localCartResolver, cartRepository);
      breadcrumbDepth = 0;
      externalCstoreTargetIdentities.clear();
      cartRepository.registerCart(cart);
      return acceptBoot(context, session.load(cart));
    } catch (error) {
      nextResolver?.dispose();
      if (session.cart !== void 0)
        session.stop();
      if (error instanceof CartCodecError) {
        return [fault(context, {
          code: "E_CART_PARSE",
          message: `${error.code}: ${error.message}`,
          phase: "none",
          recoverable: true,
          details: {
            cartCodecCode: error.code,
            ...error.offset === void 0 ? {} : { byteOffset: error.offset }
          }
        })];
      }
      return [fault(context, invariant(error instanceof Error ? error.message : String(error)))];
    }
  }
  function releaseResources(generation) {
    cancelPendingRequest();
    activeMenuSnapshot = void 0;
    scheduler.reset();
    clearInputState();
    const result = session.dispose();
    localCartResolver.dispose();
    cartRepository.dispose();
    externalCstoreTargetIdentities.clear();
    lifecycle = "disposed";
    mode = "none";
    targetFps = 0;
    devkitFlags = 0;
    if (generation > 0)
      resetAudioQueue(generation);
    return result;
  }
  function disposeSync(context) {
    const result = releaseResources(context.sessionGeneration);
    return result.ok ? [state(context, "disposed")] : [fault(context, result.error)];
  }
  function resetSync(context) {
    if (lifecycle === "disposed" || context.sessionGeneration <= sessionGeneration) {
      return generationFault(context, "reset requires a new session generation");
    }
    cancelPendingRequest();
    activeMenuSnapshot = void 0;
    sessionGeneration = context.sessionGeneration;
    scheduler.reset();
    inputSequence = -1;
    clearInputState();
    devkitFlags = 0;
    externalCstoreTargetIdentities.clear();
    return acceptBoot(context, session.reset());
  }
  function startSync(context) {
    if (lifecycle !== "ready") {
      return generationFault(context, "start requires a ready session");
    }
    scheduler.start();
    lifecycle = "running";
    return [state(context, "running")];
  }
  function openPauseMenuSync(context) {
    if (lifecycle !== "running") {
      return generationFault(context, "openPauseMenu requires a running session");
    }
    scheduler.pause();
    clearInputState();
    resetAudioQueue(context.sessionGeneration);
    const snapshot = session.snapshotMenuItems(session.generation);
    if (!snapshot.ok)
      return [fault(context, snapshot.error)];
    activeMenuSnapshot = snapshot.value;
    lifecycle = "menu-open";
    return [pauseMenuEvent(context, true, "opened", snapshot.value)];
  }
  function closePauseMenuSync(context) {
    if (lifecycle !== "menu-open" || activeMenuSnapshot === void 0) {
      return generationFault(context, "closePauseMenu requires an open pause menu");
    }
    activeMenuSnapshot = void 0;
    clearInputState();
    scheduler.resume();
    lifecycle = "running";
    return [
      pauseMenuEvent(context, false, "closed"),
      state(context, "running")
    ];
  }
  function invokeMenuItemSync(context) {
    const snapshot = activeMenuSnapshot;
    if (lifecycle !== "menu-open" || snapshot === void 0 || snapshot.generation !== session.generation) {
      return generationFault(context, "invokeMenuItem requires the active pause menu");
    }
    const item = snapshot.items.find(({ slot }) => slot === context.slot);
    if (item === void 0 || (item.filter >> 8 & context.button) !== 0) {
      return generationFault(context, "menu item intent is missing or filtered");
    }
    const invoked = session.invokeMenuItem(snapshot.generation, context.slot, context.button);
    if (!invoked.ok) {
      return invoked.error.code === "E_INVALID_STATE" ? generationFault(context, invoked.error.message) : [fault(context, invoked.error)];
    }
    if (invoked.value.cartDataCommit !== void 0) {
      enqueueCartDataCommit(invoked.value.cartDataCommit);
    }
    if (invoked.value.kind === "keep-open") {
      activeMenuSnapshot = invoked.value.snapshot;
      return [pauseMenuEvent(context, true, "keep-open", invoked.value.snapshot)];
    }
    activeMenuSnapshot = void 0;
    clearInputState();
    scheduler.resume();
    lifecycle = "running";
    return [
      pauseMenuEvent(context, false, invoked.value.kind === "removed" ? "removed" : "closed"),
      state(context, "running")
    ];
  }
  function pauseSync(context) {
    if (lifecycle !== "running" && lifecycle !== "paused" && lifecycle !== "menu-open") {
      return generationFault(context, "pause requires a running session");
    }
    const closedMenu = lifecycle === "menu-open";
    scheduler.pause();
    lifecycle = "paused";
    clearInputState();
    activeMenuSnapshot = void 0;
    return [
      ...closedMenu ? [pauseMenuEvent(context, false, "closed")] : [],
      state(context, "paused")
    ];
  }
  function resumeSync(context) {
    if (lifecycle !== "paused" && lifecycle !== "running") {
      return generationFault(context, "resume requires a paused session");
    }
    scheduler.resume();
    lifecycle = "running";
    return [state(context, "running")];
  }
  function stopSync(context) {
    cancelPendingRequest();
    const stopped = session.stop();
    scheduler.reset();
    clearInputState();
    activeMenuSnapshot = void 0;
    devkitFlags = 0;
    if (!stopped.ok)
      return [fault(context, stopped.error)];
    lifecycle = "stopped";
    resetAudioQueue(context.sessionGeneration);
    return [state(context, "stopped")];
  }
  function current(context, action) {
    return context.sessionGeneration !== sessionGeneration || sessionGeneration === 0 ? generationFault(context, "operation belongs to a stale or missing session") : action();
  }
  function replaceSession(context, action, prepareSeeds) {
    if (persistence === void 0)
      return action();
    return (async () => {
      if (context.sessionGeneration > sessionGeneration && lifecycle !== "disposed") {
        await flushPersistence();
        await prepareSeeds();
      }
      return perform(context, action);
    })();
  }
  function perform(context, action, flush = false) {
    if (persistence === void 0)
      return action();
    return (async () => {
      const events = action();
      if (flush || events.some((event) => event.type === "fault" || event.type === "runtime-control")) {
        await flushPersistence();
      }
      return [...takePersistenceEvents(context), ...events];
    })();
  }
  return {
    inspect(request) {
      if (!options.inspection)
        throw new Error("inspection is disabled for this session");
      if (!["ready", "paused"].includes(lifecycle) || pendingRequest !== void 0)
        throw new Error("inspection requires a paused frame boundary");
      return session.inspect(request);
    },
    snapshotLogs() {
      return session.snapshotLogs();
    },
    takeAudioEvents() {
      return session.takeAudioEvents();
    },
    input(generation, sequence, input) {
      acceptInput({ sessionGeneration: generation, sequence, input });
    },
    loadCart(context, load) {
      return replaceSession(context, () => loadCartSync(context, load), async () => {
        if (load.hostCartData === void 0) {
          hostPersistence = false;
          await hydratePersistence();
        }
      });
    },
    reset(context) {
      return replaceSession(context, () => resetSync(context), () => {
        if (!hostPersistence)
          return hydratePersistence();
      });
    },
    dispose(context) {
      const events = disposeSync(context);
      if (persistence === void 0)
        return events;
      return (async () => {
        try {
          await persistence.dispose();
        } catch (error) {
          recordPersistenceFailure("E_PERSISTENCE_WRITE", "Unable to dispose cartdata persistence cleanly", error);
        }
        return [...takePersistenceEvents(context), ...events];
      })();
    },
    start(context) {
      return perform(context, () => current(context, () => startSync(context)));
    },
    pause(context) {
      return perform(context, () => current(context, () => pauseSync(context)), true);
    },
    resume(context) {
      return perform(context, () => current(context, () => resumeSync(context)));
    },
    stop(context) {
      return perform(context, () => current(context, () => stopSync(context)), true);
    },
    openPauseMenu(context) {
      return perform(context, () => current(context, () => openPauseMenuSync(context)));
    },
    closePauseMenu(context) {
      return perform(context, () => current(context, () => closePauseMenuSync(context)));
    },
    invokeMenuItem(context, slot, button2) {
      return perform(context, () => current(context, () => invokeMenuItemSync({ ...context, slot, button: button2 })));
    },
    pulse(context, sequence, timestampMs) {
      return perform(context, () => current(context, () => handleTicks({ ...context, sequence }, () => scheduler.pulse(timestampMs))));
    },
    step(context, sequence) {
      return perform(context, () => current(context, () => handleTicks({ ...context, sequence }, () => ({ tickCount: 1, droppedTicks: 0, discontinuity: false }))));
    },
    flushPersistence(context) {
      if (persistence === void 0)
        return [
          ...takePersistenceEvents(context),
          { ...playerBase(context), type: "persistence-flushed", durable: hostPersistence }
        ];
      return flushPersistence().then((result) => [
        ...takePersistenceEvents(context),
        { ...playerBase(context), type: "persistence-flushed", ...result }
      ]);
    },
    async destroy() {
      releaseResources(sessionGeneration);
      try {
        await persistence?.dispose();
      } catch {
      }
    }
  };
}

// apps/web-player/dist/runtime/audio-transport.js
function assertUint32(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > 4294967295) {
    throw new RangeError(`${name} must be a uint32`);
  }
}
var PcmOutput = class {
  #port;
  #generation = -1;
  #nextSequence = 0;
  #nextFirstSample = 0n;
  #disposed = false;
  get sessionGeneration() {
    return this.#generation;
  }
  get attached() {
    return this.#port !== void 0;
  }
  attach(port, sessionGeneration) {
    this.#assertActive();
    assertUint32(sessionGeneration, "sessionGeneration");
    if (sessionGeneration < this.#generation) {
      port.close();
      return;
    }
    this.#port?.close();
    this.#port = port;
    port.start?.();
    if (sessionGeneration === this.#generation) {
      this.reset(this.#nextSequence, this.#nextFirstSample);
    } else {
      this.beginGeneration(sessionGeneration);
    }
  }
  beginGeneration(sessionGeneration, nextSequence = 0, firstSample = 0n) {
    this.#assertActive();
    assertUint32(sessionGeneration, "sessionGeneration");
    this.#generation = sessionGeneration;
    this.reset(nextSequence, firstSample);
  }
  reset(nextSequence = this.#nextSequence, firstSample = this.#nextFirstSample) {
    this.#assertActive();
    assertUint32(nextSequence, "nextSequence");
    if (firstSample < 0n)
      throw new RangeError("firstSample must be non-negative");
    this.#nextSequence = nextSequence;
    this.#nextFirstSample = firstSample;
    this.#port?.postMessage({
      v: AUDIO_PROTOCOL_VERSION,
      type: "audioReset",
      sessionGeneration: this.#generation,
      nextSequence,
      firstSample: firstSample.toString()
    }, []);
  }
  submit(slice) {
    this.#assertActive();
    const firstSample = BigInt(slice.firstSample);
    if (firstSample !== this.#nextFirstSample) {
      this.reset(this.#nextSequence, firstSample);
    }
    if (this.#port === void 0) {
      this.#nextSequence = this.#nextSequence + 1 >>> 0;
      this.#nextFirstSample = firstSample + BigInt(slice.frameCount);
      return;
    }
    this.send({
      sequence: this.#nextSequence,
      firstSample,
      frameCount: slice.frameCount,
      pcm16le: slice.pcm16le.slice().buffer
    });
  }
  send(chunk) {
    this.#assertActive();
    assertUint32(chunk.sequence, "sequence");
    if (chunk.firstSample < 0n)
      throw new RangeError("firstSample must be non-negative");
    if (!Number.isInteger(chunk.frameCount) || chunk.frameCount <= 0 || chunk.frameCount > 65536 || chunk.pcm16le.byteLength !== chunk.frameCount * 2) {
      throw new RangeError("PCM frameCount does not match the transferred buffer");
    }
    const message2 = {
      v: AUDIO_PROTOCOL_VERSION,
      type: "audioChunk",
      sessionGeneration: this.#generation,
      sequence: chunk.sequence,
      firstSample: chunk.firstSample.toString(),
      sampleRate: PICO_CANONICAL_SAMPLE_RATE,
      frameCount: chunk.frameCount,
      pcm16le: chunk.pcm16le
    };
    this.#nextSequence = chunk.sequence + 1 >>> 0;
    this.#nextFirstSample = chunk.firstSample + BigInt(chunk.frameCount);
    this.#port?.postMessage(message2, [chunk.pcm16le]);
  }
  dispose() {
    if (this.#disposed)
      return;
    this.#port?.close();
    this.#port = void 0;
    this.#generation = -1;
    this.#disposed = true;
  }
  #assertActive() {
    if (this.#disposed)
      throw new Error("PcmOutput is disposed");
  }
};

// apps/web-player/dist/runtime/player-session.js
function copyInput(input) {
  if (!isPicoInputSnapshot(input))
    throw new TypeError("invalid input snapshot");
  return { controllers: input.controllers.slice(), devkit: { ...input.devkit, keypresses: input.devkit.keypresses.slice() } };
}
var PlayerSession = class {
  #controller;
  #audio = new PcmOutput();
  #listeners = /* @__PURE__ */ new Set();
  #generations = /* @__PURE__ */ new Set();
  #cancel = /* @__PURE__ */ new Set();
  #tail = Promise.resolve();
  #generation = 0;
  #inputSequence = 0;
  #frameSequence = 0;
  #retained = false;
  #disposed = false;
  #disposal;
  constructor(module, options = {}) {
    this.#controller = createSessionController(module, { ...options, audioTransport: this.#audio });
  }
  inspect(request) {
    this.#assertActive();
    const generation = this.#generation;
    return this.#enqueue(() => {
      this.#assertActive();
      if (generation !== this.#generation)
        throw new Error("inspection session was replaced");
      return this.#controller.inspect(request);
    });
  }
  snapshotLogs() {
    this.#assertActive();
    return this.#controller.snapshotLogs();
  }
  takeAudioEvents() {
    this.#assertActive();
    return this.#controller.takeAudioEvents();
  }
  get sessionGeneration() {
    return this.#generation;
  }
  get hasRetainedCart() {
    return this.#retained;
  }
  onEvent(listener) {
    this.#assertActive();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  onSessionGenerationChange(listener) {
    this.#assertActive();
    this.#generations.add(listener);
    return () => this.#generations.delete(listener);
  }
  #advanceGeneration() {
    if (this.#generation >= 4294967295)
      throw new RangeError("session generation exhausted");
    for (const cancel of [...this.#cancel])
      cancel(new RuntimeClientError({
        code: "E_INVALID_STATE",
        message: "session operation was superseded by replacement",
        phase: "none",
        recoverable: true
      }));
    this.#generation++;
    this.#inputSequence = this.#frameSequence = 0;
    for (const listener of this.#generations)
      listener(this.#generation);
  }
  async loadCart(source, instructionBudget, bundle = [], host) {
    this.#assertActive();
    if (!isCartLoad(source, instructionBudget, bundle, host))
      throw new TypeError("invalid cart load arguments");
    const load = {
      source: source.slice(),
      localCartBundle: bundle.map((entry) => ({ ref: entry.ref, bytes: entry.bytes.slice(), access: { ...entry.access } })),
      ...host === void 0 ? {} : { hostCartData: host.map((entry) => ({ id: entry.id, bytes: entry.bytes.slice() })) },
      ...instructionBudget === void 0 ? {} : { instructionBudget }
    };
    this.#advanceGeneration();
    const event = await this.#invoke((context) => this.#controller.loadCart(context, load), "state");
    this.#retained = event.type === "state" && event.state === "ready";
    return event;
  }
  reset() {
    this.#assertActive();
    this.#advanceGeneration();
    return this.#invoke((context) => this.#controller.reset(context), "state");
  }
  start() {
    return this.#invoke((context) => this.#controller.start(context), "state");
  }
  pause() {
    this.clearInput();
    return this.#invoke((context) => this.#controller.pause(context), "state");
  }
  resume() {
    return this.#invoke((context) => this.#controller.resume(context), "state");
  }
  stop() {
    this.clearInput();
    return this.#invoke((context) => this.#controller.stop(context), "state");
  }
  openPauseMenu() {
    this.clearInput();
    return this.#invoke((context) => this.#controller.openPauseMenu(context), "pause-menu");
  }
  closePauseMenu() {
    this.clearInput();
    return this.#invoke((context) => this.#controller.closePauseMenu(context), "pause-menu");
  }
  invokeMenuItem(slot, button2) {
    if (!Number.isInteger(slot) || slot < 1 || slot > 5 || ![1, 2, 4].includes(button2)) {
      return Promise.reject(new TypeError("invalid menu item intent"));
    }
    return this.#invoke((context) => this.#controller.invokeMenuItem(context, slot, button2), "pause-menu");
  }
  flushPersistence() {
    return this.#invoke((context) => this.#controller.flushPersistence(context), "persistence-flushed");
  }
  pulse(timestampMs, input) {
    if (!Number.isFinite(timestampMs) || timestampMs < 0)
      return Promise.reject(new TypeError("invalid frame timestamp"));
    const sequence = ++this.#frameSequence;
    return this.#invoke((context) => this.#controller.pulse(context, sequence, timestampMs), "heartbeat", input);
  }
  step(input) {
    const sequence = ++this.#frameSequence;
    return this.#invoke((context) => this.#controller.step(context, sequence), "heartbeat", input);
  }
  clearInput() {
    if (this.#disposed || this.#generation === 0)
      return;
    const generation = this.#generation, sequence = ++this.#inputSequence;
    void this.#enqueue(() => this.#controller.input(generation, sequence, PICO_EMPTY_INPUT)).catch(() => void 0);
  }
  attachAudioPort(port) {
    this.#assertActive();
    this.#audio.attach(port, this.#generation);
  }
  dispose() {
    if (this.#disposal !== void 0)
      return this.#disposal;
    this.#disposed = true;
    for (const cancel of [...this.#cancel])
      cancel(new Error("PlayerSession is disposed"));
    this.#disposal = this.#enqueue(async () => {
      try {
        this.#emit(await this.#controller.dispose({ sessionGeneration: this.#generation, onResume: (events) => this.#emit(events) }));
      } catch (error) {
        await this.#controller.destroy();
        throw error;
      } finally {
        this.#controller = void 0;
        this.#audio.dispose();
        this.#listeners.clear();
        this.#generations.clear();
        this.#retained = false;
      }
    });
    return this.#disposal;
  }
  #enqueue(operation) {
    const pending = this.#tail.then(operation);
    this.#tail = pending.then(() => void 0, () => void 0);
    return pending;
  }
  #invoke(execute, terminal, input) {
    if (this.#disposed)
      return Promise.reject(new Error("PlayerSession is disposed"));
    if (this.#generation === 0)
      return Promise.reject(new TypeError("no cart session is loaded"));
    let snapshot;
    try {
      snapshot = input === void 0 ? void 0 : copyInput(input);
    } catch (error) {
      return Promise.reject(error);
    }
    const generation = this.#generation, inputSequence = ++this.#inputSequence;
    return new Promise((resolve, reject) => {
      let settled = false, handling = true;
      const background = [];
      const finish = (error, result) => {
        if (settled)
          return;
        settled = true;
        this.#cancel.delete(cancel);
        if (error !== void 0)
          reject(error);
        else
          resolve(result);
      };
      const cancel = (error) => finish(error);
      const accept = (events) => {
        this.#emit(events);
        for (const event of events) {
          if (event.type === "fault") {
            finish(new RuntimeClientError(event.error));
            return;
          }
          if (event.type === "state" && event.state === "waiting-host")
            continue;
          if (event.type === terminal || terminal === "heartbeat" && event.type === "state" && ["stopped", "ready", "running"].includes(event.state)) {
            finish(void 0, event);
            return;
          }
        }
      };
      const context = { sessionGeneration: generation, onResume(events) {
        if (handling)
          background.push(events);
        else
          accept(events);
      } };
      this.#cancel.add(cancel);
      void this.#enqueue(async () => {
        if (settled)
          return;
        try {
          if (snapshot !== void 0)
            this.#controller.input(generation, inputSequence, snapshot);
          accept(await execute(context));
        } finally {
          handling = false;
          for (const events of background.splice(0))
            accept(events);
        }
      }).catch(cancel);
    });
  }
  #emit(events) {
    for (const event of events) {
      if (event.type === "session-replaced" && event.previousSessionGeneration === this.#generation) {
        this.#generation = event.nextSessionGeneration;
        this.#inputSequence = this.#frameSequence = 0;
        for (const listener of this.#generations)
          listener(this.#generation);
      }
      if (event.sessionGeneration !== this.#generation)
        continue;
      for (const listener of [...this.#listeners])
        listener(event);
    }
  }
  #assertActive() {
    if (this.#disposed)
      throw new Error("PlayerSession is disposed");
  }
};

// apps/web-player/dist/runtime/adapters/indexeddb-persistence-adapter.js
var CART_DATA_DATABASE_NAME = "pico8-web-player";
var CART_DATA_DATABASE_VERSION = 1;
var CART_DATA_OBJECT_STORE = "cartdata";
var CART_DATA_NAMESPACE_INDEX = "namespace";
var CART_DATA_RECORD_SCHEMA_VERSION = 1;
var CART_DATA_MAX_HYDRATED_RECORDS = PICO_CART_DATA_MAX_RECORDS;
var CART_DATA_MAX_HYDRATED_BYTES = PICO_CART_DATA_MAX_RECORDS * PICO_CART_DATA_BYTES;
var CART_DATA_DEFAULT_DEBOUNCE_MS = 100;
var MAX_DIAGNOSTICS = 32;
var CART_DATA_ID_PATTERN2 = /^[a-z0-9_-]+$/u;
function errorMessage2(error) {
  if (error instanceof DOMException)
    return `${error.name}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
function validId2(id) {
  return typeof id === "string" && id.length >= 1 && id.length <= PICO_CART_DATA_ID_MAX_BYTES && CART_DATA_ID_PATTERN2.test(id);
}
function copyStoredBytes(value) {
  if (value instanceof ArrayBuffer) {
    return value.byteLength === PICO_CART_DATA_BYTES ? new Uint8Array(value.slice(0)) : void 0;
  }
  if (value instanceof Uint8Array && value.byteLength === PICO_CART_DATA_BYTES) {
    return value.slice();
  }
  return void 0;
}
function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed")), { once: true });
  });
}
function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("IndexedDB transaction aborted")), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("IndexedDB transaction failed")), { once: true });
  });
}
function storedRecord(namespace, id, bytes) {
  return {
    schemaVersion: CART_DATA_RECORD_SCHEMA_VERSION,
    namespace,
    id,
    bytes: bytes.slice().buffer
  };
}
var IndexedDbCartDataPersistenceAdapter = class {
  #factory;
  #databaseName;
  #namespace;
  #debounceMs;
  #pending = /* @__PURE__ */ new Map();
  #diagnostics = [];
  #databasePromise;
  #flushInFlight;
  #flushTimer;
  #disposed = false;
  constructor(options = {}) {
    const factory = options.factory ?? globalThis.indexedDB;
    if (factory === void 0)
      throw new Error("IndexedDB is unavailable in this Worker");
    const databaseName = options.databaseName ?? CART_DATA_DATABASE_NAME;
    const namespace = options.namespace ?? "default";
    const debounceMs = options.debounceMs ?? CART_DATA_DEFAULT_DEBOUNCE_MS;
    if (databaseName.length < 1 || databaseName.length > 128) {
      throw new RangeError("persistence database name must contain 1..128 characters");
    }
    if (namespace.length < 1 || namespace.length > 128 || namespace.includes("\0")) {
      throw new RangeError("persistence namespace must contain 1..128 non-NUL characters");
    }
    if (!Number.isFinite(debounceMs) || debounceMs < 0 || debounceMs > 6e4) {
      throw new RangeError("persistence debounce must be between 0 and 60000ms");
    }
    this.#factory = factory;
    this.#databaseName = databaseName;
    this.#namespace = namespace;
    this.#debounceMs = debounceMs;
  }
  async hydrate() {
    if (this.#disposed)
      return [];
    let records;
    try {
      const database = await this.#database();
      const transaction = database.transaction(CART_DATA_OBJECT_STORE, "readonly");
      const request = transaction.objectStore(CART_DATA_OBJECT_STORE).index(CART_DATA_NAMESPACE_INDEX).getAll(this.#namespace, CART_DATA_MAX_HYDRATED_RECORDS + 1);
      records = await requestResult(request);
      await transactionDone(transaction);
    } catch (error) {
      this.#readDiagnostic("Unable to hydrate cartdata; using an empty durable mirror", error);
      return this.#overlayPending([]);
    }
    if (records.length > CART_DATA_MAX_HYDRATED_RECORDS) {
      this.#readDiagnostic("Cartdata hydration exceeded the 4096-record limit");
      return this.#overlayPending([]);
    }
    const seeds = [];
    let hydratedBytes = 0;
    for (const value of records) {
      if (typeof value !== "object" || value === null) {
        this.#readDiagnostic("Skipped a malformed cartdata record");
        continue;
      }
      const record = value;
      if (record.namespace !== this.#namespace || !validId2(record.id)) {
        this.#readDiagnostic("Skipped a cartdata record with an invalid namespace or id");
        continue;
      }
      const schemaVersion = record.schemaVersion ?? 0;
      if (schemaVersion !== 0 && schemaVersion !== CART_DATA_RECORD_SCHEMA_VERSION) {
        this.#readDiagnostic("Skipped a cartdata record from an unsupported future schema", {
          id: record.id,
          schemaVersion: typeof schemaVersion === "number" ? schemaVersion : -1
        });
        continue;
      }
      const bytes = copyStoredBytes(record.bytes);
      if (bytes === void 0) {
        this.#readDiagnostic("Skipped a cartdata record without exactly 256 bytes", {
          id: record.id
        });
        continue;
      }
      hydratedBytes += bytes.byteLength;
      if (hydratedBytes > CART_DATA_MAX_HYDRATED_BYTES) {
        this.#readDiagnostic("Cartdata hydration exceeded the 1 MiB byte limit");
        return this.#overlayPending([]);
      }
      seeds.push(Object.freeze({ id: record.id, bytes: bytes.slice() }));
      if (schemaVersion === 0)
        this.#queueBytes(record.id, bytes);
    }
    return this.#overlayPending(seeds);
  }
  enqueue(commit) {
    if (this.#disposed)
      return;
    if (!validId2(commit.id) || !(commit.bytes instanceof Uint8Array) || commit.bytes.byteLength !== PICO_CART_DATA_BYTES) {
      this.#writeDiagnostic("Rejected a malformed committed cartdata snapshot");
      return;
    }
    this.#queueBytes(commit.id, commit.bytes);
  }
  flush() {
    this.#clearTimer();
    if (this.#disposed || this.#pending.size === 0) {
      return this.#flushInFlight ?? Promise.resolve({ durable: this.#pending.size === 0 });
    }
    if (this.#flushInFlight !== void 0)
      return this.#flushInFlight;
    const flush = this.#drainPending();
    this.#flushInFlight = flush.finally(() => {
      this.#flushInFlight = void 0;
    });
    return this.#flushInFlight;
  }
  takeDiagnostics() {
    return this.#diagnostics.splice(0);
  }
  async dispose() {
    if (this.#disposed)
      return;
    this.#clearTimer();
    await this.flush();
    this.#disposed = true;
    try {
      (await this.#databasePromise)?.close();
    } catch {
    }
    this.#databasePromise = void 0;
  }
  async #database() {
    if (this.#databasePromise !== void 0)
      return this.#databasePromise;
    const opening = new Promise((resolve, reject) => {
      const request = this.#factory.open(this.#databaseName, CART_DATA_DATABASE_VERSION);
      request.addEventListener("upgradeneeded", () => {
        const database = request.result;
        const store = database.objectStoreNames.contains(CART_DATA_OBJECT_STORE) ? request.transaction.objectStore(CART_DATA_OBJECT_STORE) : database.createObjectStore(CART_DATA_OBJECT_STORE, {
          keyPath: ["namespace", "id"]
        });
        if (!store.indexNames.contains(CART_DATA_NAMESPACE_INDEX)) {
          store.createIndex(CART_DATA_NAMESPACE_INDEX, "namespace", { unique: false });
        }
      });
      request.addEventListener("success", () => {
        const database = request.result;
        database.addEventListener("versionchange", () => database.close());
        resolve(database);
      }, { once: true });
      request.addEventListener("error", () => reject(request.error ?? new Error("Unable to open cartdata IndexedDB")), { once: true });
      request.addEventListener("blocked", () => reject(new Error("Cartdata IndexedDB upgrade was blocked")), { once: true });
    }).catch((error) => {
      this.#databasePromise = void 0;
      throw error;
    });
    this.#databasePromise = opening;
    return opening;
  }
  #overlayPending(seeds) {
    const merged = /* @__PURE__ */ new Map();
    for (const seed of seeds)
      merged.set(seed.id, seed.bytes.slice());
    for (const [id, bytes] of this.#pending)
      merged.set(id, bytes.slice());
    return Object.freeze(Array.from(merged, ([id, bytes]) => Object.freeze({ id, bytes: bytes.slice() })));
  }
  #queueBytes(id, bytes) {
    this.#pending.set(id, bytes.slice());
    if (this.#flushTimer !== void 0 || this.#debounceMs === 0) {
      if (this.#debounceMs === 0)
        void this.flush();
      return;
    }
    this.#flushTimer = globalThis.setTimeout(() => {
      this.#flushTimer = void 0;
      void this.flush();
    }, this.#debounceMs);
  }
  async #drainPending() {
    while (this.#pending.size > 0) {
      const batch = new Map(this.#pending);
      this.#pending.clear();
      try {
        const database = await this.#database();
        const transaction = database.transaction(CART_DATA_OBJECT_STORE, "readwrite");
        const store = transaction.objectStore(CART_DATA_OBJECT_STORE);
        for (const [id, bytes] of batch) {
          store.put(storedRecord(this.#namespace, id, bytes));
        }
        await transactionDone(transaction);
      } catch (error) {
        for (const [id, bytes] of batch) {
          if (!this.#pending.has(id))
            this.#pending.set(id, bytes);
        }
        this.#writeDiagnostic("Unable to durably write cartdata; the latest snapshot remains pending", error);
        return { durable: false, message: errorMessage2(error) };
      }
    }
    return { durable: true };
  }
  #clearTimer() {
    if (this.#flushTimer === void 0)
      return;
    globalThis.clearTimeout(this.#flushTimer);
    this.#flushTimer = void 0;
  }
  #readDiagnostic(message2, errorOrDetails) {
    this.#diagnostic("E_PERSISTENCE_READ", message2, errorOrDetails);
  }
  #writeDiagnostic(message2, errorOrDetails) {
    this.#diagnostic("E_PERSISTENCE_WRITE", message2, errorOrDetails);
  }
  #diagnostic(code, message2, errorOrDetails) {
    const details = typeof errorOrDetails === "object" && errorOrDetails !== null && !(errorOrDetails instanceof Error) && !(errorOrDetails instanceof DOMException) ? errorOrDetails : errorOrDetails === void 0 ? void 0 : { cause: errorMessage2(errorOrDetails) };
    if (this.#diagnostics.length >= MAX_DIAGNOSTICS)
      this.#diagnostics.shift();
    this.#diagnostics.push(Object.freeze({
      code,
      message: message2,
      phase: "none",
      recoverable: true,
      ...details === void 0 ? {} : { details }
    }));
  }
};

// apps/web-player/dist/runtime/create-session.js
async function createPlayerSession(persistent = true, inspection = false) {
  const { default: createModule } = await import("../wasm/z8lua-runtime-v1.mjs");
  const module = await createModule();
  return new PlayerSession(module, { inspection, ...persistent ? { persistence: new IndexedDbCartDataPersistenceAdapter() } : {} });
}

// apps/web-player/dist/main/audio-frontend.js
var DedicatedAudioFrontend = class _DedicatedAudioFrontend {
  #context;
  #node;
  #gain;
  #channelFactory;
  #outputGain;
  #waiters = /* @__PURE__ */ new Set();
  #lastStats;
  #muted = false;
  #disposed = false;
  constructor(context, node, gain, channelFactory, outputGain) {
    this.#context = context;
    this.#node = node;
    this.#gain = gain;
    this.#channelFactory = channelFactory;
    this.#outputGain = outputGain;
    node.port.onmessage = (event) => this.#receive(event.data);
  }
  static async create(target, workletModuleUrl, options = {}) {
    const contextFactory = options.contextFactory ?? ((contextOptions) => new AudioContext(contextOptions));
    const nodeFactory = options.nodeFactory ?? ((context2, name, nodeOptions) => new AudioWorkletNode(context2, name, nodeOptions));
    const channelFactory = options.channelFactory ?? (() => new MessageChannel());
    const context = contextFactory({
      latencyHint: "interactive",
      ...options.requestedSampleRate === void 0 ? {} : { sampleRate: options.requestedSampleRate }
    });
    try {
      if (options.startSuspended !== false && context.state === "running") {
        await context.suspend();
      }
      await context.audioWorklet.addModule(workletModuleUrl.toString());
      const node = nodeFactory(context, "pico8-audio-processor", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2]
      });
      const gain = context.createGain();
      const outputGain = options.outputGain ?? 1;
      gain.gain.value = outputGain;
      node.connect(gain).connect(context.destination);
      const frontend = new _DedicatedAudioFrontend(context, node, gain, channelFactory, outputGain);
      frontend.attach(target);
      return frontend;
    } catch (error) {
      await context.close();
      throw error;
    }
  }
  get contextState() {
    return this.#context.state;
  }
  get deviceSampleRate() {
    return this.#context.sampleRate;
  }
  get lastStats() {
    return this.#lastStats;
  }
  get muted() {
    return this.#muted;
  }
  attach(target) {
    this.#assertActive();
    const channel = this.#channelFactory();
    target.attachAudioPort(channel.port1);
    const envelope = {
      v: AUDIO_PROTOCOL_VERSION,
      type: "attachAudioPort",
      sessionGeneration: target.sessionGeneration,
      port: channel.port2
    };
    this.#node.port.postMessage(envelope, [channel.port2]);
  }
  resume() {
    this.#assertActive();
    return this.#context.resume();
  }
  suspend() {
    this.#assertActive();
    return this.#context.suspend();
  }
  setMuted(muted) {
    this.#assertActive();
    this.#muted = muted;
    this.#gain.gain.value = muted ? 0 : this.#outputGain;
  }
  requestStats(timeoutMs = 1e3) {
    this.#assertActive();
    const previous = this.#lastStats;
    const wait = this.waitForStats((stats) => stats !== previous, timeoutMs);
    this.#node.port.postMessage({ v: AUDIO_PROTOCOL_VERSION, type: "requestAudioStats" });
    return wait;
  }
  waitForStats(predicate, timeoutMs = 5e3) {
    this.#assertActive();
    if (this.#lastStats !== void 0 && predicate(this.#lastStats)) {
      return Promise.resolve(this.#lastStats);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: globalThis.setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(new Error("timed out waiting for AudioWorklet stats"));
        }, timeoutMs)
      };
      this.#waiters.add(waiter);
    });
  }
  async dispose() {
    if (this.#disposed)
      return;
    this.#disposed = true;
    this.#node.port.postMessage({ v: AUDIO_PROTOCOL_VERSION, type: "disposeAudio" });
    this.#node.port.onmessage = null;
    this.#node.disconnect();
    this.#gain.disconnect();
    for (const waiter of this.#waiters) {
      globalThis.clearTimeout(waiter.timer);
      waiter.reject(new Error("audio frontend disposed"));
    }
    this.#waiters.clear();
    await this.#context.close();
  }
  #receive(value) {
    if (!isAudioDeviceStatsMessage(value))
      return;
    this.#lastStats = value;
    for (const waiter of this.#waiters) {
      if (!waiter.predicate(value))
        continue;
      globalThis.clearTimeout(waiter.timer);
      this.#waiters.delete(waiter);
      waiter.resolve(value);
    }
  }
  #assertActive() {
    if (this.#disposed)
      throw new Error("DedicatedAudioFrontend is disposed");
  }
};

// apps/web-player/dist/runtime/pico-frame.js
var PICO_FRAME_WIDTH = 128;
var PICO_FRAME_HEIGHT = 128;
var PICO_PACKED_FRAME_BYTES = 8192;
var PICO_RGBA_FRAME_BYTES = PICO_FRAME_WIDTH * PICO_FRAME_HEIGHT * 4;
var PICO8_DEFAULT_PALETTE_RGBA = new Uint8ClampedArray([
  0,
  0,
  0,
  255,
  29,
  43,
  83,
  255,
  126,
  37,
  83,
  255,
  0,
  135,
  81,
  255,
  171,
  82,
  54,
  255,
  95,
  87,
  79,
  255,
  194,
  195,
  199,
  255,
  255,
  241,
  232,
  255,
  255,
  0,
  77,
  255,
  255,
  163,
  0,
  255,
  255,
  236,
  39,
  255,
  0,
  228,
  54,
  255,
  41,
  173,
  255,
  255,
  131,
  118,
  156,
  255,
  255,
  119,
  168,
  255,
  255,
  204,
  170,
  255
]);
var PICO8_DISPLAY_PALETTE_RGBA = new Uint8ClampedArray([
  ...PICO8_DEFAULT_PALETTE_RGBA,
  41,
  24,
  20,
  255,
  17,
  29,
  53,
  255,
  66,
  33,
  54,
  255,
  18,
  83,
  89,
  255,
  116,
  47,
  41,
  255,
  73,
  51,
  59,
  255,
  162,
  136,
  121,
  255,
  243,
  239,
  125,
  255,
  190,
  18,
  80,
  255,
  255,
  108,
  36,
  255,
  168,
  231,
  46,
  255,
  0,
  181,
  67,
  255,
  6,
  90,
  181,
  255,
  117,
  70,
  101,
  255,
  255,
  110,
  89,
  255,
  255,
  157,
  129,
  255
]);
function assertPackedScreen(source) {
  if (source.byteLength !== PICO_PACKED_FRAME_BYTES) {
    throw new RangeError(`packed PICO frame must contain ${PICO_PACKED_FRAME_BYTES} bytes`);
  }
}
function decodePackedPicoFrame(source, target, palette = PICO8_DISPLAY_PALETTE_RGBA, displayPalette) {
  assertPackedScreen(source);
  if (target.byteLength !== PICO_RGBA_FRAME_BYTES) {
    throw new RangeError(`RGBA target must contain ${PICO_RGBA_FRAME_BYTES} bytes`);
  }
  if (palette.byteLength !== 16 * 4 && palette.byteLength !== 32 * 4) {
    throw new RangeError("PICO palette must contain 16 or 32 RGBA entries");
  }
  if (displayPalette !== void 0 && displayPalette.byteLength !== 16) {
    throw new RangeError("display palette must contain 16 entries");
  }
  for (let color = 0; color < 16; color += 1) {
    const offset = displayPaletteOffset(color, displayPalette);
    if (offset + 3 >= palette.byteLength) {
      throw new RangeError("display palette references an unavailable extended colour");
    }
  }
  let targetOffset = 0;
  for (const packed of source) {
    const left = displayPaletteOffset(packed & 15, displayPalette);
    target[targetOffset] = palette[left];
    target[targetOffset + 1] = palette[left + 1];
    target[targetOffset + 2] = palette[left + 2];
    target[targetOffset + 3] = palette[left + 3];
    const right = displayPaletteOffset(packed >>> 4, displayPalette);
    target[targetOffset + 4] = palette[right];
    target[targetOffset + 5] = palette[right + 1];
    target[targetOffset + 6] = palette[right + 2];
    target[targetOffset + 7] = palette[right + 3];
    targetOffset += 8;
  }
}
function displayPaletteOffset(color, displayPalette) {
  const mapped = displayPalette?.[color] ?? color;
  const index = (mapped & 128) !== 0 ? 16 + (mapped & 15) : mapped & 15;
  return index * 4;
}

// apps/web-player/dist/main/render/canvas2d-frame-presenter.js
function isGeneration(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 4294967295;
}
var Canvas2DFramePresenter = class {
  #canvas;
  #context;
  #imageData;
  #generation = -1;
  #lastFrameId = -1;
  #disposed = false;
  constructor(canvas) {
    canvas.width = PICO_FRAME_WIDTH;
    canvas.height = PICO_FRAME_HEIGHT;
    const classList = canvas.classList;
    if (classList?.contains("pico8-player__canvas") !== true) {
      canvas.style.display = "block";
      canvas.style.imageRendering = "pixelated";
    }
    const context = canvas.getContext("2d", {
      alpha: false,
      desynchronized: true
    });
    if (context === null)
      throw new Error("Canvas2D is unavailable");
    context.imageSmoothingEnabled = false;
    this.#canvas = canvas;
    this.#context = context;
    this.#imageData = context.createImageData(PICO_FRAME_WIDTH, PICO_FRAME_HEIGHT);
  }
  get sessionGeneration() {
    return this.#generation;
  }
  get lastFrameId() {
    return this.#lastFrameId;
  }
  reset(sessionGeneration) {
    this.#assertActive();
    if (!isGeneration(sessionGeneration)) {
      throw new RangeError("sessionGeneration must be a uint32");
    }
    this.#generation = sessionGeneration;
    this.#lastFrameId = -1;
    this.#context.imageSmoothingEnabled = false;
    this.#context.clearRect(0, 0, PICO_FRAME_WIDTH, PICO_FRAME_HEIGHT);
  }
  resize(availableWidthCssPixels, availableHeightCssPixels) {
    this.#assertActive();
    if (!Number.isFinite(availableWidthCssPixels) || availableWidthCssPixels <= 0 || !Number.isFinite(availableHeightCssPixels) || availableHeightCssPixels <= 0) {
      throw new RangeError("presenter dimensions must be positive finite numbers");
    }
    const side = Math.min(availableWidthCssPixels, availableHeightCssPixels);
    this.#canvas.style.width = `${side}px`;
    this.#canvas.style.height = `${side}px`;
    return { widthCssPixels: side, heightCssPixels: side };
  }
  present(frame) {
    this.#assertActive();
    if (frame.sessionGeneration !== this.#generation)
      return false;
    if (!Number.isSafeInteger(frame.frameId) || frame.frameId < 0) {
      throw new RangeError("frameId must be a non-negative safe integer");
    }
    if (frame.frameId <= this.#lastFrameId)
      return false;
    decodePackedPicoFrame(frame.packedScreen, this.#imageData.data, void 0, frame.displayPalette);
    this.#context.imageSmoothingEnabled = false;
    this.#context.putImageData(this.#imageData, 0, 0);
    this.#lastFrameId = frame.frameId;
    return true;
  }
  dispose() {
    if (this.#disposed)
      return;
    this.#context.clearRect(0, 0, PICO_FRAME_WIDTH, PICO_FRAME_HEIGHT);
    this.#generation = -1;
    this.#lastFrameId = -1;
    this.#disposed = true;
  }
  #assertActive() {
    if (this.#disposed)
      throw new Error("Canvas2DFramePresenter is disposed");
  }
};

// apps/web-player/dist/main/worker-client.js
function clientError(code, message2, recoverable, details) {
  return new RuntimeClientError({
    code,
    message: message2,
    phase: "none",
    recoverable,
    ...details === void 0 ? {} : { details }
  });
}
var PlayerRuntimeClient = class {
  #factory;
  #timeoutMs;
  #pending = /* @__PURE__ */ new Map();
  #eventListeners = /* @__PURE__ */ new Set();
  #sessionListeners = /* @__PURE__ */ new Set();
  #worker;
  #workerGeneration = 0;
  #sessionGeneration = 0;
  #nextRequestId = 1;
  #inputSequence = 0;
  #vsyncSequence = 0;
  #lastCartBytes;
  #lastLocalCartBundle = [];
  #lastHostCartData;
  #hasWorkerSession = false;
  #disposed = false;
  constructor(factory, options = {}) {
    const timeoutMs = options.commandTimeoutMs ?? 1e3;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("commandTimeoutMs must be positive");
    }
    this.#factory = factory;
    this.#timeoutMs = timeoutMs;
    this.#spawn();
  }
  get workerGeneration() {
    return this.#workerGeneration;
  }
  get sessionGeneration() {
    return this.#sessionGeneration;
  }
  get hasRetainedCart() {
    return this.#lastCartBytes !== void 0;
  }
  onEvent(listener) {
    this.#assertActive();
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }
  onSessionGenerationChange(listener) {
    this.#assertActive();
    this.#sessionListeners.add(listener);
    return () => this.#sessionListeners.delete(listener);
  }
  async loadCart(source, instructionBudget, localCartBundle = [], hostCartData) {
    this.#assertActive();
    if (!(source instanceof Uint8Array)) {
      throw new TypeError("cart source must be a Uint8Array");
    }
    if (source.byteLength === 0 || source.byteLength > PICO_CART_INPUT_MAX_BYTES) {
      throw new RangeError("cart source must contain at most 1 MiB");
    }
    this.#lastCartBytes = source.slice();
    this.#lastLocalCartBundle = this.#copyLocalCartBundle(localCartBundle);
    this.#lastHostCartData = hostCartData === void 0 ? void 0 : this.#copyHostCartData(hostCartData);
    this.#advanceSession();
    const cartBytes = this.#lastCartBytes.slice().buffer;
    const bundle = this.#bundleForTransfer();
    const host = this.#hostCartDataForTransfer();
    const event = await this.#send({
      type: "loadCart",
      cartBytes,
      localCartBundle: bundle.entries,
      ...host === void 0 ? {} : { hostCartData: host.entries },
      ...instructionBudget === void 0 ? {} : { instructionBudget }
    }, "state", [cartBytes, ...bundle.transfers, ...host?.transfers ?? []]);
    this.#hasWorkerSession = event.type === "state" && event.state === "ready";
    return event;
  }
  async reset() {
    this.#assertActive();
    const retained = this.#lastCartBytes;
    if (retained === void 0) {
      throw clientError("E_INVALID_STATE", "no cart is available to reset", false);
    }
    this.#advanceSession();
    if (!this.#hasWorkerSession) {
      const cartBytes = retained.slice().buffer;
      const bundle = this.#bundleForTransfer();
      const host = this.#hostCartDataForTransfer();
      const event2 = await this.#send({
        type: "loadCart",
        cartBytes,
        localCartBundle: bundle.entries,
        ...host === void 0 ? {} : { hostCartData: host.entries }
      }, "state", [cartBytes, ...bundle.transfers, ...host?.transfers ?? []]);
      this.#hasWorkerSession = event2.type === "state" && event2.state === "ready";
      return event2;
    }
    const event = await this.#send({ type: "reset" }, "state");
    this.#hasWorkerSession = event.type === "state" && event.state === "ready";
    return event;
  }
  start() {
    return this.#send({ type: "start" }, "state");
  }
  pause() {
    this.clearInput();
    return this.#send({ type: "pause" }, "state");
  }
  openPauseMenu() {
    this.clearInput();
    return this.#send({ type: "openPauseMenu" }, "pause-menu");
  }
  closePauseMenu() {
    this.clearInput();
    return this.#send({ type: "closePauseMenu" }, "pause-menu");
  }
  invokeMenuItem(slot, button2) {
    return this.#send({ type: "invokeMenuItem", slot, button: button2 }, "pause-menu");
  }
  resume() {
    return this.#send({ type: "resume" }, "state");
  }
  stop() {
    this.clearInput();
    return this.#send({ type: "stop" }, "state");
  }
  pulse(timestampMs, input) {
    this.#assertActive();
    this.#postInput(input);
    const sequence = ++this.#vsyncSequence;
    return this.#send({ type: "vsync", sequence, timestampMs }, "heartbeat");
  }
  step(input) {
    this.#assertActive();
    this.#postInput(input);
    return this.#send({ type: "step", sequence: ++this.#vsyncSequence }, "heartbeat");
  }
  clearInput() {
    if (this.#disposed || this.#sessionGeneration === 0)
      return;
    this.#postInput(PICO_EMPTY_INPUT);
  }
  flushPersistence() {
    return this.#send({ type: "flushPersistence" }, "persistence-flushed");
  }
  attachAudioPort(port) {
    this.#assertActive();
    this.#worker.postMessage({
      v: 1,
      type: "attachAudioPort",
      sessionGeneration: this.#sessionGeneration,
      port
    }, [port]);
  }
  async dispose() {
    if (this.#disposed)
      return;
    this.clearInput();
    try {
      await this.#send({ type: "dispose" }, "state");
    } finally {
      this.#disposed = true;
      this.#worker.terminate();
      for (const pending of this.#pending.values()) {
        globalThis.clearTimeout(pending.timer);
      }
      this.#pending.clear();
      this.#eventListeners.clear();
      this.#sessionListeners.clear();
      this.#lastCartBytes = void 0;
      this.#lastLocalCartBundle = [];
      this.#lastHostCartData = void 0;
    }
  }
  #advanceSession() {
    if (this.#sessionGeneration >= 4294967295) {
      throw clientError("E_INVARIANT", "session generation space is exhausted", false);
    }
    const previousSessionGeneration = this.#sessionGeneration;
    this.#sessionGeneration += 1;
    this.#inputSequence = 0;
    this.#vsyncSequence = 0;
    const superseded = clientError("E_INVALID_STATE", "runtime command was superseded by a new session generation", true, {
      previousSessionGeneration,
      nextSessionGeneration: this.#sessionGeneration
    });
    for (const [requestId, pending] of this.#pending) {
      if (pending.sessionGeneration !== previousSessionGeneration)
        continue;
      globalThis.clearTimeout(pending.timer);
      this.#pending.delete(requestId);
      pending.reject(superseded);
    }
    for (const listener of this.#sessionListeners)
      listener(this.#sessionGeneration);
  }
  #postInput(input) {
    const devkit = input.devkit;
    const isInt322 = (value) => Number.isInteger(value) && Number(value) >= -2147483648 && Number(value) <= 2147483647;
    if (!Array.isArray(input.controllers) || input.controllers.length !== PICO_CONTROLLER_COUNT || input.controllers.some((buttons) => !Number.isSafeInteger(buttons) || buttons < 0 || buttons > PICO_CONTROLLER_BUTTON_MASK) || typeof devkit !== "object" || devkit === null || !isInt322(devkit.mouseXRaw) || !isInt322(devkit.mouseYRaw) || !Number.isInteger(devkit.mouseButtons) || devkit.mouseButtons < 0 || devkit.mouseButtons > 7 || !isInt322(devkit.wheelRaw) || !isInt322(devkit.movementXRaw) || !isInt322(devkit.movementYRaw) || !Array.isArray(devkit.keypresses) || devkit.keypresses.length > PICO_DEVKIT_KEYPRESS_BATCH_LIMIT || devkit.keypresses.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
      throw new RangeError("input must contain a fixed controller snapshot and devkit batch");
    }
    this.#worker.postMessage({
      v: 1,
      type: "input",
      requestId: 0,
      workerGeneration: this.#workerGeneration,
      sessionGeneration: this.#sessionGeneration,
      sequence: ++this.#inputSequence,
      input: {
        controllers: input.controllers.slice(),
        devkit: {
          mouseXRaw: devkit.mouseXRaw,
          mouseYRaw: devkit.mouseYRaw,
          mouseButtons: devkit.mouseButtons,
          wheelRaw: devkit.wheelRaw,
          movementXRaw: devkit.movementXRaw,
          movementYRaw: devkit.movementYRaw,
          keypresses: devkit.keypresses.slice()
        }
      }
    });
  }
  #spawn() {
    if (this.#workerGeneration >= 4294967295) {
      throw clientError("E_INVARIANT", "Worker generation space is exhausted", false);
    }
    this.#workerGeneration += 1;
    const generation = this.#workerGeneration;
    const worker = this.#factory();
    worker.addEventListener("message", (event) => this.#receive(event.data, generation));
    this.#worker = worker;
  }
  #receive(value, sourceWorkerGeneration) {
    if (!isPlayerRuntimeToHost(value))
      return;
    if (sourceWorkerGeneration === this.#workerGeneration && value.workerGeneration === this.#workerGeneration && value.type === "session-replaced") {
      this.#acceptSessionReplacement(value);
      return;
    }
    if (sourceWorkerGeneration !== this.#workerGeneration || value.workerGeneration !== this.#workerGeneration || value.sessionGeneration !== this.#sessionGeneration)
      return;
    if (value.type === "cartdata-commit" && this.#lastHostCartData !== void 0) {
      const records = new Map(this.#lastHostCartData.map((record) => [record.id, record.bytes]));
      records.set(value.id, new Uint8Array(value.bytes).slice());
      this.#lastHostCartData = Array.from(records, ([id, bytes]) => ({
        id,
        bytes: bytes.slice()
      }));
    }
    for (const listener of this.#eventListeners)
      listener(value);
    const pending = this.#pending.get(value.requestId);
    if (pending === void 0 || pending.workerGeneration !== value.workerGeneration || pending.sessionGeneration !== value.sessionGeneration)
      return;
    if (value.type === "fault") {
      globalThis.clearTimeout(pending.timer);
      this.#pending.delete(value.requestId);
      this.#hasWorkerSession = false;
      pending.reject(new RuntimeClientError(value.error));
      return;
    }
    if (value.type === "state" && value.state === "waiting-host")
      return;
    if (value.type !== pending.terminalType)
      return;
    globalThis.clearTimeout(pending.timer);
    this.#pending.delete(value.requestId);
    pending.resolve(value);
  }
  #acceptSessionReplacement(event) {
    const previous = this.#sessionGeneration;
    if (event.previousSessionGeneration !== previous || event.nextSessionGeneration !== previous + 1 || event.sessionGeneration !== event.nextSessionGeneration)
      return;
    const target = this.#lastLocalCartBundle.find((entry) => entry.ref === event.cartRef);
    if (target === void 0)
      return;
    const preserved = this.#pending.get(event.requestId);
    this.#sessionGeneration = event.nextSessionGeneration;
    this.#inputSequence = 0;
    this.#vsyncSequence = 0;
    this.#lastCartBytes = target.bytes.slice();
    this.#hasWorkerSession = true;
    const superseded = clientError("E_INVALID_STATE", "runtime command was superseded by guest load()", true, { previousSessionGeneration: previous, nextSessionGeneration: this.#sessionGeneration });
    for (const [requestId, pending] of this.#pending) {
      if (pending.sessionGeneration !== previous)
        continue;
      if (pending === preserved && pending.terminalType === "state") {
        pending.sessionGeneration = this.#sessionGeneration;
        continue;
      }
      globalThis.clearTimeout(pending.timer);
      this.#pending.delete(requestId);
      pending.reject(superseded);
    }
    for (const listener of this.#sessionListeners)
      listener(this.#sessionGeneration);
    for (const listener of this.#eventListeners)
      listener(event);
  }
  #copyLocalCartBundle(entries) {
    if (!Array.isArray(entries))
      throw new TypeError("local cart bundle must be an array");
    if (entries.length > PICO_LOCAL_CART_BUNDLE_MAX_ENTRIES) {
      throw new RangeError("local cart bundle exceeds 64 entries");
    }
    const refs = /* @__PURE__ */ new Set();
    return entries.map((entry) => {
      if (typeof entry?.ref !== "string" || !(entry.bytes instanceof Uint8Array)) {
        throw new TypeError("local cart bundle entries require ref and Uint8Array bytes");
      }
      let refBytes = 0;
      for (let index = 0; index < entry.ref.length; index += 1) {
        const unit = entry.ref.charCodeAt(index);
        if (unit <= 127)
          refBytes += 1;
        else if (unit <= 2047)
          refBytes += 2;
        else if (unit >= 55296 && unit <= 56319 && index + 1 < entry.ref.length && entry.ref.charCodeAt(index + 1) >= 56320 && entry.ref.charCodeAt(index + 1) <= 57343) {
          refBytes += 4;
          index += 1;
        } else
          refBytes += 3;
      }
      if (entry.ref.length === 0 || entry.ref.includes("\0") || refBytes > PICO_CART_REF_MAX_BYTES || entry.ref.startsWith("/") || entry.ref.startsWith("#") || entry.ref.includes("://") || entry.ref.includes("\\") || entry.ref.split("/").some((part) => part === "" || part === "." || part === "..") || refs.has(entry.ref)) {
        throw new RangeError("local cart bundle ref is not canonical or is duplicated");
      }
      if (entry.bytes.byteLength === 0 || entry.bytes.byteLength > PICO_CART_INPUT_MAX_BYTES) {
        throw new RangeError("local cart bundle bytes must contain at most 1 MiB");
      }
      refs.add(entry.ref);
      const access = entry.access;
      if (access === null || typeof access !== "object" || typeof access.load !== "boolean" || typeof access.reloadData !== "boolean" || typeof access.cstoreData !== "boolean" || typeof access.include !== "boolean") {
        throw new TypeError("local cart bundle entries require explicit access capabilities");
      }
      return Object.freeze({
        ref: entry.ref,
        bytes: entry.bytes.slice(),
        access: Object.freeze({ ...access })
      });
    });
  }
  #bundleForTransfer() {
    const transfers = [];
    const entries = this.#lastLocalCartBundle.map((entry) => {
      const cartBytes = entry.bytes.slice().buffer;
      transfers.push(cartBytes);
      return { ref: entry.ref, cartBytes, access: { ...entry.access } };
    });
    return { entries, transfers };
  }
  #copyHostCartData(entries) {
    if (!Array.isArray(entries) || entries.length > PICO_CART_DATA_MAX_RECORDS) {
      throw new RangeError("host cartdata exceeds 4096 records");
    }
    const ids = /* @__PURE__ */ new Set();
    return entries.map((entry) => {
      if (typeof entry?.id !== "string" || !/^[a-z0-9_-]+$/u.test(entry.id) || entry.id.length > PICO_CART_DATA_ID_MAX_BYTES || ids.has(entry.id) || !(entry.bytes instanceof Uint8Array) || entry.bytes.byteLength !== PICO_CART_DATA_BYTES) {
        throw new RangeError("host cartdata contains an invalid record");
      }
      ids.add(entry.id);
      return { id: entry.id, bytes: entry.bytes.slice() };
    });
  }
  #hostCartDataForTransfer() {
    if (this.#lastHostCartData === void 0)
      return void 0;
    const transfers = [];
    const entries = this.#lastHostCartData.map((entry) => {
      const bytes = entry.bytes.slice().buffer;
      transfers.push(bytes);
      return { id: entry.id, bytes };
    });
    return { entries, transfers };
  }
  #send(command, terminalType, transfer = []) {
    if (this.#disposed) {
      return Promise.reject(clientError("E_INVALID_STATE", "runtime client is disposed", false));
    }
    const requestId = this.#nextRequestId++;
    const workerGeneration = this.#workerGeneration;
    const sessionGeneration = this.#sessionGeneration;
    const envelope = {
      ...command,
      v: 1,
      requestId,
      workerGeneration,
      sessionGeneration
    };
    return new Promise((resolve, reject) => {
      const timer = globalThis.setTimeout(() => this.#watchdog(requestId, workerGeneration), this.#timeoutMs);
      this.#pending.set(requestId, {
        workerGeneration,
        sessionGeneration,
        terminalType,
        timer,
        resolve,
        reject
      });
      this.#worker.postMessage(envelope, transfer);
    });
  }
  #watchdog(requestId, workerGeneration) {
    const timedOut = this.#pending.get(requestId);
    if (timedOut === void 0 || timedOut.workerGeneration !== workerGeneration)
      return;
    const error = clientError("E_VM_WATCHDOG", "Runtime Worker did not respond before the command deadline", true, { workerGeneration, sessionGeneration: timedOut.sessionGeneration });
    this.#worker.terminate();
    for (const [id, pending] of this.#pending) {
      if (pending.workerGeneration !== workerGeneration)
        continue;
      globalThis.clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.reject(error);
    }
    this.#hasWorkerSession = false;
    if (!this.#disposed)
      this.#spawn();
  }
  #assertActive() {
    if (this.#disposed)
      throw new Error("PlayerRuntimeClient is disposed");
  }
};

// apps/web-player/dist/main/gamepad-input.js
var AXIS_PRESS_THRESHOLD = 0.5;
var AXIS_RELEASE_THRESHOLD = 0.35;
function pressed(gamepad, index) {
  const button2 = gamepad.buttons[index];
  return button2 !== void 0 && (button2.pressed || button2.value >= 0.5);
}
function latchAxisPair(current, value, negativeBit, positiveBit) {
  let next = current;
  if ((next & negativeBit) !== 0) {
    if (value > -AXIS_RELEASE_THRESHOLD)
      next &= ~negativeBit;
  } else if (value <= -AXIS_PRESS_THRESHOLD) {
    next = next & ~positiveBit | negativeBit;
  }
  if ((next & positiveBit) !== 0) {
    if (value < AXIS_RELEASE_THRESHOLD)
      next &= ~positiveBit;
  } else if (value >= AXIS_PRESS_THRESHOLD) {
    next = next & ~negativeBit | positiveBit;
  }
  return next;
}
var GamepadInputFrontend = class {
  #source;
  #axisMasks = new Uint8Array(PICO_CONTROLLER_COUNT);
  #controllers = new Uint8Array(PICO_CONTROLLER_COUNT);
  #enabled = false;
  #disposed = false;
  constructor(options = {}) {
    this.#source = options.source ?? navigator;
  }
  snapshot() {
    this.#assertActive();
    this.#controllers.fill(0);
    if (!this.#enabled)
      return { controllers: Array.from(this.#controllers) };
    const connected = new Uint8Array(PICO_CONTROLLER_COUNT);
    for (const gamepad of this.#source.getGamepads()) {
      if (gamepad === null || gamepad.connected === false || gamepad.mapping !== "standard" || !Number.isInteger(gamepad.index) || gamepad.index < 0 || gamepad.index >= PICO_CONTROLLER_COUNT)
        continue;
      const player = gamepad.index;
      connected[player] = 1;
      let mask = this.#axisMasks[player];
      mask = latchAxisPair(mask, gamepad.axes[0] ?? 0, 1 << 0, 1 << 1);
      mask = latchAxisPair(mask, gamepad.axes[1] ?? 0, 1 << 2, 1 << 3);
      this.#axisMasks[player] = mask;
      if (pressed(gamepad, 14))
        mask |= 1 << 0;
      if (pressed(gamepad, 15))
        mask |= 1 << 1;
      if (pressed(gamepad, 12))
        mask |= 1 << 2;
      if (pressed(gamepad, 13))
        mask |= 1 << 3;
      if (pressed(gamepad, 0))
        mask |= 1 << 4;
      if (pressed(gamepad, 1))
        mask |= 1 << 5;
      this.#controllers[player] = mask;
    }
    for (let player = 0; player < PICO_CONTROLLER_COUNT; player += 1) {
      if (connected[player] === 0)
        this.#axisMasks[player] = 0;
    }
    return { controllers: Array.from(this.#controllers) };
  }
  setEnabled(enabled) {
    this.#assertActive();
    this.#enabled = enabled;
    if (!enabled)
      this.clear();
  }
  clear() {
    if (this.#disposed)
      return;
    this.#axisMasks.fill(0);
    this.#controllers.fill(0);
  }
  dispose() {
    if (this.#disposed)
      return;
    this.clear();
    this.#disposed = true;
  }
  #assertActive() {
    if (this.#disposed)
      throw new Error("GamepadInputFrontend is disposed");
  }
};

// apps/web-player/dist/main/devkit-input.js
var DEVKIT_ENABLE2 = 1;
var DEVKIT_POINTER_LOCK = 4;
var Q16_ONE2 = 65536;
var LOGICAL_MAX = 127;
var CONTROL_KEYS = /* @__PURE__ */ new Map([
  ["Backspace", 8],
  ["Tab", 9],
  ["Enter", 13],
  ["Escape", 27],
  ["Delete", 127]
]);
function saturatingAddInt322(left, right) {
  const result = left + right;
  return Math.max(-2147483648, Math.min(2147483647, result)) | 0;
}
function eventDeltaRaw(value) {
  if (!Number.isFinite(value))
    return 0;
  return Math.max(-2147483648, Math.min(2147483647, Math.trunc(value * Q16_ONE2))) | 0;
}
function keyByte(event) {
  const control = CONTROL_KEYS.get(event.key);
  if (control !== void 0)
    return control;
  if (event.key.length !== 1)
    return void 0;
  const byte = event.key.charCodeAt(0);
  return byte <= 255 ? byte : void 0;
}
var DevkitInputFrontend = class {
  #canvas;
  #window;
  #document;
  #keypresses = [];
  #removeListeners = [];
  #enabled = false;
  #flags = 0;
  #mouseXRaw = 0;
  #mouseYRaw = 0;
  #mouseButtons = 0;
  #wheelRaw = 0;
  #movementXRaw = 0;
  #movementYRaw = 0;
  #disposed = false;
  constructor(canvas, options = {}) {
    this.#canvas = canvas;
    this.#window = options.window ?? window;
    this.#document = options.document ?? document;
    this.#bind(canvas, "pointermove", this.#onPointerMove);
    this.#bind(canvas, "pointerdown", this.#onPointerDown);
    this.#bind(this.#window, "pointerup", this.#onPointerUp);
    this.#bind(canvas, "wheel", this.#onWheel, { passive: false });
    this.#bind(canvas, "contextmenu", this.#onContextMenu);
    this.#bind(this.#window, "keydown", this.#onKeyDown);
    this.#bind(this.#window, "blur", this.#onBlur);
    this.#bind(this.#document, "visibilitychange", this.#onVisibilityChange);
    this.#bind(this.#document, "pointerlockchange", this.#onPointerLockChange);
    this.#bind(this.#document, "pointerlockerror", this.#onPointerLockError);
  }
  get flags() {
    return this.#flags;
  }
  setFlags(flags) {
    this.#assertActive();
    this.#flags = flags & 7;
    if ((this.#flags & DEVKIT_ENABLE2) === 0)
      this.clear();
    if ((this.#flags & DEVKIT_POINTER_LOCK) === 0)
      this.#exitPointerLock();
  }
  setEnabled(enabled) {
    this.#assertActive();
    this.#enabled = enabled;
    if (!enabled)
      this.clear();
  }
  peekBatch() {
    this.#assertActive();
    return this.#batch();
  }
  takeBatch() {
    this.#assertActive();
    const batch = this.#batch();
    this.#wheelRaw = 0;
    this.#movementXRaw = 0;
    this.#movementYRaw = 0;
    this.#keypresses.length = 0;
    return batch;
  }
  clear() {
    if (this.#disposed)
      return;
    this.#mouseButtons = 0;
    this.#wheelRaw = 0;
    this.#movementXRaw = 0;
    this.#movementYRaw = 0;
    this.#keypresses.length = 0;
    this.#exitPointerLock();
  }
  reset() {
    if (this.#disposed)
      return;
    this.#flags = 0;
    this.clear();
  }
  dispose() {
    if (this.#disposed)
      return;
    this.reset();
    this.#disposed = true;
    for (const remove of this.#removeListeners.splice(0))
      remove();
  }
  #batch() {
    return {
      mouseXRaw: this.#mouseXRaw,
      mouseYRaw: this.#mouseYRaw,
      mouseButtons: this.#mouseButtons,
      wheelRaw: this.#wheelRaw,
      movementXRaw: this.#movementXRaw,
      movementYRaw: this.#movementYRaw,
      keypresses: this.#keypresses.slice()
    };
  }
  #onPointerMove = (event) => {
    if (!this.#acceptsPointerInput())
      return;
    const pointer = event;
    const rect = this.#canvas.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      const x = Math.floor((pointer.clientX - rect.left) * 128 / rect.width);
      const y = Math.floor((pointer.clientY - rect.top) * 128 / rect.height);
      this.#mouseXRaw = Math.max(0, Math.min(LOGICAL_MAX, x)) * Q16_ONE2;
      this.#mouseYRaw = Math.max(0, Math.min(LOGICAL_MAX, y)) * Q16_ONE2;
    }
    if ((this.#flags & DEVKIT_POINTER_LOCK) !== 0 && this.#document.pointerLockElement === this.#canvas) {
      this.#movementXRaw = saturatingAddInt322(this.#movementXRaw, eventDeltaRaw(pointer.movementX));
      this.#movementYRaw = saturatingAddInt322(this.#movementYRaw, eventDeltaRaw(pointer.movementY));
    }
  };
  #onPointerDown = (event) => {
    if (!this.#acceptsPointerInput())
      return;
    const pointer = event;
    this.#canvas.focus();
    this.#mouseButtons = pointer.buttons & 7;
    if (pointer.button === 0 && (this.#flags & DEVKIT_POINTER_LOCK) !== 0) {
      const pending = this.#canvas.requestPointerLock();
      if (pending !== void 0)
        void pending.catch(() => this.clear());
    }
  };
  #onPointerUp = (event) => {
    if (!this.#enabled)
      return;
    this.#mouseButtons = event.buttons & 7;
  };
  #onWheel = (event) => {
    if (!this.#acceptsPointerInput())
      return;
    const wheel = event;
    wheel.preventDefault();
    const direction = Math.sign(wheel.deltaY);
    this.#wheelRaw = saturatingAddInt322(this.#wheelRaw, direction * Q16_ONE2);
  };
  #onContextMenu = (event) => {
    if (this.#acceptsPointerInput())
      event.preventDefault();
  };
  #onKeyDown = (event) => {
    const keyboard = event;
    if (!this.#acceptsInput() || keyboard.repeat)
      return;
    const byte = keyByte(keyboard);
    if (byte === void 0 || this.#keypresses.length >= PICO_DEVKIT_KEYPRESS_BATCH_LIMIT)
      return;
    this.#keypresses.push(byte);
  };
  #onBlur = () => this.clear();
  #onVisibilityChange = () => {
    if (this.#document.visibilityState === "hidden")
      this.clear();
  };
  #onPointerLockChange = () => {
    if (this.#document.pointerLockElement !== this.#canvas)
      this.clear();
  };
  #onPointerLockError = () => this.clear();
  #acceptsInput() {
    return this.#acceptsPointerInput() && this.#document.activeElement === this.#canvas;
  }
  #acceptsPointerInput() {
    return this.#enabled && (this.#flags & DEVKIT_ENABLE2) !== 0;
  }
  #exitPointerLock() {
    if (this.#document.pointerLockElement === this.#canvas) {
      this.#document.exitPointerLock();
    }
  }
  #bind(target, type, listener, options) {
    target.addEventListener(type, listener, options);
    this.#removeListeners.push(() => target.removeEventListener(type, listener, options));
  }
  #assertActive() {
    if (this.#disposed)
      throw new Error("DevkitInputFrontend is disposed");
  }
};

// apps/web-player/dist/main/input-frontend.js
var KEY_TO_BUTTON = /* @__PURE__ */ new Map([
  ["ArrowLeft", { player: 0, button: 0 }],
  ["ArrowRight", { player: 0, button: 1 }],
  ["ArrowUp", { player: 0, button: 2 }],
  ["ArrowDown", { player: 0, button: 3 }],
  ["KeyZ", { player: 0, button: 4 }],
  ["KeyN", { player: 0, button: 4 }],
  ["KeyC", { player: 0, button: 4 }],
  ["KeyX", { player: 0, button: 5 }],
  ["KeyM", { player: 0, button: 5 }],
  ["KeyV", { player: 0, button: 5 }],
  ["KeyS", { player: 1, button: 0 }],
  ["KeyF", { player: 1, button: 1 }],
  ["KeyE", { player: 1, button: 2 }],
  ["KeyD", { player: 1, button: 3 }],
  ["ShiftLeft", { player: 1, button: 4 }],
  ["Tab", { player: 1, button: 5 }],
  ["KeyW", { player: 1, button: 5 }],
  ["KeyQ", { player: 1, button: 5 }],
  ["KeyA", { player: 1, button: 5 }]
]);
var KeyboardInputFrontend = class {
  #focusTarget;
  #window;
  #document;
  #onChange;
  #heldCodes = /* @__PURE__ */ new Set();
  #enabled = false;
  #controllers = new Uint8Array(PICO_CONTROLLER_COUNT);
  #disposed = false;
  constructor(focusTarget, options = {}) {
    this.#focusTarget = focusTarget;
    this.#window = options.window ?? window;
    this.#document = options.document ?? document;
    this.#onChange = options.onChange;
    this.#window.addEventListener("keydown", this.#onKeyDown);
    this.#window.addEventListener("keyup", this.#onKeyUp);
    this.#window.addEventListener("blur", this.#onBlur);
    this.#document.addEventListener("visibilitychange", this.#onVisibilityChange);
  }
  get buttons() {
    return this.#controllers[0];
  }
  get controllers() {
    return Array.from(this.#controllers);
  }
  snapshot() {
    return { controllers: Array.from(this.#controllers) };
  }
  setEnabled(enabled) {
    this.#assertActive();
    this.#enabled = enabled;
    if (!enabled)
      this.clear();
  }
  clear() {
    if (this.#disposed)
      return;
    if (this.#heldCodes.size === 0 && this.#controllers.every((value) => value === 0))
      return;
    this.#heldCodes.clear();
    this.#setControllers(new Uint8Array(PICO_CONTROLLER_COUNT));
  }
  dispose() {
    if (this.#disposed)
      return;
    this.clear();
    this.#disposed = true;
    this.#window.removeEventListener("keydown", this.#onKeyDown);
    this.#window.removeEventListener("keyup", this.#onKeyUp);
    this.#window.removeEventListener("blur", this.#onBlur);
    this.#document.removeEventListener("visibilitychange", this.#onVisibilityChange);
  }
  #onKeyDown = (event) => {
    const binding = KEY_TO_BUTTON.get(event.code);
    if (binding === void 0 || !this.#acceptsInput())
      return;
    event.preventDefault();
    if (this.#heldCodes.has(event.code))
      return;
    this.#heldCodes.add(event.code);
    this.#recomputeButtons();
  };
  #onKeyUp = (event) => {
    const binding = KEY_TO_BUTTON.get(event.code);
    if (binding === void 0 || !this.#enabled)
      return;
    if (this.#acceptsInput())
      event.preventDefault();
    if (!this.#heldCodes.delete(event.code))
      return;
    this.#recomputeButtons();
  };
  #onBlur = () => this.clear();
  #onVisibilityChange = () => {
    if (this.#document.visibilityState === "hidden")
      this.clear();
  };
  #acceptsInput() {
    return this.#enabled && this.#document.activeElement === this.#focusTarget;
  }
  #recomputeButtons() {
    const controllers = new Uint8Array(PICO_CONTROLLER_COUNT);
    for (const code of this.#heldCodes) {
      const binding = KEY_TO_BUTTON.get(code);
      if (binding !== void 0) {
        controllers[binding.player] = controllers[binding.player] | 1 << binding.button;
      }
    }
    this.#setControllers(controllers);
  }
  #setControllers(controllers) {
    if (controllers.every((value, index) => value === this.#controllers[index]))
      return;
    this.#controllers.set(controllers);
    this.#onChange?.(this.snapshot());
  }
  #assertActive() {
    if (this.#disposed)
      throw new Error("KeyboardInputFrontend is disposed");
  }
};

// apps/web-player/dist/main/touch-input.js
function setOptionalAttribute(element, name, value) {
  const compatible = element;
  compatible.setAttribute?.(name, value);
}
var TouchInputFrontend = class {
  #window;
  #document;
  #onChange;
  #controllers = new Uint8Array(PICO_CONTROLLER_COUNT);
  #pointers = /* @__PURE__ */ new Map();
  #controls = [];
  #removeListeners = [];
  #enabled = false;
  #disposed = false;
  constructor(root, options = {}) {
    this.#window = options.window ?? window;
    this.#document = options.document ?? document;
    this.#onChange = options.onChange;
    for (const element of root.querySelectorAll("[data-pico-button]")) {
      const player = Number(element.dataset.picoPlayer ?? 0);
      const button2 = Number(element.dataset.picoButton);
      if (!Number.isInteger(player) || player < 0 || player >= PICO_CONTROLLER_COUNT || !Number.isInteger(button2) || button2 < 0 || button2 >= PICO_CONTROLLER_BUTTON_COUNT)
        continue;
      const binding = { player, button: button2 };
      this.#controls.push({ element, binding });
      setOptionalAttribute(element, "aria-pressed", "false");
      this.#bind(element, "pointerdown", (event) => this.#press(event, binding));
      this.#bind(element, "pointerup", (event) => this.#release(event));
      this.#bind(element, "pointercancel", (event) => this.#release(event));
      this.#bind(element, "lostpointercapture", (event) => this.#release(event));
    }
    this.#bind(this.#window, "blur", () => this.clear());
    this.#bind(this.#document, "visibilitychange", () => {
      if (this.#document.visibilityState === "hidden")
        this.clear();
    });
  }
  snapshot() {
    return { controllers: Array.from(this.#controllers) };
  }
  setEnabled(enabled) {
    this.#assertActive();
    this.#enabled = enabled;
    for (const { element } of this.#controls) {
      if ("disabled" in element) {
        element.disabled = !enabled;
      }
      setOptionalAttribute(element, "aria-disabled", String(!enabled));
    }
    if (!enabled)
      this.clear();
  }
  clear() {
    if (this.#disposed)
      return;
    if (this.#pointers.size === 0 && this.#controllers.every((value) => value === 0))
      return;
    this.#pointers.clear();
    this.#controllers.fill(0);
    this.#syncPressedState();
    this.#onChange?.(this.snapshot());
  }
  dispose() {
    if (this.#disposed)
      return;
    this.clear();
    this.#disposed = true;
    for (const remove of this.#removeListeners.splice(0))
      remove();
  }
  #press(event, binding) {
    if (!this.#enabled)
      return;
    event.preventDefault();
    this.#pointers.set(event.pointerId, binding);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
    }
    this.#recompute();
  }
  #release(event) {
    if (!this.#pointers.delete(event.pointerId))
      return;
    event.preventDefault();
    this.#recompute();
  }
  #recompute() {
    const next = new Uint8Array(PICO_CONTROLLER_COUNT);
    for (const { player, button: button2 } of this.#pointers.values()) {
      next[player] = next[player] | 1 << button2;
    }
    if (next.every((value, index) => value === this.#controllers[index]))
      return;
    this.#controllers.set(next);
    this.#syncPressedState();
    this.#onChange?.(this.snapshot());
  }
  #syncPressedState() {
    for (const { element, binding } of this.#controls) {
      const pressed2 = [...this.#pointers.values()].some((active) => active.player === binding.player && active.button === binding.button);
      setOptionalAttribute(element, "aria-pressed", String(pressed2));
    }
  }
  #bind(target, type, listener) {
    target.addEventListener(type, listener);
    this.#removeListeners.push(() => target.removeEventListener(type, listener));
  }
  #assertActive() {
    if (this.#disposed)
      throw new Error("TouchInputFrontend is disposed");
  }
};

// apps/web-player/dist/main/player-input.js
var PlayerInputFrontend = class {
  keyboard;
  gamepad;
  devkit;
  touch;
  #hostInput = PICO_EMPTY_INPUT;
  #hostInputEnabled = false;
  #disposed = false;
  constructor(focusTarget, options = {}) {
    this.keyboard = new KeyboardInputFrontend(focusTarget, options);
    this.gamepad = new GamepadInputFrontend({
      ...options.gamepadSource === void 0 ? {} : { source: options.gamepadSource }
    });
    this.devkit = new DevkitInputFrontend(focusTarget, options);
    this.touch = options.touchRoot === void 0 ? void 0 : new TouchInputFrontend(options.touchRoot, options);
  }
  get buttons() {
    return this.snapshot().controllers[0];
  }
  snapshot() {
    return this.#snapshot(false);
  }
  takeSnapshot() {
    return this.#snapshot(true);
  }
  setDevkitFlags(flags) {
    this.#assertActive();
    this.devkit.setFlags(flags);
  }
  setHostInput(snapshot) {
    this.#assertActive();
    this.#hostInput = copyInput2(snapshot);
  }
  #snapshot(consumeDevkitEvents) {
    this.#assertActive();
    const sources = [
      this.keyboard.snapshot().controllers,
      this.gamepad.snapshot().controllers,
      this.touch?.snapshot().controllers,
      this.#hostInputEnabled ? this.#hostInput.controllers : void 0
    ];
    const controllers = new Array(PICO_CONTROLLER_COUNT).fill(0);
    for (const source of sources) {
      if (source === void 0)
        continue;
      for (let player = 0; player < controllers.length; player += 1) {
        controllers[player] = controllers[player] | source[player];
      }
    }
    const localDevkit = consumeDevkitEvents ? this.devkit.takeBatch() : this.devkit.peekBatch();
    const hostDevkit = this.#hostInput.devkit;
    const devkit = !this.#hostInputEnabled ? localDevkit : {
      mouseXRaw: hostDevkit.mouseXRaw,
      mouseYRaw: hostDevkit.mouseYRaw,
      mouseButtons: localDevkit.mouseButtons | hostDevkit.mouseButtons,
      wheelRaw: saturatingInt32(localDevkit.wheelRaw + hostDevkit.wheelRaw),
      movementXRaw: saturatingInt32(localDevkit.movementXRaw + hostDevkit.movementXRaw),
      movementYRaw: saturatingInt32(localDevkit.movementYRaw + hostDevkit.movementYRaw),
      keypresses: [...localDevkit.keypresses, ...hostDevkit.keypresses].slice(0, 64)
    };
    if (consumeDevkitEvents && this.#hostInputEnabled) {
      this.#hostInput = {
        controllers: this.#hostInput.controllers,
        devkit: {
          ...hostDevkit,
          wheelRaw: 0,
          movementXRaw: 0,
          movementYRaw: 0,
          keypresses: []
        }
      };
    }
    return {
      controllers,
      devkit
    };
  }
  setEnabled(enabled) {
    this.#assertActive();
    if (!enabled)
      this.#hostInput = PICO_EMPTY_INPUT;
    this.keyboard.setEnabled(enabled);
    this.gamepad.setEnabled(enabled);
    this.touch?.setEnabled(enabled);
    this.devkit.setEnabled(enabled);
    this.#hostInputEnabled = enabled;
  }
  clear() {
    if (this.#disposed)
      return;
    this.keyboard.clear();
    this.gamepad.clear();
    this.touch?.clear();
    this.devkit.clear();
    this.#hostInput = PICO_EMPTY_INPUT;
  }
  dispose() {
    if (this.#disposed)
      return;
    this.clear();
    this.#disposed = true;
    this.keyboard.dispose();
    this.gamepad.dispose();
    this.touch?.dispose();
    this.devkit.dispose();
  }
  #assertActive() {
    if (this.#disposed)
      throw new Error("PlayerInputFrontend is disposed");
  }
};
function saturatingInt32(value) {
  return Math.max(-2147483648, Math.min(2147483647, value)) | 0;
}
function copyInput2(snapshot) {
  const devkit = snapshot?.devkit;
  const int32 = (value) => Number.isInteger(value) && Number(value) >= -2147483648 && Number(value) <= 2147483647;
  if (!Array.isArray(snapshot?.controllers) || snapshot.controllers.length !== PICO_CONTROLLER_COUNT || snapshot.controllers.some((buttons) => !Number.isSafeInteger(buttons) || buttons < 0 || buttons > 63) || typeof devkit !== "object" || devkit === null || !int32(devkit.mouseXRaw) || !int32(devkit.mouseYRaw) || !Number.isInteger(devkit.mouseButtons) || devkit.mouseButtons < 0 || devkit.mouseButtons > 7 || !int32(devkit.wheelRaw) || !int32(devkit.movementXRaw) || !int32(devkit.movementYRaw) || !Array.isArray(devkit.keypresses) || devkit.keypresses.length > 64 || devkit.keypresses.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new RangeError("input must contain a fixed controller snapshot and devkit batch");
  }
  return {
    controllers: snapshot.controllers.slice(),
    devkit: {
      mouseXRaw: devkit.mouseXRaw,
      mouseYRaw: devkit.mouseYRaw,
      mouseButtons: devkit.mouseButtons,
      wheelRaw: devkit.wheelRaw,
      movementXRaw: devkit.movementXRaw,
      movementYRaw: devkit.movementYRaw,
      keypresses: devkit.keypresses.slice()
    }
  };
}

// apps/web-player/dist/runtime/lifecycle-queue.js
var PlayerLifecycleQueue = class {
  #tail = Promise.resolve();
  #closed = false;
  #disposal;
  get closed() {
    return this.#closed;
  }
  run(operation) {
    if (this.#closed)
      return Promise.reject(new Error("Player lifecycle is disposed"));
    const result = this.#tail.then(async () => {
      if (this.#closed)
        throw new Error("Player lifecycle is disposed");
      return operation();
    });
    this.#tail = result.then(() => void 0, () => void 0);
    return result;
  }
  /** Close admission immediately; skip queued work and drain before teardown. */
  close(teardown) {
    if (this.#disposal !== void 0)
      return this.#disposal;
    this.#closed = true;
    this.#disposal = this.#tail.then(teardown);
    return this.#disposal;
  }
};

// apps/web-player/dist/main/ui/player-shell-policy.js
var MAX_LOCAL_CART_BYTES = PICO_CART_INPUT_MAX_BYTES;
var PICO_PLAYFIELD_SIZE = 128;
var MAX_INTEGER_SCALE = 8;
function isActivelyPlaying(state) {
  return state === "running" || state === "audio-blocked";
}
function derivePlayerShellPresentation(options) {
  const { state } = options;
  const active = isActivelyPlaying(state);
  const disposed = state === "disposed";
  const loading = state === "loading";
  const audioBlocked = state === "audio-blocked";
  return {
    audioBlocked,
    busy: loading,
    cartSelectionDisabled: loading || disposed,
    fullscreenDisabled: disposed,
    muteDisabled: disposed,
    menuDisabled: !active,
    pauseDisabled: !active && state !== "menu-open",
    playDisabled: !["ready", "paused", "audio-blocked"].includes(state),
    playLabel: audioBlocked ? "Enable audio" : state === "paused" ? "Resume" : "Play",
    resetDisabled: !options.hasRetainedCart || loading || disposed,
    stopDisabled: !["ready", "running", "audio-blocked", "menu-open", "paused", "faulted"].includes(state),
    touchDisabled: !active
  };
}
function validateLocalCartSelection(files) {
  if (files.length !== 1) {
    return { ok: false, message: "Choose or drop exactly one cartridge." };
  }
  const file = files[0];
  const lowerName = file.name.toLowerCase();
  if (!lowerName.endsWith(".p8") && !lowerName.endsWith(".p8.png")) {
    return { ok: false, message: "Cartridges must use a .p8 or .p8.png filename." };
  }
  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    return { ok: false, message: "The selected cartridge is empty or unreadable." };
  }
  if (file.size > MAX_LOCAL_CART_BYTES) {
    return {
      ok: false,
      message: `The selected cartridge exceeds ${MAX_LOCAL_CART_BYTES} bytes.`
    };
  }
  return { ok: true };
}
function computeIntegerScale(availableWidthCssPixels, availableHeightCssPixels, maximumScale = MAX_INTEGER_SCALE) {
  if (!Number.isFinite(availableWidthCssPixels) || availableWidthCssPixels <= 0 || !Number.isFinite(availableHeightCssPixels) || availableHeightCssPixels <= 0 || !Number.isSafeInteger(maximumScale) || maximumScale < 1) {
    throw new RangeError("integer scale inputs must be positive and finite");
  }
  return Math.max(1, Math.min(maximumScale, Math.floor(Math.min(availableWidthCssPixels, availableHeightCssPixels) / PICO_PLAYFIELD_SIZE)));
}

// apps/web-player/dist/main/ui/player-shell-view.js
var TOUCH_CONTROLS = [
  { label: "\u2190", accessibleName: "Move left", picoButton: 0 },
  { label: "\u2192", accessibleName: "Move right", picoButton: 1 },
  { label: "\u2191", accessibleName: "Move up", picoButton: 2 },
  { label: "\u2193", accessibleName: "Move down", picoButton: 3 },
  { label: "O", accessibleName: "O button", picoButton: 4 },
  { label: "X", accessibleName: "X button", picoButton: 5 }
];
function button(document2, label, action) {
  const element = document2.createElement("button");
  element.type = "button";
  element.textContent = label;
  element.dataset.action = action;
  element.className = "pico8-player__button";
  return element;
}
var PlayerShellView = class _PlayerShellView {
  elements;
  #window;
  #document;
  #resizeObserver;
  #disposed = false;
  constructor(elements, options) {
    this.elements = elements;
    this.#window = options.window ?? window;
    this.#document = options.document ?? document;
    this.#document.addEventListener("fullscreenchange", this.#onFullscreenChange);
    this.#window.addEventListener("resize", this.#onWindowResize);
    const ResizeObserverClass = globalThis.ResizeObserver;
    if (ResizeObserverClass !== void 0) {
      const resizeObserver = new ResizeObserverClass((entries) => {
        const entry = entries.find(({ target }) => target === this.elements.dropZone);
        if (entry === void 0)
          return;
        const fullscreen = this.fullscreen;
        this.resize(entry.contentRect.width, fullscreen ? entry.contentRect.height : entry.contentRect.width);
      });
      this.#resizeObserver = resizeObserver;
      resizeObserver.observe(elements.dropZone);
    }
    this.#syncFullscreen();
    this.#resizeFromLayout();
  }
  static create(root, options = {}) {
    const document2 = options.document ?? root.ownerDocument;
    const shell = document2.createElement("section");
    shell.className = "pico8-player";
    shell.setAttribute("aria-label", "PICO-8 player");
    shell.dataset.playerState = "idle";
    shell.dataset.scale = "1";
    shell.dataset.menuOpen = "false";
    shell.dataset.shellMode = options.shell ?? "full";
    const chrome = document2.createElement("header");
    chrome.className = "pico8-player__chrome";
    const brand = document2.createElement("span");
    brand.className = "pico8-player__brand";
    brand.textContent = "PICO-8";
    const status = document2.createElement("output");
    status.className = "pico8-player__status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.setAttribute("aria-atomic", "true");
    chrome.append(brand, status);
    const dropZone = document2.createElement("div");
    dropZone.className = "pico8-player__stage";
    dropZone.dataset.dropTarget = "cart";
    const canvas = document2.createElement("canvas");
    canvas.className = "pico8-player__canvas";
    canvas.setAttribute("aria-label", "PICO-8 playfield");
    canvas.tabIndex = 0;
    const dropHint = document2.createElement("span");
    dropHint.className = "pico8-player__drop-hint";
    dropHint.textContent = "Drop a local cart";
    dropHint.setAttribute("aria-hidden", "true");
    dropZone.append(canvas, dropHint);
    const controls = document2.createElement("div");
    controls.className = "pico8-player__toolbar";
    controls.setAttribute("role", "toolbar");
    controls.setAttribute("aria-label", "Playback controls");
    const fileLabel = document2.createElement("label");
    fileLabel.className = "pico8-player__button pico8-player__file-label";
    fileLabel.textContent = "Choose cart";
    const fileInput = document2.createElement("input");
    fileInput.className = "pico8-player__file-input";
    fileInput.type = "file";
    fileInput.accept = ".p8,.p8.png,image/png";
    fileInput.setAttribute("aria-label", "Choose a local PICO-8 cartridge");
    fileLabel.append(fileInput);
    const playButton = button(document2, "Play", "play");
    const pauseButton = button(document2, "Pause", "pause");
    const menuButton = button(document2, "Menu", "menu");
    const resetButton = button(document2, "Reset", "reset");
    const stopButton = button(document2, "Stop", "stop");
    const muteButton = button(document2, "Mute", "mute");
    muteButton.setAttribute("aria-pressed", "false");
    const fullscreenButton = button(document2, "Fullscreen", "fullscreen");
    fullscreenButton.setAttribute("aria-pressed", "false");
    controls.append(fileLabel, playButton, pauseButton, menuButton, resetButton, stopButton, muteButton, fullscreenButton);
    const touchControls = document2.createElement("div");
    touchControls.className = "pico8-player__touch-controls";
    touchControls.setAttribute("role", "group");
    touchControls.setAttribute("aria-label", "Player 1 touch controls");
    for (const definition of TOUCH_CONTROLS) {
      const control = button(document2, definition.label, `touch-${definition.picoButton}`);
      control.classList.add("pico8-player__touch-button");
      control.dataset.picoButton = String(definition.picoButton);
      control.dataset.picoPlayer = "0";
      control.setAttribute("aria-label", definition.accessibleName);
      control.setAttribute("aria-pressed", "false");
      touchControls.append(control);
    }
    const pauseMenu = document2.createElement("section");
    pauseMenu.className = "pico8-player__pause-menu";
    pauseMenu.setAttribute("role", "dialog");
    pauseMenu.setAttribute("aria-modal", "true");
    pauseMenu.setAttribute("aria-label", "Cartridge pause menu");
    pauseMenu.hidden = true;
    const pauseMenuTitle = document2.createElement("h2");
    pauseMenuTitle.className = "pico8-player__pause-menu-title";
    pauseMenuTitle.textContent = "Paused";
    const pauseMenuItems = document2.createElement("div");
    pauseMenuItems.className = "pico8-player__pause-menu-items";
    pauseMenuItems.setAttribute("role", "menu");
    const continueButton = button(document2, "Continue", "menu-continue");
    continueButton.setAttribute("role", "menuitem");
    pauseMenuItems.append(continueButton);
    pauseMenu.append(pauseMenuTitle, pauseMenuItems);
    dropZone.append(pauseMenu);
    const diagnostic = document2.createElement("pre");
    diagnostic.className = "pico8-player__diagnostic";
    diagnostic.setAttribute("role", "alert");
    diagnostic.setAttribute("aria-live", "assertive");
    diagnostic.setAttribute("aria-atomic", "true");
    diagnostic.hidden = true;
    shell.append(chrome, dropZone, controls, touchControls, diagnostic);
    root.replaceChildren(shell);
    return new _PlayerShellView({
      root: shell,
      canvas,
      status,
      diagnostic,
      fileInput,
      fileLabel,
      dropZone,
      playButton,
      pauseButton,
      menuButton,
      resetButton,
      stopButton,
      muteButton,
      fullscreenButton,
      touchControls,
      pauseMenu,
      pauseMenuItems,
      continueButton
    }, { ...options, document: document2 });
  }
  get fullscreen() {
    return this.#document.fullscreenElement === this.elements.root;
  }
  render(model) {
    this.#assertActive();
    const presentation = derivePlayerShellPresentation(model);
    const { elements } = this;
    elements.root.dataset.playerState = model.state;
    elements.root.dataset.audioState = presentation.audioBlocked ? "blocked" : model.muted ? "muted" : "enabled";
    elements.root.setAttribute("aria-busy", String(presentation.busy));
    elements.status.textContent = model.message;
    elements.fileInput.disabled = presentation.cartSelectionDisabled;
    elements.fileLabel.setAttribute("aria-disabled", String(presentation.cartSelectionDisabled));
    elements.playButton.disabled = presentation.playDisabled;
    elements.playButton.textContent = presentation.playLabel;
    elements.pauseButton.disabled = presentation.pauseDisabled;
    elements.menuButton.disabled = presentation.menuDisabled;
    elements.resetButton.disabled = presentation.resetDisabled;
    elements.stopButton.disabled = presentation.stopDisabled;
    elements.muteButton.disabled = presentation.muteDisabled;
    elements.muteButton.textContent = model.muted ? "Unmute" : "Mute";
    elements.muteButton.setAttribute("aria-pressed", String(model.muted));
    elements.fullscreenButton.disabled = presentation.fullscreenDisabled;
    for (const control of elements.touchControls.querySelectorAll("[data-pico-button]")) {
      control.disabled = presentation.touchDisabled;
      control.setAttribute("aria-disabled", String(presentation.touchDisabled));
    }
    this.#syncFullscreen();
  }
  showDiagnostic(message2) {
    this.#assertActive();
    this.elements.diagnostic.textContent = message2;
    this.elements.diagnostic.hidden = message2.length === 0;
  }
  clearDiagnostic() {
    this.showDiagnostic("");
  }
  showPauseMenu(items, preferredSlot) {
    this.#assertActive();
    const { pauseMenu, pauseMenuItems, continueButton, root } = this.elements;
    for (const item of pauseMenuItems.querySelectorAll("[data-menu-slot]"))
      item.remove();
    for (const item of items) {
      const itemButton = button(this.#document, item.label, "menu-item");
      itemButton.setAttribute("role", "menuitem");
      itemButton.dataset.menuSlot = String(item.slot);
      itemButton.dataset.menuFilter = String(item.filter);
      itemButton.title = "Left/Right or X";
      pauseMenuItems.append(itemButton);
    }
    pauseMenu.hidden = false;
    root.dataset.menuOpen = "true";
    const preferred = preferredSlot === void 0 ? void 0 : pauseMenuItems.querySelector(`[data-menu-slot="${preferredSlot}"]`);
    const target = preferred ?? continueButton;
    for (const entry of this.pauseMenuButtons())
      entry.tabIndex = entry === target ? 0 : -1;
    target.focus();
  }
  hidePauseMenu(focusPlayfield = true) {
    if (this.#disposed)
      return;
    this.elements.pauseMenu.hidden = true;
    this.elements.root.dataset.menuOpen = "false";
    for (const item of this.elements.pauseMenuItems.querySelectorAll("[data-menu-slot]")) {
      item.remove();
    }
    if (focusPlayfield)
      this.elements.canvas.focus();
  }
  pauseMenuButtons() {
    return Array.from(this.elements.pauseMenuItems.querySelectorAll("[role=menuitem]"));
  }
  setDropActive(active) {
    this.#assertActive();
    this.elements.root.dataset.dropActive = String(active);
  }
  resize(availableWidthCssPixels, availableHeightCssPixels) {
    this.#assertActive();
    const scale = computeIntegerScale(availableWidthCssPixels, availableHeightCssPixels);
    this.elements.root.dataset.scale = String(scale);
    return scale;
  }
  async toggleFullscreen() {
    this.#assertActive();
    if (this.fullscreen) {
      await this.#document.exitFullscreen();
    } else {
      if (this.elements.root.requestFullscreen === void 0) {
        throw new Error("Fullscreen is unavailable in this browser context.");
      }
      await this.elements.root.requestFullscreen();
    }
    this.#syncFullscreen();
    this.#resizeFromLayout();
  }
  async exitFullscreen() {
    if (this.#disposed || !this.fullscreen)
      return;
    await this.#document.exitFullscreen();
  }
  dispose() {
    if (this.#disposed)
      return;
    this.hidePauseMenu(false);
    this.#disposed = true;
    this.#resizeObserver?.disconnect();
    this.#document.removeEventListener("fullscreenchange", this.#onFullscreenChange);
    this.#window.removeEventListener("resize", this.#onWindowResize);
    this.elements.root.dataset.dropActive = "false";
  }
  #onFullscreenChange = () => {
    if (this.#disposed)
      return;
    this.#syncFullscreen();
    this.#resizeFromLayout();
  };
  #onWindowResize = () => {
    if (this.#disposed)
      return;
    this.#resizeFromLayout();
  };
  #syncFullscreen() {
    const fullscreen = this.fullscreen;
    this.elements.root.dataset.fullscreen = String(fullscreen);
    this.elements.fullscreenButton.setAttribute("aria-pressed", String(fullscreen));
    this.elements.fullscreenButton.textContent = fullscreen ? "Exit fullscreen" : "Fullscreen";
  }
  #resizeFromLayout() {
    const bounds = this.elements.dropZone.getBoundingClientRect();
    const width = bounds.width > 0 ? bounds.width : 128;
    const height = this.fullscreen && bounds.height > 0 ? bounds.height : width;
    this.resize(width, height);
  }
  #assertActive() {
    if (this.#disposed)
      throw new Error("PlayerShellView is disposed");
  }
};

// apps/web-player/dist/main/player-controller.js
var P8SCII_EXTENDED_GLYPHS = "\u2588\u2592\u{1F431}\u2B07\u2591\u273D\u25CF\u2665\u2609\uC6C3\u2302\u2B05\u{1F610}\u266A\u{1F17E}\u25C6\u2026\u27A1\u2605\u29D7\u2B06\u02C7\u2227\u274E\u25A4\u25A5\u3042\u3044\u3046\u3048\u304A\u304B\u304D\u304F\u3051\u3053\u3055\u3057\u3059\u305B\u305D\u305F\u3061\u3064\u3066\u3068\u306A\u306B\u306C\u306D\u306E\u306F\u3072\u3075\u3078\u307B\u307E\u307F\u3080\u3081\u3082\u3084\u3086\u3088\u3089\u308A\u308B\u308C\u308D\u308F\u3092\u3093\u3063\u3083\u3085\u3087\u30A2\u30A4\u30A6\u30A8\u30AA\u30AB\u30AD\u30AF\u30B1\u30B3\u30B5\u30B7\u30B9\u30BB\u30BD\u30BF\u30C1\u30C4\u30C6\u30C8\u30CA\u30CB\u30CC\u30CD\u30CE\u30CF\u30D2\u30D5\u30D8\u30DB\u30DE\u30DF\u30E0\u30E1\u30E2\u30E4\u30E6\u30E8\u30E9\u30EA\u30EB\u30EC\u30ED\u30EF\u30F2\u30F3\u30C3\u30E3\u30E5\u30E7\u25DC\u25DD";
var P8SCII_LOW_GLYPHS = new Map([
  ...Array.from("\xB9\xB2\xB3\u2074\u2075\u2076\u2077\u2078", (glyph, index) => [index + 1, glyph]),
  [11, "\u1D47"],
  [12, "\u1D9C"],
  [14, "\u1D49"],
  [15, "\u1DA0"],
  ...Array.from("\u25AE\u25A0\u25A1\u2059\u2058\u2016\u25C0\u25B6\u300C\u300D\xA5\u2022\u3001\u3002\u309B\u309C", (glyph, index) => [index + 16, glyph])
]);
function decodeP8sciiLabel(bytes) {
  const extended = Array.from(P8SCII_EXTENDED_GLYPHS);
  return Array.from(bytes, (byte) => {
    if (byte >= 32 && byte <= 126)
      return String.fromCharCode(byte);
    if (byte === 127)
      return "\u25CB";
    if (byte >= 128)
      return extended[byte - 128] ?? "\uFFFD";
    if (byte === 9)
      return "	";
    if (byte === 10)
      return "\n";
    if (byte === 13)
      return "\r";
    return P8SCII_LOW_GLYPHS.get(byte) ?? "\uFFFD";
  }).join("");
}
var PlayerController = class {
  #composition;
  #view;
  #elements;
  #window;
  #document;
  #animationFrames;
  #input;
  #removeRuntimeListener;
  #removeListeners = [];
  #stateListeners = /* @__PURE__ */ new Set();
  #state = "idle";
  #frameHandle;
  #environmentPaused = false;
  #muted = false;
  #menuWasAudioBlocked = false;
  #stateMessage = "Select a local .p8 or .p8.png cartridge";
  #disposed = false;
  #lifecycle = new PlayerLifecycleQueue();
  #actions = {
    loadCart: (source, options) => this.#loadCart(source, options),
    start: (audioProbe) => this.#start(audioProbe),
    pause: () => this.#pause(),
    resume: (audioProbe) => this.#resume(audioProbe),
    reset: () => this.#reset(),
    stop: () => this.#stop(),
    openPauseMenu: () => this.#openPauseMenu(),
    closePauseMenu: () => this.#closePauseMenu(),
    invokeMenuItem: (slot, button2) => this.#invokeMenuItem(slot, button2),
    retryAudio: (audioProbe) => this.#retryAudio(audioProbe),
    toggleMute: (audioProbe) => this.#toggleMute(audioProbe)
  };
  constructor(composition, view, options = {}) {
    this.#composition = composition;
    this.#view = view;
    this.#elements = view.elements;
    const elements = view.elements;
    this.#window = options.window ?? window;
    this.#document = options.document ?? document;
    this.#animationFrames = options.animationFrames ?? {
      request: (callback) => this.#window.requestAnimationFrame(callback),
      cancel: (handle) => this.#window.cancelAnimationFrame(handle)
    };
    elements.canvas.tabIndex = elements.canvas.tabIndex >= 0 ? elements.canvas.tabIndex : 0;
    this.#input = new PlayerInputFrontend(elements.canvas, {
      window: this.#window,
      document: this.#document,
      ...options.gamepadSource === void 0 ? {} : { gamepadSource: options.gamepadSource },
      touchRoot: elements.touchControls
    });
    this.#removeRuntimeListener = composition.runtime.onEvent((event) => this.#onRuntimeEvent(event));
    this.#bind(elements.canvas, "click", () => elements.canvas.focus());
    this.#bind(elements.fileInput, "change", () => {
      const files = elements.fileInput.files === null ? [] : Array.from(elements.fileInput.files);
      this.#loadLocalFiles(files);
      elements.fileInput.value = "";
    });
    this.#bind(elements.dropZone, "dragenter", (event) => this.#drag(event));
    this.#bind(elements.dropZone, "dragover", (event) => this.#drag(event));
    this.#bind(elements.dropZone, "dragleave", () => this.#view.setDropActive(false));
    this.#bind(elements.dropZone, "drop", (event) => {
      const dragEvent = event;
      dragEvent.preventDefault();
      this.#view.setDropActive(false);
      const files = dragEvent.dataTransfer === null ? [] : Array.from(dragEvent.dataTransfer.files);
      this.#loadLocalFiles(files);
    });
    this.#bind(elements.playButton, "click", () => {
      if (this.#lifecycle.closed)
        return;
      if (this.#state === "audio-blocked") {
        void this.retryAudio().catch((error) => this.#showUiError(error));
        return;
      }
      const audioProbe = this.#muted ? Promise.resolve(true) : this.#composition.resumeAudio();
      this.#enqueue(async (actions) => {
        if (this.#state === "paused")
          await actions.resume(audioProbe);
        else if (this.#state === "ready")
          await actions.start(audioProbe);
      });
    });
    this.#bind(elements.pauseButton, "click", () => this.#enqueue((actions) => actions.pause()));
    this.#bind(elements.menuButton, "click", () => this.#enqueue((actions) => actions.openPauseMenu()));
    this.#bind(elements.pauseMenuItems, "click", (event) => {
      if (this.#state !== "menu-open")
        return;
      const target = event.target instanceof Element ? event.target.closest("[role=menuitem]") : null;
      if (target === null)
        return;
      const slot = this.#menuSlot(target);
      if (slot === void 0)
        this.#enqueue((actions) => actions.closePauseMenu());
      else if (!this.#menuFiltered(target, 4)) {
        this.#enqueue((actions) => actions.invokeMenuItem(slot, 4));
      }
    });
    this.#bind(elements.pauseMenu, "keydown", (event) => {
      this.#onPauseMenuKeydown(event);
    });
    this.#bind(elements.resetButton, "click", () => this.#enqueue(async (actions) => {
      const restart = isActivelyPlaying(this.#state);
      await actions.reset();
      if (restart)
        await actions.start();
    }));
    this.#bind(elements.stopButton, "click", () => this.#enqueue((actions) => actions.stop()));
    this.#bind(elements.muteButton, "click", () => {
      void this.toggleMute().catch((error) => this.#showUiError(error));
    });
    this.#bind(elements.fullscreenButton, "click", () => {
      void this.#view.toggleFullscreen().catch((error) => this.#showUiError(error));
    });
    this.#bind(this.#window, "blur", () => this.#pauseForEnvironment());
    this.#bind(this.#window, "focus", () => this.#resumeFromEnvironment());
    this.#bind(this.#document, "visibilitychange", () => {
      if (this.#document.visibilityState === "hidden")
        this.#pauseForEnvironment();
      else
        this.#resumeFromEnvironment();
    });
    this.#bind(this.#window, "pagehide", (event) => {
      this.#enqueue(async () => {
        await this.#composition.runtime.flushPersistence();
      });
      if (event.persisted)
        this.#pauseForEnvironment();
    });
    this.#bind(this.#window, "pageshow", (event) => {
      if (event.persisted)
        this.#resumeFromEnvironment();
    });
    this.#renderState(this.#stateMessage);
  }
  get state() {
    return this.#state;
  }
  get inputButtons() {
    return this.#input.buttons;
  }
  get inputControllers() {
    return this.#input.snapshot().controllers;
  }
  get muted() {
    return this.#muted;
  }
  setInput(snapshot) {
    this.#assertActive();
    this.#input.setHostInput(snapshot);
  }
  clearInput() {
    this.#assertActive();
    this.#input.clear();
    this.#composition.runtime.clearInput();
  }
  onStateChange(listener) {
    this.#assertActive();
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }
  /** Serializes facade transactions and Controller entrypoints with DOM/environment intents. */
  runLifecycle(operation) {
    return this.#lifecycle.run(() => operation(this.#actions));
  }
  loadCart(source, options = {}) {
    return this.runLifecycle((actions) => actions.loadCart(source, options));
  }
  start(audioProbe) {
    return this.runLifecycle((actions) => actions.start(audioProbe));
  }
  pause() {
    return this.runLifecycle((actions) => actions.pause());
  }
  resume(audioProbe) {
    return this.runLifecycle((actions) => actions.resume(audioProbe));
  }
  reset() {
    return this.runLifecycle((actions) => actions.reset());
  }
  stop() {
    return this.runLifecycle((actions) => actions.stop());
  }
  openPauseMenu() {
    return this.runLifecycle((actions) => actions.openPauseMenu());
  }
  closePauseMenu() {
    return this.runLifecycle((actions) => actions.closePauseMenu());
  }
  invokeMenuItem(slot, button2) {
    return this.runLifecycle((actions) => actions.invokeMenuItem(slot, button2));
  }
  retryAudio(audioProbe) {
    if (this.#lifecycle.closed)
      return Promise.reject(new Error("Player lifecycle is disposed"));
    const probe = audioProbe ?? (this.#state === "audio-blocked" && !this.#muted ? this.#composition.resumeAudio() : void 0);
    return this.runLifecycle((actions) => actions.retryAudio(probe));
  }
  toggleMute(audioProbe) {
    if (this.#lifecycle.closed)
      return Promise.reject(new Error("Player lifecycle is disposed"));
    const probe = audioProbe ?? (this.#muted && isActivelyPlaying(this.#state) ? this.#composition.resumeAudio() : void 0);
    return this.runLifecycle((actions) => actions.toggleMute(probe));
  }
  dispose(hooks = {}) {
    return this.#lifecycle.close(async () => {
      try {
        await hooks.beforeDispose?.(this.#actions);
      } finally {
        try {
          await this.#dispose();
        } finally {
          await hooks.afterDispose?.();
        }
      }
    });
  }
  async #loadCart(source, options = {}) {
    this.#assertActive();
    const normalized = typeof options === "string" ? { displayName: options } : options;
    const displayName = normalized.displayName ?? "cartridge";
    this.#cancelFrame();
    this.#input.setEnabled(false);
    this.#input.setDevkitFlags(0);
    this.#composition.runtime.clearInput();
    this.#view.hidePauseMenu(false);
    this.#setState("loading", `Loading ${displayName}\u2026`);
    this.#view.clearDiagnostic();
    try {
      const loaded = await this.#composition.runtime.loadCart(source, normalized.instructionBudget, normalized.localCartBundle, normalized.hostCartData);
      if (this.#disposed)
        return;
      if (loaded.type === "state" && loaded.state === "stopped") {
        await this.#composition.suspendAudio();
        if (this.#disposed)
          return;
        this.#setState("stopped", "Cartridge stopped");
        return;
      }
      this.#setState("ready", `${displayName} ready`);
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }
  async #start(audioProbe) {
    this.#assertActive();
    if (this.#state !== "ready")
      return;
    try {
      const audioReady = this.#muted ? true : await (audioProbe ?? this.#composition.resumeAudio());
      if (this.#disposed)
        return;
      await this.#composition.runtime.start();
      if (this.#disposed)
        return;
      this.#environmentPaused = false;
      this.#input.setEnabled(true);
      this.#elements.canvas.focus();
      this.#setPlayingState(audioReady);
      this.#scheduleFrame();
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }
  async #pause() {
    this.#assertActive();
    if (!isActivelyPlaying(this.#state) && this.#state !== "menu-open")
      return;
    this.#environmentPaused = false;
    await this.#pauseInternal();
  }
  async #openPauseMenu() {
    this.#assertActive();
    if (!isActivelyPlaying(this.#state))
      return;
    this.#menuWasAudioBlocked = this.#state === "audio-blocked";
    this.#cancelFrame();
    this.#input.setEnabled(false);
    this.#composition.runtime.clearInput();
    try {
      const event = await this.#composition.runtime.openPauseMenu();
      if (this.#disposed)
        return;
      if (event.type !== "pause-menu" || !event.open) {
        throw new Error("Runtime did not open the cartridge pause menu");
      }
      await this.#composition.suspendAudio();
      if (this.#disposed)
        return;
      this.#view.showPauseMenu(this.#decodeMenuItems(event.items));
      this.#setState("menu-open", "Cartridge menu");
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }
  async #closePauseMenu() {
    this.#assertActive();
    if (this.#state !== "menu-open")
      return;
    const event = await this.#composition.runtime.closePauseMenu();
    if (this.#disposed)
      return;
    if (event.type !== "pause-menu" || event.open) {
      throw new Error("Runtime did not close the cartridge pause menu");
    }
    await this.#resumeAfterMenu();
  }
  async #invokeMenuItem(slot, button2) {
    this.#assertActive();
    if (this.#state !== "menu-open")
      return;
    const event = await this.#composition.runtime.invokeMenuItem(slot, button2);
    if (this.#disposed)
      return;
    if (event.type !== "pause-menu") {
      throw new Error("Runtime returned an invalid menu invocation outcome");
    }
    if (event.open) {
      this.#view.showPauseMenu(this.#decodeMenuItems(event.items), slot);
      this.#setState("menu-open", "Cartridge menu");
      return;
    }
    await this.#resumeAfterMenu();
  }
  async #resume(audioProbe) {
    this.#assertActive();
    if (this.#state !== "paused")
      return;
    try {
      const audioReady = this.#muted ? true : await (audioProbe ?? this.#composition.resumeAudio());
      if (this.#disposed)
        return;
      await this.#composition.runtime.resume();
      if (this.#disposed)
        return;
      this.#input.setEnabled(true);
      this.#elements.canvas.focus();
      this.#setPlayingState(audioReady);
      this.#scheduleFrame();
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }
  async #reset() {
    this.#assertActive();
    this.#cancelFrame();
    this.#input.setEnabled(false);
    this.#input.setDevkitFlags(0);
    this.#composition.runtime.clearInput();
    this.#view.hidePauseMenu(false);
    try {
      await this.#composition.runtime.reset();
      if (this.#disposed)
        return;
      this.#view.clearDiagnostic();
      this.#setState("ready", "Reset complete");
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }
  async #stop() {
    this.#assertActive();
    if (["idle", "loading", "stopped", "disposed"].includes(this.#state))
      return;
    this.#cancelFrame();
    this.#input.setEnabled(false);
    this.#input.setDevkitFlags(0);
    this.#composition.runtime.clearInput();
    this.#view.hidePauseMenu(false);
    try {
      await this.#composition.runtime.stop();
      if (this.#disposed)
        return;
      await this.#composition.suspendAudio();
      if (this.#disposed)
        return;
      this.#setState("stopped", "Stopped");
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }
  async #dispose() {
    if (this.#disposed)
      return;
    this.#disposed = true;
    this.#setState("disposed", "Disposed");
    this.#cancelFrame();
    this.#input.dispose();
    this.#view.hidePauseMenu(false);
    this.#removeRuntimeListener();
    for (const remove of this.#removeListeners.splice(0))
      remove();
    this.#stateListeners.clear();
    await this.#view.exitFullscreen().catch(() => void 0);
    try {
      await this.#composition.dispose();
    } finally {
      this.#view.dispose();
    }
  }
  async #retryAudio(audioProbe) {
    this.#assertActive();
    if (this.#state !== "audio-blocked")
      return;
    if (this.#muted) {
      this.#setState("running", "Running \xB7 Muted");
      return;
    }
    const audioReady = await (audioProbe ?? this.#composition.resumeAudio());
    if (this.#disposed)
      return;
    this.#setPlayingState(audioReady);
  }
  async #toggleMute(audioProbe) {
    this.#assertActive();
    this.#muted = !this.#muted;
    this.#composition.setMuted(this.#muted);
    if (this.#muted) {
      if (this.#state === "audio-blocked") {
        this.#setState("running", "Running \xB7 Muted");
      } else {
        this.#renderState(isActivelyPlaying(this.#state) ? "Running \xB7 Muted" : this.#stateMessage);
      }
      return;
    }
    if (isActivelyPlaying(this.#state)) {
      const audioReady = await (audioProbe ?? this.#composition.resumeAudio());
      if (this.#disposed)
        return;
      this.#setPlayingState(audioReady);
    } else {
      this.#renderState(this.#stateMessage);
    }
  }
  #scheduleFrame() {
    if (this.#frameHandle !== void 0 || !isActivelyPlaying(this.#state))
      return;
    this.#frameHandle = this.#animationFrames.request((timestamp) => {
      this.#frameHandle = void 0;
      if (!isActivelyPlaying(this.#state))
        return;
      void this.#composition.runtime.pulse(timestamp, this.#input.takeSnapshot()).then(() => this.#scheduleFrame(), (error) => {
        if (error instanceof RuntimeClientError && error.record.code === "E_INVALID_STATE" && !isActivelyPlaying(this.#state))
          return;
        this.#fail(error);
      });
    });
  }
  #cancelFrame() {
    if (this.#frameHandle === void 0)
      return;
    this.#animationFrames.cancel(this.#frameHandle);
    this.#frameHandle = void 0;
  }
  async #pauseInternal() {
    this.#cancelFrame();
    this.#input.setEnabled(false);
    this.#composition.runtime.clearInput();
    try {
      await this.#composition.runtime.pause();
      if (this.#disposed)
        return;
      await this.#composition.suspendAudio();
      if (this.#disposed)
        return;
      this.#view.hidePauseMenu(false);
      this.#setState("paused", "Paused");
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }
  #pauseForEnvironment() {
    this.#enqueue(async () => {
      if (!isActivelyPlaying(this.#state) && this.#state !== "menu-open" || this.#environmentPaused)
        return;
      this.#environmentPaused = true;
      await this.#pauseInternal();
    });
  }
  #resumeFromEnvironment() {
    this.#enqueue(async (actions) => {
      if (!this.#environmentPaused || this.#document.visibilityState === "hidden")
        return;
      this.#environmentPaused = false;
      if (this.#state === "paused")
        await actions.resume();
    });
  }
  #onRuntimeEvent(event) {
    if (event.type === "state" || event.type === "frame") {
      this.#input.setDevkitFlags(event.devkitFlags);
    }
    if (event.type === "state" && event.state === "stopped" && isActivelyPlaying(this.#state)) {
      this.#cancelFrame();
      this.#input.setEnabled(false);
      this.#input.setDevkitFlags(0);
      this.#composition.runtime.clearInput();
      this.#setState("stopped", "Cartridge stopped");
      this.#enqueue(async () => {
        if (this.#state === "stopped")
          await this.#composition.suspendAudio();
      });
      return;
    }
    if (event.type === "diagnostic") {
      this.#view.showDiagnostic(`${event.error.code}: ${event.error.message}`);
    } else if (event.type === "fault") {
      this.#fail(new RuntimeClientError(event.error));
    } else if (event.type === "pause-menu" && !event.open) {
      this.#view.hidePauseMenu(false);
    }
  }
  #fail(error) {
    if (this.#disposed || this.#state === "faulted")
      return;
    this.#cancelFrame();
    this.#input.setEnabled(false);
    this.#input.setDevkitFlags(0);
    this.#composition.runtime.clearInput();
    this.#view.hidePauseMenu(false);
    const message2 = error instanceof RuntimeClientError ? `${error.record.code}: ${error.record.message}` : error instanceof Error ? error.message : String(error);
    this.#view.showDiagnostic(message2);
    this.#setState("faulted", "Faulted");
  }
  #setState(state, text) {
    this.#state = state;
    this.#stateMessage = text;
    this.#renderState(text);
  }
  #renderState(text) {
    this.#stateMessage = text;
    this.#view.render({
      state: this.#state,
      message: text,
      hasRetainedCart: this.#composition.runtime.hasRetainedCart,
      muted: this.#muted
    });
    for (const listener of this.#stateListeners) {
      listener({ state: this.#state, message: text });
    }
  }
  #setPlayingState(audioReady) {
    if (audioReady) {
      this.#setState("running", this.#muted ? "Running \xB7 Muted" : "Running");
    } else {
      this.#setState("audio-blocked", "Running without audio \xB7 Select Enable audio to try again");
    }
  }
  async #resumeAfterMenu() {
    this.#view.hidePauseMenu(true);
    this.#composition.runtime.clearInput();
    const audioReady = this.#muted ? true : this.#menuWasAudioBlocked ? false : await this.#composition.resumeAudio();
    if (this.#disposed)
      return;
    this.#input.setEnabled(true);
    this.#setPlayingState(audioReady);
    this.#scheduleFrame();
  }
  #decodeMenuItems(items) {
    return items.map((item) => ({
      slot: item.slot,
      label: decodeP8sciiLabel(new Uint8Array(item.label)),
      filter: item.filter
    }));
  }
  #menuSlot(button2) {
    const raw = Number(button2.dataset.menuSlot);
    return raw >= 1 && raw <= 5 && Number.isInteger(raw) ? raw : void 0;
  }
  #menuFiltered(button2, intent) {
    return (Number(button2.dataset.menuFilter ?? 0) >> 8 & intent) !== 0;
  }
  #onPauseMenuKeydown(event) {
    if (this.#state !== "menu-open")
      return;
    const buttons = this.#view.pauseMenuButtons();
    const current = event.target instanceof HTMLButtonElement ? buttons.indexOf(event.target) : -1;
    if (event.key === "Escape") {
      event.preventDefault();
      this.#enqueue((actions) => actions.closePauseMenu());
      return;
    }
    if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : event.key === "ArrowUp" ? current <= 0 ? buttons.length - 1 : current - 1 : (current + 1) % buttons.length;
      for (const [index, button2] of buttons.entries())
        button2.tabIndex = index === next ? 0 : -1;
      buttons[next]?.focus();
      return;
    }
    const target = current < 0 ? void 0 : buttons[current];
    if (target === void 0)
      return;
    const slot = this.#menuSlot(target);
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      if (slot === void 0)
        return;
      event.preventDefault();
      const intent = event.key === "ArrowLeft" ? 1 : 2;
      if (!this.#menuFiltered(target, intent)) {
        this.#enqueue((actions) => actions.invokeMenuItem(slot, intent));
      }
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (slot === void 0)
        this.#enqueue((actions) => actions.closePauseMenu());
      else if (!this.#menuFiltered(target, 4)) {
        this.#enqueue((actions) => actions.invokeMenuItem(slot, 4));
      }
    }
  }
  #loadLocalFiles(files) {
    if (this.#lifecycle.closed)
      return;
    const validation = validateLocalCartSelection(files);
    if (!validation.ok) {
      this.#view.showDiagnostic(validation.message);
      return;
    }
    const file = files[0];
    this.#enqueue(async (actions) => {
      let bytes;
      try {
        bytes = new Uint8Array(await file.arrayBuffer());
      } catch (error) {
        this.#showUiError(error);
        return;
      }
      if (this.#lifecycle.closed)
        return;
      await actions.loadCart(bytes, file.name);
      await actions.start();
    });
  }
  #drag(event) {
    if (this.#state === "loading" || this.#state === "disposed")
      return;
    event.preventDefault();
    if (event.dataTransfer !== null)
      event.dataTransfer.dropEffect = "copy";
    this.#view.setDropActive(true);
  }
  #showUiError(error) {
    if (this.#disposed)
      return;
    const message2 = error instanceof Error ? error.message : String(error);
    this.#view.showDiagnostic(message2);
  }
  #enqueue(operation) {
    void this.runLifecycle(operation).catch((error) => {
      if (!this.#lifecycle.closed)
        this.#fail(error);
    });
  }
  #bind(target, type, listener) {
    target.addEventListener(type, listener);
    this.#removeListeners.push(() => target.removeEventListener(type, listener));
  }
  #assertActive() {
    if (this.#disposed)
      throw new Error("PlayerController is disposed");
  }
};

// apps/web-player/dist/main/compose-player.js
var AUDIO_RESUME_PROBE_TIMEOUT_MS = 250;
var PlayerComposition = class _PlayerComposition {
  runtime;
  presenter;
  audio;
  #removeRuntimeListener;
  #removeGenerationListener;
  #disposed = false;
  constructor(runtime, presenter, audio) {
    this.runtime = runtime;
    this.presenter = presenter;
    this.audio = audio;
    this.#removeRuntimeListener = runtime.onEvent((event) => {
      if (event.type !== "frame")
        return;
      presenter.present({
        sessionGeneration: event.sessionGeneration,
        frameId: event.frameId,
        packedScreen: new Uint8Array(event.packedScreen),
        displayPalette: new Uint8Array(event.displayPalette)
      });
    });
    this.#removeGenerationListener = runtime.onSessionGenerationChange((sessionGeneration) => {
      presenter.reset(sessionGeneration);
      audio?.attach(runtime);
    });
  }
  static async create(options) {
    if (options.commandTimeoutMs !== void 0 && (!Number.isFinite(options.commandTimeoutMs) || options.commandTimeoutMs <= 0)) {
      throw new RangeError("commandTimeoutMs must be positive");
    }
    if (options.useDefaultAssets === true && options.runtimeWorkerFactory !== void 0) {
      throw new TypeError("default assets and a custom Worker factory are mutually exclusive");
    }
    const runtimeWorkerFactory = options.useDefaultAssets === true ? () => new Worker(new URL("../browser/player-worker.mjs", import.meta.url), { type: "module" }) : options.runtimeWorkerFactory;
    const workletModuleUrl = options.useDefaultAssets === true ? new URL("../worklet/pico8-audio-processor.js", import.meta.url) : options.workletModuleUrl;
    const useWorker = options.execution === "worker" || options.runtimeWorkerFactory !== void 0;
    if (useWorker && runtimeWorkerFactory === void 0)
      throw new TypeError("a runtime Worker factory is required");
    const runtime = useWorker ? new PlayerRuntimeClient(runtimeWorkerFactory, {
      ...options.commandTimeoutMs === void 0 ? {} : { commandTimeoutMs: options.commandTimeoutMs }
    }) : await createPlayerSession();
    const presenter = new Canvas2DFramePresenter(options.canvas);
    presenter.reset(runtime.sessionGeneration);
    let audio;
    try {
      if (workletModuleUrl !== void 0) {
        audio = await DedicatedAudioFrontend.create(runtime, workletModuleUrl, options.audio);
      }
      return new _PlayerComposition(runtime, presenter, audio);
    } catch (error) {
      await audio?.dispose().catch(() => void 0);
      presenter.dispose();
      await runtime.dispose().catch(() => void 0);
      throw error;
    }
  }
  async resumeAudio() {
    this.#assertActive();
    if (this.audio === void 0)
      return true;
    let timeout;
    try {
      await Promise.race([
        this.audio.resume(),
        new Promise((resolve) => {
          timeout = globalThis.setTimeout(resolve, AUDIO_RESUME_PROBE_TIMEOUT_MS);
        })
      ]);
      return this.audio.contextState === "running";
    } catch {
      return false;
    } finally {
      if (timeout !== void 0)
        globalThis.clearTimeout(timeout);
    }
  }
  suspendAudio() {
    this.#assertActive();
    return this.audio?.suspend() ?? Promise.resolve();
  }
  setMuted(muted) {
    this.#assertActive();
    this.audio?.setMuted(muted);
  }
  async dispose() {
    if (this.#disposed)
      return;
    this.#disposed = true;
    this.#removeRuntimeListener();
    this.#removeGenerationListener();
    this.presenter.dispose();
    await this.audio?.dispose();
    await this.runtime.dispose();
  }
  #assertActive() {
    if (this.#disposed)
      throw new Error("PlayerComposition is disposed");
  }
};
async function mountPico8Player({ root, shell, gamepadSource, ...compositionOptions }) {
  const document2 = root.ownerDocument;
  const hostWindow = document2.defaultView ?? window;
  const view = PlayerShellView.create(root, {
    window: hostWindow,
    document: document2,
    ...shell === void 0 ? {} : { shell }
  });
  const { elements } = view;
  try {
    const composition = await PlayerComposition.create({
      ...compositionOptions,
      canvas: elements.canvas
    });
    const controller = new PlayerController(composition, view, {
      window: hostWindow,
      document: document2,
      ...gamepadSource === void 0 ? {} : { gamepadSource }
    });
    return { composition, controller, elements };
  } catch (error) {
    view.showDiagnostic(error instanceof Error ? error.message : String(error));
    view.dispose();
    throw error;
  }
}

// apps/web-player/dist/main/host-persistence.js
var CONTENT_ID_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,127}$/u;
var CART_DATA_ID_PATTERN3 = /^[a-z0-9_-]{1,64}$/u;
function message(error) {
  return error instanceof Error ? error.message : String(error);
}
function copySeed(value) {
  if (typeof value?.id !== "string" || !CART_DATA_ID_PATTERN3.test(value.id) || !(value.bytes instanceof Uint8Array) || value.bytes.byteLength !== 256) {
    throw new RangeError("host persistence returned an invalid cartdata record");
  }
  return { id: value.id, bytes: value.bytes.slice() };
}
var HostPersistenceFrontend = class {
  #adapter;
  #emit;
  #contentId;
  #writeQueue = Promise.resolve();
  #lastFailure;
  #writesSinceFlush = 0;
  constructor(adapter, emit) {
    if (typeof adapter?.hydrate !== "function" || typeof adapter.write !== "function" || typeof adapter.flush !== "function") {
      throw new TypeError("persistence adapter requires hydrate, write and flush");
    }
    this.#adapter = adapter;
    this.#emit = emit;
  }
  get active() {
    return this.#contentId !== void 0;
  }
  async activate(contentId) {
    if (!CONTENT_ID_PATTERN.test(contentId)) {
      throw new RangeError("contentId must be a stable 1..128 character identifier");
    }
    const hydrated = await this.#adapter.hydrate(contentId);
    if (!Array.isArray(hydrated) || hydrated.length > 4096) {
      throw new RangeError("host persistence hydration exceeds 4096 records");
    }
    const ids = /* @__PURE__ */ new Set();
    const seeds = hydrated.map((entry) => {
      const copied = copySeed(entry);
      if (ids.has(copied.id))
        throw new RangeError("host persistence returned duplicate ids");
      ids.add(copied.id);
      return copied;
    });
    this.#contentId = contentId;
    this.#lastFailure = void 0;
    this.#writesSinceFlush = 0;
    return seeds;
  }
  enqueue(commit) {
    const contentId = this.#contentId;
    if (contentId === void 0)
      return;
    const copied = { ...copySeed(commit), revision: commit.revision };
    if (!Number.isSafeInteger(copied.revision) || copied.revision < 1) {
      throw new RangeError("cartdata commit revision must be positive");
    }
    this.#writesSinceFlush += 1;
    this.#emit({
      status: "saving",
      contentId,
      cartDataId: copied.id,
      revision: copied.revision
    });
    const write = this.#writeQueue.then(() => this.#adapter.write(contentId, copied));
    this.#writeQueue = write.then(() => {
      this.#emit({
        status: "saved",
        contentId,
        cartDataId: copied.id,
        revision: copied.revision
      });
    }, (error) => {
      this.#lastFailure = error instanceof Error ? error : new Error(message(error));
      this.#emit({
        status: "failed",
        contentId,
        cartDataId: copied.id,
        revision: copied.revision,
        message: message(error)
      });
    });
  }
  async flush(reason) {
    const contentId = this.#contentId;
    if (contentId === void 0) {
      return { status: "unchanged", reason, durable: true };
    }
    await this.#writeQueue;
    try {
      await this.#adapter.flush(contentId);
      const status = this.#writesSinceFlush > 0 ? "written" : "unchanged";
      this.#writesSinceFlush = 0;
      this.#lastFailure = void 0;
      this.#emit({ status: "saved", contentId, reason });
      return { status, reason, durable: true };
    } catch (error) {
      this.#lastFailure = error instanceof Error ? error : new Error(message(error));
      this.#emit({ status: "failed", contentId, reason, message: message(error) });
      return { status: "failed", reason, durable: false, message: message(error) };
    }
  }
};

// apps/web-player/dist/main/embed-player.js
var PICO8_WEB_PLAYER_API_VERSION = 2;
var Pico8WebPlayer = class _Pico8WebPlayer {
  #mounted;
  #firstFrameTimeoutMs;
  #listeners = /* @__PURE__ */ new Map();
  #removeSubscriptions;
  #persistence;
  #disposeRequested = false;
  #disposePromise;
  #rejectFirstFrameWaiters = /* @__PURE__ */ new Set();
  constructor(mounted, persistence, firstFrameTimeoutMs = 1e3) {
    this.#mounted = mounted;
    this.#firstFrameTimeoutMs = firstFrameTimeoutMs;
    this.#persistence = persistence === void 0 ? void 0 : new HostPersistenceFrontend(persistence, (event) => this.#emit({
      v: PICO8_WEB_PLAYER_API_VERSION,
      type: "persistence",
      ...event
    }));
    this.#removeSubscriptions = [
      mounted.controller.onStateChange((event) => {
        this.#emit({
          v: PICO8_WEB_PLAYER_API_VERSION,
          type: "state",
          state: event.state,
          message: event.message
        });
      }),
      mounted.composition.runtime.onEvent((event) => this.#onRuntimeEvent(event))
    ];
  }
  static async create(options) {
    const mounted = await mountPico8Player({
      root: options.root,
      ...options.execution === void 0 ? {} : { execution: options.execution },
      useDefaultAssets: true,
      ...options.commandTimeoutMs === void 0 ? {} : { commandTimeoutMs: options.commandTimeoutMs },
      ...options.audio === void 0 ? {} : { audio: options.audio },
      ...options.shell === void 0 ? {} : { shell: options.shell }
    });
    return new _Pico8WebPlayer(mounted, options.persistence, options.commandTimeoutMs ?? 1e3);
  }
  get state() {
    return this.#disposeRequested ? "disposed" : this.#mounted.controller.state;
  }
  get root() {
    return this.#mounted.elements.root;
  }
  get canvas() {
    return this.#mounted.elements.canvas;
  }
  on(type, listener) {
    this.#assertActive();
    let listeners = this.#listeners.get(type);
    if (listeners === void 0) {
      listeners = /* @__PURE__ */ new Set();
      this.#listeners.set(type, listeners);
    }
    const erased = listener;
    listeners.add(erased);
    return () => listeners?.delete(erased);
  }
  loadCart(source, options = {}) {
    return this.#enqueue(async (actions) => {
      let hostCartData;
      if (this.#persistence !== void 0) {
        if (options.contentId === void 0) {
          throw new TypeError("contentId is required with a host persistence adapter");
        }
        if (this.#persistence.active) {
          await actions.stop();
          const flushed = await this.#flushPersistenceInternal("cart-switch");
          if (!flushed.durable)
            throw new Error(flushed.message ?? "Cart switch persistence failed");
        }
        hostCartData = await this.#persistence.activate(options.contentId);
        this.#assertActive();
      }
      await actions.loadCart(source, {
        ...options,
        ...hostCartData === void 0 ? {} : { hostCartData }
      });
    });
  }
  start() {
    return this.#enqueue(async (actions) => {
      if (this.#mounted.controller.state !== "ready") {
        await actions.start();
        return;
      }
      const sessionGeneration = this.#mounted.composition.runtime.sessionGeneration;
      const gate = this.#waitForPresentedFrame(sessionGeneration);
      void gate.promise.catch(() => void 0);
      try {
        await actions.start();
        await gate.promise;
      } catch (error) {
        if (!this.#disposeRequested && ["running", "audio-blocked"].includes(this.#mounted.controller.state)) {
          await actions.stop().catch(() => void 0);
        }
        throw error;
      } finally {
        gate.release();
      }
    });
  }
  pause() {
    return this.#enqueue((actions) => actions.pause());
  }
  resume() {
    return this.#enqueue((actions) => actions.resume());
  }
  reset() {
    return this.#enqueue((actions) => actions.reset());
  }
  stop() {
    return this.#enqueue((actions) => actions.stop());
  }
  /** Replaces the caller-owned input snapshot without entering the lifecycle queue. */
  setInput(snapshot) {
    this.#assertActive();
    this.#mounted.controller.setInput(snapshot);
  }
  flushPersistence(reason = "explicit") {
    return this.#enqueue(() => this.#flushPersistenceInternal(reason));
  }
  handleLifecycle(event) {
    return this.#enqueue(async (actions) => {
      if (event === "active")
        return { status: "handled", event };
      this.#mounted.controller.clearInput();
      if (["running", "audio-blocked", "menu-open"].includes(this.#mounted.controller.state)) {
        await actions.pause();
      }
      if (event === "background")
        return this.#flushPersistenceInternal("background");
      return { status: "handled", event };
    });
  }
  dispose() {
    if (this.#disposePromise !== void 0)
      return this.#disposePromise;
    this.#disposeRequested = true;
    const disposed = new Error("Pico8WebPlayer was disposed before its first frame");
    for (const reject of [...this.#rejectFirstFrameWaiters])
      reject(disposed);
    this.#emit({
      v: PICO8_WEB_PLAYER_API_VERSION,
      type: "state",
      state: "disposed",
      message: "Disposed"
    });
    this.#listeners.clear();
    this.#disposePromise = this.#mounted.controller.dispose({
      beforeDispose: async (actions) => {
        await actions.stop().catch(() => void 0);
        if (this.#mounted.controller.state !== "idle") {
          await this.#mounted.composition.runtime.flushPersistence().catch(() => void 0);
        }
      },
      afterDispose: async () => {
        try {
          await this.#persistence?.flush("dispose");
        } finally {
          for (const remove of this.#removeSubscriptions.splice(0))
            remove();
        }
      }
    });
    return this.#disposePromise;
  }
  #enqueue(operation) {
    if (this.#disposeRequested) {
      return Promise.reject(new Error("Pico8WebPlayer is disposed"));
    }
    return this.#mounted.controller.runLifecycle(async (actions) => {
      this.#assertActive();
      const value = await operation(actions);
      this.#assertActive();
      return value;
    });
  }
  #onRuntimeEvent(event) {
    if (event.type === "cartdata-commit") {
      this.#persistence?.enqueue({
        id: event.id,
        revision: event.revision,
        bytes: new Uint8Array(event.bytes).slice()
      });
    } else if (event.type === "frame") {
      this.#emit({
        v: PICO8_WEB_PLAYER_API_VERSION,
        type: "frame",
        sessionGeneration: event.sessionGeneration,
        frameId: event.frameId,
        targetFps: event.targetFps,
        cpuInstructions: event.cpuInstructions,
        cpuFractionRaw: event.cpuFractionRaw,
        slowFrame: event.slowFrame,
        packedScreen: new Uint8Array(event.packedScreen).slice(),
        displayPalette: new Uint8Array(event.displayPalette).slice()
      });
    } else if (event.type === "diagnostic" || event.type === "fault") {
      this.#emit({
        v: PICO8_WEB_PLAYER_API_VERSION,
        type: event.type,
        error: {
          ...event.error,
          ...event.error.details === void 0 ? {} : { details: { ...event.error.details } }
        }
      });
    }
  }
  #waitForPresentedFrame(sessionGeneration) {
    let settled = false;
    let removeRuntimeListener = () => {
    };
    let removeStateListener = () => {
    };
    let timeout;
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve2, reject2) => {
      resolvePromise = resolve2;
      rejectPromise = reject2;
    });
    const cleanup = () => {
      if (timeout !== void 0)
        globalThis.clearTimeout(timeout);
      removeRuntimeListener();
      removeStateListener();
      this.#rejectFirstFrameWaiters.delete(reject);
    };
    const resolve = () => {
      if (settled)
        return;
      settled = true;
      cleanup();
      resolvePromise();
    };
    const reject = (reason) => {
      if (settled)
        return;
      settled = true;
      cleanup();
      rejectPromise(reason);
    };
    const release = () => {
      if (settled)
        return;
      settled = true;
      cleanup();
    };
    this.#rejectFirstFrameWaiters.add(reject);
    removeRuntimeListener = this.#mounted.composition.runtime.onEvent((event) => {
      if (event.sessionGeneration !== sessionGeneration)
        return;
      if (event.type === "frame") {
        const frameId = event.frameId;
        globalThis.queueMicrotask(() => {
          if (this.#mounted.composition.presenter.sessionGeneration === sessionGeneration && this.#mounted.composition.presenter.lastFrameId >= frameId)
            resolve();
        });
      } else if (event.type === "fault") {
        reject(new RuntimeClientError(event.error));
      }
    });
    removeStateListener = this.#mounted.controller.onStateChange(({ state }) => {
      if (["faulted", "stopped", "disposed"].includes(state)) {
        reject(new Error(`Pico8WebPlayer entered ${state} before its first frame`));
      }
    });
    timeout = globalThis.setTimeout(() => reject(new RuntimeClientError({
      code: "E_VM_WATCHDOG",
      message: "PICO-8 Web Player did not present its first frame before the command deadline",
      phase: "none",
      recoverable: true,
      details: { sessionGeneration }
    })), this.#firstFrameTimeoutMs);
    return { promise, release };
  }
  async #flushPersistenceInternal(reason) {
    const result = await this.#mounted.composition.runtime.flushPersistence();
    if (result.type !== "persistence-flushed" || !result.durable) {
      return {
        status: "failed",
        reason,
        durable: false,
        message: result.type === "persistence-flushed" ? result.message ?? "Persistence was not durably flushed" : "Runtime did not acknowledge persistence flush"
      };
    }
    if (this.#persistence === void 0) {
      return { status: "flushed", reason, durable: true };
    }
    return this.#persistence.flush(reason);
  }
  #emit(event) {
    if (this.#disposeRequested && event.type !== "state")
      return;
    const listeners = this.#listeners.get(event.type);
    if (listeners === void 0)
      return;
    for (const listener of [...listeners])
      listener(event);
  }
  #assertActive() {
    if (this.#disposeRequested)
      throw new Error("Pico8WebPlayer is disposed");
  }
};
function createPico8WebPlayer(options) {
  return Pico8WebPlayer.create(options);
}

// apps/web-player/dist/runtime/standalone-session.js
var PICO8_SESSION_API_VERSION = 1;
var PICO8_AUDIO_EVENT_LIMIT = 32;
var Pico8Session = class _Pico8Session {
  #runtime;
  #queue = new PlayerLifecycleQueue();
  #id = globalThis.crypto.randomUUID();
  #remove;
  #revision = 0;
  #state = "empty";
  #frame;
  #diagnostics = [];
  #frameCount = 0;
  #disposal;
  #inspection;
  constructor(runtime, inspection) {
    this.#runtime = runtime;
    this.#inspection = inspection;
    this.#remove = [
      runtime.onSessionGenerationChange(() => {
        this.#frame = void 0;
      }),
      runtime.onEvent((event) => {
        if (event.type === "state")
          this.#state = event.state;
        if (event.type === "frame") {
          this.#frame = event;
          this.#frameCount++;
        }
        if (event.type === "fault" || event.type === "diagnostic") {
          if (event.type === "fault")
            this.#state = "faulted";
          this.#diagnostics.push(event.error);
          if (this.#diagnostics.length > 64)
            this.#diagnostics.shift();
        }
      })
    ];
  }
  static async create(options = {}) {
    if (options.inspection && options.persistence === "indexeddb")
      throw new TypeError("inspection requires memory persistence");
    if (options.persistence !== void 0 && !["memory", "indexeddb"].includes(options.persistence)) {
      throw new TypeError("unknown persistence profile");
    }
    return new _Pico8Session(await createPlayerSession(options.persistence === "indexeddb", options.inspection === true), options.inspection === true);
  }
  loadCart(bytes, options = {}) {
    if (!(bytes instanceof Uint8Array))
      return Promise.reject(new TypeError("cart bytes must be Uint8Array"));
    const copy = bytes.slice();
    const bundle = options.localCartBundle?.map((entry) => ({ ref: entry.ref, bytes: entry.bytes.slice(), access: { ...entry.access } }));
    return this.#queue.run(async () => {
      this.#revision++;
      this.#frame = void 0;
      this.#diagnostics = [];
      this.#state = "loading";
      try {
        await this.#runtime.loadCart(copy, options.instructionBudget, bundle);
      } catch (error) {
        if (this.#state !== "faulted")
          throw error;
      }
      return this.observe();
    });
  }
  loadSource(source, options = {}) {
    if (typeof source !== "string")
      return Promise.reject(new TypeError("Lua source must be a string"));
    if (/^__[a-zA-Z0-9_]+__\s*$/m.test(source))
      return Promise.reject(new TypeError("use loadCart for cartridge sections"));
    return this.loadCart(new TextEncoder().encode(`pico-8 cartridge // http://www.pico-8.com
version 43
__lua__
${source}
`), options);
  }
  reset() {
    return this.#queue.run(async () => {
      this.#diagnostics = [];
      this.#frame = void 0;
      try {
        await this.#runtime.reset();
      } catch (error) {
        if (this.#state !== "faulted")
          throw error;
      }
      return this.observe();
    });
  }
  advance(options) {
    if (!Number.isInteger(options.frames) || options.frames < 1 || options.frames > 600) {
      return Promise.reject(new RangeError("frames must be an integer between 1 and 600"));
    }
    const requestedFrames = options.frames;
    const raw = options.input ?? PICO_EMPTY_INPUT;
    if (!isPicoInputSnapshot(raw))
      return Promise.reject(new TypeError("invalid input snapshot"));
    const input = { controllers: raw.controllers.slice(), devkit: { ...raw.devkit, keypresses: raw.devkit.keypresses.slice() } };
    return this.#queue.run(async () => {
      const generation = this.#runtime.sessionGeneration;
      const before = this.#frameCount;
      let outcome = "completed";
      const audio = [];
      let audioDropped = 0;
      const collectAudio = () => {
        if (!this.#inspection || this.#runtime.sessionGeneration !== generation)
          return;
        const log = this.#runtime.takeAudioEvents();
        const frameId = this.#frame?.frameId ?? null;
        audioDropped += log.dropped;
        for (const event of log.events) {
          if (audio.length >= PICO8_AUDIO_EVENT_LIMIT) {
            audioDropped++;
            continue;
          }
          audio.push("sfx" in event ? { frameId, sfx: event.sfx, channel: event.channel, overMusic: event.music } : { frameId, music: event.music });
        }
      };
      if (!["ready", "paused"].includes(this.#state))
        throw new Error("advance requires a ready or paused session");
      try {
        if (this.#state === "ready")
          await this.#runtime.start();
        else
          await this.#runtime.resume();
        for (let i = 0; i < requestedFrames; i++) {
          if (this.#queue.closed) {
            outcome = "interrupted";
            break;
          }
          const framesBefore = this.#frameCount;
          const snapshot = i === 0 ? input : { controllers: input.controllers, devkit: {
            ...input.devkit,
            wheelRaw: 0,
            movementXRaw: 0,
            movementYRaw: 0,
            keypresses: []
          } };
          await this.#runtime.step(snapshot);
          collectAudio();
          if (this.#runtime.sessionGeneration !== generation) {
            outcome = "session-replaced";
            break;
          }
          if (this.#state === "stopped") {
            outcome = "stopped";
            break;
          }
          if (this.#frameCount === framesBefore) {
            outcome = "interrupted";
            break;
          }
          if ((i + 1) % 8 === 0)
            await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
        }
      } catch (error) {
        if (this.#state !== "faulted")
          throw error;
        outcome = "faulted";
      } finally {
        if (this.#state === "running")
          await this.#runtime.pause();
        this.#runtime.clearInput();
      }
      if (outcome === "faulted") {
        try {
          collectAudio();
        } catch {
        }
      }
      return {
        requestedFrames,
        completedFrames: this.#frameCount - before,
        outcome,
        observation: this.observe(),
        ...this.#inspection ? { audio: { events: audio, dropped: audioDropped } } : {}
      };
    });
  }
  inspect(request) {
    const prepared = prepareInspection(request);
    return this.#queue.run(async () => {
      if (!this.#frame || !["ready", "paused"].includes(this.#state))
        throw new Error("inspect requires a completed frame");
      return this.#runtime.inspect(prepared);
    });
  }
  /** Non-destructive log snapshot. Cursor is local to this loaded VM generation. */
  readLogs(after = 0) {
    if (!Number.isInteger(after) || after < 0 || after > 4294967295)
      throw new TypeError("invalid log cursor");
    const snapshot = this.#runtime.snapshotLogs();
    const first = snapshot.entries[0]?.sequence ?? snapshot.sequence + 1;
    return {
      cursor: snapshot.sequence,
      dropped: Math.max(0, first - after - 1),
      entries: snapshot.entries.filter((entry) => entry.sequence > after).map((entry) => ({
        sequence: entry.sequence,
        frameId: entry.frameId,
        text: Array.from(entry.bytes, (byte) => byte >= 32 && byte <= 126 || byte === 10 || byte === 9 ? String.fromCharCode(byte) : "\\x" + byte.toString(16).padStart(2, "0")).join(""),
        truncated: entry.truncated
      }))
    };
  }
  /** Pure snapshot: does not run guest code or consume diagnostic/input events. */
  observe() {
    const frame = this.#frame;
    let snapshot = null;
    if (frame !== void 0) {
      const rgba = new Uint8ClampedArray(PICO_RGBA_FRAME_BYTES);
      const packedScreen = new Uint8Array(frame.packedScreen).slice();
      const displayPalette = new Uint8Array(frame.displayPalette).slice();
      decodePackedPicoFrame(packedScreen, rgba, void 0, displayPalette);
      snapshot = {
        frameId: frame.frameId,
        targetFps: frame.targetFps,
        cpuInstructions: frame.cpuInstructions,
        slowFrame: frame.slowFrame,
        width: 128,
        height: 128,
        rgba,
        packedScreen,
        displayPalette
      };
    }
    return {
      v: 1,
      sessionId: this.#id,
      revision: this.#revision,
      generation: this.#runtime.sessionGeneration,
      state: this.#queue.closed ? "disposed" : this.#state,
      frame: snapshot,
      diagnostics: this.#diagnostics.map((error) => ({ ...error, ...error.details === void 0 ? {} : { details: { ...error.details } } }))
    };
  }
  dispose() {
    return this.#disposal ??= this.#queue.close(async () => {
      try {
        await this.#runtime.dispose();
      } finally {
        this.#remove.forEach((remove) => remove());
        this.#frame = void 0;
        this.#state = "disposed";
      }
    });
  }
};
function createPico8Session(options) {
  return Pico8Session.create(options);
}

// apps/web-player/dist/runtime/session-tool.js
var PICO8_SESSION_TOOL = {
  name: "pico8_session",
  description: "Load PICO-8 Lua, advance exact frames with held buttons, observe, reset or dispose a session.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["load_source", "advance", "observe", "reset", "dispose"] },
      source: { type: "string", description: "PICO-8 Lua source for load_source; resources use the session loadCart API." },
      frames: { type: "integer", minimum: 1, maximum: 600 },
      buttons: { type: "integer", minimum: 0, maximum: 63, description: "Player 1 held bitmask: left=1, right=2, up=4, down=8, O=16, X=32. Default releases all buttons." },
      image: { type: "boolean", description: "Include base64 RGBA8 pixels; defaults to true." }
    },
    required: ["action"],
    additionalProperties: false
  }
};
function base64(bytes) {
  let text = "";
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 4096));
  }
  return btoa(text);
}
function serialize(observation, image) {
  const frame = observation.frame;
  return { ...observation, frame: frame === null ? null : {
    frameId: frame.frameId,
    targetFps: frame.targetFps,
    cpuInstructions: frame.cpuInstructions,
    slowFrame: frame.slowFrame,
    width: frame.width,
    height: frame.height,
    ...image ? { encoding: "rgba8-base64", data: base64(frame.rgba) } : {}
  } };
}
function createPico8SessionTool(session) {
  return {
    ...PICO8_SESSION_TOOL,
    async execute(value) {
      if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new TypeError("tool arguments must be an object");
      const args = value;
      if (Object.keys(args).some((key) => !["action", "source", "frames", "buttons", "image"].includes(key))) {
        throw new TypeError("unknown tool argument");
      }
      if (args.image !== void 0 && typeof args.image !== "boolean")
        throw new TypeError("image must be boolean");
      const image = args.image !== false;
      if (args.action === "load_source") {
        if (typeof args.source !== "string")
          throw new TypeError("source is required");
        return { observation: serialize(await session.loadSource(args.source), image) };
      }
      if (args.action === "advance") {
        const buttons = args.buttons ?? 0;
        if (!Number.isInteger(buttons) || Number(buttons) < 0 || Number(buttons) > 63)
          throw new RangeError("buttons must be 0\u201363");
        if (typeof args.frames !== "number")
          throw new TypeError("frames is required");
        const result = await session.advance({ frames: args.frames, input: {
          controllers: PICO_EMPTY_INPUT.controllers.map((_, index) => index === 0 ? Number(buttons) : 0),
          devkit: PICO_EMPTY_INPUT.devkit
        } });
        return { ...result, observation: serialize(result.observation, image) };
      }
      if (args.action === "reset")
        return { observation: serialize(await session.reset(), image) };
      if (args.action === "observe")
        return { observation: serialize(session.observe(), image) };
      if (args.action === "dispose") {
        await session.dispose();
        return { observation: serialize(session.observe(), image) };
      }
      throw new TypeError("unknown tool action");
    }
  };
}
export {
  INSPECTION_LIMITS,
  PICO8_SESSION_API_VERSION,
  PICO8_SESSION_TOOL,
  PICO8_WEB_PLAYER_API_VERSION,
  Pico8Session,
  Pico8WebPlayer,
  createPico8Session,
  createPico8SessionTool,
  createPico8WebPlayer,
  decodeP8,
  prepareInspection
};
