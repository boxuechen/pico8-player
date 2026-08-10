import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const readJson = async (path) => JSON.parse(await read(path));

test("Phase 12 authorizes one bounded pal(table) compatibility change", async () => {
  const contract = await readJson("spec/phase-12-pal-table-compatibility-contract.json");
  assert.equal(contract.phase, "12");
  assert.equal(contract.runtimeBoundary.productionRuntimeChangesAuthorized, true);
  assert.equal(contract.runtimeBoundary.allowedProductionFile, "wasm/bridge/p8w_frame_runtime.cpp");
  assert.equal(contract.runtimeBoundary.abiChangesAuthorized, false);
  assert.equal(contract.runtimeBoundary.runtimeCoreChangesAuthorized, false);
  assert.deepEqual(contract.behavior, {
    api: "pal(table[, p])",
    tableIndexMinimum: 1,
    tableIndexMaximum: 16,
    nonNumericEntry: "ignore",
    numericEntry: "dispatch",
    splitEmptyMustNotFault: true,
  });
});

test("Phase 12 keeps verification focused and third-party carts untracked", async () => {
  const contract = await readJson("spec/phase-12-pal-table-compatibility-contract.json");
  assert.equal(contract.contentBoundary.projectOwnedRegressionOnly, true);
  assert.equal(contract.contentBoundary.thirdPartyCartBytesTracked, 0);
  assert.equal(contract.contentBoundary.thirdPartyCartScreenshotsTracked, 0);
  assert.equal(contract.verificationBudget.externalCorpusAutomatedRuns, 0);
  assert.equal(contract.verificationBudget.historicalMatrixRuns, 0);
  assert.equal(contract.verificationBudget.longSoakRuns, 0);
});
