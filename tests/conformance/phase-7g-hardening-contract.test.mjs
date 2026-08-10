import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { verifyReleaseArtifact } from "../../tools/release/release-artifact.mjs";

const manifestPath = "tests/conformance/manifests/phase-7g-chrome-hardening.json";
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const phaseContract = JSON.parse(await readFile(
  "spec/phase-7-web-player-release-candidate-contract.json",
  "utf8",
));
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const PHASE_7_EXIT_COMMIT = "49b24ad32b54d14d4678ebd5b7225d3a9bec668e";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha256AtPhase7Exit = (path) => sha256(
  execFileSync("git", ["show", `${PHASE_7_EXIT_COMMIT}:${path}`]),
);

test("Phase 7G manifest fixes a complete Chrome-only gate before measurement", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.browser.only, ["Google Chrome", "Chromium"]);
  assert.equal(manifest.browser.crossOriginIsolated, false);
  assert.deepEqual(
    manifest.gates.map(({ id }) => id),
    [
      "artifact-matrix",
      "audio-matrix",
      "persistence-failures",
      "lifecycle-recovery-fuzz",
      "desktop-soak",
      "provenance",
    ],
  );
  assert.ok(manifest.gates.every(({ requirements }) => requirements.length >= 3));
  assert.equal(manifest.recovery.workerTerminationCycles, 20);
  assert.equal(manifest.recovery.maximumActiveWorkersBeforeFinalDispose, 1);
  assert.equal(manifest.recovery.maximumStaleOutputs, 0);
  assert.equal(manifest.recovery.fuzzIterations, 64);
  assert.equal(manifest.soak.seconds, 600);
  assert.deepEqual(manifest.soak.profilesHz, [30, 60]);
  assert.equal(manifest.soak.maximumSteadyAudioUnderruns, 0);
  assert.equal(manifest.soak.maximumMainThreadLongTasks, 0);
  assert.equal(manifest.provenance.publicationPerformed, false);
});

test("Phase 7G locks every project cart and declared source input", async () => {
  for (const cart of manifest.projectCarts) {
    assert.match(cart.sha256, /^[0-9a-f]{64}$/u);
    assert.equal(sha256(await readFile(cart.source)), cart.sha256, cart.source);
  }
  for (const [path, expected] of Object.entries(manifest.lockedInputs)) {
    assert.match(expected, /^[0-9a-f]{64}$/u, `${path} has no locked SHA-256`);
    assert.equal(sha256AtPhase7Exit(path), expected, path);
  }
});

test("Phase 7G release artifact remains allowlisted, local-only and reproducible-owned", async () => {
  const { manifest: release } = await verifyReleaseArtifact({
    outputDirectory: "apps/web-player/dist/release",
  });
  assert.equal(release.capabilities.networkCartAccess, false);
  assert.equal(release.capabilities.arbitraryUrlAccess, false);
  assert.equal(release.capabilities.crossOriginIsolationRequired, false);
  assert.equal(release.capabilities.publicationPerformed, false);
  assert.deepEqual(Object.keys(release.artifacts), [
    "main", "worker", "worklet", "wasm", "styles", "demo",
  ]);
  assert.ok(release.files.every(({ path }) => !path.startsWith("/") && !path.includes("..")));
  assert.ok(release.files.some(({ provenance }) => provenance === "third-party-license"));
});

test("Phase 7G tracks no cart corpus, screenshots or reference output", () => {
  const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  const forbidden = tracked.filter((path) =>
    path.startsWith("ref/") || path.startsWith("local-corpus/") ||
    /(^|\/)screenshots?\//u.test(path) || /third-party-cart/u.test(path));
  assert.deepEqual(forbidden, []);
  assert.equal(tracked.some((path) => path.startsWith("apps/web-player/dist/release/")), false);
});

test("Phase 7G lifecycle ownership is bfcache-aware and environment pause is idempotent", async () => {
  const controller = await readFile(
    "apps/web-player/src/main/player-controller.ts",
    "utf8",
  );
  const demo = await readFile("apps/web-player/public/demo/demo.mjs", "utf8");
  assert.match(controller, /PageTransitionEvent\)\.persisted/u);
  assert.match(controller, /"pageshow"/u);
  assert.match(controller, /this\.#environmentPaused\s*\) return/u);
  assert.match(controller, /this\.#state !== "menu-open"/u);
  assert.match(demo, /if \(!event\.persisted\) void player\?\.dispose\(\)/u);
  assert.doesNotMatch(demo, /pagehide[\s\S]{0,160}once:\s*true/u);
});

test("Phase 7G has one full exit command and a clearly non-exit diagnostic command", () => {
  assert.match(packageJson.scripts["test:phase-7g"], /run-gate\.mjs/u);
  assert.doesNotMatch(packageJson.scripts["test:phase-7g"], /diagnostic/u);
  assert.match(packageJson.scripts["test:phase-7g:diagnostic"], /--diagnostic/u);
  assert.match(packageJson.scripts.test, /test:phase-7g/u);
  assert.match(packageJson.scripts.verify, /test:phase-7g/u);
  assert.ok(
    phaseContract.completedWorkUnits.at(-1) === "7G" ||
    phaseContract.completedWorkUnits.at(-1) === "7H",
  );
  assert.equal(phaseContract.workUnits["7G"].status, "complete");
  assert.ok(
    (phaseContract.activeWorkUnit === "7H" &&
      phaseContract.workUnits["7H"].status === "active") ||
    (phaseContract.status === "complete" &&
      phaseContract.activeWorkUnit === null &&
      phaseContract.workUnits["7H"].status === "complete"),
  );
});
