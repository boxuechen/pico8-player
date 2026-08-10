import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const readJson = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));

test("Phase 8E remains complete after its successors advance", async () => {
  const contract = await readJson("spec/phase-8-expanded-real-cart-qualification-contract.json");
  assert.deepEqual(contract.completedWorkUnits,
    ["8A", "8B", "8C", "8D", "8E", "8F", "8G", "8H"]);
  assert.equal(contract.workUnits["8D"].status, "complete");
  assert.equal(contract.workUnits["8D"].result.implementationCommit,
    "c9a0d0237b418a711a912cf9bd83a75cd0e5e7c6");
  assert.equal(contract.activeWorkUnit, null);
  assert.equal(contract.nextWorkUnit, null);
  assert.equal(contract.workUnits["8E"].status, "complete");
  assert.equal(contract.workUnits["8F"].status, "complete");
  assert.equal(contract.workUnits["8G"].status, "complete");
  assert.equal(contract.workUnits["8H"].status, "complete");
  assert.ok(Object.values(contract.workUnits).every(({ status }) => status === "complete"));
});

test("Phase 8E fixes pair, privacy, browser and capability boundaries before execution", async () => {
  const contract = await readJson("spec/phase-8-expanded-real-cart-qualification-contract.json");
  const unit = contract.workUnits["8E"];
  assert.equal(contract.externalSource.formatPairs, 65);
  assert.equal(contract.corpusPolicy.formatPairCases, 65);
  assert.deepEqual(contract.browserGate, ["chrome", "chromium"]);
  assert.ok(unit.exit.some((entry) => entry.includes("65 source/export pairs")));
  assert.ok(unit.exit.some((entry) => entry.includes("production Chrome")));
  assert.ok(unit.exit.some((entry) => entry.includes("no third-party identity")));
  assert.ok(unit.exit.some((entry) => entry.includes("caller-authorized bundle")));
  assert.ok(unit.exit.some((entry) => entry.includes("open P0/P1 are zero")));
  assert.ok(unit.allowedPaths.includes("tools/compat/"));
  assert.ok(unit.allowedPaths.includes("spec/compat/"));
  assert.ok(unit.allowedPaths.includes("tests/compat/"));
  assert.equal(unit.allowedPaths.some((path) => path.startsWith("ref/")), false);
  assert.equal(contract.corpusPolicy.networkAccess, false);
  assert.equal(contract.corpusPolicy.ciDependency, false);
  assert.equal(contract.corpusPolicy.releaseArtifactDependency, false);
  assert.equal(unit.result.pairCount, 65);
  assert.equal(unit.result.caseCount, 130);
  assert.deepEqual(unit.result.dispositions, { matched: 9, divergent: 56, notRun: 0 });
  assert.deepEqual(unit.result.boot, { matched: 64, divergent: 1, notRun: 0 });
  assert.equal(unit.result.potentialRuntimeDefects, 0);
  assert.equal(unit.result.screenshotsCapturedLocally, 130);
  assert.equal(unit.result.screenshotReview.openP0, 0);
  assert.equal(unit.result.screenshotReview.openP1, 0);
  assert.equal(unit.result.implementationCommit,
    "bfc83d6f4f245318876177e3a02c9eac08fb6009");
  assert.equal(unit.result.thirdPartyPerPairDataTracked, false);
  assert.equal(unit.result.thirdPartyScreenshotsTracked, false);
  assert.equal(unit.result.qualificationComplete, true);
});

test("current compatibility counts match the machine inventory after Phase 8E", async () => {
  const [contract, inventory, packageJson, scope, evidence, testing] =
    await Promise.all([
      readJson("spec/phase-8-expanded-real-cart-qualification-contract.json"),
      readJson("spec/pico-api-inventory.yaml"),
      readJson("package.json"),
      readFile(new URL("docs/01-scope-and-success-criteria.md", root), "utf8"),
      readFile(new URL(
        "docs/evidence/phase-8/91-phase-8-expanded-real-cart-qualification-exit-evidence.md",
        root,
      ), "utf8"),
      readFile(new URL("docs/06-testing-compatibility.md", root), "utf8"),
    ]);
  const count = (status) => inventory.apis.filter(
    ({ conformanceStatus }) => conformanceStatus === status,
  ).length;
  assert.equal(count("compatible"), 101);
  assert.equal(count("partial"), 5);
  assert.equal(count("unsupported"), 7);
  assert.equal(inventory.apis.filter(
    ({ mvpDisposition, conformanceStatus }) =>
      mvpDisposition === "required" && conformanceStatus === "unknown",
  ).length, 0);
  assert.ok(evidence.includes("65 个 source/export format pair"));
  assert.match(scope, /101 compatible、5 partial、\s*7 unsupported/u);
  assert.match(testing, /`101 compatible`、`5 partial`、`7 unsupported`/u);
  assert.equal(packageJson.scripts["test:phase-8e"],
    "pnpm run build && node --test tests/contract/phase-8e-activation.test.mjs tests/compat/phase-8e-format-pairs.test.mjs && pnpm run test:phase-8f");
  assert.match(packageJson.scripts["qualification:phase-8:pairs"],
    /aggregate-expanded-format-pairs\.mjs/u);
  assert.match(packageJson.scripts["test:historical"], /test:phase-8e/u);
  assert.match(packageJson.scripts["verify:historical"], /test:phase-8e/u);
  assert.equal(contract.workUnits["8F"].status, "complete");
  assert.equal(contract.workUnits["8G"].status, "complete");
});
