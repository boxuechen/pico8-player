import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const readJson = async (path) => JSON.parse(await read(path));
const [contract, causes] = await Promise.all([
  readJson("spec/phase-9-supplemental-compatibility-remediation-contract.json"),
  readJson("spec/compat/phase-9-root-cause-contract-v1.json"),
]);

test("Phase 9B remains complete while one later work unit is active", () => {
  assert.ok(contract.completedWorkUnits.includes("9B"));
  assert.equal(contract.workUnits["9A"].status, "complete");
  assert.equal(contract.workUnits["9B"].status, "complete");
  assert.equal(Object.values(contract.workUnits)
    .filter(({ status }) => status === "active").length, 1);
});

test("Phase 9B owns exactly the 45 anonymous language cases", () => {
  const candidates = causes.candidates.filter(({ ownerPhase }) => ownerPhase === "9B");
  assert.equal(candidates.length, 13);
  assert.equal(candidates.reduce((sum, entry) => sum + entry.cases, 0), 45);
  assert.ok(candidates.every(({ cluster }) => cluster === "language"));
  assert.ok(candidates.every(({ reproducerPlan }) =>
    reproducerPlan.command === "pnpm run test:phase-9b"));
  assert.ok(candidates.every(({ evidenceGap }) => evidenceGap.length > 0));
});

test("Phase 9B authorizes language owners without cart-specific or ref input", () => {
  const allowed = contract.workUnits["9B"].allowedPaths;
  for (const path of [
    "wasm/bridge/",
    "wasm/z8lua/",
    "packages/z8lua-bridge/src/",
    "packages/runtime-core/src/",
    "tests/runtime/",
    "tests/wasm/",
    "tests/fixtures/phase-9/",
  ]) assert.ok(allowed.includes(path));
  assert.equal(allowed.some((path) => path.startsWith("ref/")), false);
  assert.equal(contract.remediationPolicy.cartSpecificBranchesAllowed, false);
  assert.equal(contract.remediationPolicy.dailyExternalChromeCasesMaximum, 10);
});

test("Phase 9B records aggregate-only completion evidence", () => {
  const result = contract.workUnits["9B"].result;
  assert.equal(result.candidateBuckets, 13);
  assert.equal(result.baselineLanguageCases, 45);
  assert.equal(result.projectAuthoredFixtures, 13);
  assert.equal(result.ownerRegressionsPassed, 13);
  assert.equal(result.chromeSelectedCases, 10);
  assert.equal(result.chromeLanguageRootPasses, 10);
  assert.equal(result.chromeCuPasses, 9);
  assert.equal(result.downstreamCasesReownedTo9D, 1);
  assert.equal(result.defaultLuaHeapBytes, 2 * 1024 * 1024);
  assert.equal(result.fixedWasmBytes, 16 * 1024 * 1024);
  assert.equal(result.memoryGrowth, false);
  assert.equal(result.productionCartSpecificBranches, 0);
  assert.equal(result.supplementalFullReruns, 0);
  assert.equal(result.trackedThirdPartyDetails, 0);
});

test("Phase 9B remains summarized after the route advances", async () => {
  const phase = await read("docs/phases/9-supplemental-compatibility-remediation.md");
  assert.match(phase, /13 个 language candidate/u);
});
