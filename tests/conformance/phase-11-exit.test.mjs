import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const readJson = async (path) => JSON.parse(await read(path));

test("Phase 11 closes with bounded local-gallery evidence", async () => {
  const [contract, evidence, docsReadme] = await Promise.all([
    readJson("spec/phase-11-local-cart-gallery-contract.json"),
    read("docs/evidence/phase-11/121-phase-11-local-cart-gallery-exit-evidence.md"),
    read("docs/README.md"),
  ]);
  assert.equal(contract.status, "complete");
  assert.equal(contract.activeWorkUnit, null);
  assert.deepEqual(contract.completedWorkUnits, ["11A"]);
  const result = contract.workUnits["11A"].result;
  assert.deepEqual({
    activationTests: result.activationTests,
    serverContractTests: result.serverContractTests,
    focusedChromeRuns: result.focusedChromeRuns,
    projectOwnedChromeCarts: result.projectOwnedChromeCarts,
    externalCorpusAutomatedRuns: result.externalCorpusAutomatedRuns,
    productionRuntimeSourceChanges: result.productionRuntimeSourceChanges,
    packageJsonChanges: result.packageJsonChanges,
    openP0: result.openP0,
    openP1: result.openP1,
  }, {
    activationTests: 2,
    serverContractTests: 3,
    focusedChromeRuns: 1,
    projectOwnedChromeCarts: 2,
    externalCorpusAutomatedRuns: 0,
    productionRuntimeSourceChanges: 0,
    packageJsonChanges: 0,
    openP0: 0,
    openP1: 0,
  });
  assert.match(evidence, /loopback-only developer tool/u);
  assert.match(evidence, new RegExp(result.releaseArchiveSha256, "u"));
  assert.match(docsReadme, /最近完成 \| Phase 11/u);
  assert.match(docsReadme, /当前阶段 \| None/u);
});

test("local-gallery source has no built-in corpus or non-loopback authority", async () => {
  const [server, client, readme, packageJson] = await Promise.all([
    read("tools/local-gallery/server.mjs"),
    read("tools/local-gallery/public/gallery.mjs"),
    read("README.md"),
    read("package.json"),
  ]);
  assert.doesNotMatch(`${server}\n${client}`, /pico8-top200|nerdyteachers|ref\//iu);
  assert.match(server, /server\.listen\(port, "127\.0\.0\.1"/u);
  assert.doesNotMatch(server, /0\.0\.0\.0|listen\(port, host/u);
  assert.match(readme, /--cart-root \/absolute\/path\/to\/your\/carts/u);
  assert.doesNotMatch(packageJson, /local-gallery|phase-11/u);
});
