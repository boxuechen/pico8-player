import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const contract = JSON.parse(await readFile(
  new URL("../../spec/phase-13-mobile-host-ports-contract.json", import.meta.url),
  "utf8",
));

test("Phase 13 activation remains recorded after phase closure", async () => {
  const [docsReadme, roadmap, phaseIndex, evidence] = await Promise.all([
    read("docs/README.md"),
    read("docs/05-delivery-plan.md"),
    read("docs/phases/README.md"),
    read("docs/evidence/phase-13/141-phase-13-mobile-host-ports-exit-evidence.md"),
  ]);
  assert.equal(contract.status, "complete");
  assert.equal(contract.activeWorkUnit, null);
  assert.equal(contract.publicApi.currentVersion, 2);
  assert.deepEqual(contract.completedWorkUnits, ["13A", "13B", "13C", "13D", "13E"]);
  assert.equal(Object.values(contract.workUnits)
    .filter(({ status }) => status === "active").length, 0);
  assert.match(docsReadme, /当前阶段 \| None/u);
  assert.match(docsReadme, /Active work unit \| None/u);
  assert.match(roadmap, /当前 active phase：\*\*None\*\*/u);
  assert.doesNotMatch(phaseIndex, /13-mobile-host-ports\.md/u);
  assert.match(evidence, /Embed API v2/u);
  await assert.rejects(read("docs/phases/13-mobile-host-ports.md"), { code: "ENOENT" });
});

test("Phase 13 locks hosted ports without compatibility or native scope", () => {
  assert.equal(contract.publicApi.targetVersion, 2);
  assert.equal(contract.publicApi.hostedProfile.externalInput, true);
  assert.deepEqual(
    contract.publicApi.hostedProfile.persistenceAdapter,
    ["hydrate", "write", "flush"],
  );
  assert.equal(contract.publicApi.hostedProfile.awaitableFlush, true);
  assert.equal(contract.ownership.capacitorImportsAllowed, false);
  assert.equal(contract.contentBoundary.externalCorpusRuns, 0);
  assert.equal(contract.contentBoundary.top200Runs, 0);
  assert.equal(contract.verificationBudget.WebKitRuns, 0);
});
