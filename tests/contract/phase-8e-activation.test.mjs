import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const readJson = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));

test("Phase 8E is the only active work unit after the committed 8D exit", async () => {
  const contract = await readJson("spec/phase-8-expanded-real-cart-qualification-contract.json");
  assert.deepEqual(contract.completedWorkUnits, ["8A", "8B", "8C", "8D"]);
  assert.equal(contract.workUnits["8D"].status, "complete");
  assert.equal(contract.workUnits["8D"].result.implementationCommit,
    "c9a0d0237b418a711a912cf9bd83a75cd0e5e7c6");
  assert.equal(contract.activeWorkUnit, "8E");
  assert.equal(contract.nextWorkUnit, "8E");
  assert.equal(contract.workUnits["8E"].status, "active");
  assert.equal(
    Object.values(contract.workUnits).filter(({ status }) => status === "active").length,
    1,
  );
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
});

test("Phase 8E routing and living compatibility counts match the machine inventory", async () => {
  const [contract, inventory, packageJson, docsReadme, scope, phase, testing] =
    await Promise.all([
      readJson("spec/phase-8-expanded-real-cart-qualification-contract.json"),
      readJson("spec/pico-api-inventory.yaml"),
      readJson("package.json"),
      readFile(new URL("docs/README.md", root), "utf8"),
      readFile(new URL("docs/01-scope-and-success-criteria.md", root), "utf8"),
      readFile(new URL("docs/phases/8-expanded-real-cart-qualification.md", root), "utf8"),
      readFile(new URL("docs/06-testing-compatibility.md", root), "utf8"),
    ]);
  const count = (status) => inventory.apis.filter(
    ({ conformanceStatus }) => conformanceStatus === status,
  ).length;
  assert.equal(count("compatible"), 101);
  assert.equal(count("partial"), 4);
  assert.equal(count("unsupported"), 8);
  assert.equal(inventory.apis.filter(
    ({ mvpDisposition, conformanceStatus }) =>
      mvpDisposition === "required" && conformanceStatus === "unknown",
  ).length, 0);
  assert.match(docsReadme, /Active work unit \| 8E/u);
  assert.match(phase, /Active work unit：8E/u);
  assert.match(scope, /101 compatible、4 partial、\s*8 unsupported/u);
  assert.match(testing, /101 compatible`、`4 partial/u);
  assert.equal(packageJson.scripts["test:phase-8e"],
    "node --test tests/contract/phase-8e-activation.test.mjs");
  assert.match(packageJson.scripts.test, /test:phase-8e/u);
  assert.match(packageJson.scripts.verify, /test:phase-8e/u);
  assert.equal(contract.workUnits["8F"].status, "pending");
});
