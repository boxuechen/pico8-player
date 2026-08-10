import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const readJson = async (path) => JSON.parse(await read(path));
const [contract, packageJson] = await Promise.all([
  readJson("spec/phase-9-supplemental-compatibility-remediation-contract.json"),
  readJson("package.json"),
]);

test("Phase 9E remains complete while one later work unit is active", () => {
  assert.ok(contract.completedWorkUnits.includes("9E"));
  assert.equal(contract.workUnits["9E"].status, "complete");
  assert.equal(Object.values(contract.workUnits)
    .filter(({ status }) => status === "active").length, 1);
});

test("Phase 9E is verification-only and bounded to ten external cases", () => {
  const allowed = contract.workUnits["9E"].allowedPaths;
  assert.ok(allowed.includes("tools/compat/"));
  assert.ok(allowed.includes("tests/compat/"));
  assert.equal(allowed.some((path) => path.startsWith("packages/")), false);
  assert.equal(allowed.some((path) => path.startsWith("wasm/")), false);
  assert.equal(allowed.some((path) => path.startsWith("ref/")), false);
  assert.equal(contract.remediationPolicy.dailyExternalChromeCasesMaximum, 10);
  assert.equal(contract.remediationPolicy.dailyLogicalTicksPerCase, 120);
});

test("Phase 9E remains summarized and executable after the route advances", async () => {
  const phase = await read("docs/phases/9-supplemental-compatibility-remediation.md");
  assert.match(phase, /10\/10 CU/u);
  assert.match(packageJson.scripts["test:phase-9e"], /phase-9e-activation\.test\.mjs/u);
  assert.match(packageJson.scripts["verify:phase-9"], /test:phase-9e/u);
});

test("Phase 9E records aggregate-only focused Chrome evidence", () => {
  const result = contract.workUnits["9E"].result;
  assert.deepEqual(
    [result.languageRepresentatives, result.timingRepresentatives, result.hostRepresentatives],
    [6, 2, 2],
  );
  assert.equal(result.representativeCases, 10);
  assert.equal(result.logicalTicksPerCase, 120);
  assert.equal(result.completedCases, 10);
  assert.equal(result.chromeCuPasses, 10);
  assert.equal(result.remainingFailures, 0);
  assert.equal(result.failureClusters, 0);
  assert.equal(result.singlePlayerCommit, true);
  assert.equal(result.singleRuntimeWasm, true);
  assert.equal(result.singleChromeBuild, true);
  assert.equal(result.productionWorkerPath, true);
  assert.equal(result.productionSourceChanges, 0);
  assert.equal(result.supplementalFullReruns, 0);
  assert.equal(result.longPlayabilityRuns, 0);
  assert.equal(result.historicalVerificationRuns, 0);
  assert.equal(result.trackedThirdPartyDetails, 0);
});
