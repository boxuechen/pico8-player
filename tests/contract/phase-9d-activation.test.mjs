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

test("Phase 9D is the only active work unit", () => {
  assert.deepEqual(contract.completedWorkUnits, ["9A", "9B", "9C"]);
  assert.equal(contract.activeWorkUnit, "9D");
  assert.equal(contract.nextWorkUnit, "9D");
  assert.equal(contract.workUnits["9D"].status, "active");
  assert.equal(Object.values(contract.workUnits)
    .filter(({ status }) => status === "active").length, 1);
});

test("Phase 9D owns the baseline host candidate plus one downstream case", () => {
  const candidates = causes.candidates.filter(({ ownerPhase }) => ownerPhase === "9D");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].id, "host-external-cartdata-request");
  assert.equal(candidates[0].cases, 1);
  assert.equal(contract.workUnits["9B"].result.downstreamCasesReownedTo9D, 1);
});

test("Phase 9D preserves caller-authorized local-only authority", () => {
  const allowed = contract.workUnits["9D"].allowedPaths;
  for (const path of [
    "packages/runtime-core/src/",
    "apps/web-player/src/worker/",
    "tests/runtime/",
    "tests/contract/",
    "tests/fixtures/phase-9/",
  ]) assert.ok(allowed.includes(path));
  assert.equal(allowed.some((path) => path.startsWith("ref/")), false);
  assert.equal(contract.remediationPolicy.networkAuthorityExpansion, false);
  assert.equal(contract.remediationPolicy.hostFilesystemAuthorityExpansion, false);
});

test("Phase 9D is the documented and executable route", async () => {
  const [readme, phase, index] = await Promise.all([
    read("docs/README.md"),
    read("docs/phases/9-supplemental-compatibility-remediation.md"),
    read("docs/phases/README.md"),
  ]);
  assert.match(readme, /Active work unit \| 9D/u);
  assert.match(phase, /Active work unit：9D/u);
  assert.match(phase, /host-external-cartdata-request/u);
  assert.match(index, /active\s+work unit 为 9D/u);
  assert.match(packageJson.scripts["test:phase-9d"], /phase-9d-activation\.test\.mjs/u);
  assert.match(packageJson.scripts["verify:phase-9"], /test:phase-9d/u);
});
