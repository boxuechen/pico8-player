import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { before } from "node:test";

import createZ8LuaModule from "../../wasm/dist/z8lua-runtime-v1.mjs";
import {
  createPlayerWorkerController,
} from "../../apps/web-player/dist/worker/compose-runtime.js";
import { makeP8Png } from "../fixtures/p8png/fixture-builder.mjs";

const projectRoot = new URL("../../", import.meta.url);
const manifestUrl = new URL(
  "manifests/phase-1f-l1-exit.json",
  import.meta.url,
);
let module;
let manifest;
let phaseContract;
let reviewedChromeBytes;
let reviewedChromeResult;

before(async () => {
  [module, manifest, phaseContract, reviewedChromeBytes] = await Promise.all([
    createZ8LuaModule(),
    readFile(manifestUrl, "utf8").then(JSON.parse),
    readFile(new URL("spec/phase-1-l1-contract.json", projectRoot), "utf8").then(JSON.parse),
    readFile(new URL(
      "benchmarks/phase-1/results/chromium-macos-arm64-l1-exit.json",
      projectRoot,
    )),
  ]);
  reviewedChromeResult = JSON.parse(reviewedChromeBytes.toString("utf8"));
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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

function luaSection(source) {
  const marker = "__lua__\n";
  const start = source.indexOf(marker);
  if (start < 0) throw new Error("conformance cart is missing __lua__");
  return source.slice(start + marker.length);
}

async function caseAsset(entry) {
  const source = new Uint8Array(await readFile(new URL(entry.source, projectRoot)));
  if (entry.format === "p8") return { source, cart: source.slice() };
  if (entry.format !== "p8png-generated") {
    throw new Error(`unsupported conformance format: ${entry.format}`);
  }
  const lua = luaSection(new TextDecoder().decode(source));
  const cart = makeP8Png({
    codeHex: Buffer.from(lua, "utf8").toString("hex"),
    compression: "raw",
    cartVersion: 42,
    romPatternSeed: 71,
    zlibMode: "fixed",
    filterMode: "cycle",
    splitIdat: true,
  }).png;
  return { source, cart };
}

function pixel(packedScreen, x, y) {
  const packed = packedScreen[y * 64 + (x >>> 1)];
  return (x & 1) === 0 ? packed & 0x0f : packed >>> 4;
}

function checkSemanticPixels(packedScreen, expected, label) {
  for (const item of expected.semanticPixels) {
    assert.equal(
      pixel(packedScreen, item.x, item.y),
      item.color,
      `${label} pixel (${item.x},${item.y})`,
    );
  }
}

function onlyFrame(events, label) {
  const frames = events.filter((event) => event.type === "frame");
  assert.equal(frames.length, 1, `${label} must publish exactly one frame`);
  assert.equal(events.at(-1)?.type, "heartbeat", `${label} must end in heartbeat`);
  assert.equal(events.at(-1)?.tickCount, 1, `${label} must execute one tick`);
  return frames[0];
}

function inspectFrame(event) {
  const screen = new Uint8Array(event.packedScreen);
  return {
    frameId: event.frameId,
    completedSlices: event.completedSlices,
    timeRawBeforeStep: event.timeRawBeforeStep,
    targetFps: event.targetFps,
    screenSha256: sha256(screen),
  };
}

function runOnce(entry, cart) {
  const controller = createPlayerWorkerController(module);
  let requestId = 1;
  const loaded = controller.handle(command("loadCart", requestId++, 1, {
    cartBytes: cart.slice().buffer,
    instructionBudget: 100_000,
  }));
  assert.equal(loaded.length, 1);
  assert.deepEqual(
    {
      type: loaded[0].type,
      state: loaded[0].state,
      mode: loaded[0].mode,
      targetFps: loaded[0].targetFps,
    },
    {
      type: "state",
      state: "ready",
      mode: entry.mode,
      targetFps: entry.targetFps,
    },
    `${entry.id} boot contract`,
  );
  assert.equal(
    controller.handle(command("start", requestId++, 1))[0].state,
    "running",
  );

  const anchorMs = 1_000;
  const anchor = controller.handle(command("vsync", requestId++, 1, {
    sequence: 1,
    timestampMs: anchorMs,
  }));
  assert.equal(anchor.at(-1)?.type, "heartbeat");
  assert.equal(anchor.at(-1)?.tickCount, 0);

  const trace = [];
  let finalPackedScreen;
  const tickMs = 1_000 / entry.targetFps;
  for (let index = 0; index < entry.inputTrace.length; index += 1) {
    controller.handle(command("input", 0, 1, {
      sequence: index + 1,
      input: { controllers: [entry.inputTrace[index], 0, 0, 0, 0, 0, 0, 0] },
    }));
    const frame = onlyFrame(controller.handle(command("vsync", requestId++, 1, {
      sequence: index + 2,
      timestampMs: anchorMs + (index + 1) * tickMs,
    })), `${entry.id} frame ${index}`);
    finalPackedScreen = new Uint8Array(frame.packedScreen);
    trace.push(inspectFrame(frame));
  }

  const finalFrame = trace.at(-1);
  assert.equal(trace.length, entry.expected.frameCount);
  assert.equal(finalFrame.frameId, entry.expected.finalFrameId);
  assert.equal(finalFrame.completedSlices, entry.expected.completedSlices);
  assert.equal(finalFrame.timeRawBeforeStep, entry.expected.timeRawBeforeStep);
  checkSemanticPixels(finalPackedScreen, entry.expected, `${entry.id} final`);
  const finalEvents = controller.handle(command("vsync", requestId++, 1, {
    sequence: entry.inputTrace.length + 2,
    timestampMs: anchorMs + entry.inputTrace.length * tickMs,
  }));
  assert.equal(finalEvents.at(-1)?.tickCount, 0, "same timestamp must not advance");

  const reset = controller.handle(command("reset", requestId++, 2));
  assert.equal(reset[0].state, "ready");
  assert.equal(reset[0].mode, entry.mode);
  assert.equal(reset[0].targetFps, entry.targetFps);
  assert.equal(controller.handle(command("start", requestId++, 2))[0].state, "running");
  const resetAnchorMs = 10_000;
  controller.handle(command("vsync", requestId++, 2, {
    sequence: 1,
    timestampMs: resetAnchorMs,
  }));
  controller.handle(command("input", 0, 2, {
    sequence: 1,
    input: { controllers: [0, 0, 0, 0, 0, 0, 0, 0] },
  }));
  const resetFrameEvent = onlyFrame(controller.handle(command("vsync", requestId++, 2, {
    sequence: 2,
    timestampMs: resetAnchorMs + tickMs,
  })), `${entry.id} reset frame`);
  const resetFrame = inspectFrame(resetFrameEvent);
  assert.equal(resetFrame.frameId, 0);
  assert.equal(resetFrame.completedSlices, entry.reset.completedSlices);
  assert.equal(resetFrame.timeRawBeforeStep, entry.reset.timeRawBeforeStep);
  const resetPackedScreen = new Uint8Array(resetFrameEvent.packedScreen);
  checkSemanticPixels(resetPackedScreen, entry.reset, `${entry.id} reset`);

  controller.handle(command("dispose", requestId++, 2));
  return {
    trace,
    resetFrame,
    finalPackedScreen,
    resetPackedScreen,
  };
}

test("Phase 1F project-owned L1 cart matrix is deterministic", async () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.match(manifest.ownership, /Project-authored/u);
  assert.equal(manifest.cases.length, 3);
  assert.equal(new Set(manifest.cases.map(({ id }) => id)).size, 3);
  const faultSource = await readFile(new URL(manifest.faultCase.source, projectRoot));
  assert.equal(sha256(faultSource), manifest.faultCase.sourceSha256);
  assert.equal(manifest.faultCase.expectedCode, "E_VM_INSTRUCTION_BUDGET");

  const inspected = [];
  for (const entry of manifest.cases) {
    const { source, cart } = await caseAsset(entry);
    const sourceSha256 = sha256(source);
    const cartSha256 = sha256(cart);
    const first = runOnce(entry, cart);
    const second = runOnce(entry, cart);
    assert.deepEqual(first.trace, second.trace, `${entry.id} fresh replay trace`);
    assert.deepEqual(first.resetFrame, second.resetFrame, `${entry.id} fresh reset trace`);
    const final = first.trace.at(-1);
    const traceSha256 = sha256(Buffer.from(JSON.stringify(first.trace)));

    inspected.push({
      id: entry.id,
      sourceSha256,
      cartSha256,
      screenSha256: final.screenSha256,
      resetScreenSha256: first.resetFrame.screenSha256,
      traceSha256,
    });

    if (!entry.sourceSha256.includes("TBD")) {
      assert.equal(sourceSha256, entry.sourceSha256, `${entry.id} source provenance`);
      assert.equal(cartSha256, entry.cartSha256, `${entry.id} cart provenance`);
      assert.equal(final.screenSha256, entry.expected.screenSha256, `${entry.id} screen`);
      assert.equal(traceSha256, entry.expected.traceSha256, `${entry.id} trace digest`);
      assert.equal(
        first.resetFrame.screenSha256,
        entry.reset.screenSha256,
        `${entry.id} reset screen`,
      );
    }
  }

  if (manifest.cases.some(({ sourceSha256 }) => sourceSha256.includes("TBD"))) {
    assert.fail(`review and lock Phase 1F manifest:\n${JSON.stringify(inspected, null, 2)}`);
  }
});

test("Phase 1 exit contract hash-locks the reviewed Chrome evidence", () => {
  const unit = phaseContract.workUnits["1F"];
  assert.equal(phaseContract.status, "complete");
  assert.deepEqual(phaseContract.completedWorkUnits, ["1A", "1B", "1C", "1D", "1E", "1F"]);
  assert.equal(phaseContract.activeWorkUnit, null);
  assert.equal(phaseContract.nextWorkUnit, null);
  assert.equal(phaseContract.nextPhase, "2");
  assert.equal(unit.status, "complete");
  assert.deepEqual(unit.caseIds, manifest.cases.map(({ id }) => id));
  assert.equal(unit.assetPolicy.networkAccess, false);
  assert.equal(unit.assetPolicy.bbsAccess, false);
  assert.equal(unit.assetPolicy.thirdPartyCartDependency, false);
  assert.equal(unit.exitResult.projectCartCasesPassed, manifest.cases.length);
  assert.equal(unit.exitResult.openP0P1, 0);
  assert.equal(sha256(reviewedChromeBytes), unit.exitResult.rawChromeResultSha256);
  assert.equal(reviewedChromeResult.phase, "1F");
  assert.deepEqual(
    reviewedChromeResult.deterministic.map(({ id, cartSha256 }) => ({ id, cartSha256 })),
    manifest.cases.map(({ id, cartSha256 }) => ({ id, cartSha256 })),
  );
  assert.equal(reviewedChromeResult.faultRecovery.cartSha256,
    manifest.faultCase.sourceSha256);
  assert.equal(reviewedChromeResult.performance.measuredTicks, 120);
  assert.ok(reviewedChromeResult.performance.p95Ms <= 8);
});
