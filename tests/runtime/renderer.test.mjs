import assert from "node:assert/strict";
import test from "node:test";

import {
  Canvas2DFramePresenter,
} from "../../apps/web-player/dist/main/render/canvas2d-frame-presenter.js";
import {
  decodePackedPicoFrame,
  PICO8_DEFAULT_PALETTE_RGBA,
  PICO_PACKED_FRAME_BYTES,
  PICO_RGBA_FRAME_BYTES,
} from "../../apps/web-player/dist/runtime/pico-frame.js";

function createCanvasDouble() {
  const state = {
    clears: 0,
    imageSmoothingEnabled: true,
    lastRgba: undefined,
    puts: 0,
  };
  const context = {
    get imageSmoothingEnabled() {
      return state.imageSmoothingEnabled;
    },
    set imageSmoothingEnabled(value) {
      state.imageSmoothingEnabled = value;
    },
    clearRect() {
      state.clears += 1;
    },
    createImageData(width, height) {
      return { data: new Uint8ClampedArray(width * height * 4), width, height };
    },
    putImageData(imageData) {
      state.puts += 1;
      state.lastRgba = imageData.data.slice();
    },
  };
  return {
    canvas: {
      width: 0,
      height: 0,
      style: {},
      getContext(kind) {
        return kind === "2d" ? context : null;
      },
    },
    state,
  };
}

test("packed frame decoding preserves low/high nibble order and all palette entries", () => {
  const packed = new Uint8Array(PICO_PACKED_FRAME_BYTES);
  for (let index = 0; index < packed.length; index += 1) {
    const left = (index * 2) & 0x0f;
    const right = (left + 1) & 0x0f;
    packed[index] = left | (right << 4);
  }
  const rgba = new Uint8ClampedArray(PICO_RGBA_FRAME_BYTES);
  decodePackedPicoFrame(packed, rgba);
  for (let color = 0; color < 16; color += 1) {
    assert.deepEqual(
      [...rgba.subarray(color * 4, color * 4 + 4)],
      [...PICO8_DEFAULT_PALETTE_RGBA.subarray(color * 4, color * 4 + 4)],
    );
  }
  assert.throws(
    () => decodePackedPicoFrame(packed.subarray(1), rgba),
    /8192 bytes/u,
  );
});

test("Canvas2D presenter rejects stale generations and frames without reallocating its surface", () => {
  const { canvas, state } = createCanvasDouble();
  const presenter = new Canvas2DFramePresenter(canvas);
  assert.equal(canvas.width, 128);
  assert.equal(canvas.height, 128);
  assert.equal(canvas.style.imageRendering, "pixelated");
  assert.equal(state.imageSmoothingEnabled, false);

  presenter.reset(3);
  const packedScreen = new Uint8Array(PICO_PACKED_FRAME_BYTES).fill(0x21);
  assert.equal(
    presenter.present({ sessionGeneration: 2, frameId: 0, packedScreen }),
    false,
  );
  assert.equal(
    presenter.present({ sessionGeneration: 3, frameId: 0, packedScreen }),
    true,
  );
  assert.equal(
    presenter.present({ sessionGeneration: 3, frameId: 0, packedScreen }),
    false,
  );
  assert.equal(state.puts, 1);
  assert.deepEqual([...state.lastRgba.subarray(0, 8)], [0x1d, 0x2b, 0x53, 0xff, 0x7e, 0x25, 0x53, 0xff]);

  assert.deepEqual(presenter.resize(511.5, 300.25), {
    widthCssPixels: 300.25,
    heightCssPixels: 300.25,
  });
  assert.equal(canvas.style.width, "300.25px");
  assert.equal(canvas.width, 128, "CSS resize must not reset the source surface");

  presenter.dispose();
  presenter.dispose();
  assert.throws(() => presenter.reset(4), /disposed/u);
});
