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

test("Phase 9H is the only active work unit", () => {
  assert.equal(contract.activeWorkUnit, "9H");
  assert.equal(contract.nextWorkUnit, "9H");
  assert.equal(contract.workUnits["9H"].status, "active");
  assert.equal(Object.values(contract.workUnits)
    .filter(({ status }) => status === "active").length, 1);
});

test("Phase 9H is aggregate-only and cannot expand runtime scope", () => {
  const unit = contract.workUnits["9H"];
  assert.equal(unit.scope.aggregateEvidenceOnly, true);
  assert.equal(unit.scope.externalCorpusCases, 0);
  assert.equal(unit.scope.supplementalFullRerunsAllowed, 0);
  assert.equal(unit.scope.historicalVerificationRunsRequired, 0);
  assert.equal(unit.scope.longSoakRunsRequired, 0);
  assert.equal(unit.scope.productionSourceChangesAllowed, false);
  assert.equal(unit.scope.trackedThirdPartyDetails, 0);
  assert.equal(unit.scope.publicCompatibilityRate, false);
  assert.equal(unit.allowedPaths.some((path) => path.startsWith("packages/")), false);
  assert.equal(unit.allowedPaths.some((path) => path.startsWith("wasm/")), false);
  assert.equal(unit.allowedPaths.some((path) => path.startsWith("apps/")), false);
  assert.equal(unit.allowedPaths.some((path) => path.startsWith("ref/")), false);
});

test("Phase 9H is the documented and executable route", async () => {
  const [readme, phase, index] = await Promise.all([
    read("docs/README.md"),
    read("docs/phases/9-supplemental-compatibility-remediation.md"),
    read("docs/phases/README.md"),
  ]);
  assert.match(readme, /Active work unit \| 9H/u);
  assert.match(phase, /Active work unit：9H/u);
  assert.match(phase, /当前工作：9H Aggregate Exit/u);
  assert.match(phase, /不得把跨 commit observation 合并/u);
  assert.match(index, /active\s+work unit 为 9H/u);
  assert.match(packageJson.scripts["test:phase-9h"], /phase-9h-activation\.test\.mjs/u);
  assert.match(packageJson.scripts["verify:phase-9"], /test:phase-9h/u);
});
