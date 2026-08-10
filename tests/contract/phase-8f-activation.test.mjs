import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const readJson = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));

test("Phase 8F remains complete after Phase 8 aggregate exit", async () => {
  const contract = await readJson("spec/phase-8-expanded-real-cart-qualification-contract.json");
  assert.deepEqual(contract.completedWorkUnits,
    ["8A", "8B", "8C", "8D", "8E", "8F", "8G", "8H"]);
  assert.equal(contract.activeWorkUnit, null);
  assert.equal(contract.nextWorkUnit, null);
  assert.equal(contract.workUnits["8E"].status, "complete");
  assert.equal(contract.workUnits["8F"].status, "complete");
  assert.equal(contract.workUnits["8G"].status, "complete");
  assert.equal(contract.workUnits["8H"].status, "complete");
  assert.ok(Object.values(contract.workUnits).every(({ status }) => status === "complete"));
});

test("Phase 8F locks C2, risk, review and external-data boundaries", async () => {
  const contract = await readJson("spec/phase-8-expanded-real-cart-qualification-contract.json");
  const unit = contract.workUnits["8F"];
  assert.ok(unit.exit.some((entry) => entry.includes("at least 10")));
  assert.ok(unit.exit.some((entry) => entry.includes("graphics, audio, input, persistence")));
  assert.ok(unit.exit.some((entry) => entry.includes("main verbs")));
  assert.ok(unit.exit.some((entry) => entry.includes("Canvas screenshots")));
  assert.ok(unit.exit.some((entry) => entry.includes("open P0/P1 are zero")));
  assert.ok(unit.allowedPaths.includes("tools/compat/"));
  assert.ok(unit.allowedPaths.includes("tests/compat/"));
  assert.ok(unit.allowedPaths.includes("docs/phases/8-expanded-real-cart-qualification.md"));
  assert.equal(unit.allowedPaths.some((path) => path.startsWith("ref/")), false);
  assert.equal(contract.corpusPolicy.networkAccess, false);
  assert.equal(contract.classification.thirdPartyPerCartResultsTracked, false);
  assert.deepEqual(unit.execution.quickSmoke, {
    corpus: "supplemental-top200-local-snapshot",
    cases: 200,
    batches: [50, 50, 50, 50],
    logicalTicksPerCase: 120,
    formalPhase8DenominatorChanged: false,
  });
  assert.deepEqual(unit.execution.representativeC2, {
    cases: 10,
    criticalFlowCases: 8,
    durationCases: 2,
    durationSeconds: 900,
    durationLogicalFrames: 27000,
  });
  assert.equal(unit.result.supplementalQuickSmoke.caseCount, 200);
  assert.equal(unit.result.supplementalQuickSmoke.completedCaseCount, 200);
  assert.deepEqual(unit.result.supplementalQuickSmoke.smokeOutcomes,
    { boots: 149, fails: 51, notRun: 0 });
  assert.deepEqual(unit.result.supplementalQuickSmoke.failureClusters,
    { language: 45, timing: 5, "unsupported-host-feature": 1 });
  assert.equal(unit.result.supplementalQuickSmoke.formalPhase8DenominatorChanged, false);
  assert.equal(unit.result.representativeC2.c2CaseCount, 10);
  assert.deepEqual(unit.result.representativeC2.gateCounts,
    { criticalFlow: 8, duration: 2 });
  assert.equal(unit.result.representativeC2.riskCoverage.persistence, 1);
  assert.equal(unit.result.representativeC2.realAudioDeviceCases, 4);
  assert.equal(unit.result.representativeC2.persistenceReloadCases, 1);
  assert.deepEqual(unit.result.representativeC2.openFindings,
    { P0: 0, P1: 0, P2: 0, P3: 0 });
  assert.equal(unit.result.productionCartSpecificBranches, 0);
  assert.equal(unit.result.thirdPartyPerCartDataTracked, false);
  assert.equal(unit.result.thirdPartyScreenshotsTracked, false);
  assert.equal(unit.result.qualificationComplete, true);
});

test("Phase 8F history is documented and continuously verified", async () => {
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
  assert.match(evidence, /10 个代表 case 全部达到 C2/u);
  assert.match(evidence, /没有重复读取外部 corpus/u);
  assert.match(packageJson.scripts["test:phase-8f"], /phase-8f-supplemental-top200\.test\.mjs/u);
  assert.match(packageJson.scripts["test:phase-8f"], /phase-8f-representative-playability\.test\.mjs/u);
  assert.match(packageJson.scripts["test:phase-8f"], /phase-8g-activation\.test\.mjs/u);
  assert.match(packageJson.scripts["prepare:phase-8f:top200"], /prepare-supplemental-top200\.mjs/u);
  assert.match(packageJson.scripts["qualification:phase-8f:playability:finalize"],
    /finalize-representative-playability\.mjs/u);
  assert.match(packageJson.scripts["test:phase-8e"], /pnpm run test:phase-8f/u);
  assert.match(packageJson.scripts["test:historical"], /test:phase-8e/u);
  assert.match(packageJson.scripts["verify:historical"], /test:phase-8e/u);
});
