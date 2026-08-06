import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../../", import.meta.url);

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, projectRoot), "utf8"));
}

async function sha256(relativePath) {
  return createHash("sha256")
    .update(await readFile(new URL(relativePath, projectRoot)))
    .digest("hex");
}

function countBy(items, key) {
  return Object.fromEntries(
    [...new Set(items.map((item) => item[key]))]
      .sort()
      .map((value) => [value, items.filter((item) => item[key] === value).length]),
  );
}

function sorted(values) {
  return [...values].sort();
}

const exit = await readJson("tests/conformance/manifests/phase-4h-exit.json");

test("Phase 4H hash-locks every accepted exit input", async () => {
  assert.equal(exit.phase, "4H");
  assert.equal(
    exit.target,
    "PICO-8 v0.2.7 L2/MVP project profile on Chrome/Chromium desktop",
  );
  assert.equal(exit.releaseClaim.projectCorpusOnly, true);
  assert.equal(exit.releaseClaim.thirdPartyOrBbsCompatibilityClaimed, false);
  assert.equal(exit.releaseClaim.officialBitExactClaimed, false);

  for (const [relativePath, expectedSha256] of Object.entries(exit.inputs)) {
    assert.match(expectedSha256, /^[0-9a-f]{64}$/);
    assert.equal(await sha256(relativePath), expectedSha256, relativePath);
  }
});

test("Phase 4H inventory, limitations and exclusions are exhaustive", async () => {
  const inventory = await readJson("spec/pico-api-inventory.yaml");
  assert.equal(inventory.apis.length, exit.inventory.apiCount);
  assert.deepEqual(
    countBy(inventory.apis, "implementationStatus"),
    exit.inventory.implementationCounts,
  );
  assert.deepEqual(
    countBy(inventory.apis, "conformanceStatus"),
    exit.inventory.conformanceCounts,
  );
  assert.deepEqual(
    countBy(inventory.apis, "mvpDisposition"),
    exit.inventory.dispositionCounts,
  );

  const required = inventory.apis.filter((api) => api.mvpDisposition === "required");
  const requiredPartial = required
    .filter((api) => api.conformanceStatus === "partial")
    .map((api) => api.name);
  const requiredUnknown = required
    .filter((api) => api.conformanceStatus === "unknown")
    .map((api) => api.name);
  assert.deepEqual(
    sorted(requiredPartial),
    sorted(exit.requiredPartialKnownDifferences.flatMap((difference) => difference.apis)),
  );
  assert.equal(exit.acceptedCoverageLimitations.length, 1);
  assert.equal(
    exit.acceptedCoverageLimitations[0].status,
    "accepted-unverified-baseline",
  );
  assert.deepEqual(
    sorted(requiredUnknown),
    sorted(exit.acceptedCoverageLimitations[0].apis),
  );
  assert.deepEqual(
    required.filter((api) => ["unsupported", "unimplemented"].includes(api.implementationStatus)),
    [],
  );

  for (const disposition of ["conditional", "excluded"]) {
    assert.deepEqual(
      sorted(
        inventory.apis
          .filter((api) => api.mvpDisposition === disposition)
          .map((api) => api.name),
      ),
      sorted(exit.scopeExclusions[disposition]),
    );
  }

  const differences = [
    ...exit.requiredPartialKnownDifferences,
    ...exit.additionalKnownDifferences,
  ];
  assert.deepEqual(
    differences.map((difference) => difference.id),
    ["P4-KD-01", "P4-KD-02", "P4-KD-03", "P4-KD-04", "P4-KD-05", "P4-KD-06"],
  );
  assert.ok(differences.every((difference) => difference.severity === "P2"));
  assert.ok(differences.every((difference) => difference.workaround.length > 0));
});

test("Phase 4H project corpus remains 7/7 C3 with Node and Chrome agreement", async () => {
  const corpus = await readJson("tests/conformance/manifests/phase-4-l2-corpus.json");
  const issues = await readJson("tests/conformance/manifests/phase-4-issues.json");
  const node = await readJson("benchmarks/phase-4/results/node-macos-arm64-l2-baseline.json");
  const chrome = await readJson(
    "benchmarks/phase-4/results/chromium-macos-arm64-l2-baseline.json",
  );

  assert.equal(corpus.corpusId, exit.corpus.id);
  assert.equal(corpus.ownership, "project-authored and tracked in this repository");
  assert.equal(corpus.cases.length, exit.corpus.cases);
  assert.ok(corpus.cases.every((entry) => entry.provenance === "project-authored"));
  for (const entry of corpus.cases) {
    assert.equal(await sha256(entry.source), entry.sourceSha256, entry.id);
  }

  const expectedSummary = {
    counts: exit.corpus.classifications,
    denominator: 7,
    playable: 7,
    playableRate: exit.corpus.playableRate,
    openP0: exit.corpus.openP0,
    openP1: exit.corpus.openP1,
  };
  assert.deepEqual(node.summary, expectedSummary);
  assert.deepEqual(chrome.summary, expectedSummary);
  assert.equal(node.build.playerBuildId, chrome.build.playerBuildId);
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
  assert.equal(chrome.environment.browserScope, "Chrome/Chromium desktop only");
  assert.equal(chrome.externalCorpus.publishedDenominatorContribution, 0);
  assert.deepEqual(issues.issues, []);
});

