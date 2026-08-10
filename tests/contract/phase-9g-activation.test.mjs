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

test("Phase 9G is the only active work unit", () => {
  assert.equal(contract.activeWorkUnit, "9G");
  assert.equal(contract.nextWorkUnit, "9G");
  assert.equal(contract.workUnits["9G"].status, "active");
  assert.equal(Object.values(contract.workUnits)
    .filter(({ status }) => status === "active").length, 1);
});

test("Phase 9G is a focused release-only verification unit", () => {
  const unit = contract.workUnits["9G"];
  assert.equal(unit.scope.phaseVerification, "pnpm run verify:phase-9");
  assert.equal(unit.scope.releaseVerification, "pnpm run verify:release");
  assert.equal(unit.scope.externalCorpusCases, 0);
  assert.equal(unit.scope.historicalVerificationRunsRequired, 0);
  assert.equal(unit.scope.longSoakRunsRequired, 0);
  assert.equal(unit.scope.productionSourceChangesAllowed, false);
  assert.equal(unit.scope.openP0Target, 0);
  assert.equal(unit.scope.openP1Target, 0);
  assert.equal(unit.allowedPaths.some((path) => path.startsWith("packages/")), false);
  assert.equal(unit.allowedPaths.some((path) => path.startsWith("wasm/")), false);
  assert.equal(unit.allowedPaths.some((path) => path.startsWith("apps/")), false);
  assert.equal(unit.allowedPaths.some((path) => path.startsWith("ref/")), false);
});

test("Phase 9G is the documented and executable route", async () => {
  const [readme, phase, index] = await Promise.all([
    read("docs/README.md"),
    read("docs/phases/9-supplemental-compatibility-remediation.md"),
    read("docs/phases/README.md"),
  ]);
  assert.match(readme, /Active work unit \| 9G/u);
  assert.match(phase, /Active work unit：9G/u);
  assert.match(phase, /verification-only/u);
  assert.match(index, /active\s+work unit 为 9G/u);
  assert.match(packageJson.scripts["test:phase-9g"], /phase-9g-activation\.test\.mjs/u);
  assert.match(packageJson.scripts["verify:phase-9"], /test:phase-9g/u);
});
