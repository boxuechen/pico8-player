import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const readJson = async (path) => JSON.parse(await read(path));

test("Phase 11 activation remains recorded after phase closure", async () => {
  const [contract, docsReadme, phaseIndex, roadmap] = await Promise.all([
    readJson("spec/phase-11-local-cart-gallery-contract.json"),
    read("docs/README.md"),
    read("docs/phases/README.md"),
    read("docs/05-delivery-plan.md"),
  ]);
  assert.equal(contract.status, "complete");
  assert.equal(contract.activeWorkUnit, null);
  assert.equal(contract.workUnits["11A"].status, "complete");
  assert.equal(Object.values(contract.workUnits)
    .filter(({ status }) => status === "active").length, 0);
  assert.match(docsReadme, /最近完成 \| Phase 11/u);
  assert.match(docsReadme, /当前阶段 \| None/u);
  assert.match(docsReadme, /Active work unit \| None/u);
  assert.doesNotMatch(phaseIndex, /11-local-cart-gallery\.md/u);
  assert.match(roadmap, /active phase：\*\*None/u);
  await assert.rejects(read("docs/phases/11-local-cart-gallery.md"), { code: "ENOENT" });
});

test("Phase 11 keeps carts out of production, build, test and tracked evidence", async () => {
  const contract = await readJson("spec/phase-11-local-cart-gallery-contract.json");
  assert.deepEqual(contract.runtimeBoundary, {
    productionRuntimeChangesAuthorized: false,
    releaseArtifactChangesAuthorized: false,
    embedApiChangesAuthorized: false,
    networkCartAuthorityExpansion: false,
    hostFilesystemAuthorityExpansionInPlayer: false,
    developerToolCallerAuthorizedReadOnlyDirectory: true,
    loopbackHost: "127.0.0.1",
  });
  assert.equal(contract.contentBoundary.cartRootFromCliOnly, true);
  assert.equal(contract.contentBoundary.hardcodedCorpusPath, false);
  assert.equal(contract.contentBoundary.thirdPartyCartBytesTracked, 0);
  assert.equal(contract.contentBoundary.thirdPartyCartScreenshotsTracked, 0);
  assert.equal(contract.contentBoundary.thirdPartyPerCartResultsTracked, 0);
  assert.equal(contract.contentBoundary.externalCorpusAutomatedRuns, 0);
  assert.equal(contract.verificationBudget.projectOwnedFixturesOnly, true);
  assert.equal(contract.verificationBudget.historicalMatrixRuns, 0);
  assert.equal(contract.verificationBudget.longSoakRuns, 0);
});
