import { codecFailure } from "./errors.js";

const UNICODE_TO_P8SCII = new Map<number, number>();

function mapGlyphs(start: number, glyphs: string): void {
  let code = start;
  for (const glyph of glyphs) {
    const codePoint = glyph.codePointAt(0);
    if (codePoint !== undefined) UNICODE_TO_P8SCII.set(codePoint, code);
    code += 1;
  }
}

mapGlyphs(0x01, "¹²³⁴⁵⁶⁷⁸");
UNICODE_TO_P8SCII.set("ᵇ".codePointAt(0) ?? 0, 0x0b);
UNICODE_TO_P8SCII.set("ᶜ".codePointAt(0) ?? 0, 0x0c);
UNICODE_TO_P8SCII.set("ᵉ".codePointAt(0) ?? 0, 0x0e);
UNICODE_TO_P8SCII.set("ᶠ".codePointAt(0) ?? 0, 0x0f);
mapGlyphs(0x10, "▮■□⁙⁘‖◀▶「」¥•、。゛゜");
UNICODE_TO_P8SCII.set("○".codePointAt(0) ?? 0, 0x7f);
mapGlyphs(
  0x80,
  "█▒🐱⬇░✽●♥☉웃⌂⬅😐♪🅾◆…➡★⧗⬆ˇ∧❎▤▥" +
    "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよ" +
    "らりるれろわをんっゃゅょ" +
    "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨ" +
    "ラリルレロワヲンッャュョ◜◝",
);

const VARIATION_SELECTOR_BYTES = [0xef, 0xb8, 0x8f] as const;
const VARIATION_GLYPHS = new Set([0x2b07, 0x2b05, 0x1f17e, 0x27a1, 0x2b06]);

function isContinuation(value: number): boolean {
  return (value & 0xc0) === 0x80;
}

function decodeCodePoint(input: Uint8Array, index: number, sourceOffset: number): {
  readonly codePoint: number;
  readonly length: number;
} {
  const first = input[index] ?? 0;
  let length: number;
  let codePoint: number;
  let minimum: number;
  if (first >= 0xc2 && first <= 0xdf) {
    length = 2;
    codePoint = first & 0x1f;
    minimum = 0x80;
  } else if (first >= 0xe0 && first <= 0xef) {
    length = 3;
    codePoint = first & 0x0f;
    minimum = 0x800;
  } else if (first >= 0xf0 && first <= 0xf4) {
    length = 4;
    codePoint = first & 0x07;
    minimum = 0x1_0000;
  } else {
    codecFailure("E_CART_TEXT_ENCODING", "Invalid UTF-8 leading byte", {
      offset: sourceOffset + index,
    });
  }

  if (index + length > input.length) {
    codecFailure("E_CART_TEXT_ENCODING", "Truncated UTF-8 sequence", {
      offset: sourceOffset + index,
    });
  }
  for (let cursor = 1; cursor < length; cursor += 1) {
    const byte = input[index + cursor] ?? 0;
    if (!isContinuation(byte)) {
      codecFailure("E_CART_TEXT_ENCODING", "Invalid UTF-8 continuation byte", {
        offset: sourceOffset + index + cursor,
      });
    }
    codePoint = (codePoint << 6) | (byte & 0x3f);
  }
  if (
    codePoint < minimum ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    codecFailure("E_CART_TEXT_ENCODING", "Invalid UTF-8 scalar value", {
      offset: sourceOffset + index,
    });
  }
  return { codePoint, length };
}

function hasVariationSelector(input: Uint8Array, index: number): boolean {
  return VARIATION_SELECTOR_BYTES.every((byte, offset) => input[index + offset] === byte);
}

/** Convert one external UTF-8 Lua line into P8SCII without normalization. */
export function encodeP8sciiLine(input: Uint8Array, sourceOffset: number): Uint8Array {
  const output: number[] = [];
  for (let index = 0; index < input.length; ) {
    const byte = input[index] ?? 0;
    if (byte < 0x80) {
      if (byte !== 0x09 && (byte < 0x20 || byte === 0x7f)) {
        codecFailure("E_CART_TEXT_ENCODING", "Control byte is not valid external cart text", {
          offset: sourceOffset + index,
        });
      }
      output.push(byte);
      index += 1;
      continue;
    }

    const decoded = decodeCodePoint(input, index, sourceOffset);
    const mapped = UNICODE_TO_P8SCII.get(decoded.codePoint);
    if (mapped === undefined) {
      codecFailure("E_CART_TEXT_ENCODING", "Unicode scalar is not representable in P8SCII", {
        offset: sourceOffset + index,
        details: { codePoint: decoded.codePoint },
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
