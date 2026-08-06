import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { before } from "node:test";

import { decodeCart } from "@pico8-web/cart-codec";
import { PICO_RAM_SIZE } from "@pico8-web/contracts";
import { CartSession, FrameSliceRuntime } from "@pico8-web/runtime-core";
import { createPicoApiHostRouter, Z8LuaFrameVm } from "@pico8-web/z8lua-bridge";
import {
  PICO_AUDIO_QUEUE_CAPACITY_FRAMES,
  PICO_AUDIO_QUEUE_HIGH_WATER_FRAMES,
  PICO_AUDIO_QUEUE_LOW_WATER_FRAMES,
  PICO_AUDIO_QUEUE_PREBUFFER_FRAMES,
  Pcm16Queue,
} from "../../apps/web-player/dist/worklet/pcm-queue.js";
import {
  CART_DATA_MAX_HYDRATED_BYTES,
  CART_DATA_MAX_HYDRATED_RECORDS,
} from "../../apps/web-player/dist/worker/adapters/indexeddb-persistence-adapter.js";
import { CartRepositoryAdapter } from "../../apps/web-player/dist/worker/adapters/cart-repository-adapter.js";
import { createPlayerWorkerController } from "../../apps/web-player/dist/worker/compose-runtime.js";
import createZ8LuaModule from "../../wasm/dist/z8lua-runtime-v1.mjs";

const projectRoot = new URL("../../", import.meta.url);
const manifestUrl = new URL("manifests/phase-4g-resource-long-run.json", import.meta.url);
const reviewedEvidenceUrl = new URL(
  "../../benchmarks/phase-4/results/chromium-macos-arm64-phase-4g-long-run.json",
  import.meta.url,
);
const runtimeManifestUrl = new URL("../../wasm/runtime-v1.manifest.lock.json", import.meta.url);
let module;
let manifest;
let carts;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

before(async () => {
  [module, manifest] = await Promise.all([
    createZ8LuaModule(),
    readFile(manifestUrl, "utf8").then(JSON.parse),
  ]);
  carts = new Map();
  for (const entry of manifest.carts) {
    const source = new Uint8Array(await readFile(new URL(entry.source, projectRoot)));
    assert.equal(sha256(source), entry.sourceSha256);
    const cart = decodeCart(source);
    assert.equal(cart.identity.contentSha256, entry.cartSha256);
    carts.set(entry.id, { entry, source, cart });
  }
});

function runtimeFor(luaHeapLimit, instructionBudget = 1_000_000) {
  const vm = new Z8LuaFrameVm(module, createPicoApiHostRouter(module), {
    ...(luaHeapLimit === undefined ? {} : { luaHeapLimit }),
  });
  return {
    vm,
    runtime: new FrameSliceRuntime(vm, { instructionBudget }),
  };
}

function assertOk(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}

function command(type, sessionGeneration, extra = {}) {
  return {
    v: 1,
    type,
    requestId: type === "input" ? 0 : sessionGeneration,
    workerGeneration: 1,
    sessionGeneration,
    ...extra,
  };
}

test("Phase 4G machine manifest owns every fixed resource limit", () => {
  assert.equal(manifest.limits.wasmMemory.bytes, 16 * 1024 * 1024);
  assert.equal(manifest.limits.wasmMemory.pages, 256);
  assert.equal(manifest.limits.wasmMemory.growth, false);
  assert.equal(manifest.limits.picoRam.bytes, PICO_RAM_SIZE);
  assert.equal(manifest.limits.luaHeap.defaultBytes, 1024 * 1024);
  assert.equal(manifest.limits.luaHeap.minimumBytes, 32 * 1024);
  assert.equal(manifest.limits.luaHeap.adaptive, false);
  assert.deepEqual(manifest.limits.audioQueue, {
    owner: "apps/web-player/src/worklet/pcm-queue.ts",
    capacityFrames: PICO_AUDIO_QUEUE_CAPACITY_FRAMES,
    prebufferFrames: PICO_AUDIO_QUEUE_PREBUFFER_FRAMES,
    lowWaterFrames: PICO_AUDIO_QUEUE_LOW_WATER_FRAMES,
    highWaterFrames: PICO_AUDIO_QUEUE_HIGH_WATER_FRAMES,
    observableFailure: "bounded overrun and droppedSourceFrames counters",
  });
  assert.equal(
    manifest.limits.cartdataHydration.maximumRecords,
    CART_DATA_MAX_HYDRATED_RECORDS,
  );
  assert.equal(
    manifest.limits.cartdataHydration.maximumBytes,
    CART_DATA_MAX_HYDRATED_BYTES,
  );
  assert.equal(manifest.lifecycle.sequence.length, manifest.lifecycle.requiredLoads);
  assert.equal(manifest.chrome.evidenceSeconds, 1800);
});

