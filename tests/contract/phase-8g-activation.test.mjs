import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const readJson = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));

test("Phase 8G remains complete after release regression requalification", async () => {
  const contract = await readJson("spec/phase-8-expanded-real-cart-qualification-contract.json");
  assert.deepEqual(contract.completedWorkUnits,
    ["8A", "8B", "8C", "8D", "8E", "8F", "8G", "8H"]);
  assert.equal(contract.activeWorkUnit, null);
  assert.equal(contract.nextWorkUnit, null);
  assert.equal(contract.workUnits["8F"].status, "complete");
  assert.equal(contract.workUnits["8G"].status, "complete");
  assert.equal(contract.workUnits["8H"].status, "complete");
  assert.ok(Object.values(contract.workUnits).every(({ status }) => status === "complete"));
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
  assert.equal(unit.result.externalCorpusRead, false);
  assert.equal(unit.result.longRealCartRerun, false);
  assert.equal(unit.result.releaseArtifactVerified, true);
  assert.equal(unit.result.fullChromeGate.desktopSoakSeconds, 600);
  assert.equal(unit.result.fullChromeGate.droppedTicks, 0);
  assert.equal(unit.result.openP0, 0);
  assert.equal(unit.result.openP1, 0);
});

test("Phase 8G history documents the bounded verification strategy", async () => {
  const [packageJson, docsReadme, evidence] = await Promise.all([
    readJson("package.json"),
    readFile(new URL("docs/README.md", root), "utf8"),
    readFile(new URL(
      "docs/evidence/phase-8/91-phase-8-expanded-real-cart-qualification-exit-evidence.md",
      root,
    ), "utf8"),
  ]);
  assert.match(docsReadme, /最近完成 \| Phase 8/u);
  assert.match(docsReadme, /Active work unit \| 9A/u);
  assert.match(evidence, /bounded requalification/u);
  assert.match(evidence, /没有重复读取外部 corpus/u);
  assert.match(packageJson.scripts["test:phase-8g"], /phase-8g-activation\.test\.mjs/u);
  assert.match(packageJson.scripts["test:phase-8f"], /phase-8g-activation\.test\.mjs/u);
  assert.match(packageJson.scripts["test:phase-8e"], /pnpm run test:phase-8f/u);
  assert.match(packageJson.scripts.test, /test:phase-8e/u);
  assert.match(packageJson.scripts.verify, /test:phase-8e/u);
});
