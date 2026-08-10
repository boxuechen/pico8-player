import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const readJson = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));

test("Phase 8D closes an aggregate-only 100-CU result at its implementation commit", async () => {
  const [contract, packageJson] = await Promise.all([
    readJson("spec/phase-8-expanded-real-cart-qualification-contract.json"),
    readJson("package.json"),
  ]);
  const unit = contract.workUnits["8D"];
  const result = unit.result;

  assert.ok(contract.completedWorkUnits.includes("8D"));
  assert.equal(contract.activeWorkUnit, null);
  assert.equal(unit.status, "complete");
  assert.equal(result.caseCount, 100);
  assert.equal(result.completedCaseCount, 100);
  assert.deepEqual(result.smokeOutcomes, { boots: 99, fails: 1, notRun: 0 });
  assert.deepEqual(result.counts, { C0: 0, C1: 0, C2: 0, C3: 0, CU: 100 });
  assert.equal(Object.values(result.failureClusters).every((count) => count === 0), true);
  assert.equal(result.expectedFaultMatches, 1);
  assert.equal(result.screenshotsCapturedLocally, 100);
  assert.equal(result.implementationCommit,
    "c9a0d0237b418a711a912cf9bd83a75cd0e5e7c6");
  assert.ok(result.verification.includes("pnpm run verify"));
  assert.equal(result.productionChanged, true);
  assert.equal(result.networkSurfaceChanged, false);
  assert.equal(result.thirdPartyPerCartDataTracked, false);
  assert.equal(result.thirdPartyScreenshotsTracked, false);
  assert.equal(result.publicCompatibilityRatePublished, false);
  assert.doesNotMatch(JSON.stringify(result), /phase8\/|\.p8|cartSha256|screenSha256/u);

  assert.match(packageJson.scripts["test:phase-8d"], /phase-8d-real-cart-gaps\.test\.mjs/u);
  assert.match(packageJson.scripts.test, /test:phase-8d/u);
  assert.match(packageJson.scripts.verify, /test:phase-8d/u);
});

test("Phase 8D remains closed under immutable exit evidence", async () => {
  const [contract, readme, evidence, testing] = await Promise.all([
    readJson("spec/phase-8-expanded-real-cart-qualification-contract.json"),
    readFile(new URL("docs/README.md", root), "utf8"),
    readFile(new URL(
      "docs/evidence/phase-8/91-phase-8-expanded-real-cart-qualification-exit-evidence.md",
      root,
    ), "utf8"),
    readFile(new URL("docs/06-testing-compatibility.md", root), "utf8"),
  ]);
  assert.equal(contract.nextWorkUnit, null);
  assert.equal(contract.activeWorkUnit, null);
  assert.equal(contract.status, "complete");
  assert.match(readme, /Active work unit \| 无/u);
  assert.match(evidence, /99 boots/u);
  assert.match(testing, /99 boots/u);
});
