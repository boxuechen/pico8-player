import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const readJson = async (path) => JSON.parse(await read(path));
const sha256AtCommit = (commit, path) => createHash("sha256")
  .update(execFileSync("git", ["show", `${commit}:${path}`]))
  .digest("hex");
const contract = await readJson(
  "spec/phase-9-supplemental-compatibility-remediation-contract.json",
);

test("Phase 9A freezes the immutable Phase 8 exit baseline", () => {
  assert.equal(contract.phase, "9");
  assert.equal(contract.status, "active");
  assert.deepEqual(contract.browserGate, ["chrome", "chromium"]);
  for (const [pathKey, hashKey] of [
    ["phase8Contract", "phase8ContractSha256"],
    ["phase8Evidence", "phase8EvidenceSha256"],
    ["phase8ExitManifest", "phase8ExitManifestSha256"],
    ["runtimeManifest", "runtimeManifestSha256"],
  ]) assert.equal(
    sha256AtCommit(contract.baseline.baselineCommit, contract.baseline[pathKey]),
    contract.baseline[hashKey],
  );
});

test("Phase 9A makes the 51-failure target and bounded verification strategy measurable", () => {
  assert.deepEqual(contract.backlog.smokeOutcomes, { boots: 149, fails: 51, notRun: 0 });
  assert.deepEqual(contract.backlog.failureClusters,
    { language: 45, timing: 5, "unsupported-host-feature": 1 });
  assert.deepEqual(contract.backlog.targetDisposition, { CU: 200, fails: 0, notRun: 0 });
  assert.equal(contract.phaseExitGate.targetCU, 200);
  assert.equal(contract.phaseExitGate.remainingFails, 0);
  assert.equal(contract.remediationPolicy.dailyExternalChromeCasesMaximum, 10);
  assert.equal(contract.remediationPolicy.dailyLogicalTicksPerCase, 120);
  assert.equal(contract.remediationPolicy.fullSupplementalReruns, 1);
  assert.equal(contract.remediationPolicy.longPlayabilityRerunRequired, false);
  assert.equal(contract.remediationPolicy.fullVerifyRuns, 1);
  assert.equal(contract.remediationPolicy.fullVerifyOwner, "9G");
  assert.equal(contract.remediationPolicy.cartSpecificBranchesAllowed, false);
});

test("Phase 9A is the only active unit and cannot modify production", () => {
  assert.deepEqual(contract.completedWorkUnits, []);
  assert.equal(contract.activeWorkUnit, "9A");
  assert.equal(contract.nextWorkUnit, "9A");
  assert.equal(contract.workUnits["9A"].status, "active");
  assert.ok(Object.entries(contract.workUnits)
    .filter(([name]) => name !== "9A")
    .every(([, unit]) => unit.status === "pending"));
  assert.equal(Object.values(contract.workUnits)
    .filter(({ status }) => status === "active").length, 1);
  const allowed = contract.workUnits["9A"].allowedPaths;
  assert.equal(allowed.some((path) => path.startsWith("apps/")), false);
  assert.equal(allowed.some((path) => path.startsWith("packages/")), false);
  assert.equal(allowed.some((path) => path.startsWith("wasm/")), false);
  assert.equal(allowed.some((path) => path.startsWith("ref/")), false);
});

test("Phase 9A preserves local-only privacy and zero host-authority expansion", () => {
  assert.equal(contract.privacy.sourceRuntimePath, "outside repository");
  assert.equal(contract.privacy.refPathMayBeTestInput, false);
  assert.equal(contract.privacy.repositoryThirdPartyCartBytes, 0);
  assert.equal(contract.privacy.repositoryThirdPartyScreenshots, 0);
  assert.equal(contract.privacy.thirdPartyCartIdentitiesTracked, false);
  assert.equal(contract.privacy.thirdPartyCartHashesTracked, false);
  assert.equal(contract.privacy.thirdPartyPathsTracked, false);
  assert.equal(contract.privacy.thirdPartyPerCartResultsTracked, false);
  assert.equal(contract.privacy.publicCompatibilityRate, false);
  assert.equal(contract.remediationPolicy.networkAuthorityExpansion, false);
  assert.equal(contract.remediationPolicy.hostFilesystemAuthorityExpansion, false);
});

test("Phase 9A is the single documented Codex route and is continuously verified", async () => {
  const [docsReadme, phaseIndex, phase, roadmap, packageJson] = await Promise.all([
    read("docs/README.md"),
    read("docs/phases/README.md"),
    read("docs/phases/9-supplemental-compatibility-remediation.md"),
    read("docs/05-delivery-plan.md"),
    readJson("package.json"),
  ]);
  assert.match(docsReadme, /当前阶段 \| Phase 9/u);
  assert.match(docsReadme, /Active work unit \| 9A/u);
  assert.ok(phaseIndex.includes("9-supplemental-compatibility-remediation.md"));
  assert.match(phase, /Active work unit：9A/u);
  assert.match(phase, /language `45`、timing `5`/u);
  assert.match(roadmap, /9 Supplemental Compatibility Remediation（9A–9H） \| Active/u);
  assert.match(packageJson.scripts["test:phase-9a"], /phase-9a-activation\.test\.mjs/u);
  assert.match(packageJson.scripts.test, /test:phase-9a/u);
  assert.match(packageJson.scripts.verify, /test:phase-9a/u);
});
