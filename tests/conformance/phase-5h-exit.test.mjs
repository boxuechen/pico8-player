import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../../", import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, projectRoot), "utf8");
}

async function readJson(relativePath) {
  return JSON.parse(await read(relativePath));
}

async function sha256(relativePath) {
  return createHash("sha256")
    .update(await readFile(new URL(relativePath, projectRoot)))
    .digest("hex");
}

const exit = await readJson("tests/conformance/manifests/phase-5h-exit.json");
const node = await readJson("benchmarks/phase-5/results/node-macos-arm64-l3-exit.json");
const chrome = await readJson(
  "benchmarks/phase-5/results/chromium-macos-arm64-l3-exit.json",
);
const EVOLVING_AFTER_PHASE_5 = new Set([
  "wasm/runtime-v1.manifest.lock.json",
]);

const STALE_CART_FIELDS = [
  "staleFrameCommits",
  "staleAudioCommits",
  "staleInputCommits",
  "staleRequestCommits",
  "stalePersistenceCommits",
];

test("Phase 5H hash-locks every accepted local L3 exit input", async () => {
  assert.equal(exit.phase, "5H");
  assert.equal(
    exit.target,
    "PICO-8 v0.2.7 L3 local/multicart project profile on Chrome/Chromium desktop",
  );
  assert.equal(exit.releaseClaim.projectCorpusOnly, true);
  assert.equal(exit.releaseClaim.thirdPartyOrBbsCompatibilityClaimed, false);
  assert.equal(exit.releaseClaim.officialBitExactClaimed, false);
  assert.equal(exit.releaseClaim.networkAccess, false);

  for (const [relativePath, expectedSha256] of Object.entries(exit.inputs)) {
    assert.match(expectedSha256, /^[0-9a-f]{64}$/u);
    if (!EVOLVING_AFTER_PHASE_5.has(relativePath)) {
      assert.equal(await sha256(relativePath), expectedSha256, relativePath);
    }
  }
});

test("Phase 5H project corpus remains 6/6 C3 with Node and Chrome agreement", async () => {
  const corpus = await readJson("tests/conformance/manifests/phase-5-l3-corpus.json");
  const expectedSummary = {
    counts: exit.corpus.classifications,
    denominator: exit.corpus.cases,
    playable: exit.corpus.cases,
    playableRate: exit.corpus.playableRate,
    openP0: exit.corpus.openP0,
    openP1: exit.corpus.openP1,
  };

  assert.equal(corpus.corpusId, exit.corpus.id);
  assert.equal(corpus.ownership, "project-authored and tracked in this repository");
  assert.equal(corpus.networkAccess, false);
  assert.equal(corpus.thirdPartyOrBbsContent, false);
  assert.equal(corpus.cases.length, exit.corpus.cases);
  assert.ok(corpus.cases.every((entry) => entry.phase5hClassification === "C3"));
  assert.deepEqual(node.summary, expectedSummary);
  assert.deepEqual(chrome.summary, expectedSummary);
  assert.deepEqual(node.runner, chrome.runner);
  assert.deepEqual(
    node.cases.map(({ id, classification, crossOracleSha256 }) => ({
      id,
      classification,
      crossOracleSha256,
    })),
    chrome.cases.map(({ id, classification, crossOracleSha256 }) => ({
      id,
      classification,
      crossOracleSha256,
    })),
  );
  assert.ok(node.cases.every((entry) => entry.classification === "C3"));

  for (const relativePath of [
    "apps/web-player/src/main/player-runtime-client.ts",
    "apps/web-player/src/worker/compose-runtime.ts",
    "apps/web-player/src/worker/adapters/host-cart-resolver-adapter.ts",
    "packages/runtime-core/src/cart/cart-loader.ts",
    "packages/runtime-core/src/frame-runtime.ts",
    "packages/z8lua-bridge/src/public.ts",
    "wasm/bridge/p8w_frame_runtime.cpp",
  ]) {
    assert.equal(node.sourceSha256[relativePath], chrome.sourceSha256[relativePath], relativePath);
  }
  assert.equal(chrome.externalCorpus.publishedDenominatorContribution, 0);
  assert.equal(chrome.externalCorpus.networkAccess, false);
  assert.equal(chrome.externalCorpus.thirdPartyOrBbsContent, false);
});

