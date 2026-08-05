import {
  Canvas2DFramePresenter,
} from "../../apps/web-player/dist/main/render/canvas2d-frame-presenter.js";
import {
  PICO8_DEFAULT_PALETTE_RGBA,
} from "../../apps/web-player/dist/main/render/pico-frame.js";
import {
  createPhase0FFrameFixture,
  FRAME_FIXTURE_PACKED_SHA256,
  FRAME_FIXTURE_RGBA_SHA256,
} from "../fixtures/phase-0f/frame-fixture.mjs";

const resultNode = document.querySelector("#result");
const canvas = document.querySelector("#screen");
const stage = document.querySelector("#stage");

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function quantile(values, probability) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function paletteSet() {
  const result = new Set();
  for (let offset = 0; offset < PICO8_DEFAULT_PALETTE_RGBA.length; offset += 4) {
    result.add(
      `${PICO8_DEFAULT_PALETTE_RGBA[offset]},${PICO8_DEFAULT_PALETTE_RGBA[offset + 1]},${PICO8_DEFAULT_PALETTE_RGBA[offset + 2]},${PICO8_DEFAULT_PALETTE_RGBA[offset + 3]}`,
    );
  }
  return result;
}

try {
  const packedScreen = createPhase0FFrameFixture();
  check(await sha256(packedScreen) === FRAME_FIXTURE_PACKED_SHA256, "packed fixture hash drifted");
  const presenter = new Canvas2DFramePresenter(canvas);
  const stageBounds = stage.getBoundingClientRect();
  presenter.resize(stageBounds.width, stageBounds.height);
  presenter.reset(7);
  check(
    presenter.present({ sessionGeneration: 7, frameId: 0, packedScreen }),
    "fixture frame was not presented",
  );
  check(
    !presenter.present({ sessionGeneration: 6, frameId: 1, packedScreen }),
    "stale generation was accepted",
  );
  const context = canvas.getContext("2d");
  const rgba = context.getImageData(0, 0, 128, 128).data;
  check(await sha256(rgba) === FRAME_FIXTURE_RGBA_SHA256, "Canvas2D RGBA hash drifted");

  window.phase0fRunRenderBenchmark = () => {
    presenter.reset(8);
    const frame = { sessionGeneration: 8, frameId: 0, packedScreen };
    for (let index = 0; index < 100; index += 1) {
      frame.frameId = index;
      presenter.present(frame);
    }
    presenter.reset(9);
    frame.sessionGeneration = 9;
    const samples = [];
    const framesPerSample = 250;
    const sampleCount = 40;
    let frameId = 0;
    for (let sample = 0; sample < sampleCount; sample += 1) {
      const start = performance.now();
      for (let index = 0; index < framesPerSample; index += 1) {
        frame.frameId = frameId++;
        presenter.present(frame);
      }
      samples.push((performance.now() - start) / framesPerSample);
    }
    presenter.reset(10);
    presenter.present({ sessionGeneration: 10, frameId: 0, packedScreen });
    return {
      totalFrames: framesPerSample * sampleCount,
      samples: samples.length,
      p50Ms: quantile(samples, 0.5),
      p95Ms: quantile(samples, 0.95),
      p99Ms: quantile(samples, 0.99),
      minMs: Math.min(...samples),
      maxMs: Math.max(...samples),
    };
  };

  window.phase0fCheckDpr = async () => {
    const sourceRgba = context.getImageData(0, 0, 128, 128).data;
    const probe = document.createElement("canvas");
    probe.width = 257;
    probe.height = 257;
    const probeContext = probe.getContext("2d", { alpha: false });
    probeContext.imageSmoothingEnabled = false;
    probeContext.drawImage(canvas, 0, 0, probe.width, probe.height);
    const scaled = probeContext.getImageData(0, 0, probe.width, probe.height).data;
    const accepted = paletteSet();
    let paletteOnly = true;
    for (let offset = 0; offset < scaled.length; offset += 4) {
      if (!accepted.has(`${scaled[offset]},${scaled[offset + 1]},${scaled[offset + 2]},${scaled[offset + 3]}`)) {
        paletteOnly = false;
        break;
      }
    }
    const bounds = canvas.getBoundingClientRect();
    return {
      devicePixelRatio,
      backingWidth: canvas.width,
      backingHeight: canvas.height,
      cssWidth: bounds.width,
      cssHeight: bounds.height,
      imageRendering: getComputedStyle(canvas).imageRendering,
      imageSmoothingEnabled: context.imageSmoothingEnabled,
      paletteOnly,
      rgbaSha256: await sha256(sourceRgba),
    };
  };

  window.phase0fRenderResult = {
    packedSha256: FRAME_FIXTURE_PACKED_SHA256,
    rgbaSha256: FRAME_FIXTURE_RGBA_SHA256,
    staleGenerationRejected: true,
  };
  resultNode.textContent = JSON.stringify(window.phase0fRenderResult, null, 2);
  document.body.dataset.status = "ready";
  document.body.dataset.progress = "ready";
} catch (error) {
  resultNode.textContent = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  document.body.dataset.status = "error";
}
