import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const readJson = async (path) => JSON.parse(await read(path));

test("Phase 12 closes the bounded pal(table) compatibility change", async () => {
  const [contract, runtimeManifest, docsReadme, phaseIndex, roadmap, evidence] =
    await Promise.all([
      readJson("spec/phase-12-pal-table-compatibility-contract.json"),
      readJson("wasm/runtime-v1.manifest.lock.json"),
      read("docs/README.md"),
      read("docs/phases/README.md"),
      read("docs/05-delivery-plan.md"),
      read("docs/evidence/phase-12/131-phase-12-pal-table-compatibility-exit-evidence.md"),
    ]);
  assert.equal(contract.status, "complete");
  assert.equal(contract.activeWorkUnit, null);
  assert.deepEqual(contract.completedWorkUnits, ["12A"]);
  assert.equal(contract.workUnits["12A"].status, "complete");
  assert.equal(contract.behavior.nonNumericEntry, "ignore");
  assert.equal(runtimeManifest.compatibilityRevision, "12A");
  assert.match(docsReadme, /最近完成 \| Phase 12/u);
  assert.match(docsReadme, /当前阶段 \| None/u);
  assert.match(docsReadme, /Active work unit \| None/u);
  assert.match(phaseIndex, /当前没有 active phase/u);
  assert.match(roadmap, /当前 active phase：\*\*None/u);
  assert.match(evidence, /129 logical ticks；0 VM faults/u);
  await assert.rejects(read("docs/phases/12-pal-table-compatibility.md"), { code: "ENOENT" });
});

test("Phase 12 publishes no third-party cart detail or expanded authority", async () => {
  const contract = await readJson("spec/phase-12-pal-table-compatibility-contract.json");
  assert.equal(contract.contentBoundary.thirdPartyCartBytesTracked, 0);
  assert.equal(contract.contentBoundary.thirdPartyCartScreenshotsTracked, 0);
  assert.equal(contract.contentBoundary.thirdPartyPerCartResultsTracked, 0);
  assert.equal(contract.workUnits["12A"].result.externalCorpusAutomatedRuns, 0);
  assert.equal(contract.runtimeBoundary.abiChangesAuthorized, false);
  assert.equal(contract.runtimeBoundary.galleryChangesAuthorized, false);
  const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0").filter(Boolean);
  assert.deepEqual(tracked.filter((path) => path.startsWith("ref/") ||
    /(^|\/)screenshots?\//u.test(path)), []);
});
