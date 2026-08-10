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

test("Phase 9F is complete after its single full requalification", () => {
  assert.ok(contract.completedWorkUnits.includes("9F"));
  assert.equal(contract.activeWorkUnit, "9H");
  assert.equal(contract.nextWorkUnit, "9H");
  assert.equal(contract.workUnits["9F"].status, "complete");
  assert.equal(Object.values(contract.workUnits)
    .filter(({ status }) => status === "active").length, 1);
});

test("Phase 9F authorizes exactly one four-by-fifty short Chrome requalification", () => {
  const qualification = contract.workUnits["9F"].qualification;
  assert.equal(qualification.executionRuns, 1);
  assert.equal(qualification.batches, 4);
  assert.equal(qualification.casesPerBatch, 50);
  assert.equal(qualification.expectedCases, 200);
  assert.equal(qualification.logicalTicksPerCase, 120);
  assert.equal(qualification.requiresCleanPlayer, true);
  assert.equal(qualification.productionWorkerPath, true);
  assert.equal(qualification.explicitLocalBundlesRequired, true);
  assert.equal(contract.remediationPolicy.fullSupplementalReruns, 1);
});

test("Phase 9F remains verification-only and does not expand authority", () => {
  const allowed = contract.workUnits["9F"].allowedPaths;
  assert.ok(allowed.includes("tools/compat/"));
  assert.ok(allowed.includes("tests/compat/"));
  assert.equal(allowed.some((path) => path.startsWith("packages/")), false);
  assert.equal(allowed.some((path) => path.startsWith("wasm/")), false);
  assert.equal(allowed.some((path) => path.startsWith("apps/")), false);
  assert.equal(allowed.some((path) => path.startsWith("ref/")), false);
  assert.equal(qualificationAuthority("networkAuthorityExpansion"), false);
  assert.equal(qualificationAuthority("hostFilesystemAuthorityExpansion"), false);
});

test("Phase 9F remains documented and executable after routing its final failure", async () => {
  const [readme, phase, index] = await Promise.all([
    read("docs/README.md"),
    read("docs/phases/9-supplemental-compatibility-remediation.md"),
    read("docs/phases/README.md"),
  ]);
  assert.match(readme, /Active work unit \| 9H/u);
  assert.match(phase, /199 CU、1 个 language failure/u);
  assert.match(phase, /不会运行第二次 200-cart sweep/u);
  assert.match(index, /active\s+work unit 为 9H/u);
  assert.match(packageJson.scripts["test:phase-9f"], /phase-9f-activation\.test\.mjs/u);
  assert.match(packageJson.scripts["verify:phase-9"], /test:phase-9f/u);
});

test("Phase 9F records its complete aggregate without hiding the remaining failure", () => {
  const result = contract.workUnits["9F"].result;
  assert.equal(result.qualificationAttempts, 2);
  assert.equal(result.completedRequalificationRuns, 1);
  assert.equal(result.completedObservationBatches, 4);
  assert.equal(result.observedCases, 200);
  assert.equal(result.observedCu, 199);
  assert.equal(result.observedFailures, 1);
  assert.deepEqual(result.observedFailureClusters, { language: 1 });
  assert.equal(result.logicalTicksPerCase, 120);
  assert.equal(result.explicitLocalBundleCases, 3);
  assert.equal(result.screenshotsCaptured, 200);
  assert.equal(result.samePlayerCommit, true);
  assert.equal(result.sameRuntimeWasm, true);
  assert.equal(result.sameChromeBuild, true);
  assert.equal(result.productionWorkerPath, true);
  assert.equal(result.secondFullRerunAllowed, false);
  assert.equal(result.trackedThirdPartyDetails, 0);
});

test("Phase 9F records the aborted attempt as aggregate-only evidence", () => {
  const attempt = contract.workUnits["9F"].attempt;
  assert.equal(attempt.qualificationAttempts, 1);
  assert.equal(attempt.completedRequalificationRuns, 0);
  assert.equal(attempt.completedObservationBatches, 3);
  assert.equal(attempt.observedCases, 175);
  assert.equal(attempt.observedCu, 171);
  assert.equal(attempt.observedFailures, 4);
  assert.deepEqual(attempt.observedFailureClusters, {
    language: 3,
    "unsupported-host-feature": 1,
  });
  assert.equal(attempt.abortedOnFailure, true);
  assert.equal(attempt.productionSourceChanges, 0);
  assert.equal(attempt.trackedThirdPartyDetails, 0);
});

function qualificationAuthority(field) {
  return contract.workUnits["9F"].qualification[field];
}
