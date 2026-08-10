import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const exitPath = "tests/conformance/manifests/phase-7h-exit.json";
const evidencePath =
  "docs/evidence/phase-7/81-phase-7-web-player-release-candidate-exit-evidence.md";
const exitBytes = await readFile(exitPath);
const exit = JSON.parse(exitBytes);
const phase7g = JSON.parse(await readFile(
  "tests/conformance/manifests/phase-7g-chrome-hardening.json",
  "utf8",
));
const contract = JSON.parse(await readFile(
  "spec/phase-7-web-player-release-candidate-contract.json",
  "utf8",
));
const PHASE_7_EXIT_COMMIT = "49b24ad32b54d14d4678ebd5b7225d3a9bec668e";
const readAtPhase7Exit = (path) => execFileSync(
  "git", ["show", `${PHASE_7_EXIT_COMMIT}:${path}`], { encoding: "utf8" },
);
const inventory = JSON.parse(readAtPhase7Exit("spec/pico-api-inventory.yaml"));
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha256AtPhase7Exit = (path) => sha256(Buffer.from(readAtPhase7Exit(path)));

test("Phase 7H aggregate input locks and Chrome gate source locks match the frozen exit", async () => {
  assert.equal(exit.schemaVersion, 1);
  assert.equal(exit.phase, "7H");
  assert.equal(
    exit.target,
    "PICO-8 v0.2.7 Web Player Release Candidate on desktop Chrome/Chromium",
  );
  for (const [path, expected] of Object.entries(exit.sourceLocks)) {
    assert.match(expected, /^[0-9a-f]{64}$/u, path);
    assert.equal(sha256AtPhase7Exit(path), expected, path);
  }
  assert.equal(
    exit.sourceLocks["tests/conformance/manifests/phase-7g-chrome-hardening.json"],
    sha256(await readFile("tests/conformance/manifests/phase-7g-chrome-hardening.json")),
  );
  assert.deepEqual(exit.gateSourceHashes, phase7g.lockedInputs);
  for (const [path, expected] of Object.entries(exit.gateSourceHashes)) {
    assert.equal(sha256AtPhase7Exit(path), expected, path);
  }
});

test("Phase 7H publishes the exact release compatibility profile", () => {
  const count = (status) => inventory.apis.filter(
    ({ conformanceStatus }) => conformanceStatus === status,
  ).length;
  assert.equal(inventory.apis.length, exit.compatibility.inventoryTotal);
  assert.equal(count("compatible"), exit.compatibility.compatible);
  assert.equal(count("unsupported"), exit.compatibility.unsupported);
  assert.deepEqual(
    inventory.apis
      .filter(({ conformanceStatus }) => conformanceStatus === "partial")
      .map(({ name }) => name),
    exit.compatibility.partial,
  );
  assert.equal(
    inventory.apis.filter(
      ({ mvpDisposition, conformanceStatus }) =>
        mvpDisposition === "required" && conformanceStatus === "unknown",
    ).length,
    exit.compatibility.unknownRequiredReleaseModes,
  );
  assert.equal(exit.compatibility.openP0, 0);
  assert.equal(exit.compatibility.openP1, 0);
});

test("Phase 7H closes the machine contract without expanding authority", () => {
  assert.equal(contract.status, "complete");
  assert.deepEqual(contract.completedWorkUnits, [
    "7A", "7B", "7C", "7D", "7E", "7F", "7G", "7H",
  ]);
  assert.equal(contract.activeWorkUnit, null);
  assert.equal(contract.nextWorkUnit, null);
  assert.ok(Object.values(contract.workUnits).every(({ status }) => status === "complete"));
  assert.equal(contract.workUnits["7H"].result.exitManifest, exitPath);
  assert.equal(contract.workUnits["7H"].result.evidence, evidencePath);
  assert.equal(contract.workUnits["7H"].result.browser, exit.chromeGate.exactVersion);
  assert.deepEqual(contract.workUnits["7H"].result.apiInventory, {
    total: exit.compatibility.inventoryTotal,
    compatible: exit.compatibility.compatible,
    partial: exit.compatibility.partial,
    unsupported: exit.compatibility.unsupported,
    unknownRequired: exit.compatibility.unknownRequiredReleaseModes,
  });
  assert.equal(contract.workUnits["7H"].result.productionChanged, false);
  assert.equal(contract.workUnits["7H"].result.networkSurfaceChanged, false);
  assert.equal(contract.workUnits["7H"].result.publicationPerformed, false);
  assert.equal(exit.profile.networkAccess, false);
  assert.equal(exit.profile.automatedBbsAccess, false);
  assert.equal(exit.profile.arbitraryUrlAccess, false);
  assert.equal(exit.profile.hostFilesystemAccess, false);
  assert.equal(exit.profile.externalPublicationPerformed, false);
});

