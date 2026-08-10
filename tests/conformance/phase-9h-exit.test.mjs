import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const readJson = async (path) => JSON.parse(await read(path));
const sha256AtRevision = (revision, path) => createHash("sha256")
  .update(execFileSync("git", ["show", `${revision}:${path}`]))
  .digest("hex");
const exit = await readJson("tests/conformance/manifests/phase-9h-exit.json");

test("Phase 9H binds project-owned remediation sources", () => {
  assert.equal(exit.schemaVersion, 1);
  assert.equal(exit.phase, "9H");
  assert.match(exit.sourceRevision, /^[0-9a-f]{40}$/u);
  for (const [path, expected] of Object.entries(exit.sourceLocks)) {
    assert.match(expected, /^[a-f0-9]{64}$/u, path);
    assert.equal(sha256AtRevision(exit.sourceRevision, path), expected, path);
  }
  assert.deepEqual(exit.remediation.baseline.failureClusters,
    { language: 45, timing: 5, "unsupported-host-feature": 1 });
  assert.equal(exit.remediation.baseline.failures, 51);
  assert.equal(exit.remediation.baseline.rootCauseCandidates, 15);
  assert.equal(exit.remediation.baseline.unclassifiedFailures, 0);
  assert.equal(exit.remediation.projectAuthoredFixtures, 21);
  assert.equal(exit.remediation.productionCartSpecificBranches, 0);
});

test("Phase 9H keeps the full requalification and final delta distinct", () => {
  const aborted = exit.qualification.abortedAttempt;
  assert.deepEqual(
    [aborted.observedCases, aborted.CU, aborted.failures],
    [175, 171, 4],
  );
  assert.equal(aborted.completedBatches, 3);
  assert.equal(aborted.partialFourthBatchCases, 25);
  assert.equal(aborted.abortedOnFailure, true);

  const full = exit.qualification.fullRequalification;
  assert.equal(full.runs, 1);
  assert.equal(full.cases, 200);
  assert.equal(full.logicalTicksPerCase, 120);
  assert.equal(full.CU, 199);
  assert.equal(full.failures, 1);
  assert.deepEqual(full.failureClusters, { language: 1 });
  assert.equal(full.samePlayerCommit, true);
  assert.equal(full.sameRuntimeWasm, true);
  assert.equal(full.sameChromeBuild, true);
  assert.equal(full.productionWorkerPath, true);

  const delta = exit.qualification.finalFocusedDelta;
  assert.equal(delta.cases, 1);
  assert.equal(delta.CU, 1);
  assert.equal(delta.failures, 0);
  assert.equal(delta.cleanProductionCommit, true);

  const disposition = exit.qualification.knownFailureDisposition;
  assert.deepEqual(
    [disposition.baselineFailures, disposition.resolved, disposition.remaining],
    [51, 51, 0],
  );
  assert.equal(disposition.singleEnvironmentAggregate, false);
  assert.equal(disposition.publicCompatibilityRatePublished, false);
  assert.equal(exit.qualification.completedFullRequalificationRuns, 1);
  assert.equal(exit.qualification.secondCompletedFullRequalificationRuns, 0);
  assert.equal(exit.qualification.historicalVerificationRuns, 0);
  assert.equal(exit.qualification.longSoakRuns, 0);
});

test("Phase 9H records the bounded Chrome release regression", () => {
  const release = exit.releaseRegression;
  assert.equal(release.chromeVersion, "Google Chrome 151.0.7922.76");
  assert.equal(release.runtimeWasmBytes, 197591);
  assert.match(release.runtimeWasmSha256, /^[a-f0-9]{64}$/u);
  assert.equal(release.releaseArtifactFiles, 12);
  assert.equal(release.releaseArtifactVerified, true);
  assert.equal(release.phaseVerification, "pass");
  assert.equal(release.focusedReleaseVerification, "pass");
  assert.equal(release.shortChromeLifecycle, "pass");
  assert.equal(release.workersReleased, true);
  assert.equal(release.audioContextClosed, true);
  assert.equal(release.externalCorpusRead, false);
});

