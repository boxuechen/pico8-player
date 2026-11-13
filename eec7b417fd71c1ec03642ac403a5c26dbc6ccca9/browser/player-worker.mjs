// apps/web-player/src/worker/player-worker-entry.mjs
import createZ8LuaModule from "../wasm/z8lua-runtime-v1.mjs";

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
  constructor(code, message, options = {}) {
    super(message);
    this.code = code;
    if (options.offset !== void 0)
      this.offset = options.offset;
    if (options.details !== void 0)
      this.details = options.details;
  }
};
function codecFailure(code, message, options = {}) {
  throw new CartCodecError(code, message, options);
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
  constructor(code, message) {
    super(message);
    this.name = "CartResolutionError";
    this.code = code;
  }
};
function utf8ByteLength(value) {
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
  if (utf8ByteLength(ref) > PICO_CART_REF_MAX_BYTES) {
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
function invalidCartRequest(kind, message) {
  throw new RangeError(`invalid ${kind} request: ${message}`);
}
function decodeCartRequestRef(kind, bytes) {
  const invalid4 = (message) => invalidCartRequest(kind, message);
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
function invalid(message) {
  return invalidCartRequest("external cart-data", message);
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
function invalid2(message) {
  return invalidCartRequest("guest cart", message);
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
      for (let button = 0; button < buttonCount; button += 1) {
        const bit = 1 << button;
        if ((buttons & bit) === 0) {
          heldTicksForPlayer[button] = 0;
          continue;
        }
        const heldTicks = (heldTicksForPlayer[button] ?? 0) + 1;
        heldTicksForPlayer[button] = heldTicks;
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
    const button = q16Integer2(buttonRaw);
    const player = playerRaw === void 0 ? 0 : q16Integer2(playerRaw);
    return this.#validButton(button, player) && (this.#ram[PLAYER_ZERO_BUTTONS + player] & 1 << button) !== 0 ? 1 : 0;
  }
  btnp(buttonRaw, playerRaw) {
    if (buttonRaw === void 0) {
      return this.#pressedMasks[0] | (this.#pressedMasks[1] & PICO_CONTROLLER_BUTTON_MASK) << 8;
    }
    const button = q16Integer2(buttonRaw);
    const player = playerRaw === void 0 ? 0 : q16Integer2(playerRaw);
    return this.#validButton(button, player) && (this.#pressedMasks[player] & 1 << button) !== 0 ? 1 : 0;
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
  #validButton(button, player) {
    if (player < 0 || player >= PICO_CONTROLLER_COUNT || button < 0)
      return false;
    if (button < PICO_CONTROLLER_BUTTON_COUNT)
      return true;
    return player === 0 && button === 6 && this.#mouseButtonsEnabled();
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
function invalidState(message) {
  return {
    code: "E_INVALID_STATE",
    message,
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
  invokeMenuItem(slot, button) {
    if (this.#state !== "ready") {
      return { ok: false, error: invalidState("runtime session is not ready for menu invocation") };
    }
    const outcome = this.#vm.invokeMenuItem(slot, button, this.#instructionBudget);
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
function lifecycleError(code, message, details) {
  return {
    code,
    message,
    phase: "none",
    recoverable: false,
    ...details === void 0 ? {} : { details }
  };
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function invalid3(message, details) {
  return { ok: false, error: lifecycleError("E_INVALID_STATE", message, details) };
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
  invokeMenuItem(generation, slot, button) {
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
      result = runtime.invokeMenuItem(slot, button);
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
  invokeMenuItem(slot, button, instructionBudget) {
    this.#assertLive();
    const status = this.#module._p8w_menu_invoke(this.#handle, slot, button, checkedUint32("instructionBudget", instructionBudget, true)) >>> 0;
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
    const message = status === STATUS_HOST_API_ERROR ? (hostFailure?.message ?? bridgeMessage) || `p8w status ${status}` : bridgeMessage || `p8w status ${status}`;
    const trace = this.#text(this.#module._p8w_error_trace_ptr(this.#handle), this.#module._p8w_error_trace_length(this.#handle));
    const line = this.#module._p8w_error_line(this.#handle) | 0;
    const code = hostFailure?.code ?? failureCode(status);
    const oomDetails = code === "E_VM_OOM" ? {
      liveLuaBytes: this.#module._p8w_lua_live_bytes(this.#handle) >>> 0,
      luaHeapLimit: this.#module._p8w_lua_heap_limit(this.#handle) >>> 0
    } : void 0;
    return {
      code,
      message,
      phase: runtimePhase(this.#module._p8w_phase(this.#handle) >>> 0),
      ...line < 0 ? {} : { line },
      ...trace.length === 0 ? {} : { trace },
      ...code === "E_FEATURE_UNSUPPORTED" && message === "nested-host-suspend" ? { details: { reason: "nested-host-suspend" } } : oomDetails === void 0 ? {} : { details: oomDetails }
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

// apps/web-player/src/runtime/adapters/cart-repository-adapter.ts
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
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
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
    if (this.#disposed) return;
    this.#records.clear();
    this.#disposed = true;
  }
  #record(identity) {
    const record = this.#records.get(keyOf(identity));
    if (record === void 0) throw new Error("cart is not registered in this Worker");
    return record;
  }
  #assertLive() {
    if (this.#disposed) throw new Error("cart repository is disposed");
  }
};

// apps/web-player/src/runtime/adapters/host-cart-resolver-adapter.ts
function assertLocalRef(ref) {
  const checked = assertCartRef(ref);
  if (checked.startsWith("/") || checked.startsWith("#") || checked.includes("://") || checked.includes("\\") || checked.split("/").some((part) => part === "." || part === ".." || part.length === 0)) {
    throw new CartResolutionError(
      CART_RESOLUTION_ERROR_CODES.invalidRef,
      "local bundle ref must be a canonical relative opaque name"
    );
  }
  return checked;
}
function copyEntry(entry) {
  const ref = assertLocalRef(entry.ref);
  if (!(entry.bytes instanceof Uint8Array) || entry.bytes.byteLength === 0) {
    throw new CartResolutionError(
      CART_RESOLUTION_ERROR_CODES.invalidSource,
      "local bundle entry must contain cart bytes"
    );
  }
  if (entry.bytes.byteLength > PICO_CART_INPUT_MAX_BYTES) {
    throw new CartResolutionError(
      CART_RESOLUTION_ERROR_CODES.sourceTooLarge,
      `local bundle entry exceeds ${PICO_CART_INPUT_MAX_BYTES} bytes`
    );
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
      throw new CartResolutionError(
        CART_RESOLUTION_ERROR_CODES.bundleLimit,
        `local cart bundle exceeds ${PICO_LOCAL_CART_BUNDLE_MAX_ENTRIES} entries`
      );
    }
    for (const candidate of entries) {
      const entry = copyEntry(candidate);
      if (this.#entries.has(entry.ref)) {
        throw new CartResolutionError(
          CART_RESOLUTION_ERROR_CODES.duplicateRef,
          `local cart bundle contains duplicate ref: ${entry.ref}`
        );
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
        if (settled) return;
        settled = true;
        unsubscribe();
        action();
      };
      const cancel = () => {
        finish(() => reject(new CartResolutionError(
          CART_RESOLUTION_ERROR_CODES.cancelled,
          "cart resolution was cancelled"
        )));
      };
      try {
        unsubscribe = cancellation.onCancel(cancel);
        if (cancellation.cancelled) cancel();
      } catch (error) {
        finish(() => reject(error));
      }
      void Promise.resolve().then(() => {
        if (settled) return;
        if (this.#disposed) {
          finish(() => reject(new CartResolutionError(
            CART_RESOLUTION_ERROR_CODES.disposed,
            "local cart bundle resolver is disposed"
          )));
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
    if (this.#disposed) return;
    this.#entries.clear();
    this.#disposed = true;
  }
  #assertLive() {
    if (this.#disposed) {
      throw new CartResolutionError(
        CART_RESOLUTION_ERROR_CODES.disposed,
        "local cart bundle resolver is disposed"
      );
    }
  }
  #resolveEntry(ref, purpose) {
    this.#assertLive();
    const checkedRef = assertLocalRef(ref);
    const entry = this.#entries.get(checkedRef);
    if (entry === void 0) {
      throw new CartResolutionError(
        CART_RESOLUTION_ERROR_CODES.notFound,
        `local cart bundle does not contain ref: ${checkedRef}`
      );
    }
    assertCartAccessForPurpose(entry.access, assertCartResolvePurpose(purpose));
    return entry;
  }
};

// apps/web-player/src/runtime/compose-session.ts
function invariant(message) {
  return {
    code: "E_INVARIANT",
    message,
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
function playerLifecycleError(message, recoverable = false) {
  return {
    code: "E_INVALID_STATE",
    message,
    phase: "none",
    recoverable
  };
}
function isSerializedRuntimeError(value) {
  return value !== null && typeof value === "object" && "code" in value && typeof value.code === "string" && "message" in value && typeof value.message === "string" && "phase" in value && typeof value.phase === "string" && "recoverable" in value && typeof value.recoverable === "boolean";
}
function createSessionController(module, options = {}) {
  const audioTransport2 = options.audioTransport;
  const persistence2 = options.persistence;
  const hostRequestHandler = options.hostRequestHandler;
  const luaHeapLimit2 = options.luaHeapLimit;
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
        ...luaHeapLimit2 === void 0 ? {} : { luaHeapLimit: luaHeapLimit2 }
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
    audioTransport2?.beginGeneration(generation);
  }
  function resetAudioQueue(generation) {
    if (audioTransport2 === void 0) return;
    if (audioTransport2.sessionGeneration !== generation) {
      audioTransport2.beginGeneration(generation);
    } else {
      audioTransport2.reset();
    }
  }
  function sendAudio(slice) {
    audioTransport2?.submit(slice);
  }
  function recordPersistenceFailure(code, message, error) {
    if (localPersistenceDiagnostics.length >= 32) {
      localPersistenceDiagnostics.shift();
    }
    localPersistenceDiagnostics.push({
      code,
      message,
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
    if (persistence2 === void 0) return;
    try {
      persistence2.enqueue(commit);
    } catch (error) {
      recordPersistenceFailure(
        "E_PERSISTENCE_WRITE",
        "Unable to queue committed cartdata for durable storage",
        error
      );
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
    if (persistence2 !== void 0 && !hostPersistence) {
      try {
        diagnostics = persistence2.takeDiagnostics();
      } catch (error) {
        recordPersistenceFailure(
          "E_PERSISTENCE_READ",
          "Unable to read persistence diagnostics",
          error
        );
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
    if (hostPersistence) return { durable: true };
    if (persistence2 === void 0) {
      return { durable: false, message: "No durable persistence adapter is configured" };
    }
    try {
      const result = await persistence2.flush();
      return result ?? { durable: false, message: "Persistence adapter did not confirm durability" };
    } catch (error) {
      recordPersistenceFailure(
        "E_PERSISTENCE_WRITE",
        "Unable to durably flush committed cartdata",
        error
      );
      return { durable: false, message: error instanceof Error ? error.message : String(error) };
    }
  }
  async function hydratePersistence() {
    if (persistence2 === void 0) return;
    try {
      cartDataSeeds = await persistence2.hydrate();
    } catch (error) {
      cartDataSeeds = [];
      recordPersistenceFailure(
        "E_PERSISTENCE_READ",
        "Unable to hydrate cartdata; using an empty durable mirror",
        error
      );
    }
  }
  function useHostPersistence(records) {
    const ids = /* @__PURE__ */ new Set();
    if (records.length > PICO_CART_DATA_MAX_RECORDS) throw new RangeError("host cartdata exceeds 4096 records");
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
    if (pendingRequest !== pending) return;
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
      const loaded = await cartLoader.load(
        request.ref,
        { ...current2 === void 0 ? {} : { current: current2 }, purpose: "load" },
        pending.cancellation.token
      );
      if (pendingRequest !== pending || pending.cancellation.token.cancelled || pending.sessionGeneration !== sessionGeneration) return;
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
      if (request.breadcrumb !== void 0) breadcrumbDepth++;
      inputSequence = -1;
      clearInputState();
      mode = boot.value.mode;
      targetFps = boot.value.targetFps;
      devkitFlags = boot.value.devkitFlags;
      scheduler.reset();
      scheduler.configure(targetFps);
      lifecycle = pending.continueRunning ? "running" : "ready";
      if (pending.continueRunning) scheduler.start();
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
        stateForGeneration(
          context,
          nextSessionGeneration,
          pending.continueRunning ? "running" : "ready"
        )
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
    if (!externalCartDataIsCurrent(pending)) return;
    pendingRequest = void 0;
    pending.emit(pending.resume(new Uint8Array(), true));
  }
  async function completeExternalCartData(pending, request, range, cstoreSnapshot) {
    try {
      const current2 = session.cart?.identity;
      const loaded = await cartLoader.load(
        request.ref,
        {
          ...current2 === void 0 ? {} : { current: current2 },
          purpose: request.operation
        },
        pending.cancellation.token
      );
      if (!externalCartDataIsCurrent(pending)) return;
      if (request.operation === "reload") {
        const bytes = cartRepository.readData(
          loaded.cart.identity,
          range.source,
          range.length
        );
        if (!externalCartDataIsCurrent(pending)) return;
        const written = session.writeSuspendedLogicalRam(
          pending.runtimeGeneration,
          range.destination,
          bytes
        );
        if (!written.ok) throw written.error;
      } else {
        if (cstoreSnapshot === void 0 || cstoreSnapshot.byteLength !== range.length) {
          throw new Error("external cstore snapshot invariant failed");
        }
        if (range.length !== 0) {
          const target = loaded.cart.identity.contentSha256;
          if (!externalCstoreTargetIdentities.has(target) && externalCstoreTargetIdentities.size >= 64) {
            throw new RangeError("external cstore reached its 64-target execution limit");
          }
          cartRepository.writeDataOverlay(
            loaded.cart.identity,
            range.destination,
            cstoreSnapshot
          );
          externalCstoreTargetIdentities.add(target);
        }
      }
      if (!externalCartDataIsCurrent(pending)) return;
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
      const range = request.operation === "reload" ? normalizeReloadRange(
        request.destinationRaw,
        request.sourceRaw,
        request.lengthRaw
      ) : normalizeCstoreRange(
        request.destinationRaw,
        request.sourceRaw,
        request.lengthRaw
      );
      const cstoreSnapshot = request.operation === "cstore" ? session.copySuspendedLogicalRam(
        hostRequest.generation,
        range.source,
        range.length
      ) : void 0;
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
      void completeExternalCartData(
        pending,
        request,
        range,
        cstoreSnapshot?.value
      );
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
    if (pendingRequest !== pending || pending.cancellation.token.cancelled || pending.sessionGeneration !== sessionGeneration) return;
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
    void Promise.resolve().then(() => hostRequestHandler.handle(handlerRequest, cancellation.token)).then(
      (completion) => completePendingHostRequest(pending, completion),
      () => completePendingHostRequest(pending, void 0)
    );
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
      if (!current2.ok) return [...events, fault(context, current2.error)];
      if (current2.value.kind === "host-request") {
        const request = current2.value.request;
        return [...events, ...suspendHostRequest(context, request, (response, isError) => acceptBoot(
          context,
          session.completeHostRequest(
            request.generation,
            request.id,
            response,
            isError
          ),
          continueRunning
        ))];
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
    if (context.sessionGeneration !== sessionGeneration || context.sequence <= inputSequence || lifecycle !== "running") return;
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
      if (pendingKeypresses.length >= PICO_DEVKIT_KEYPRESS_BATCH_LIMIT) break;
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
    if (!result.ok) return [fault(context, result.error)];
    if (result.value.kind === "host-request") {
      const request = result.value.request;
      return suspendHostRequest(context, request, (response, isError) => acceptVsyncHostCompletion(
        context,
        session.completeHostRequest(
          request.generation,
          request.id,
          response,
          isError
        ),
        executedBefore,
        droppedTicks
      ));
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
      if (index === 0) clearPendingDevkitEvents();
      if (!result.ok) {
        events.push(fault(context, result.error));
        return events;
      }
      if (result.value.kind === "host-request") {
        const request = result.value.request;
        return [...events, ...suspendHostRequest(context, request, (response, isError) => acceptVsyncHostCompletion(
          context,
          session.completeHostRequest(
            request.generation,
            request.id,
            response,
            isError
          ),
          executedTicks,
          decision.droppedTicks
        ))];
      }
      executedTicks += 1;
      events.push(...acceptCompletedStep(context, result.value));
      if (result.value.kind !== "frame") break;
    }
    events.push(heartbeatEvent(context, executedTicks, decision.droppedTicks));
    return events;
  }
  function generationFault(context, message) {
    return [{ ...playerBase(context), type: "fault", error: playerLifecycleError(message) }];
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
    if (load.hostCartData !== void 0) useHostPersistence(load.hostCartData);
    let nextResolver;
    try {
      nextResolver = new LocalCartBundleResolver(
        (load.localCartBundle ?? []).map((entry) => ({
          ref: entry.ref,
          bytes: entry.bytes,
          access: entry.access
        }))
      );
      const cart = decodeCart(load.source, {
        p8: {
          includeResolver(specifier) {
            try {
              return nextResolver?.resolveImmediate(specifier, "include").bytes;
            } catch (error) {
              if (error instanceof CartResolutionError) return void 0;
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
      if (session.cart !== void 0) session.stop();
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
      return [fault(context, invariant(
        error instanceof Error ? error.message : String(error)
      ))];
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
    if (generation > 0) resetAudioQueue(generation);
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
    if (!snapshot.ok) return [fault(context, snapshot.error)];
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
    const invoked = session.invokeMenuItem(
      snapshot.generation,
      context.slot,
      context.button
    );
    if (!invoked.ok) {
      return invoked.error.code === "E_INVALID_STATE" ? generationFault(context, invoked.error.message) : [fault(context, invoked.error)];
    }
    if (invoked.value.cartDataCommit !== void 0) {
      enqueueCartDataCommit(invoked.value.cartDataCommit);
    }
    if (invoked.value.kind === "keep-open") {
      activeMenuSnapshot = invoked.value.snapshot;
      return [pauseMenuEvent(
        context,
        true,
        "keep-open",
        invoked.value.snapshot
      )];
    }
    activeMenuSnapshot = void 0;
    clearInputState();
    scheduler.resume();
    lifecycle = "running";
    return [
      pauseMenuEvent(
        context,
        false,
        invoked.value.kind === "removed" ? "removed" : "closed"
      ),
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
    if (!stopped.ok) return [fault(context, stopped.error)];
    lifecycle = "stopped";
    resetAudioQueue(context.sessionGeneration);
    return [state(context, "stopped")];
  }
  function current(context, action) {
    return context.sessionGeneration !== sessionGeneration || sessionGeneration === 0 ? generationFault(context, "operation belongs to a stale or missing session") : action();
  }
  function replaceSession(context, action, prepareSeeds) {
    if (persistence2 === void 0) return action();
    return (async () => {
      if (context.sessionGeneration > sessionGeneration && lifecycle !== "disposed") {
        await flushPersistence();
        await prepareSeeds();
      }
      return perform(context, action);
    })();
  }
  function perform(context, action, flush = false) {
    if (persistence2 === void 0) return action();
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
      if (!options.inspection) throw new Error("inspection is disabled for this session");
      if (!["ready", "paused"].includes(lifecycle) || pendingRequest !== void 0) throw new Error("inspection requires a paused frame boundary");
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
        if (!hostPersistence) return hydratePersistence();
      });
    },
    dispose(context) {
      const events = disposeSync(context);
      if (persistence2 === void 0) return events;
      return (async () => {
        try {
          await persistence2.dispose();
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
    invokeMenuItem(context, slot, button) {
      return perform(context, () => current(context, () => invokeMenuItemSync({ ...context, slot, button })));
    },
    pulse(context, sequence, timestampMs) {
      return perform(context, () => current(context, () => handleTicks(
        { ...context, sequence },
        () => scheduler.pulse(timestampMs)
      )));
    },
    step(context, sequence) {
      return perform(context, () => current(context, () => handleTicks(
        { ...context, sequence },
        () => ({ tickCount: 1, droppedTicks: 0, discontinuity: false })
      )));
    },
    flushPersistence(context) {
      if (persistence2 === void 0) return [
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
        await persistence2?.dispose();
      } catch {
      }
    }
  };
}

// apps/web-player/src/worker/compose-runtime.ts
function createPlayerWorkerController(module, options = {}) {
  const session = createSessionController(module, options);
  let generation;
  let eventSink;
  function dispatch(command, context) {
    switch (command.type) {
      case "input":
        session.input(command.sessionGeneration, command.sequence, command.input);
        return [];
      case "loadCart":
        return session.loadCart(context, {
          source: new Uint8Array(command.cartBytes),
          ...command.instructionBudget === void 0 ? {} : { instructionBudget: command.instructionBudget },
          ...command.localCartBundle === void 0 ? {} : { localCartBundle: command.localCartBundle.map((entry) => ({
            ref: entry.ref,
            bytes: new Uint8Array(entry.cartBytes),
            access: entry.access
          })) },
          ...command.hostCartData === void 0 ? {} : { hostCartData: command.hostCartData.map((entry) => ({
            id: entry.id,
            bytes: new Uint8Array(entry.bytes)
          })) }
        });
      case "step":
        return session.step(context, command.sequence);
      case "vsync":
        return session.pulse(context, command.sequence, command.timestampMs);
      case "invokeMenuItem":
        return session.invokeMenuItem(context, command.slot, command.button);
      default:
        return session[command.type](context);
    }
  }
  return {
    handle(command) {
      generation ??= command.workerGeneration;
      if (command.workerGeneration !== generation) {
        if (command.type === "input" || command.type === "flushPersistence") return [];
        return [{
          v: 1,
          requestId: command.requestId,
          workerGeneration: command.workerGeneration,
          sessionGeneration: command.sessionGeneration,
          type: "fault",
          error: { code: "E_INVALID_STATE", message: "command belongs to another Worker generation", phase: "none", recoverable: false }
        }];
      }
      const wrap = (events) => events.map((event) => ({ ...event, v: 1, workerGeneration: command.workerGeneration, requestId: command.requestId }));
      const result = dispatch(command, {
        sessionGeneration: command.sessionGeneration,
        onResume(events) {
          if (eventSink === void 0) throw new Error("Worker background event sink is not installed");
          eventSink(wrap(events));
        }
      });
      return result instanceof Promise ? result.then(wrap) : wrap(result);
    },
    setEventSink(sink) {
      if (typeof sink !== "function") throw new TypeError("Worker event sink must be a function");
      if (eventSink !== void 0 && eventSink !== sink) throw new Error("Worker event sink is already installed");
      eventSink = sink;
    },
    dispose() {
      return session.destroy();
    }
  };
}

// apps/web-player/src/transport/audio-protocol.ts
var AUDIO_PROTOCOL_VERSION = 1;
var PICO_CANONICAL_SAMPLE_RATE = 22050;

// apps/web-player/src/transport/validators.ts
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
function isCartAccess(value) {
  return isRecord(value) && typeof value.load === "boolean" && typeof value.reloadData === "boolean" && typeof value.cstoreData === "boolean" && typeof value.include === "boolean";
}
function utf8ByteLength2(value) {
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 127) length += 1;
    else if (unit <= 2047) length += 2;
    else if (unit >= 55296 && unit <= 56319 && index + 1 < value.length && value.charCodeAt(index + 1) >= 56320 && value.charCodeAt(index + 1) <= 57343) {
      length += 4;
      index += 1;
    } else length += 3;
  }
  return length;
}
function isLocalCartBundle(value, wire = false) {
  if (value === void 0) return true;
  if (!Array.isArray(value) || value.length > PICO_LOCAL_CART_BUNDLE_MAX_ENTRIES) return false;
  const refs = /* @__PURE__ */ new Set();
  for (const entry of value) {
    if (!isRecord(entry)) return false;
    const bytes = wire ? entry.cartBytes : entry.bytes;
    if (typeof entry.ref !== "string" || entry.ref.length === 0 || utf8ByteLength2(entry.ref) > PICO_CART_REF_MAX_BYTES || !(wire ? bytes instanceof ArrayBuffer : bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > PICO_CART_INPUT_MAX_BYTES || !isCartAccess(entry.access) || refs.has(entry.ref)) return false;
    refs.add(entry.ref);
  }
  return true;
}
function isHostCartData(value, wire = false) {
  if (value === void 0) return true;
  if (!Array.isArray(value) || value.length > PICO_CART_DATA_MAX_RECORDS) return false;
  const ids = /* @__PURE__ */ new Set();
  return value.every((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length < 1 || utf8ByteLength2(entry.id) > PICO_CART_DATA_ID_MAX_BYTES || !/^[a-z0-9_-]+$/u.test(entry.id) || ids.has(entry.id) || !(wire ? entry.bytes instanceof ArrayBuffer : entry.bytes instanceof Uint8Array) || entry.bytes.byteLength !== PICO_CART_DATA_BYTES) {
      return false;
    }
    ids.add(entry.id);
    return true;
  });
}
function isPlayerHostToRuntime(value) {
  return isPlayerEnvelope(value) && isPlayerCommand(value);
}
function isPlayerCommand(value) {
  if (!isRecord(value) || !isUint(value.sessionGeneration)) return false;
  if (value.type === "input") {
    return value.requestId === 0 && isPositiveUint(value.sessionGeneration) && isUint(value.sequence) && isPicoInputSnapshot(value.input);
  }
  if (!isPositiveUint(value.requestId)) return false;
  if (value.type === "loadCart") {
    return isPositiveUint(value.sessionGeneration) && value.cartBytes instanceof ArrayBuffer && value.cartBytes.byteLength > 0 && value.cartBytes.byteLength <= PICO_CART_INPUT_MAX_BYTES && isLocalCartBundle(value.localCartBundle, true) && isHostCartData(value.hostCartData, true) && (value.instructionBudget === void 0 || isPositiveUint(value.instructionBudget));
  }
  if (value.type === "step") return isPositiveUint(value.sessionGeneration) && isUint(value.sequence);
  if (value.type === "vsync") {
    return isPositiveUint(value.sessionGeneration) && isUint(value.sequence) && typeof value.timestampMs === "number" && Number.isFinite(value.timestampMs) && value.timestampMs >= 0;
  }
  if (value.type === "start" || value.type === "pause" || value.type === "resume" || value.type === "reset" || value.type === "stop" || value.type === "flushPersistence" || value.type === "openPauseMenu" || value.type === "closePauseMenu") {
    return isPositiveUint(value.sessionGeneration);
  }
  if (value.type === "invokeMenuItem") {
    return isPositiveUint(value.sessionGeneration) && isUint(value.slot) && Number(value.slot) >= 1 && Number(value.slot) <= 5 && (value.button === 1 || value.button === 2 || value.button === 4);
  }
  return value.type === "dispose";
}
function isAudioEnvelope(value) {
  return isRecord(value) && value.v === AUDIO_PROTOCOL_VERSION && isUint(value.sessionGeneration);
}
function isAudioPortAttachmentEnvelope(value) {
  return isAudioEnvelope(value) && value.type === "attachAudioPort";
}

// apps/web-player/src/runtime/audio-transport.ts
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
    if (firstSample < 0n) throw new RangeError("firstSample must be non-negative");
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
    if (chunk.firstSample < 0n) throw new RangeError("firstSample must be non-negative");
    if (!Number.isInteger(chunk.frameCount) || chunk.frameCount <= 0 || chunk.frameCount > 65536 || chunk.pcm16le.byteLength !== chunk.frameCount * 2) {
      throw new RangeError("PCM frameCount does not match the transferred buffer");
    }
    const message = {
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
    this.#port?.postMessage(message, [chunk.pcm16le]);
  }
  dispose() {
    if (this.#disposed) return;
    this.#port?.close();
    this.#port = void 0;
    this.#generation = -1;
    this.#disposed = true;
  }
  #assertActive() {
    if (this.#disposed) throw new Error("PcmOutput is disposed");
  }
};

// apps/web-player/src/runtime/adapters/indexeddb-persistence-adapter.ts
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
  if (error instanceof DOMException) return `${error.name}: ${error.message}`;
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
    request.addEventListener("error", () => reject(
      request.error ?? new Error("IndexedDB request failed")
    ), { once: true });
  });
}
function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(
      transaction.error ?? new Error("IndexedDB transaction aborted")
    ), { once: true });
    transaction.addEventListener("error", () => reject(
      transaction.error ?? new Error("IndexedDB transaction failed")
    ), { once: true });
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
    if (factory === void 0) throw new Error("IndexedDB is unavailable in this Worker");
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
    if (this.#disposed) return [];
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
      if (schemaVersion === 0) this.#queueBytes(record.id, bytes);
    }
    return this.#overlayPending(seeds);
  }
  enqueue(commit) {
    if (this.#disposed) return;
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
    if (this.#flushInFlight !== void 0) return this.#flushInFlight;
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
    if (this.#disposed) return;
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
    if (this.#databasePromise !== void 0) return this.#databasePromise;
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
      request.addEventListener("error", () => reject(
        request.error ?? new Error("Unable to open cartdata IndexedDB")
      ), { once: true });
      request.addEventListener("blocked", () => reject(
        new Error("Cartdata IndexedDB upgrade was blocked")
      ), { once: true });
    }).catch((error) => {
      this.#databasePromise = void 0;
      throw error;
    });
    this.#databasePromise = opening;
    return opening;
  }
  #overlayPending(seeds) {
    const merged = /* @__PURE__ */ new Map();
    for (const seed of seeds) merged.set(seed.id, seed.bytes.slice());
    for (const [id, bytes] of this.#pending) merged.set(id, bytes.slice());
    return Object.freeze(Array.from(merged, ([id, bytes]) => Object.freeze({ id, bytes: bytes.slice() })));
  }
  #queueBytes(id, bytes) {
    this.#pending.set(id, bytes.slice());
    if (this.#flushTimer !== void 0 || this.#debounceMs === 0) {
      if (this.#debounceMs === 0) void this.flush();
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
          if (!this.#pending.has(id)) this.#pending.set(id, bytes);
        }
        this.#writeDiagnostic("Unable to durably write cartdata; the latest snapshot remains pending", error);
        return { durable: false, message: errorMessage2(error) };
      }
    }
    return { durable: true };
  }
  #clearTimer() {
    if (this.#flushTimer === void 0) return;
    globalThis.clearTimeout(this.#flushTimer);
    this.#flushTimer = void 0;
  }
  #readDiagnostic(message, errorOrDetails) {
    this.#diagnostic("E_PERSISTENCE_READ", message, errorOrDetails);
  }
  #writeDiagnostic(message, errorOrDetails) {
    this.#diagnostic("E_PERSISTENCE_WRITE", message, errorOrDetails);
  }
  #diagnostic(code, message, errorOrDetails) {
    const details = typeof errorOrDetails === "object" && errorOrDetails !== null && !(errorOrDetails instanceof Error) && !(errorOrDetails instanceof DOMException) ? errorOrDetails : errorOrDetails === void 0 ? void 0 : { cause: errorMessage2(errorOrDetails) };
    if (this.#diagnostics.length >= MAX_DIAGNOSTICS) this.#diagnostics.shift();
    this.#diagnostics.push(Object.freeze({
      code,
      message,
      phase: "none",
      recoverable: true,
      ...details === void 0 ? {} : { details }
    }));
  }
};

// apps/web-player/src/worker/runtime-worker.ts
function postPlayerResponse(scope, response) {
  const transfer = response.type === "frame" ? [response.packedScreen, response.displayPalette] : response.type === "cartdata-commit" ? [response.bytes] : response.type === "runtime-control" ? [response.payload] : response.type === "session-replaced" ? [response.breadcrumb] : response.type === "pause-menu" ? response.items.map((item) => item.label) : [];
  scope.postMessage(response, transfer);
}
function isWorkerAudioPort(value) {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value;
  return typeof candidate.postMessage === "function" && typeof candidate.close === "function";
}
function attachAudioPort(value, audioTransport2) {
  if (!isAudioPortAttachmentEnvelope(value)) return false;
  const port = value.port;
  if (!isWorkerAudioPort(port)) return true;
  audioTransport2.attach(port, value.sessionGeneration);
  return true;
}
function installPlayerRuntimeWorker(scope, controller2, audioTransport2) {
  let queue = Promise.resolve();
  let activeController;
  let handlingCommand = false;
  const bufferedBackgroundEvents = [];
  const controllerPromise = Promise.resolve(controller2);
  function postBackgroundEvents(responses) {
    if (handlingCommand) {
      bufferedBackgroundEvents.push([...responses]);
      return;
    }
    for (const response of responses) postPlayerResponse(scope, response);
  }
  function flushBackgroundEvents() {
    for (const responses of bufferedBackgroundEvents.splice(0)) {
      for (const response of responses) postPlayerResponse(scope, response);
    }
  }
  async function getController() {
    const active = activeController ?? await controllerPromise;
    if (activeController === void 0) {
      activeController = active;
      active.setEventSink(postBackgroundEvents);
    }
    return active;
  }
  scope.addEventListener("message", (event) => {
    if (audioTransport2 !== void 0 && attachAudioPort(event.data, audioTransport2)) return;
    if (!isPlayerHostToRuntime(event.data)) return;
    const command = event.data;
    queue = queue.then(async () => {
      try {
        const active = await getController();
        handlingCommand = true;
        const responses = await active.handle(command);
        for (const response of responses) postPlayerResponse(scope, response);
        handlingCommand = false;
        flushBackgroundEvents();
        if (command.type === "dispose" && responses.some((response) => response.type === "state" && response.state === "disposed")) {
          audioTransport2?.dispose();
        }
      } catch (error) {
        handlingCommand = false;
        bufferedBackgroundEvents.length = 0;
        postPlayerResponse(scope, {
          v: 1,
          type: "fault",
          requestId: command.requestId,
          workerGeneration: command.workerGeneration,
          sessionGeneration: command.sessionGeneration,
          error: {
            code: "E_INVARIANT",
            message: `Runtime Worker bootstrap failed: ${error instanceof Error ? error.message : String(error)}`,
            phase: "none",
            recoverable: false
          }
        });
      }
    });
  });
}

// apps/web-player/src/worker/player-worker-entry.mjs
var audioTransport = new PcmOutput();
var persistence = new IndexedDbCartDataPersistenceAdapter();
var heapLimitText = new URL(import.meta.url).searchParams.get("luaHeapLimit");
var luaHeapLimit = heapLimitText === null ? void 0 : Number(heapLimitText);
var controller = (async () => {
  const module = await createZ8LuaModule();
  return createPlayerWorkerController(module, {
    audioTransport,
    persistence,
    ...luaHeapLimit === void 0 ? {} : { luaHeapLimit }
  });
})();
installPlayerRuntimeWorker(self, controller, audioTransport);
