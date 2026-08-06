export function invalidCartRequest(kind: string, message: string): never {
  throw new RangeError(`invalid ${kind} request: ${message}`);
}

/** Strict UTF-8 decoder used by the bounded binary cart-request protocols. */
export function decodeCartRequestRef(
  kind: string,
  bytes: Uint8Array,
): string {
  const invalid = (message: string): never => invalidCartRequest(kind, message);
  const output: string[] = [];
  const continuation = (index: number): number => {
    const byte = bytes[index];
    if (byte === undefined || (byte & 0xc0) !== 0x80) {
      return invalid("ref is not valid UTF-8");
    }
    return byte & 0x3f;
  };
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index++]!;
    let codePoint = 0;
    if (first <= 0x7f) {
      codePoint = first;
    } else if (first >= 0xc2 && first <= 0xdf) {
      codePoint = ((first & 0x1f) << 6) | continuation(index++);
    } else if (first >= 0xe0 && first <= 0xef) {
      const second = continuation(index++);
      const third = continuation(index++);
      if ((first === 0xe0 && second < 0x20) || (first === 0xed && second >= 0x20)) {
        invalid("ref is not valid UTF-8");
      }
      codePoint = ((first & 0x0f) << 12) | (second << 6) | third;
    } else if (first >= 0xf0 && first <= 0xf4) {
      const second = continuation(index++);
      const third = continuation(index++);
      const fourth = continuation(index++);
      if ((first === 0xf0 && second < 0x10) || (first === 0xf4 && second >= 0x10)) {
        invalid("ref is not valid UTF-8");
      }
      codePoint = ((first & 0x07) << 18) | (second << 12) | (third << 6) | fourth;
    } else {
      invalid("ref is not valid UTF-8");
    }
    output.push(String.fromCodePoint(codePoint));
  }
  const ref = output.join("");
  if (ref.length === 0 || ref.includes("\0")) invalid("ref is empty or contains NUL");
  return ref;
}
