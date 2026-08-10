import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const readJson = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));

test("Phase 8G is the only active unit after representative C2 qualification", async () => {
  const contract = await readJson("spec/phase-8-expanded-real-cart-qualification-contract.json");
  assert.deepEqual(contract.completedWorkUnits, ["8A", "8B", "8C", "8D", "8E", "8F"]);
  assert.equal(contract.activeWorkUnit, "8G");
  assert.equal(contract.nextWorkUnit, "8G");
  assert.equal(contract.workUnits["8F"].status, "complete");
  assert.equal(contract.workUnits["8G"].status, "active");
  assert.equal(contract.workUnits["8H"].status, "pending");
  assert.equal(
    Object.values(contract.workUnits).filter(({ status }) => status === "active").length,
    1,
  );
});

test("Phase 8G requalifies release behavior without repeating external long runs", async () => {
  const contract = await readJson("spec/phase-8-expanded-real-cart-qualification-contract.json");
  const unit = contract.workUnits["8G"];
  assert.equal(unit.execution.externalCorpusDependency, false);
  assert.equal(unit.execution.repeatLongRealCartQualification, false);
  assert.equal(unit.execution.browserGate, "chrome-chromium-only");
  assert.deepEqual(unit.execution.requiredCommands, [
    "pnpm run test:phase-8f",
    "pnpm run test:release",
    "pnpm run verify",
  ]);
  assert.ok(unit.exit.some((entry) => entry.includes("test:release and full verify")));
  assert.ok(unit.exit.some((entry) => entry.includes("without external corpus or ref")));
  assert.ok(unit.exit.some((entry) => entry.includes("open P0 and P1 are zero")));
  assert.ok(unit.allowedPaths.includes("tests/artifact/"));
  assert.ok(unit.allowedPaths.includes("tests/browser/"));
  assert.ok(unit.allowedPaths.includes("tests/conformance/"));
  assert.equal(unit.allowedPaths.some((path) => path.startsWith("ref/")), false);
  assert.equal(unit.allowedPaths.some((path) => path.startsWith("packages/")), false);
  assert.equal(unit.allowedPaths.some((path) => path.startsWith("apps/")), false);
});

test("Phase 8G routing documents the bounded verification strategy", async () => {
  const [packageJson, docsReadme, phase] = await Promise.all([
    readJson("package.json"),
    readFile(new URL("docs/README.md", root), "utf8"),
    readFile(new URL("docs/phases/8-expanded-real-cart-qualification.md", root), "utf8"),
  ]);
  assert.match(docsReadme, /Active work unit \| 8G/u);
  assert.match(phase, /Active work unit：8G/u);
  assert.match(phase, /默认不重跑 Top200/u);
  assert.match(phase, /只运行一次完整 `pnpm run verify`/u);
  assert.match(packageJson.scripts["test:phase-8g"], /phase-8g-activation\.test\.mjs/u);
  assert.match(packageJson.scripts["test:phase-8f"], /phase-8g-activation\.test\.mjs/u);
  assert.match(packageJson.scripts["test:phase-8e"], /pnpm run test:phase-8f/u);
  assert.match(packageJson.scripts.test, /test:phase-8e/u);
  assert.match(packageJson.scripts.verify, /test:phase-8e/u);
});
