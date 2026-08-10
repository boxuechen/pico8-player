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

test("Phase 9R is the only active work unit", () => {
  assert.equal(contract.activeWorkUnit, "9R");
  assert.equal(contract.nextWorkUnit, "9R");
  assert.equal(contract.workUnits["9R"].status, "active");
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
  assert.equal(scope.focusedExternalCasesMaximum, 4);
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

test("Phase 9R is the documented and executable route", async () => {
  const [readme, phase, index] = await Promise.all([
    read("docs/README.md"),
    read("docs/phases/9-supplemental-compatibility-remediation.md"),
    read("docs/phases/README.md"),
  ]);
  assert.match(readme, /Active work unit \| 9R/u);
  assert.match(phase, /Active work unit：9R/u);
  assert.match(index, /active\s+work unit 为 9R/u);
  assert.match(packageJson.scripts["test:phase-9r"], /phase-9r-activation\.test\.mjs/u);
  assert.match(packageJson.scripts["verify:phase-9"], /test:phase-9r/u);
});
