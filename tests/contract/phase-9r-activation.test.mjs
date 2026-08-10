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

test("Phase 9R remains complete while one later work unit is active", () => {
  assert.ok(contract.completedWorkUnits.includes("9R"));
  assert.equal(contract.workUnits["9R"].status, "complete");
  assert.equal(Object.values(contract.workUnits)
    .filter(({ status }) => status === "active").length, 1);
});

test("Phase 9R is bounded to the four observed failures and three generic language roots", () => {
  const scope = contract.workUnits["9R"].scope;
  assert.deepEqual(
    [scope.observedFailures, scope.languageFailures, scope.hostFeatureFailures],
    [4, 3, 1],
  );
  assert.equal(scope.downstreamLanguageFailuresAfterBundleResolution, 1);
  assert.equal(scope.genericLanguageRootCauses, 3);
  assert.equal(scope.projectAuthoredReproducersRequired, 3);
  assert.equal(scope.focusedExternalUniqueCasesMaximum, 4);
  assert.equal(scope.logicalTicksPerCase, 120);
  assert.equal(scope.fullSupplementalRerunsAllowed, 0);
  assert.equal(scope.cartSpecificBranchesAllowed, false);
});

test("Phase 9R authorizes only the required bridge and test owners", () => {
  const allowed = contract.workUnits["9R"].allowedPaths;
  for (const path of ["wasm/bridge/", "tests/runtime/", "tests/fixtures/phase-9/", "docs/adr/"]) {
    assert.ok(allowed.includes(path));
  }
  assert.equal(allowed.some((path) => path.startsWith("packages/")), false);
  assert.equal(allowed.some((path) => path.startsWith("apps/")), false);
  assert.equal(allowed.some((path) => path.startsWith("ref/")), false);
  assert.equal(contract.workUnits["9R"].scope.networkAuthorityExpansion, false);
  assert.equal(contract.workUnits["9R"].scope.hostFilesystemAuthorityExpansion, false);
});

test("Phase 9R remains summarized and executable after the route advances", async () => {
  const phase = await read("docs/phases/9-supplemental-compatibility-remediation.md");
  assert.match(phase, /最终 4\/4 CU/u);
  assert.match(packageJson.scripts["test:phase-9r"], /phase-9r-activation\.test\.mjs/u);
  assert.match(packageJson.scripts["verify:phase-9"], /test:phase-9r/u);
});

test("Phase 9R records aggregate-only completion evidence", () => {
  const result = contract.workUnits["9R"].result;
  assert.equal(result.initialObservedFailures, 4);
  assert.equal(result.genericLanguageRootCauses, 3);
  assert.equal(result.localCompositionGaps, 1);
  assert.equal(result.projectAuthoredFixtures, 3);
  assert.equal(result.ownerRegressionsPassed, 3);
  assert.equal(result.cameraPreviousStateReturn, true);
  assert.equal(result.absentValueAllIsEmpty, true);
  assert.equal(result.maximumChrValues, 8192);
  assert.equal(result.explicitLocalBundleRequired, true);
  assert.equal(result.externalUniqueCases, 4);
  assert.equal(result.externalChromeExecutions, 5);
  assert.equal(result.externalCasesAtCU, 4);
  assert.equal(result.remainingFocusedFailures, 0);
  assert.equal(result.productionCartSpecificBranches, 0);
  assert.equal(result.networkAuthorityExpansion, false);
  assert.equal(result.hostFilesystemAuthorityExpansion, false);
  assert.equal(result.supplementalFullReruns, 0);
  assert.equal(result.trackedThirdPartyDetails, 0);
  assert.equal(result.runtimeWasmBytes, 197646);
  assert.match(result.runtimeWasmSha256, /^[a-f0-9]{64}$/u);
});
