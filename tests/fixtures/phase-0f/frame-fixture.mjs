export const FRAME_FIXTURE_PACKED_SHA256 =
  "003f38517f7c1cccab9d309fb68d3871abe2671716bc4467e610a4cb2937c6f3";
export const FRAME_FIXTURE_RGBA_SHA256 =
  "b60f72f8ba81fd392d3cbc0a18e22aa61f0cca3df30bad9c81d77fa50663c93d";

/** Project-owned fixture covering all palette entries, nibble order, edges and corners. */
export function createPhase0FFrameFixture() {
  const packed = new Uint8Array(0x2000);
  for (let y = 0; y < 128; y += 1) {
    for (let x = 0; x < 128; x += 1) {
      let color = ((x >>> 3) + (y >>> 3)) & 0x0f;
      if (x === 0 || x === 127 || y === 0 || y === 127) {
        color = (x + y) & 0x0f;
      }
      if (x === y) color = (x >>> 3) & 0x0f;
      if (x === 0 && y === 0) color = 0;
      if (x === 127 && y === 0) color = 15;
      if (x === 0 && y === 127) color = 8;
      if (x === 127 && y === 127) color = 7;
      const offset = y * 64 + (x >>> 1);
      packed[offset] = x & 1 ? packed[offset] | (color << 4) : color;
    }
  }
  return packed;
}