test("production WASM memory and Lua heap fail closed without detaching views", () => {
  const buffer = module.wasmMemory.buffer;
  const heap = module.HEAPU8;
  assert.equal(buffer.byteLength, manifest.limits.wasmMemory.bytes);
  assert.throws(() => module.wasmMemory.grow(1), RangeError);
  assert.equal(module.wasmMemory.buffer, buffer);
  assert.equal(module.HEAPU8, heap);
  assert.equal(module.HEAPU8.buffer, buffer);

  const normal = runtimeFor(undefined);
  try {
    assert.equal(normal.vm.luaHeapLimit, manifest.limits.luaHeap.defaultBytes);
    const ready = assertOk(normal.runtime.boot(carts.get("phase-4/resource-stable-30").cart));
    assert.equal(ready.kind, "ready");
    assert.ok(normal.vm.liveLuaBytes > 0);
    assert.ok(normal.vm.liveLuaBytes < normal.vm.luaHeapLimit);
  } finally {
    normal.runtime.dispose();
  }

  const constrained = runtimeFor(manifest.limits.luaHeap.minimumBytes);
  try {
    const result = constrained.runtime.boot(carts.get("phase-4/resource-oom").cart);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "E_VM_OOM");
    assert.equal(result.error.details.luaHeapLimit, manifest.limits.luaHeap.minimumBytes);
    assert.ok(result.error.details.liveLuaBytes > 0);
    assert.ok(result.error.details.liveLuaBytes <= result.error.details.luaHeapLimit);
  } finally {
    constrained.runtime.dispose();
  }

  const recovered = runtimeFor(manifest.limits.luaHeap.minimumBytes);
  try {
    const ready = assertOk(
      recovered.runtime.boot(carts.get("phase-4/resource-minimum-recovery").cart),
    );
    assert.equal(ready.kind, "ready");
  } finally {
    recovered.runtime.dispose();
  }
  assert.equal(module._p8w_live_contexts(), 0);
  assert.equal(module.wasmMemory.buffer, buffer);
});

test("bounded AudioWorklet queue reports stale input and overflow pressure", () => {
  const queue = new Pcm16Queue();
  queue.reset({
    v: 1,
    type: "audioReset",
    sessionGeneration: 2,
    nextSequence: 0,
    firstSample: "0",
  });
  const stale = queue.push({
    v: 1,
    type: "audioChunk",
    sessionGeneration: 1,
    sequence: 0,
    firstSample: "0",
    sampleRate: 22_050,
    frameCount: 1,
    pcm16le: new ArrayBuffer(2),
  });
  assert.deepEqual(stale, { accepted: false, resynced: false });

  const frames = PICO_AUDIO_QUEUE_HIGH_WATER_FRAMES + 1024;
  const accepted = queue.push({
    v: 1,
    type: "audioChunk",
    sessionGeneration: 2,
    sequence: 0,
    firstSample: "0",
    sampleRate: 22_050,
    frameCount: frames,
    pcm16le: new ArrayBuffer(frames * 2),
  });
  assert.equal(accepted.accepted, true);
  const stats = queue.snapshot(48_000);
  assert.equal(stats.queuedSourceFrames, PICO_AUDIO_QUEUE_HIGH_WATER_FRAMES);
  assert.equal(stats.staleChunks, 1);
  assert.equal(stats.overruns, 1);
  assert.equal(stats.droppedSourceFrames, 1024);
  assert.ok(stats.queueHighWaterFrames <= PICO_AUDIO_QUEUE_CAPACITY_FRAMES);
});

