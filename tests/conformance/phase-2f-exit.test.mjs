import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { before } from "node:test";

import { decodeCart } from "@pico8-web/cart-codec";
import {
  CartSession,
  FrameSliceRuntime,
} from "@pico8-web/runtime-core";
import {
  createPicoApiHostRouter,
  Z8LuaFrameVm,
} from "@pico8-web/z8lua-bridge";
import {
  createPlayerWorkerController,
} from "../../apps/web-player/dist/worker/compose-runtime.js";
import {
  decodePackedPicoFrame,
  PICO_RGBA_FRAME_BYTES,
} from "../../apps/web-player/dist/main/render/pico-frame.js";
import createZ8LuaModule from "../../wasm/dist/z8lua-runtime-v1.mjs";

const projectRoot = new URL("../../", import.meta.url);
const manifestUrl = new URL("manifests/phase-2f-exit.json", import.meta.url);
let module;
let manifest;
let phaseContract;
let reviewedEvidence;
let reviewedEvidenceBytes;

before(async () => {
  [module, manifest, phaseContract, reviewedEvidenceBytes] = await Promise.all([
    createZ8LuaModule(),
    readFile(manifestUrl, "utf8").then(JSON.parse),
    readFile(new URL("../../spec/phase-2-graphics-memory-text-contract.json", import.meta.url),
      "utf8").then(JSON.parse),
    readFile(new URL(
      "../../benchmarks/phase-2/results/chromium-macos-arm64-phase-2-exit.json",
      import.meta.url,
    )),
  ]);
  reviewedEvidence = JSON.parse(reviewedEvidenceBytes.toString("utf8"));
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

function pixel(packedScreen, x, y) {
  const packed = packedScreen[y * 64 + (x >>> 1)];
  return (packed >>> ((x & 1) * 4)) & 0x0f;
}

function assertSemanticPixels(screen, expected, label) {
  for (const item of expected.semanticPixels) {
    assert.equal(pixel(screen, item.x, item.y), item.color,
      `${label} pixel (${item.x},${item.y})`);
  }
}

function createRealSession() {
  return new CartSession({
    createRuntime() {
      const router = createPicoApiHostRouter(module);
      const vm = new Z8LuaFrameVm(module, router);
      try {
        return new FrameSliceRuntime(vm, { instructionBudget: 2_000_000 });
      } catch (error) {
        vm.destroy();
        throw error;
      }
    },
  });
}

function inspectFrame(frame) {
  return {
    frameId: frame.frameId,
    completedSlices: frame.completedSlices,
    timeRawBeforeStep: frame.timeRawBeforeStep,
    targetFps: frame.targetFps,
    screenSha256: sha256(frame.screen),
    displayPaletteSha256: sha256(frame.displayPalette),
  };
}

function stepFrames(session, entry) {
  const trace = [];
  let finalFrame;
  for (let index = 0; index < manifest.frameCount; index += 1) {
    const result = session.step({ controllers: [0, 0, 0, 0, 0, 0, 0, 0] });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.value.kind, "frame", `${entry.id} step ${index}`);
    finalFrame = result.value.frame;
    trace.push(inspectFrame(finalFrame));
  }
  return { trace, finalFrame };
}

function copyRegion(session, region) {
  const copied = session.copyRam(region.address, region.length);
  assert.equal(copied.ok, true, JSON.stringify(copied));
  return {
    id: region.id,
    address: region.address,
    length: region.length,
    sha256: sha256(copied.value),
    ...(Object.hasOwn(region, "hex") ? { hex: hex(copied.value) } : {}),
  };
}

function captureSession(session, entry) {
  const { trace, finalFrame } = stepFrames(session, entry);
  const rgba = new Uint8ClampedArray(PICO_RGBA_FRAME_BYTES);
  decodePackedPicoFrame(
    finalFrame.screen,
    rgba,
    undefined,
    finalFrame.displayPalette,
  );
  assertSemanticPixels(finalFrame.screen, entry.expected, entry.id);
  return {
    trace,
    traceSha256: sha256(Buffer.from(JSON.stringify(trace))),
    screenSha256: sha256(finalFrame.screen),
    displayPaletteSha256: sha256(finalFrame.displayPalette),
    displayPaletteHex: hex(finalFrame.displayPalette),
    rgbaSha256: sha256(rgba),
    ramRegions: entry.ramRegions.map((region) => copyRegion(session, region)),
  };
}

function runWithColdReset(entry, cart) {
  const session = createRealSession();
  try {
    const loaded = session.load(cart);
    assert.equal(loaded.ok, true, JSON.stringify(loaded));
    assert.equal(loaded.value.kind, "ready");
    assert.equal(loaded.value.mode, entry.mode);
    assert.equal(loaded.value.targetFps, entry.targetFps);
    assert.equal(loaded.value.generation, 1);
    const initial = captureSession(session, entry);

    const reset = session.reset();
    assert.equal(reset.ok, true, JSON.stringify(reset));
    assert.equal(reset.value.kind, "ready");
    assert.equal(reset.value.generation, 2);
    const replay = captureSession(session, entry);
    assert.deepEqual(replay, initial, `${entry.id} cold reset replay`);
    return initial;
  } finally {
    session.dispose();
  }
}

function assertLockedEntry(entry, actual) {
  assert.equal(actual.traceSha256, entry.expected.traceSha256, `${entry.id} trace`);
  assert.equal(actual.screenSha256, entry.expected.screenSha256, `${entry.id} screen`);
  assert.equal(actual.displayPaletteSha256, entry.expected.displayPaletteSha256,
    `${entry.id} display palette`);
  assert.equal(actual.displayPaletteHex, entry.expected.displayPaletteHex,
    `${entry.id} display palette bytes`);
  assert.equal(actual.rgbaSha256, entry.expected.rgbaSha256, `${entry.id} RGBA`);
  assert.deepEqual(actual.ramRegions, entry.ramRegions, `${entry.id} RAM regions`);
}

function command(type, requestId, sessionGeneration, overrides = {}) {
  return {
    v: 1,
    type,
    requestId,
    workerGeneration: 1,
    sessionGeneration,
    ...overrides,
  };
}

test("Phase 2F project-owned carts lock real-WASM screen, palette, RAM and reset oracles", async () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.frameCount, 4);
  assert.equal(manifest.cases.length, 2);
  assert.match(manifest.ownership, /Project-authored/u);
  assert.doesNotMatch(JSON.stringify(manifest), /(?:ref\/|bbs-download|third-party cart)/iu);
  assert.equal(new Set(manifest.cases.map(({ id }) => id)).size, manifest.cases.length);

  const inspected = [];
  for (const entry of manifest.cases) {
    const source = new Uint8Array(await readFile(new URL(entry.source, projectRoot)));
    const cart = decodeCart(source);
    const first = runWithColdReset(entry, cart);
    const second = runWithColdReset(entry, cart);
    assert.deepEqual(second, first, `${entry.id} fresh session replay`);
    const actual = {
      id: entry.id,
      sourceSha256: sha256(source),
      cartSha256: cart.identity.contentSha256,
      ...first,
    };
    inspected.push(actual);

    if (entry.sourceSha256 !== "TBD") {
      assert.equal(actual.sourceSha256, entry.sourceSha256, `${entry.id} source`);
      assert.equal(actual.cartSha256, entry.cartSha256, `${entry.id} cart`);
      assertLockedEntry(entry, first);
    }
  }

  if (manifest.cases.some(({ sourceSha256 }) => sourceSha256 === "TBD")) {
    assert.fail(`review and lock Phase 2F manifest:\n${JSON.stringify(inspected, null, 2)}`);
  }
});

