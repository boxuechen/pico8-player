import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const readJson = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));

test("Phase 8D records an aggregate-only 100-CU candidate without closing before commit", async () => {
  const [contract, packageJson] = await Promise.all([
    readJson("spec/phase-8-expanded-real-cart-qualification-contract.json"),
    readJson("package.json"),
  ]);
  const unit = contract.workUnits["8D"];
  const result = unit.candidateResult;

  assert.equal(contract.activeWorkUnit, "8D");
  assert.equal(unit.status, "active");
  assert.equal(result.caseCount, 100);
  assert.equal(result.completedCaseCount, 100);
  assert.deepEqual(result.smokeOutcomes, { boots: 99, fails: 1, notRun: 0 });
  assert.deepEqual(result.counts, { C0: 0, C1: 0, C2: 0, C3: 0, CU: 100 });
  assert.equal(Object.values(result.failureClusters).every((count) => count === 0), true);
  assert.equal(result.expectedFaultMatches, 1);
  assert.equal(result.screenshotsCapturedLocally, 100);
  assert.equal(result.thirdPartyPerCartDataTracked, false);
  assert.equal(result.thirdPartyScreenshotsTracked, false);
  assert.equal(result.publicCompatibilityRatePublished, false);
  assert.doesNotMatch(JSON.stringify(result), /phase8\/|\.p8|cartSha256|screenSha256/u);

  assert.match(packageJson.scripts["test:phase-8d"], /phase-8d-real-cart-gaps\.test\.mjs/u);
  assert.match(packageJson.scripts.test, /test:phase-8d/u);
  assert.match(packageJson.scripts.verify, /test:phase-8d/u);
});

test("Phase 8D keeps current owner documents and the next unit explicit", async () => {
  const [contract, readme, phase, testing] = await Promise.all([
    readJson("spec/phase-8-expanded-real-cart-qualification-contract.json"),
    readFile(new URL("docs/README.md", root), "utf8"),
    readFile(new URL("docs/phases/8-expanded-real-cart-qualification.md", root), "utf8"),
    readFile(new URL("docs/06-testing-compatibility.md", root), "utf8"),
  ]);
  assert.equal(contract.nextWorkUnit, "8D");
  assert.equal(contract.workUnits["8E"].status, "pending");
  assert.match(readme, /Active work unit \| 8D/u);
  assert.match(phase, /Active work unit：8D/u);
  assert.match(phase, /99 boots/u);
  assert.match(testing, /99 boots/u);
});