test("20 sequential real-WASM loads release every superseded VM context", () => {
  let instructionBudget = 1_000_000;
  const repository = new CartRepositoryAdapter();
  const session = new CartSession({
    createRuntime(context) {
      const vm = new Z8LuaFrameVm(module, createPicoApiHostRouter(module));
      try {
        return new FrameSliceRuntime(vm, {
          instructionBudget,
          currentCart: { identity: context.cart.identity, repository },
        });
      } catch (error) {
        vm.destroy();
        throw error;
      }
    },
  });
  let faults = 0;
  try {
    for (let index = 0; index < manifest.lifecycle.sequence.length; index += 1) {
      const id = manifest.lifecycle.sequence[index];
      const fixture = carts.get(id);
      instructionBudget = fixture.entry.instructionBudget ?? 1_000_000;
      repository.registerCart(fixture.cart);
      const loaded = assertOk(session.load(fixture.cart));
      assert.equal(loaded.kind, "ready");
      assert.equal(module._p8w_live_contexts(), 1);
      const stepped = session.step();
      if (fixture.entry.expectedCode === undefined) {
        const frame = assertOk(stepped);
        assert.equal(frame.kind, "frame");
        if ((index + 1) % 5 === 0) {
          const reset = assertOk(session.reset());
          assert.equal(reset.kind, "ready");
          assert.equal(module._p8w_live_contexts(), 1);
        }
        assertOk(session.stop());
      } else {
        assert.equal(stepped.ok, false);
        assert.equal(stepped.error.code, fixture.entry.expectedCode);
        faults += 1;
      }
    }
  } finally {
    assertOk(session.dispose());
    repository.dispose();
  }
  assert.equal(faults, 1);
  assert.equal(module._p8w_live_contexts(), 0);
});

test("production Worker controller classifies minimum-heap OOM and recovers fresh", () => {
  const controller = createPlayerWorkerController(module, {
    luaHeapLimit: manifest.limits.luaHeap.minimumBytes,
  });
  try {
    const oom = controller.handle(command("loadCart", 1, {
      cartBytes: carts.get("phase-4/resource-oom").source.slice().buffer,
    }));
    assert.equal(oom.length, 1);
    assert.equal(oom[0].type, "fault");
    assert.equal(oom[0].error.code, "E_VM_OOM");
    assert.equal(oom[0].error.details.luaHeapLimit, manifest.limits.luaHeap.minimumBytes);

    const ready = controller.handle(command("loadCart", 2, {
      cartBytes: carts.get("phase-4/resource-minimum-recovery").source.slice().buffer,
    }));
    assert.equal(ready.at(-1).type, "state");
    assert.equal(ready.at(-1).state, "ready");
    const running = controller.handle(command("start", 2));
    assert.equal(running.at(-1).state, "running");
    const anchor = controller.handle(command("vsync", 2, { sequence: 1, timestampMs: 1000 }));
    assert.equal(anchor.at(-1).type, "heartbeat");
    const frame = controller.handle(command("vsync", 2, {
      sequence: 2,
      timestampMs: 1000 + 1000 / 30,
    }));
    assert.equal(frame.some((event) => event.type === "frame"), true);
  } finally {
    controller.dispose();
  }
  assert.equal(module._p8w_live_contexts(), 0);
});

