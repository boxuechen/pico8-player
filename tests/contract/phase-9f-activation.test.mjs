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

test("Phase 9F is the only active work unit", () => {
  assert.deepEqual(contract.completedWorkUnits, ["9A", "9B", "9C", "9D", "9E"]);
  assert.equal(contract.activeWorkUnit, "9F");
  assert.equal(contract.nextWorkUnit, "9F");
  assert.equal(contract.workUnits["9F"].status, "active");
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

test("Phase 9F is the documented and executable route", async () => {
  const [readme, phase, index] = await Promise.all([
    read("docs/README.md"),
    read("docs/phases/9-supplemental-compatibility-remediation.md"),
    read("docs/phases/README.md"),
  ]);
  assert.match(readme, /Active work unit \| 9F/u);
  assert.match(phase, /Active work unit：9F/u);
  assert.match(phase, /恰好一次 4×50/u);
  assert.match(index, /active\s+work unit 为 9F/u);
  assert.match(packageJson.scripts["test:phase-9f"], /phase-9f-activation\.test\.mjs/u);
  assert.match(packageJson.scripts["verify:phase-9"], /test:phase-9f/u);
});

function qualificationAuthority(field) {
  return contract.workUnits["9F"].qualification[field];
}