test("Phase 5H closes sequential replacement, failure and stale-output gates", () => {
  for (const result of [node, chrome]) {
    assert.equal(result.cartSwaps.required, exit.cartSwaps.required);
    assert.equal(result.cartSwaps.completed, exit.cartSwaps.required);
    assert.equal(result.cartSwaps.initialGeneration, exit.cartSwaps.initialGeneration);
    assert.equal(result.cartSwaps.finalGeneration, exit.cartSwaps.finalGeneration);
    assert.equal(
      result.cartSwaps.replacementHandshakes,
      exit.cartSwaps.replacementHandshakes,
    );
    assert.equal(
      result.cartSwaps.exactGenerationSequence,
      exit.cartSwaps.exactGenerationSequence,
    );
    for (const field of STALE_CART_FIELDS) assert.equal(result.cartSwaps[field], 0, field);
  }
  assert.equal(node.cartSwaps.liveContextsAfterDispose, 0);
  assert.equal(chrome.cartSwaps.liveContextsBeforeDispose, 1);
  assert.equal(chrome.cartSwaps.wasmBytes, exit.resources.fixedWasmBytes);
  assert.deepEqual(chrome.faultRecovery, {
    stagedFaultCode: "E_VM_RUNTIME",
    replacementHandshakes: 0,
    recovered: true,
  });
  assert.equal(chrome.staleCommits.total, exit.cartSwaps.staleCommitCount);
  assert.ok(Object.values(chrome.staleCommits).every((value) => value === 0));
});

test("Phase 5H passes the reviewed 1800-second Chrome resource gate", () => {
  assert.match(chrome.browser, /^Google Chrome /u);
  assert.equal(chrome.configuration.evidence, true);
  assert.equal(chrome.soak.requestedSeconds, 1800);
  assert.ok(chrome.soak.actualDurationMs / 1000 >= exit.resources.chromeMixedSoakSeconds);
  assert.equal(chrome.soak.measuredCycles, exit.resources.measuredCycles);
  assert.equal(
    chrome.soak.retainedHeap.deltaBytes,
    exit.resources.retainedHeapDeltaBytes,
  );
  assert.ok(
    chrome.soak.retainedHeap.deltaBytes <= exit.resources.maximumRetainedHeapDeltaBytes,
  );
  for (const field of [
    "guestLoads",
    "customLoads",
    "externalReloads",
    "externalCstores",
    "resolverFaults",
    "freshRecoveries",
    "callbackFrames",
  ]) {
    assert.equal(chrome.soak.totals[field], chrome.soak.totals.cycles, field);
  }
  assert.equal(chrome.resources.wasmBytes, exit.resources.fixedWasmBytes);
  assert.equal(chrome.resources.workersCreated, exit.resources.workersCreated);
  assert.equal(chrome.resources.workersTerminated, exit.resources.workersTerminated);
  assert.equal(chrome.resources.pendingRequests, exit.resources.pendingRequests);
  assert.equal(chrome.resources.audioPortReleased, exit.resources.audioPortReleased);
  assert.ok(chrome.resources.audioMessages > 0);
  assert.equal(chrome.workerErrors.length, exit.resources.workerErrors);
  assert.equal(exit.resources.resourcesReleased, true);
});

test("Phase 5 contract and published evidence are closed", async () => {
  const contract = await readJson("spec/phase-5-l3-multicart-contract.json");
  const packageJson = await readJson("package.json");
  const evidence = await read(
    "docs/evidence/phase-5/61-phase-5-l3-local-multicart-exit-evidence.md",
  );
  const compatibility = await read("docs/06-testing-compatibility.md");

  assert.equal(contract.status, "complete");
  assert.deepEqual(
    contract.completedWorkUnits,
    ["5A", "5B", "5C", "5D", "5E", "5F", "5G", "5H"],
  );
  assert.equal(contract.activeWorkUnit, null);
  assert.equal(contract.nextWorkUnit, null);
  assert.equal(contract.nextPhase, "deferred");
  assert.ok(Object.values(contract.workUnits).every((unit) => unit.status === "complete"));
  assert.equal(
    contract.workUnits["5H"].result.exitManifestSha256,
    await sha256("tests/conformance/manifests/phase-5h-exit.json"),
  );
  assert.equal(contract.workUnits["5H"].result.releaseClaim, exit.target);
  assert.equal(contract.workUnits["5H"].result.projectCorpusCases, 6);
  assert.equal(contract.workUnits["5H"].result.publishedKnownDifferences, 5);
  assert.equal(contract.workUnits["5H"].result.acceptedRequiredCoverageLimitations, 28);

  for (const hash of Object.values(exit.inputs)) assert.ok(evidence.includes(hash), hash);
  for (const id of [
    "P4-KD-02",
    "P4-KD-03",
    "P4-KD-05",
    "P4-KD-06",
    "P5-KD-01",
    "P4-CL-01",
    "ADR-018",
    "ADR-019",
    "ADR-020",
  ]) {
    assert.ok(evidence.includes(id), id);
  }
  assert.ok(evidence.includes(exit.target));
  assert.ok(compatibility.includes(exit.target));
  assert.ok(compatibility.includes("P5-KD-01"));
  assert.ok(packageJson.scripts["test:historical"].includes("test:phase-5h"));
  assert.ok(packageJson.scripts["verify:historical"].includes("test:phase-5h"));
  assert.ok(packageJson.scripts["evidence:phase-5h"].includes("--evidence"));
  await assert.rejects(
    readFile(new URL("docs/phases/5-l3-local-multicart.md", projectRoot)),
    { code: "ENOENT" },
  );
});
