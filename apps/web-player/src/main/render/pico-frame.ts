export const PICO_FRAME_WIDTH = 128 as const;
export const PICO_FRAME_HEIGHT = 128 as const;
export const PICO_PACKED_FRAME_BYTES = 0x2000 as const;
export const PICO_RGBA_FRAME_BYTES = PICO_FRAME_WIDTH * PICO_FRAME_HEIGHT * 4;

export const PICO8_DEFAULT_PALETTE_RGBA = new Uint8ClampedArray([
  0x00, 0x00, 0x00, 0xff,
  0x1d, 0x2b, 0x53, 0xff,
  0x7e, 0x25, 0x53, 0xff,
  0x00, 0x87, 0x51, 0xff,
  0xab, 0x52, 0x36, 0xff,
  0x5f, 0x57, 0x4f, 0xff,
  0xc2, 0xc3, 0xc7, 0xff,
  0xff, 0xf1, 0xe8, 0xff,
  0xff, 0x00, 0x4d, 0xff,
  0xff, 0xa3, 0x00, 0xff,
  0xff, 0xec, 0x27, 0xff,
  0x00, 0xe4, 0x36, 0xff,
  0x29, 0xad, 0xff, 0xff,
  0x83, 0x76, 0x9c, 0xff,
  0xff, 0x77, 0xa8, 0xff,
  0xff, 0xcc, 0xaa, 0xff,
]);

export interface PackedPicoFrame {
  readonly sessionGeneration: number;
  readonly frameId: number;
  readonly packedScreen: Uint8Array;
}

function assertPackedScreen(source: Uint8Array): void {
  if (source.byteLength !== PICO_PACKED_FRAME_BYTES) {
    throw new RangeError(
      `packed PICO frame must contain ${PICO_PACKED_FRAME_BYTES} bytes`,
    );
  }
}

export function decodePackedPicoFrame(
  source: Uint8Array,
  target: Uint8ClampedArray,
  palette: Uint8ClampedArray = PICO8_DEFAULT_PALETTE_RGBA,
): void {
  assertPackedScreen(source);
  if (target.byteLength !== PICO_RGBA_FRAME_BYTES) {
    throw new RangeError(`RGBA target must contain ${PICO_RGBA_FRAME_BYTES} bytes`);
  }
  if (palette.byteLength !== 16 * 4) {
    throw new RangeError("PICO palette must contain 16 RGBA entries");
  }

  let targetOffset = 0;
  for (const packed of source) {
    const left = (packed & 0x0f) * 4;
    target[targetOffset] = palette[left]!;
    target[targetOffset + 1] = palette[left + 1]!;
    target[targetOffset + 2] = palette[left + 2]!;
    target[targetOffset + 3] = palette[left + 3]!;

    const right = (packed >>> 4) * 4;
    target[targetOffset + 4] = palette[right]!;
    target[targetOffset + 5] = palette[right + 1]!;
    target[targetOffset + 6] = palette[right + 2]!;
    target[targetOffset + 7] = palette[right + 3]!;
    targetOffset += 8;
  }
}
