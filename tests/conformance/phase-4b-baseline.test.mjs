import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import test, { before } from "node:test";

const projectRoot = new URL("../../", import.meta.url);
const paths = {
  corpus: new URL("manifests/phase-4-l2-corpus.json", import.meta.url),
  issues: new URL("manifests/phase-4-issues.json", import.meta.url),
  schema: new URL("manifests/phase-4-result.schema.json", import.meta.url),
  contract: new URL("spec/phase-4-l2-mvp-contract.json", projectRoot),
  reviewedNode: new URL(
    "benchmarks/phase-4/results/node-macos-arm64-l2-baseline.json",
    projectRoot,
  ),
  reviewedChrome: new URL(
    "benchmarks/phase-4/results/chromium-macos-arm64-l2-baseline.json",
    projectRoot,
  ),
  smokeNode: new URL("benchmarks/phase-4/results/node-l2-baseline-smoke.json", projectRoot),
  smokeChrome: new URL(
    "benchmarks/phase-4/results/chromium-l2-baseline-smoke.json",
    projectRoot,
  ),
};

let corpus;
let issues;
let schema;
let contract;
let reviewedNode;
let reviewedChrome;

before(async () => {
  [corpus, issues, schema, contract, reviewedNode, reviewedChrome] = await Promise.all([
    readFile(paths.corpus, "utf8").then(JSON.parse),
    readFile(paths.issues, "utf8").then(JSON.parse),
    readFile(paths.schema, "utf8").then(JSON.parse),
    readFile(paths.contract, "utf8").then(JSON.parse),
    readFile(paths.reviewedNode, "utf8").then(JSON.parse),
    readFile(paths.reviewedChrome, "utf8").then(JSON.parse),
  ]);
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertResult(result, target) {
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.phase, "4B");
  assert.deepEqual(result.runner, { id: "phase4-l2-runner", version: 1 });
  assert.equal(result.target, target);
  assert.equal(result.corpus.id, corpus.corpusId);
  assert.equal(result.corpus.caseCount, corpus.cases.length);
  assert.match(result.build.playerBuildId, /^[a-f0-9]{64}$/u);
  assert.match(result.build.wasm.wasmSha256, /^[a-f0-9]{64}$/u);
  assert.equal(result.cases.length, corpus.cases.length);
  assert.deepEqual(result.cases.map(({ id }) => id), corpus.cases.map(({ id }) => id));
  for (const entry of result.cases) {
    assert.match(entry.sourceSha256, /^[a-f0-9]{64}$/u, `${entry.id} source hash`);
    assert.match(entry.cartSha256, /^[a-f0-9]{64}$/u, `${entry.id} cart hash`);
    assert.match(entry.execution.inputTraceSha256, /^[a-f0-9]{64}$/u,
      `${entry.id} input trace`);
    assert.ok(entry.execution.frameCount > 0, `${entry.id} frame range`);
    assert.ok(entry.execution.durationSeconds > 0, `${entry.id} time range`);
    assert.equal(entry.boot.state, "ready", `${entry.id} boot`);
    assert.equal(entry.targetObservation.firstFault, null, `${entry.id} first fault`);
    assert.equal(entry.targetObservation.firstDivergentFrame, null,
      `${entry.id} first divergent frame`);
    assert.ok(entry.oracle.screen, `${entry.id} screen observation`);
    assert.ok(entry.oracle.palette, `${entry.id} palette observation`);
    assert.ok(entry.oracle.ram, `${entry.id} RAM observation`);
    assert.ok(entry.oracle.canonicalAudio, `${entry.id} canonical audio observation`);
    assert.ok(entry.oracle.persistence, `${entry.id} persistence observation`);
  }
  assert.deepEqual(result.summary.counts, { C0: 0, C1: 0, C2: 0, C3: 7, CU: 0 });
  assert.equal(result.summary.denominator, 7);
  assert.equal(result.summary.playable, 7);
  assert.equal(result.summary.playableRate, 1);
  assert.equal(result.summary.openP0, 0);
  assert.equal(result.summary.openP1, 0);
  assert.deepEqual(result.externalCorpus, {
    included: false,
    bytesTracked: false,
    resultsTracked: false,
    publishedDenominatorContribution: 0,
  });
}

test("Phase 4B reviewed Node and Chrome results satisfy the versioned result contract", () => {
  assert.equal(schema.properties.phase.const, "4B");
  assert.equal(schema.properties.runner.properties.id.const, "phase4-l2-runner");
  assertResult(reviewedNode, "node-real-wasm");
  assertResult(reviewedChrome, "chrome-production");
  assert.match(reviewedChrome.environment.browserVersion, /Chrome|Chromium/u);
  assert.deepEqual(
    reviewedNode.cases.map(({ id, crossOracleSha256 }) => ({ id, crossOracleSha256 })),
    reviewedChrome.cases.map(({ id, crossOracleSha256 }) => ({ id, crossOracleSha256 })),
  );
  assert.equal(reviewedNode.build.playerBuildId, reviewedChrome.build.playerBuildId);
});

test("Phase 4B classifications and triage cover the complete frozen corpus", () => {
  assert.equal(issues.schemaVersion, 1);
  const issueByCase = new Map(issues.issues.map((issue) => [issue.caseId, issue]));
  for (const entry of reviewedChrome.cases) {
    if (entry.classification === "C0" || entry.classification === "C1") {
      const issue = issueByCase.get(entry.id);
      assert.ok(issue, `${entry.id} requires an issue record`);
      assert.ok(issues.severities.includes(issue.severity));
      assert.ok(issues.owners.includes(issue.owner));
      assert.ok(issue.repro?.projectAuthored || issue.minimizationState === "pending");
    }
  }
  assert.equal(reviewedChrome.cases.every(({ classification }) => classification === "C3"), true);
  assert.equal(issues.issues.length, 0);
  assert.deepEqual(
    corpus.cases.map(({ phase4Classification }) => phase4Classification),
    Array(corpus.cases.length).fill("C3"),
  );
});

test("Phase 4B contract hash-locks reviewed evidence and advances to 4C", async () => {
  const result = contract.workUnits["4B"].result;
  assert.equal(contract.activeWorkUnit, "4C");
  assert.equal(contract.nextWorkUnit, "4D");
  assert.deepEqual(contract.completedWorkUnits, ["4A", "4B"]);
  assert.equal(contract.workUnits["4B"].status, "complete");
  assert.equal(result.runner, "phase4-l2-runner@1");
  assert.equal(result.projectCorpusCases, 7);
  assert.deepEqual(result.classifications, { C0: 0, C1: 0, C2: 0, C3: 7, CU: 0 });
  assert.equal(result.playableRate, 1);
  assert.equal(
    sha256(await readFile(paths.reviewedNode)),
    result.nodeEvidenceSha256,
  );
  assert.equal(
    sha256(await readFile(paths.reviewedChrome)),
    result.chromeEvidenceSha256,
  );
});

test("current smoke results cannot silently drift from the reviewed baseline", async () => {
  for (const [path, reviewed] of [
    [paths.smokeNode, reviewedNode],
    [paths.smokeChrome, reviewedChrome],
  ]) {
    try {
      await access(path);
    } catch {
      continue;
    }
    const smoke = JSON.parse(await readFile(path, "utf8"));
    assert.equal(smoke.target, reviewed.target);
    assert.equal(smoke.build.playerBuildId, reviewed.build.playerBuildId);
    assert.deepEqual(
      smoke.cases.map(({ id, classification, crossOracleSha256 }) => ({
        id, classification, crossOracleSha256,
      })),
      reviewed.cases.map(({ id, classification, crossOracleSha256 }) => ({
        id, classification, crossOracleSha256,
      })),
    );
  }
});
