import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AUDIO_PROTOCOL_VERSION,
  PICO_CANONICAL_SAMPLE_RATE,
} from "../../apps/web-player/dist/transport/public.js";
import {
  PICO_FRAME_HEIGHT,
  PICO_FRAME_WIDTH,
  PICO_PACKED_FRAME_BYTES,
  PICO_RGBA_FRAME_BYTES,
} from "../../apps/web-player/dist/main/render/pico-frame.js";
import {
  Pcm16Queue,
} from "../../apps/web-player/dist/worklet/pcm-queue.js";

test("Phase 0F machine contract matches production renderer/audio constants", async () => {
  const contract = JSON.parse(
    await readFile("spec/phase-0f-browser-boundary.json", "utf8"),
  );
  assert.equal(contract.schemaVersion, 1);
  assert.deepEqual(contract.browserGate, ["chrome", "chromium"]);
  assert.equal(contract.renderer.default, "canvas2d");
  assert.deepEqual(contract.renderer.fallbacks, []);
  assert.equal(contract.renderer.width, PICO_FRAME_WIDTH);
  assert.equal(contract.renderer.height, PICO_FRAME_HEIGHT);
  assert.equal(contract.renderer.packedFrameBytes, PICO_PACKED_FRAME_BYTES);
  assert.equal(contract.renderer.rgbaFrameBytes, PICO_RGBA_FRAME_BYTES);
  assert.equal(contract.audio.defaultTransport, "worker-dedicated-messageport-audioworklet");
  assert.deepEqual(contract.audio.fallbacks, []);
  assert.equal(contract.audio.crossOriginIsolationRequired, false);
  assert.equal(contract.audio.canonicalSampleRate, PICO_CANONICAL_SAMPLE_RATE);
  const queueStats = new Pcm16Queue().snapshot(48_000);
  assert.equal(
    contract.audio.queue.lowWaterFrames,
    queueStats.configuredLowWaterFrames,
  );
  assert.equal(
    contract.audio.queue.highWaterFrames,
    queueStats.configuredHighWaterFrames,
  );
  assert.equal(contract.audio.queue.capacityFrames, 66_150);
  assert.equal(contract.audio.queue.prebufferFrames, 11_025);
  assert.equal(contract.protocol.version, AUDIO_PROTOCOL_VERSION);
});