test("Phase 7H preserves the measured full Chrome hardening thresholds", () => {
  assert.equal(exit.chromeGate.exactVersion, "Google Chrome 151.0.7922.76");
  assert.equal(exit.chromeGate.desktopSoakSeconds, phase7g.soak.seconds);
  assert.deepEqual(exit.chromeGate.profilesHz, phase7g.soak.profilesHz);
  assert.equal(exit.chromeGate.minimumCadenceRatio, phase7g.soak.minimumCadenceRatio);
  assert.equal(exit.chromeGate.maximumDroppedTickRatio, phase7g.soak.maximumDroppedTickRatio);
  assert.equal(exit.chromeGate.steadyAudioUnderruns, phase7g.soak.maximumSteadyAudioUnderruns);
  assert.equal(exit.chromeGate.audioOverruns, phase7g.soak.maximumAudioOverruns);
  assert.equal(exit.chromeGate.audioDiscontinuities, phase7g.soak.maximumAudioDiscontinuities);
  assert.equal(exit.chromeGate.workerErrors, phase7g.soak.maximumWorkerErrors);
  assert.equal(exit.chromeGate.mainThreadLongTasks, phase7g.soak.maximumMainThreadLongTasks);
  assert.equal(exit.chromeGate.workerRecoveryCycles, phase7g.recovery.workerTerminationCycles);
  assert.equal(exit.chromeGate.fuzzIterations, phase7g.recovery.fuzzIterations);
  assert.equal(exit.chromeGate.staleOutputs, phase7g.recovery.maximumStaleOutputs);
  assert.equal(exit.chromeGate.externalRequests, phase7g.recovery.maximumExternalRequests);
  assert.equal(exit.chromeGate.resourceRelease, true);
});

test("Phase 7H release command cannot be replaced by the diagnostic gate", () => {
  assert.match(packageJson.scripts["test:release"], /build:release/u);
  assert.match(packageJson.scripts["test:release"], /build:player-worker/u);
  assert.match(packageJson.scripts["test:release"], /verify-release\.mjs/u);
  assert.match(packageJson.scripts["test:release"], /phase-7g\/run-gate\.mjs/u);
  assert.match(packageJson.scripts["test:release"], /test:phase-7h/u);
  assert.doesNotMatch(packageJson.scripts["test:release"], /diagnostic/u);
  assert.match(packageJson.scripts["test:historical"], /test:phase-7h/u);
  assert.match(packageJson.scripts["verify:historical"], /test:phase-7h/u);
  assert.equal(exit.releaseGate.diagnosticMaySubstitute, false);
  assert.equal(exit.releaseGate.cleanCheckout.install, "pnpm install --offline --frozen-lockfile");
  assert.equal(exit.releaseGate.cleanCheckout.testRelease, "pass");
  assert.equal(exit.releaseGate.cleanCheckout.verify, "pass");
});

test("Phase 7H tracks no release output, third-party cart corpus or screenshot", () => {
  const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  assert.equal(tracked.some((path) => path.startsWith("apps/web-player/dist/release/")), false);
  assert.deepEqual(tracked.filter((path) =>
    path.startsWith("ref/") || path.startsWith("local-corpus/") ||
    /(^|\/)screenshots?\//u.test(path) || /third-party-cart/u.test(path)), []);
  assert.equal(exit.privacy.repositoryThirdPartyCartBytes, 0);
  assert.equal(exit.privacy.repositoryThirdPartyScreenshots, 0);
  assert.equal(exit.privacy.thirdPartyCartIdentitiesPublished, false);
  assert.equal(exit.privacy.thirdPartyCartHashesPublished, false);
  assert.equal(exit.privacy.thirdPartyPathsPublished, false);
  assert.equal(exit.privacy.thirdPartyPerCartResultsPublished, false);
  const serialized = exitBytes.toString("utf8");
  assert.doesNotMatch(serialized, /\/Users\/|[A-Za-z]:\\/u);
  assert.doesNotMatch(serialized, /"projectCarts"|"cartSha256"|"sourceSha256"/u);
});

test("Phase 7H documentation preserves immutable evidence under its successor phase", async () => {
  const phase8 = JSON.parse(await readFile(
    "spec/phase-8-expanded-real-cart-qualification-contract.json",
    "utf8",
  ));
  const [docsReadme, phaseIndex, roadmap, scope, compatibility, evidence] =
    await Promise.all([
      readFile("docs/README.md", "utf8"),
      readFile("docs/phases/README.md", "utf8"),
      readFile("docs/05-delivery-plan.md", "utf8"),
      readFile("docs/01-scope-and-success-criteria.md", "utf8"),
      readFile("docs/06-testing-compatibility.md", "utf8"),
      readFile(evidencePath, "utf8"),
    ]);
  assert.ok(!phaseIndex.includes("7-web-player-release-candidate.md"));
  assert.equal(phase8.status, "complete");
  assert.ok(!docsReadme.includes("7-web-player-release-candidate.md"));
  assert.match(roadmap, /7 Web Player Release Candidate（7A–7H） \| Complete/u);
  assert.match(scope, /101 compatible/u);
  assert.match(compatibility, /101 compatible/u);
  assert.match(compatibility, /required unknown=0/u);
  assert.ok(compatibility.includes("pnpm run test:release"));
  for (const difference of exit.compatibility.knownDifferences) {
    assert.ok(compatibility.includes(difference), difference);
    assert.ok(evidence.includes(difference), difference);
  }
  for (const hash of Object.values(exit.sourceLocks)) assert.ok(evidence.includes(hash), hash);
  assert.ok(evidence.includes(sha256(exitBytes)));
  assert.ok(evidence.includes(exit.releaseArtifact.manifestSha256));
  assert.ok(evidence.includes(exit.chromeGate.exactVersion));
  await assert.rejects(readFile("docs/phases/7-web-player-release-candidate.md"), {
    code: "ENOENT",
  });
});
