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

test("Phase 9S remains complete while one later work unit is active", () => {
  assert.ok(contract.completedWorkUnits.includes("9S"));
  assert.equal(contract.activeWorkUnit, "9G");
  assert.equal(contract.nextWorkUnit, "9G");
  assert.equal(contract.workUnits["9S"].status, "complete");
  assert.equal(Object.values(contract.workUnits)
    .filter(({ status }) => status === "active").length, 1);
});

test("Phase 9S is bounded to one generic menuitem failure", () => {
  const scope = contract.workUnits["9S"].scope;
  assert.deepEqual(
    [scope.observedFailures, scope.languageFailures, scope.genericRootCauses],
    [1, 1, 1],
  );
  assert.equal(scope.projectAuthoredReproducersRequired, 1);
  assert.equal(scope.focusedExternalUniqueCasesMaximum, 1);
  assert.equal(scope.logicalTicksPerCase, 120);
  assert.equal(scope.fullSupplementalRerunsAllowed, 0);
  assert.equal(scope.cartSpecificBranchesAllowed, false);
});

test("Phase 9S authorizes only VM-local bridge owners and focused evidence", () => {
  const unit = contract.workUnits["9S"];
  for (const path of ["wasm/bridge/", "tests/runtime/", "tests/fixtures/phase-9/", "docs/adr/"]) {
    assert.ok(unit.allowedPaths.includes(path));
  }
  assert.equal(unit.allowedPaths.some((path) => path.startsWith("packages/")), false);
  assert.equal(unit.allowedPaths.some((path) => path.startsWith("apps/")), false);
  assert.equal(unit.allowedPaths.some((path) => path.startsWith("ref/")), false);
  assert.equal(unit.scope.networkAuthorityExpansion, false);
  assert.equal(unit.scope.hostFilesystemAuthorityExpansion, false);
});

test("Phase 9S remains documented and executable without another full sweep", async () => {
  const [readme, phase, index] = await Promise.all([
    read("docs/README.md"),
    read("docs/phases/9-supplemental-compatibility-remediation.md"),
    read("docs/phases/README.md"),
  ]);
  assert.match(readme, /Active work unit \| 9G/u);
  assert.match(phase, /唯一 affected external case/u);
  assert.match(phase, /第二次 full sweep/u);
  assert.match(index, /active\s+work unit 为 9G/u);
  assert.match(packageJson.scripts["test:phase-9s"], /phase-9s-activation\.test\.mjs/u);
  assert.match(packageJson.scripts["verify:phase-9"], /test:phase-9s/u);
});

test("Phase 9S records aggregate-only completion evidence", () => {
  const result = contract.workUnits["9S"].result;
  assert.equal(result.initialObservedFailures, 1);
  assert.equal(result.genericLanguageRootCauses, 1);
  assert.equal(result.projectAuthoredFixtures, 1);
  assert.equal(result.ownerRegressionsPassed, 1);
  assert.equal(result.displayLabelP8sciiBytes, 16);
  assert.equal(result.longerLabelIsNonFatal, true);
  assert.equal(result.callbackRemainsInvokable, true);
  assert.equal(result.externalUniqueCases, 1);
  assert.equal(result.externalChromeExecutions, 1);
  assert.equal(result.externalCasesAtCU, 1);
  assert.equal(result.remainingFocusedFailures, 0);
  assert.equal(result.supplementalFullReruns, 0);
  assert.equal(result.historicalVerificationRuns, 0);
  assert.equal(result.trackedThirdPartyDetails, 0);
  assert.equal(result.runtimeWasmBytes, 197591);
  assert.match(result.runtimeWasmSha256, /^[a-f0-9]{64}$/u);
});
