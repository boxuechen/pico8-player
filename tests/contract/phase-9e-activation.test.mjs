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

test("Phase 9E is the only active work unit", () => {
  assert.deepEqual(contract.completedWorkUnits, ["9A", "9B", "9C", "9D"]);
  assert.equal(contract.activeWorkUnit, "9E");
  assert.equal(contract.nextWorkUnit, "9E");
  assert.equal(contract.workUnits["9E"].status, "active");
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

test("Phase 9E is the documented and executable route", async () => {
  const [readme, phase, index] = await Promise.all([
    read("docs/README.md"),
    read("docs/phases/9-supplemental-compatibility-remediation.md"),
    read("docs/phases/README.md"),
  ]);
  assert.match(readme, /Active work unit \| 9E/u);
  assert.match(phase, /Active work unit：9E/u);
  assert.match(phase, /最多 10/u);
  assert.match(index, /active\s+work unit 为 9E/u);
  assert.match(packageJson.scripts["test:phase-9e"], /phase-9e-activation\.test\.mjs/u);
  assert.match(packageJson.scripts["verify:phase-9"], /test:phase-9e/u);
});
