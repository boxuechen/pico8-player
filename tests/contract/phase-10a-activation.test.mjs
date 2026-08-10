import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const readJson = async (path) => JSON.parse(await read(path));

test("Phase 10A activation remains recorded after phase closure", async () => {
  const [contract, docsReadme, roadmap, phaseIndex] = await Promise.all([
    readJson("spec/phase-10-release-readiness-contract.json"),
    read("docs/README.md"),
    read("docs/05-delivery-plan.md"),
    read("docs/phases/README.md"),
  ]);
  assert.equal(contract.status, "complete");
  assert.equal(contract.workUnits["10A"].status, "complete");
  assert.ok(contract.completedWorkUnits.includes("10A"));
  assert.match(docsReadme, /最近完成 \| Phase 10/u);
  assert.match(docsReadme, /当前阶段 \| None/u);
  assert.match(roadmap, /当前 active phase：\*\*None\*\*/u);
  assert.doesNotMatch(phaseIndex, /10-release-readiness\.md/u);
  await assert.rejects(read("docs/phases/10-release-readiness.md"), { code: "ENOENT" });
});

test("Phase 10A freezes a local-only unlicensed RC and bounded validation", async () => {
  const contract = await readJson("spec/phase-10-release-readiness-contract.json");
  assert.deepEqual(contract.release, {
    version: "0.1.0-rc.1",
    apiVersion: 1,
    channel: "release-candidate",
    distribution: "local static directory plus deterministic tar.gz",
    projectLicense: "UNLICENSED",
    packagePublication: false,
    remotePublication: false,
    tagCreation: false,
  });
  assert.deepEqual(contract.verificationBudget, {
    quickGate: true,
    focusedReleaseGate: true,
    projectOwnedReleaseFixturesOnly: true,
    externalCorpusRuns: 0,
    historicalMatrixRuns: 0,
    longSoakRuns: 0,
  });
  assert.ok(contract.nonGoals.some((value) => value.includes("GitHub Release")));
  assert.ok(contract.nonGoals.some((value) => value.includes("full external corpus")));
});

test("Phase 10A authorizes no production source changes", async () => {
  const contract = await readJson("spec/phase-10-release-readiness-contract.json");
  const allowed = contract.workUnits["10A"].allowedPaths;
  assert.ok(allowed.every((path) =>
    !path.startsWith("apps/web-player/src/") &&
    !path.startsWith("packages/") &&
    !path.startsWith("wasm/bridge/") &&
    !path.startsWith("tools/release/")));
});
