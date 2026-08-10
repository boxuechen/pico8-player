import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const readJson = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));

test("Phase 10D owns a bounded release gate with five project suites", async () => {
  const [contract, packageJson] = await Promise.all([
    readJson("spec/phase-10-release-readiness-contract.json"),
    readJson("package.json"),
  ]);
  const command = packageJson.scripts["test:phase-10d"];
  for (const required of [
    "verify",
    "verify:release",
    "phase-1f-l1-exit.test.mjs",
    "phase-3a-sfx.test.mjs",
    "phase-3c-controller-input.test.mjs",
    "phase-3f-persistence.test.mjs",
    "phase-5d-guest-load.test.mjs",
  ]) {
    assert.match(command, new RegExp(required.replaceAll(".", "\\."), "u"), required);
  }
  assert.doesNotMatch(command, /historical|qualification:|local-corpus|phase-7g\/run-gate/u);
  assert.deepEqual(contract.verificationBudget, {
    quickGate: true,
    focusedReleaseGate: true,
    projectOwnedReleaseFixturesOnly: true,
    externalCorpusRuns: 0,
    historicalMatrixRuns: 0,
    longSoakRuns: 0,
  });
});

test("Phase 10D retains caller-owned cart and Chrome-only boundaries", async () => {
  const contract = await readJson("spec/phase-10-release-readiness-contract.json");
  assert.equal(contract.browserGate, "Chrome/Chromium desktop only");
  assert.equal(contract.claims.networkCartAuthority, false);
  assert.equal(contract.release.remotePublication, false);
  assert.equal(contract.release.packagePublication, false);
});