test("reviewed 30-minute Chrome evidence remains hash-locked and inside every resource gate", async () => {
  const [evidenceBytes, manifestBytes, runtimeManifestBytes] = await Promise.all([
    readFile(reviewedEvidenceUrl),
    readFile(manifestUrl),
    readFile(runtimeManifestUrl),
  ]);
  const evidence = JSON.parse(evidenceBytes);
  const runtimeManifest = JSON.parse(runtimeManifestBytes);

  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.phase, "4G");
  assert.deepEqual(evidence.configuration, {
    evidence: true,
    soakSeconds: manifest.chrome.evidenceSeconds,
  });
  assert.ok(evidence.soak.actualDurationMs >= manifest.chrome.evidenceSeconds * 1000);
  assert.equal(evidence.manifestSha256, sha256(manifestBytes));
  assert.deepEqual(evidence.runtimeArtifact, runtimeManifest.artifact);

  for (const [sourcePath, expectedSha256] of Object.entries(evidence.sourceSha256)) {
    assert.equal(sha256(await readFile(new URL(sourcePath, projectRoot))), expectedSha256,
      `${sourcePath} evidence source hash`);
  }
  for (const artifact of evidence.runtimeArtifact.files) {
    const bytes = await readFile(new URL(
      `${evidence.runtimeArtifact.outputDirectory}/${artifact.path}`,
      projectRoot,
    ));
    assert.equal(bytes.byteLength, artifact.bytes, `${artifact.path} evidence bytes`);
    assert.equal(sha256(bytes), artifact.sha256, `${artifact.path} evidence hash`);
  }

  assert.deepEqual(evidence.soak.profiles.map(({ targetFps }) => targetFps), [30, 60]);
  for (const profile of evidence.soak.profiles) {
    assert.equal(profile.frames, profile.ticks);
    assert.equal(profile.droppedTicks, 0);
    assert.equal(profile.discontinuities, 0);
    assert.ok(profile.cadenceRatio >= manifest.chrome.minimumCadenceRatio);
    assert.ok(profile.droppedTickRatio <= manifest.chrome.maximumDroppedTickRatio);
    assert.equal(profile.audioDelta.startupUnderruns, 0);
    assert.ok(profile.audioDelta.steadyUnderruns
      <= manifest.chrome.maximumSteadyAudioUnderruns);
    assert.ok(profile.audioDelta.overruns <= manifest.chrome.maximumAudioOverruns);
    assert.ok(profile.audioDelta.discontinuities
      <= manifest.chrome.maximumAudioDiscontinuities);
    assert.equal(profile.audioDelta.droppedSourceFrames, 0);
    assert.equal(profile.audioDelta.staleChunks, 0);
  }

  assert.equal(evidence.soak.longTaskSupport, "measured");
  assert.ok(evidence.soak.longTasks.length <= manifest.chrome.maximumMainThreadLongTasks);
  assert.equal(evidence.soak.heap.cdp.status, "measured");
  assert.ok(evidence.soak.heap.cdp.deltaBytes
    <= manifest.chrome.maximumMeasuredHeapGrowthBytes);
  assert.equal(evidence.lifecycle.loads, manifest.lifecycle.requiredLoads);
  assert.equal(evidence.lifecycle.staleInputProbes, evidence.lifecycle.generations);
  assert.equal(evidence.lifecycle.staleFrameProbes, evidence.lifecycle.generations);
  assert.equal(evidence.lifecycle.stalePcmProbes, evidence.lifecycle.generations);
  assert.equal(evidence.minimumHeap.oomCode, "E_VM_OOM");
  assert.equal(evidence.minimumHeap.oomDetails.luaHeapLimit,
    manifest.limits.luaHeap.minimumBytes);
  assert.equal(evidence.minimumHeap.audioStateAfterDispose, "closed");
  assert.equal(evidence.resources.workersCreated, evidence.resources.workersTerminated);
  assert.equal(evidence.resources.activeAnimationFrames, 0);
  assert.equal(evidence.resources.activeDomListeners, 0);
  assert.equal(evidence.resources.audioStates.every((state) => state === "closed"), true);
  assert.equal(evidence.soak.releasedAudio.every(
    ({ queuedSourceFrames, playing }) => queuedSourceFrames === 0 && playing === false,
  ), true);
  assert.ok(evidence.workerErrors.length <= manifest.chrome.maximumWorkerErrors);
});