test("Phase 4H closes CPU, resource and reviewed Chrome gates", async () => {
  const contract = await readJson("spec/phase-4-l2-mvp-contract.json");
  const longRun = await readJson(
    "benchmarks/phase-4/results/chromium-macos-arm64-phase-4g-long-run.json",
  );
  const runtimeManifest = await readJson("wasm/runtime-v1.manifest.lock.json");

  assert.equal(
    contract.workUnits["4F"].result.referenceInstructionsPerSecond,
    exit.cpu.referenceInstructionsPerSecond,
  );
  assert.equal(
    contract.workUnits["4F"].result.slowFrameThresholdRawExclusive,
    exit.cpu.slowFrameThresholdRawExclusive,
  );
  assert.equal(
    contract.workUnits["4F"].result.safetyHardCapDefault,
    exit.cpu.safetyHardCapDefault,
  );

  assert.equal(longRun.limits.wasmMemory.bytes, exit.resources.fixedWasmBytes);
  assert.equal(longRun.limits.wasmMemory.growth, false);
  assert.equal(longRun.limits.luaHeap.defaultBytes, exit.resources.defaultLuaHeapBytes);
  assert.ok(longRun.soak.actualDurationMs / 1000 >= exit.resources.soakSeconds);
  assert.equal(longRun.lifecycle.loads, exit.resources.sequentialCartLoads);
  assert.equal(longRun.workerErrors.length, 0);
  assert.equal(longRun.soak.longTasks.length, 0);
  assert.ok(longRun.soak.heap.cdp.deltaBytes <= 1024 * 1024);
  assert.ok(
    longRun.soak.profiles.every(
      (profile) =>
        profile.droppedTicks === 0 &&
        profile.discontinuities === 0 &&
        Object.values(profile.audioDelta).every((value) => value === 0),
    ),
  );
  assert.equal(longRun.resources.workersCreated, longRun.resources.workersTerminated);
  assert.equal(longRun.resources.activeAnimationFrames, 0);
  assert.equal(longRun.resources.activeDomListeners, 0);
  assert.ok(longRun.resources.audioStates.every((state) => state === "closed"));
  assert.ok(
    longRun.soak.releasedAudio.every(
      (audio) => audio.queuedSourceFrames === 0 && audio.playing === false,
    ),
  );
  assert.equal(longRun.manifestSha256, exit.inputs["tests/conformance/manifests/phase-4g-resource-long-run.json"]);

  const runtimeWasm = runtimeManifest.artifact.files.find(
    (artifact) => artifact.path === "z8lua-runtime-v1.wasm",
  );
  assert.equal(runtimeManifest.abiVersion, 0x00010003);
  assert.equal(runtimeWasm.sha256, contract.workUnits["4H"].result.runtimeWasmSha256);
});

test("Phase 4 contract and published evidence are closed", async () => {
  const contract = await readJson("spec/phase-4-l2-mvp-contract.json");
  const packageJson = await readJson("package.json");
  const evidence = await readFile(
    new URL("docs/evidence/phase-4/51-phase-4-l2-mvp-exit-evidence.md", projectRoot),
    "utf8",
  );
  const compatibility = await readFile(
    new URL("docs/06-testing-compatibility.md", projectRoot),
    "utf8",
  );

  assert.equal(contract.status, "complete");
  assert.deepEqual(contract.completedWorkUnits, ["4A", "4B", "4C", "4D", "4E", "4F", "4G", "4H"]);
  assert.equal(contract.activeWorkUnit, null);
  assert.equal(contract.nextWorkUnit, null);
  assert.equal(contract.nextPhase, "5-deferred");
  assert.ok(Object.values(contract.workUnits).every((unit) => unit.status === "complete"));
  assert.equal(contract.workUnits["4H"].result.exitManifestSha256, await sha256("tests/conformance/manifests/phase-4h-exit.json"));
  assert.equal(contract.workUnits["4H"].result.releaseClaim, exit.target);
  assert.equal(contract.workUnits["4H"].result.publishedKnownDifferences, 6);
  assert.equal(contract.workUnits["4H"].result.acceptedRequiredCoverageLimitations, 28);

  for (const hash of Object.values(exit.inputs)) assert.ok(evidence.includes(hash));
  for (const id of ["P4-KD-01", "P4-KD-02", "P4-KD-03", "P4-KD-04", "P4-KD-05", "P4-KD-06", "P4-CL-01"]) {
    assert.ok(evidence.includes(id), id);
    assert.ok(compatibility.includes(id), id);
  }
  assert.ok(evidence.includes(exit.target));
  assert.ok(packageJson.scripts.test.includes("test:phase-4h"));
  assert.ok(packageJson.scripts.verify.includes("test:phase-4h"));
  assert.equal(
    packageJson.scripts["test:phase-4h"],
    "node --test tests/conformance/phase-4h-exit.test.mjs",
  );
  await assert.rejects(
    readFile(new URL("docs/phases/4-l2-mvp-hardening.md", projectRoot)),
    { code: "ENOENT" },
  );
});