test("Phase 2F resource fault is structured and a fresh generation rejects stale work then recovers", async () => {
  const [faultBytes, validBytes] = await Promise.all([
    readFile(new URL(manifest.faultCase.source, projectRoot)),
    readFile(new URL(manifest.cases[0].source, projectRoot)),
  ]);
  if (manifest.faultCase.sourceSha256 !== "TBD") {
    assert.equal(sha256(faultBytes), manifest.faultCase.sourceSha256);
  }

  const controller = createPlayerWorkerController(module);
  try {
    const fault = controller.handle(command("loadCart", 1, 1, {
      cartBytes: faultBytes.buffer.slice(
        faultBytes.byteOffset,
        faultBytes.byteOffset + faultBytes.byteLength,
      ),
      instructionBudget: 2_000_000,
    }));
    assert.equal(fault.length, 1);
    assert.equal(fault[0].type, "fault");
    assert.equal(fault[0].error.code, manifest.faultCase.expectedCode);

    const loaded = controller.handle(command("loadCart", 2, 2, {
      cartBytes: validBytes.buffer.slice(
        validBytes.byteOffset,
        validBytes.byteOffset + validBytes.byteLength,
      ),
      instructionBudget: 2_000_000,
    }));
    assert.equal(loaded[0].type, "state");
    assert.equal(loaded[0].state, "ready");

    const stale = controller.handle(command("start", 3, 1));
    assert.equal(stale[0].type, "fault");
    assert.match(stale[0].error.message, /stale or missing session/u);

    assert.equal(controller.handle(command("start", 4, 2))[0].state, "running");
    controller.handle(command("vsync", 5, 2, { sequence: 1, timestampMs: 1_000 }));
    const recovered = controller.handle(command("vsync", 6, 2, {
      sequence: 2,
      timestampMs: 1_000 + 1_000 / 60,
    }));
    assert.equal(recovered.some(({ type }) => type === "frame"), true);
    assert.equal(recovered.at(-1).type, "heartbeat");
    assert.equal(recovered.at(-1).tickCount, 1);
  } finally {
    controller.dispose();
  }

  if (manifest.faultCase.sourceSha256 === "TBD") {
    assert.fail(`lock fault source SHA-256: ${sha256(faultBytes)}`);
  }
});

