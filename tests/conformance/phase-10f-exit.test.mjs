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
const exit = await readJson("tests/conformance/manifests/phase-10f-exit.json");

test("Phase 10F locks the verified release implementation revision", () => {
  assert.equal(exit.schemaVersion, 1);
  assert.equal(exit.phase, "10F");
  assert.match(exit.implementationRevision, /^[a-f0-9]{40}$/u);
  for (const [path, expected] of Object.entries(exit.sourceLocks)) {
    assert.match(expected, /^[a-f0-9]{64}$/u, path);
    assert.equal(sha256AtRevision(exit.implementationRevision, path), expected, path);
  }
});

test("Phase 10F records one self-verifying local candidate", () => {
  assert.deepEqual({
    version: exit.release.version,
    apiVersion: exit.release.apiVersion,
    channel: exit.release.channel,
    projectLicense: exit.release.projectLicense,
    directoryFiles: exit.release.directoryFiles,
    archivedFiles: exit.release.archivedFiles,
  }, {
    version: "0.1.0-rc.1",
    apiVersion: 1,
    channel: "release-candidate",
    projectLicense: "UNLICENSED",
    directoryFiles: 15,
    archivedFiles: 16,
  });
  assert.deepEqual(exit.release.stableArtifactKeys,
    ["main", "worker", "worklet", "wasm", "styles", "demo"]);
  assert.ok(exit.release.archiveBytes > 0);
  assert.match(exit.release.archiveSha256, /^[a-f0-9]{64}$/u);
  assert.notEqual(exit.release.archiveSha256, "0".repeat(64));
  assert.match(exit.release.manifestSha256, /^[a-f0-9]{64}$/u);
  assert.notEqual(exit.release.manifestSha256, "0".repeat(64));
  assert.equal(exit.release.portableVerification, "pass");
  assert.equal(exit.release.repeatedBuildByteExact, true);
});

test("Phase 10F preserves the bounded validation and publication policy", () => {
  assert.deepEqual(exit.validation, {
    quickTests: 49,
    boundedProjectTests: 27,
    artifactTests: 4,
    localRcTests: 2,
    chromeVersion: "Google Chrome 151.0.7922.76",
    focusedChromeRelease: "pass",
    workersReleased: true,
    audioContextClosed: true,
    activeAnimationFrames: 0,
    externalCorpusRuns: 0,
    historicalMatrixRuns: 0,
    longSoakRuns: 0,
    openP0: 0,
    openP1: 0,
  });
  assert.deepEqual(exit.boundaries, {
    networkCartAuthority: false,
    thirdPartyCartBytesTracked: 0,
    thirdPartyScreenshotsTracked: 0,
    publicCompatibilityRatePublished: false,
    npmPublication: false,
    remotePublication: false,
    tagCreated: false,
  });
});

test("Phase 10 contract and active route are closed", async () => {
  const [contract, docsReadme, phaseIndex, roadmap, compatibility, evidence, packageJson, ci] =
    await Promise.all([
      readJson("spec/phase-10-release-readiness-contract.json"),
      read("docs/README.md"),
      read("docs/phases/README.md"),
      read("docs/05-delivery-plan.md"),
      read("docs/06-testing-compatibility.md"),
      read("docs/evidence/phase-10/111-phase-10-release-readiness-exit-evidence.md"),
      readJson("package.json"),
      read(".github/workflows/verify.yml"),
    ]);
  assert.equal(contract.status, "complete");
  assert.deepEqual(contract.completedWorkUnits, ["10A", "10B", "10C", "10D", "10E", "10F"]);
  assert.equal(contract.activeWorkUnit, null);
  assert.equal(contract.nextWorkUnit, null);
  assert.ok(Object.values(contract.workUnits).every(({ status }) => status === "complete"));
  assert.equal(contract.workUnits["10F"].result.exitManifest,
    "tests/conformance/manifests/phase-10f-exit.json");
  assert.match(docsReadme, /最近完成 \| Phase 10/u);
  assert.match(docsReadme, /当前阶段 \| None/u);
  assert.match(docsReadme, /Active work unit \| None/u);
  assert.doesNotMatch(phaseIndex, /10-release-readiness\.md/u);
  assert.match(phaseIndex, /当前没有 active phase/u);
  assert.match(roadmap, /当前 active phase：\*\*None\*\*/u);
  assert.match(compatibility, /Phase 10 exit evidence/u);
  assert.match(evidence, /0\.1\.0-rc\.1/u);
  assert.match(packageJson.scripts["verify:quick"], /phase-10f-exit\.test\.mjs/u);
  assert.match(packageJson.scripts["verify:release"], /test:phase-10f/u);
  assert.match(ci, /pnpm run verify:phase-10/u);
  await assert.rejects(read("docs/phases/10-release-readiness.md"), { code: "ENOENT" });
});

test("Phase 10F tracks no generated release or third-party corpus", () => {
  const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0").filter(Boolean);
  assert.deepEqual(tracked.filter((path) =>
    path.startsWith("apps/web-player/dist/") || path.startsWith("ref/") ||
    path.startsWith("tests/conformance/local-corpus/") ||
    /(^|\/)screenshots?\//u.test(path)), []);
});
