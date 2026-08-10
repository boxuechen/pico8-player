import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const readJson = async (path) => JSON.parse(await read(path));
const [contract, causes, packageJson] = await Promise.all([
  readJson("spec/phase-9-supplemental-compatibility-remediation-contract.json"),
  readJson("spec/compat/phase-9-root-cause-contract-v1.json"),
  readJson("package.json"),
]);

test("Phase 9C is complete and activates only 9D", () => {
  assert.deepEqual(contract.completedWorkUnits, ["9A", "9B", "9C"]);
  assert.equal(contract.activeWorkUnit, "9D");
  assert.equal(contract.nextWorkUnit, "9D");
  assert.equal(contract.workUnits["9C"].status, "complete");
  assert.equal(contract.workUnits["9D"].status, "active");
  assert.equal(Object.values(contract.workUnits)
    .filter(({ status }) => status === "active").length, 1);
});

test("Phase 9C owns one anonymous timing candidate covering five cases", () => {
  const candidates = causes.candidates.filter(({ ownerPhase }) => ownerPhase === "9C");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].id, "timing-instruction-budget-boundary");
  assert.equal(candidates[0].cases, 5);
  assert.deepEqual(candidates[0].faultCodes, ["E_VM_INSTRUCTION_BUDGET"]);
  assert.equal(candidates[0].reproducerPlan.command, "pnpm run test:phase-9c");
  assert.match(candidates[0].evidenceGap, /cannot distinguish legitimate heavy work/u);
});

test("Phase 9C authorizes deterministic scheduler owners without expanding authority", () => {
  const allowed = contract.workUnits["9C"].allowedPaths;
  for (const path of [
    "packages/runtime-core/src/",
    "packages/z8lua-bridge/src/",
    "wasm/bridge/",
    "tests/runtime/",
    "tests/compat/",
    "tests/contract/",
    "tests/fixtures/phase-9/",
  ]) assert.ok(allowed.includes(path));
  assert.equal(allowed.some((path) => path.startsWith("ref/")), false);
  assert.equal(contract.remediationPolicy.dailyExternalChromeCasesMaximum, 10);
  assert.equal(contract.remediationPolicy.networkAuthorityExpansion, false);
  assert.equal(contract.remediationPolicy.hostFilesystemAuthorityExpansion, false);
});

test("Phase 9C records aggregate-only completion evidence", () => {
  const result = contract.workUnits["9C"].result;
  assert.equal(result.candidateBuckets, 1);
  assert.equal(result.baselineTimingCases, 5);
  assert.equal(result.projectAuthoredFixtures, 2);
  assert.equal(result.ownerRegressionsPassed, 2);
  assert.equal(result.measuredFiniteMaximumInstructions, 21_623_599);
  assert.equal(result.defaultSafetyInstructionLimit, 32_000_000);
  assert.equal(result.deterministicInstructionAccounting, true);
  assert.equal(result.adaptiveBudget, false);
  assert.equal(result.numericForBoundaryFix, true);
  assert.equal(result.chromeSelectedCases, 5);
  assert.equal(result.chromeCuPasses, 5);
  assert.equal(result.remainingTimingFailures, 0);
  assert.equal(result.productionCartSpecificBranches, 0);
  assert.equal(result.supplementalFullReruns, 0);
  assert.equal(result.trackedThirdPartyDetails, 0);
});

test("Phase 9C hands the documented route to 9D", async () => {
  const [readme, phase, index] = await Promise.all([
    read("docs/README.md"),
    read("docs/phases/9-supplemental-compatibility-remediation.md"),
    read("docs/phases/README.md"),
  ]);
  assert.match(readme, /Active work unit \| 9D/u);
  assert.match(phase, /Active work unit：9D/u);
  assert.match(phase, /timing-instruction-budget-boundary/u);
  assert.match(index, /active\s+work unit 为 9D/u);
  assert.match(packageJson.scripts["test:phase-9c"], /phase-9c-activation\.test\.mjs/u);
  assert.match(packageJson.scripts["verify:phase-9"], /test:phase-9c/u);
});
