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

test("Phase 9S is the only active work unit", () => {
  assert.equal(contract.activeWorkUnit, "9S");
  assert.equal(contract.nextWorkUnit, "9S");
  assert.equal(contract.workUnits["9S"].status, "active");
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

test("Phase 9S is documented and executable without another full sweep", async () => {
  const [readme, phase, index] = await Promise.all([
    read("docs/README.md"),
    read("docs/phases/9-supplemental-compatibility-remediation.md"),
    read("docs/phases/README.md"),
  ]);
  assert.match(readme, /Active work unit \| 9S/u);
  assert.match(phase, /Active work unit：9S/u);
  assert.match(phase, /只复测剩余 1 case/u);
  assert.match(index, /active\s+work unit 为 9S/u);
  assert.match(packageJson.scripts["test:phase-9s"], /phase-9s-activation\.test\.mjs/u);
  assert.match(packageJson.scripts["verify:phase-9"], /test:phase-9s/u);
});
