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
const exit = await readJson("tests/conformance/manifests/phase-8h-exit.json");

test("Phase 8H binds project-owned source and aggregate-only qualification", () => {
  assert.equal(exit.schemaVersion, 1);
  assert.equal(exit.phase, "8H");
  assert.match(exit.sourceRevision, /^[0-9a-f]{40}$/u);
  for (const [path, expected] of Object.entries(exit.sourceLocks)) {
    assert.match(expected, /^[0-9a-f]{64}$/u, path);
    assert.equal(sha256AtRevision(exit.sourceRevision, path), expected, path);
  }
  assert.equal(exit.qualification.canonical.classified, 100);
  assert.deepEqual(exit.qualification.canonical.counts,
    { C0: 0, C1: 0, C2: 0, C3: 0, CU: 100 });
  assert.equal(exit.qualification.formatPairs.completed, 65);
  assert.equal(exit.qualification.formatPairs.potentialRuntimeDefects, 0);
  assert.equal(exit.qualification.representativePlayability.C2, 10);
  assert.equal(exit.qualification.representativePlayability.openP0, 0);
  assert.equal(exit.qualification.representativePlayability.openP1, 0);
});

test("Phase 8H preserves the supplemental 51-failure remediation backlog", () => {
  const supplemental = exit.qualification.supplementalQuickSmoke;
  assert.deepEqual(supplemental.smokeOutcomes, { boots: 149, fails: 51, notRun: 0 });
  assert.deepEqual(supplemental.failureClusters,
    { language: 45, timing: 5, "unsupported-host-feature": 1 });
  assert.equal(supplemental.formalPhase8DenominatorChanged, false);
  assert.equal(supplemental.publicCompatibilityRatePublished, false);
  assert.equal(exit.claims.supplementalFailureBacklogDiscovered, 51);
});

test("Phase 8H records the bounded release requalification without external input", () => {
  const release = exit.releaseRegression;
  assert.equal(release.chromeVersion, "Google Chrome 151.0.7922.76");
  assert.equal(release.releaseArtifactFiles, 12);
  assert.equal(release.releaseArtifactVerified, true);
  assert.equal(release.fullChromeGate.desktopSoakSeconds, 600);
  assert.deepEqual(release.fullChromeGate.profilesHz, [30, 60]);
  assert.equal(release.fullChromeGate.droppedTicks, 0);
  assert.equal(release.fullChromeGate.audioUnderruns, 0);
  assert.equal(release.fullChromeGate.audioOverruns, 0);
  assert.equal(release.fullChromeGate.audioDiscontinuities, 0);
  assert.equal(release.fullChromeGate.allWorkersReleased, true);
  assert.equal(release.fullChromeGate.fullVerify, "pass");
  assert.equal(release.boundedRequalification.externalCorpusRead, false);
  assert.equal(release.boundedRequalification.longRealCartRerun, false);
});

test("Phase 8H publishes no third-party identity, path, hash, screenshot or rate", () => {
  const serialized = JSON.stringify(exit);
  assert.deepEqual(exit.privacy, {
    repositoryThirdPartyCartBytes: 0,
    repositoryThirdPartyScreenshots: 0,
    thirdPartyCartIdentitiesPublished: false,
    thirdPartyCartHashesPublished: false,
    thirdPartyPathsPublished: false,
    thirdPartyPerCartResultsPublished: false,
  });
  assert.equal(exit.claims.thirdPartyOrBbsCompatibilityRateClaimed, false);
  assert.equal(exit.claims.networkAccess, false);
  assert.doesNotMatch(serialized, /\/Users\/|[A-Za-z]:\\/u);
  assert.doesNotMatch(serialized, /"entries"|"cartSha256"|"screenSha256"|"projectCarts"/u);
  const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0").filter(Boolean);
  assert.deepEqual(tracked.filter((path) =>
    path.startsWith("ref/") || path.startsWith("local-corpus/") ||
    /(^|\/)screenshots?\//u.test(path) || /third-party-cart/u.test(path)), []);
});

test("Phase 8 contract and its active phase route remain closed", async () => {
  const [contract, docsReadme, phaseIndex, evidence, packageJson] = await Promise.all([
    readJson("spec/phase-8-expanded-real-cart-qualification-contract.json"),
    read("docs/README.md"),
    read("docs/phases/README.md"),
    read("docs/evidence/phase-8/91-phase-8-expanded-real-cart-qualification-exit-evidence.md"),
    readJson("package.json"),
  ]);
  assert.equal(contract.status, "complete");
  assert.deepEqual(contract.completedWorkUnits,
    ["8A", "8B", "8C", "8D", "8E", "8F", "8G", "8H"]);
  assert.equal(contract.activeWorkUnit, null);
  assert.equal(contract.nextWorkUnit, null);
  assert.ok(Object.values(contract.workUnits).every(({ status }) => status === "complete"));
  assert.equal(contract.workUnits["8H"].result.exitManifest,
    "tests/conformance/manifests/phase-8h-exit.json");
  assert.ok(!docsReadme.includes("8-expanded-real-cart-qualification.md"));
  assert.doesNotMatch(phaseIndex, /8-expanded-real-cart-qualification\.md/u);
  assert.ok(evidence.includes("51 个失败"));
  assert.match(packageJson.scripts["test:phase-8h"], /phase-8h-exit\.test\.mjs/u);
  assert.match(packageJson.scripts["test:historical"], /test:phase-8h/u);
  assert.match(packageJson.scripts["verify:historical"], /test:phase-8h/u);
  await assert.rejects(read("docs/phases/8-expanded-real-cart-qualification.md"), {
    code: "ENOENT",
  });
});