test("Phase 9H publishes no third-party detail or compatibility rate", () => {
  const serialized = JSON.stringify(exit);
  assert.deepEqual(exit.privacy, {
    repositoryThirdPartyCartBytes: 0,
    repositoryThirdPartyScreenshots: 0,
    thirdPartyCartIdentitiesPublished: false,
    thirdPartyCartHashesPublished: false,
    thirdPartyPathsPublished: false,
    thirdPartyPerCartResultsPublished: false,
  });
  assert.equal(exit.claims.knownSupplementalFailuresResolved, 51);
  assert.equal(exit.claims.remainingKnownFailures, 0);
  assert.equal(exit.claims.singleCommitTwoHundredCaseCompatibilityClaimed, false);
  assert.equal(exit.claims.thirdPartyOrBbsCompatibilityRateClaimed, false);
  assert.equal(exit.claims.officialBitExactClaimed, false);
  assert.equal(exit.claims.networkAccess, false);
  assert.doesNotMatch(serialized, /\/Users\/|[A-Za-z]:\\/u);
  assert.doesNotMatch(serialized, /"entries"|"cartSha256"|"screenSha256"|"projectCarts"/u);
  const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0").filter(Boolean);
  assert.deepEqual(tracked.filter((path) =>
    path.startsWith("ref/") || path.startsWith("local-corpus/") ||
    /(^|\/)screenshots?\//u.test(path) || /third-party-cart/u.test(path)), []);
});

test("Phase 9 contract and active phase route are closed", async () => {
  const [contract, docsReadme, phaseIndex, roadmap, compatibility, evidence, packageJson] =
    await Promise.all([
      readJson("spec/phase-9-supplemental-compatibility-remediation-contract.json"),
      read("docs/README.md"),
      read("docs/phases/README.md"),
      read("docs/05-delivery-plan.md"),
      read("docs/06-testing-compatibility.md"),
      read("docs/evidence/phase-9/101-phase-9-supplemental-compatibility-remediation-exit-evidence.md"),
      readJson("package.json"),
    ]);
  assert.equal(contract.status, "complete");
  assert.deepEqual(contract.completedWorkUnits,
    ["9A", "9B", "9C", "9D", "9E", "9R", "9F", "9S", "9G", "9H"]);
  assert.equal(contract.activeWorkUnit, null);
  assert.equal(contract.nextWorkUnit, null);
  assert.ok(Object.values(contract.workUnits).every(({ status }) => status === "complete"));
  assert.equal(contract.workUnits["9H"].result.exitManifest,
    "tests/conformance/manifests/phase-9h-exit.json");
  assert.match(docsReadme, /最近完成 \| Phase 9/u);
  assert.match(docsReadme, /当前阶段 \| None/u);
  assert.match(docsReadme, /Active work unit \| None/u);
  assert.doesNotMatch(phaseIndex, /9-supplemental-compatibility-remediation\.md/u);
  assert.match(phaseIndex, /当前没有 active phase/u);
  assert.match(roadmap, /当前 active phase：\*\*None\*\*/u);
  assert.match(roadmap, /101-phase-9-supplemental-compatibility-remediation-exit-evidence\.md/u);
  assert.match(compatibility, /Phase 9 exit evidence/u);
  assert.match(evidence, /51 resolved \/ 0 remaining/u);
  assert.match(evidence, /不合并成单环境 `200\/200` aggregate/u);
  assert.match(packageJson.scripts["test:phase-9h"], /phase-9h-exit\.test\.mjs/u);
  assert.match(packageJson.scripts["test:historical"], /test:phase-9h/u);
  assert.match(packageJson.scripts["verify:historical"], /test:phase-9h/u);
  assert.match(packageJson.scripts["verify:quick"], /phase-9h-exit\.test\.mjs/u);
  await assert.rejects(read("docs/phases/9-supplemental-compatibility-remediation.md"), {
    code: "ENOENT",
  });
});