test("Phase 2 exit contract hash-locks reviewed Chrome evidence and has no active work unit", async () => {
  assert.equal(phaseContract.status, "complete");
  assert.equal(phaseContract.activeWorkUnit, null);
  assert.equal(phaseContract.nextWorkUnit, null);
  assert.equal(phaseContract.nextPhase, "3");
  assert.deepEqual(phaseContract.completedWorkUnits, ["2A", "2B", "2C", "2D", "2E", "2F"]);
  assert.equal(phaseContract.workUnits["2F"].status, "complete");

  const result = phaseContract.workUnits["2F"].result;
  assert.equal(sha256(reviewedEvidenceBytes), result.rawEvidenceSha256);
  assert.equal(reviewedEvidence.phase, "2F");
  assert.equal(reviewedEvidence.browser, result.chromeGate.browser);
  assert.equal(reviewedEvidence.deterministic.length, result.projectOwnedCases.length);
  assert.equal(reviewedEvidence.canvas.length, result.projectOwnedCases.length);
  assert.equal(reviewedEvidence.performance.maxP95Ms,
    result.chromeGate.maximumP95Milliseconds);
  assert.ok(reviewedEvidence.performance.maxP95Ms <= 8);
  assert.equal(reviewedEvidence.workerError, null);
  assert.equal(reviewedEvidence.faultRecovery.code, result.recovery.faultCode);
  assert.equal(reviewedEvidence.faultRecovery.mainThreadResponsive, true);
  assert.ok(reviewedEvidence.faultRecovery.recoverySessionGeneration
    > reviewedEvidence.faultRecovery.faultSessionGeneration);
  assert.equal(result.openP0P1, 0);

  const evidenceDocument = await readFile(new URL(
    "../../docs/evidence/phase-2/31-phase-2-graphics-memory-text-exit-evidence.md",
    import.meta.url,
  ), "utf8");
  assert.match(evidenceDocument, new RegExp(result.rawEvidenceSha256, "u"));
  await assert.rejects(
    readFile(new URL("../../docs/phases/2-graphics-memory-text.md", import.meta.url)),
    { code: "ENOENT" },
  );
});
