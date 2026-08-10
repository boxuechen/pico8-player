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

test("Phase 9D remains complete while one later work unit is active", () => {
  assert.ok(contract.completedWorkUnits.includes("9D"));
  assert.equal(contract.workUnits["9D"].status, "complete");
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

test("Phase 9D records aggregate-only completion evidence", () => {
  const result = contract.workUnits["9D"].result;
  assert.equal(result.candidateBuckets, 1);
  assert.equal(result.baselineHostCases, 1);
  assert.equal(result.downstreamHostCases, 1);
  assert.equal(result.projectAuthoredFixtures, 2);
  assert.equal(result.ownerRegressionsPassed, 3);
  assert.equal(result.emptyLoadNoop, true);
  assert.equal(result.explicitLocalBundleRequired, true);
  assert.equal(result.missingOrDeniedRefFailsClosed, true);
  assert.equal(result.networkAuthorityExpansion, false);
  assert.equal(result.hostFilesystemAuthorityExpansion, false);
  assert.equal(result.chromeSelectedCases, 2);
  assert.equal(result.chromeCuPasses, 2);
  assert.equal(result.remainingHostFailures, 0);
  assert.equal(result.productionCartSpecificBranches, 0);
  assert.equal(result.supplementalFullReruns, 0);
  assert.equal(result.trackedThirdPartyDetails, 0);
});

test("Phase 9D remains documented and executable after the route advances", async () => {
  const phase = await read("docs/phases/9-supplemental-compatibility-remediation.md");
  assert.match(phase, /host-external-cartdata-request/u);
  assert.match(packageJson.scripts["test:phase-9d"], /phase-9d-activation\.test\.mjs/u);
  assert.match(packageJson.scripts["verify:phase-9"], /test:phase-9d/u);
});
