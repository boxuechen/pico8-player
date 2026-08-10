import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const contract = JSON.parse(await readFile(
  new URL("../../spec/phase-13-mobile-host-ports-contract.json", import.meta.url),
  "utf8",
));
const phase = await readFile(
  new URL("../../docs/phases/13-mobile-host-ports.md", import.meta.url),
  "utf8",
);

test("Phase 13 activates one bounded work unit", () => {
  assert.equal(contract.status, "active");
  assert.equal(contract.activeWorkUnit, "13A");
  assert.deepEqual(contract.completedWorkUnits, []);
  assert.equal(contract.nextWorkUnit, "13B");
  assert.match(phase, /Active work unit：13A/u);
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
