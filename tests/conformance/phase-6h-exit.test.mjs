import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../../", import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, projectRoot), "utf8");
}

async function readJson(relativePath) {
  return JSON.parse(await read(relativePath));
}

async function sha256(relativePath) {
  return createHash("sha256")
    .update(await readFile(new URL(relativePath, projectRoot)))
    .digest("hex");
}

const exit = await readJson("tests/conformance/manifests/phase-6h-exit.json");
const PHASE_6_EXIT_COMMIT = "117882a8bbd368ea8d8ebea2a2145d8f71152ec3";
const sha256AtCommit = (relativePath) => createHash("sha256")
  .update(execFileSync("git", ["show", `${PHASE_6_EXIT_COMMIT}:${relativePath}`]))
  .digest("hex");

test("Phase 6H hash-locks only project-owned exit inputs", async () => {
  assert.equal(exit.schemaVersion, 1);
  assert.equal(exit.phase, "6H");
  assert.equal(
    exit.target,
    "local real-cart qualification for the PICO-8 v0.2.7 L3 project profile on Chrome/Chromium desktop",
  );
  assert.deepEqual(exit.releaseClaim, {
    localQualificationPerformed: true,
    projectRegressionClaimed: true,
    thirdPartyOrBbsCompatibilityClaimed: false,
    publicCompatibilityRateClaimed: false,
    officialBitExactClaimed: false,
    networkAccess: false,
  });

  for (const [relativePath, expectedSha256] of Object.entries(exit.inputs)) {
    assert.match(relativePath, /^(docs\/adr|packages\/runtime-core|spec\/compat|tools\/compat|wasm|tests\/runtime)\//u);
    assert.ok(!relativePath.includes("ref/"), relativePath);
    assert.ok(!relativePath.includes("local-corpus"), relativePath);
    assert.match(expectedSha256, /^[0-9a-f]{64}$/u);
    assert.equal(sha256AtCommit(relativePath), expectedSha256, relativePath);
  }
});

test("Phase 6H aggregate satisfies smoke, manual C2 and scope gates", () => {
  const qualification = exit.qualification;
  const classificationTotal = Object.values(qualification.classifications)
    .reduce((sum, count) => sum + count, 0);

  assert.equal(qualification.corpusMode, "developer-supplied-local-only");
  assert.equal(qualification.cases, 12);
  assert.equal(classificationTotal, qualification.cases);
  assert.equal(qualification.allCasesClassified, true);
  assert.ok(qualification.classifications.C2 >= 3);
  assert.equal(qualification.smoke.inProfileCases, 11);
  assert.equal(qualification.smoke.inProfileBoots, qualification.smoke.inProfileCases);
  assert.equal(qualification.smoke.outOfProfileCases, 1);
  assert.equal(
    qualification.smoke.futureVersionDispositions,
    qualification.smoke.outOfProfileCases,
  );
  assert.equal(qualification.manualPlayability.C2Cases, qualification.classifications.C2);
  assert.equal(qualification.manualPlayability.criticalFlowCases, 2);
  assert.equal(qualification.manualPlayability.durationGateCases, 1);
  assert.ok(qualification.manualPlayability.durationGateSeconds >= 900);
  assert.match(qualification.manualPlayability.localEvidenceSha256, /^[0-9a-f]{64}$/u);
  assert.equal(qualification.openP0, 0);
  assert.equal(qualification.openP1, 0);
  assert.equal(qualification.perCartResultsPublished, false);
  assert.equal(qualification.publishedDenominatorContribution, 0);
});

test("Phase 6H publishes no third-party identity, path, hash or compatibility rate", () => {
  const serialized = JSON.stringify(exit);

  assert.equal(exit.privacy.repositoryThirdPartyCartBytes, 0);
  assert.equal(exit.privacy.repositoryThirdPartyScreenshots, 0);
  assert.equal(exit.privacy.thirdPartyCartIdentitiesPublished, false);
  assert.equal(exit.privacy.thirdPartyCartHashesPublished, false);
  assert.equal(exit.privacy.thirdPartyPathsPublished, false);
  assert.equal(exit.privacy.thirdPartyPerCartResultsPublished, false);
  assert.ok(!serialized.includes("playableRate"));
  assert.ok(!serialized.includes("cartSha256"));
  assert.ok(!serialized.includes("local-observations.json"));
  assert.ok(!serialized.includes("local-corpus-results"));
  assert.doesNotMatch(serialized, /\/Users\/|[A-Za-z]:\\/u);
});

test("Phase 6H binds every closed compatibility cluster and its exit runtime", async () => {
  const contract = await readJson("spec/phase-6-real-cart-qualification-contract.json");

  assert.deepEqual(exit.compatibility.closedClusters, [
    "legacy-stat-20-note-query",
    "menuitem-registration",
    "implicit-cpu-slicing",
    "lua-unpack-global",
    "p8scii-source-token",
  ]);
  assert.equal(exit.compatibility.projectChromeCasesPerCluster, 12);
  assert.equal(exit.compatibility.projectChromeFramesPerCase, 120);
  assert.equal(
    exit.compatibility.runtimeWasmSha256,
    contract.workUnits["6G"].result.runtimeWasmSha256,
  );
  assert.deepEqual(exit.knownDifferences, [
    "P4-KD-02",
    "P4-KD-03",
    "P4-KD-05",
    "P4-KD-06",
    "P5-KD-01",
    "P6-KD-01",
    "P6-KD-02",
  ]);
});

test("Phase 6 contract, evidence, roadmap and active route are closed", async () => {
  const contract = await readJson("spec/phase-6-real-cart-qualification-contract.json");
  const phase7 = await readJson("spec/phase-7-web-player-release-candidate-contract.json");
  const phase8 = await readJson("spec/phase-8-expanded-real-cart-qualification-contract.json");
  const packageJson = await readJson("package.json");
  const evidence = await read(
    "docs/evidence/phase-6/71-phase-6-real-cart-qualification-exit-evidence.md",
  );
  const docsReadme = await read("docs/README.md");
  const phaseIndex = await read("docs/phases/README.md");
  const roadmap = await read("docs/05-delivery-plan.md");
  const compatibility = await read("docs/06-testing-compatibility.md");
  const exitManifestSha256 = await sha256(
    "tests/conformance/manifests/phase-6h-exit.json",
  );

  assert.equal(contract.status, "complete");
  assert.deepEqual(
    contract.completedWorkUnits,
    ["6A", "6B", "6C", "6D", "6E", "6F", "6G", "6H"],
  );
  assert.equal(contract.activeWorkUnit, null);
  assert.equal(contract.nextWorkUnit, null);
  assert.equal(contract.nextPhase, "deferred");
  assert.ok(Object.values(contract.workUnits).every((unit) => unit.status === "complete"));
  assert.equal(contract.workUnits["6H"].result.exitManifestSha256, exitManifestSha256);
  assert.equal(contract.workUnits["6H"].result.localCorpusCases, 12);
  assert.equal(contract.workUnits["6H"].result.manualC2Cases, 3);
  assert.equal(contract.workUnits["6H"].result.publicCompatibilityRateClaimed, false);

  for (const hash of Object.values(exit.inputs)) assert.ok(evidence.includes(hash), hash);
  assert.ok(evidence.includes(exitManifestSha256));
  assert.ok(evidence.includes(exit.target));
  for (const id of exit.knownDifferences) assert.ok(evidence.includes(id), id);
  assert.ok(!phaseIndex.includes("6-real-cart-qualification.md"));
  assert.equal(phase7.status, "complete");
  assert.ok(!phaseIndex.includes("7-web-player-release-candidate.md"));
  if (phase8.status === "active") {
    assert.match(docsReadme, /当前阶段 \| Phase 8/u);
    assert.match(docsReadme, /Active work unit \| 8[B-H]/u);
    assert.ok(docsReadme.includes("81-phase-7-web-player-release-candidate-exit-evidence.md"));
    assert.ok(phaseIndex.includes("8-expanded-real-cart-qualification.md"));
  } else {
    assert.match(docsReadme, /最近完成 \| Phase 8/u);
    assert.match(docsReadme, /当前阶段 \| 无/u);
    assert.match(docsReadme, /Active work unit \| 无/u);
    assert.ok(docsReadme.includes("91-phase-8-expanded-real-cart-qualification-exit-evidence.md"));
  }
  assert.ok(roadmap.includes("Phase 6 exit"));
  assert.ok(compatibility.includes(exit.target));
  assert.ok(packageJson.scripts.test.includes("test:phase-6h"));
  assert.ok(packageJson.scripts.verify.includes("test:phase-6h"));
  await assert.rejects(
    readFile(new URL("docs/phases/6-real-cart-qualification.md", projectRoot)),
    { code: "ENOENT" },
  );
});
