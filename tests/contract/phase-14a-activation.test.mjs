import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Phase 14 presented-startup activation remains recorded after closure", async () => {
  const contract = JSON.parse(await readFile(
    "spec/phase-14-presented-startup-lifecycle-contract.json",
    "utf8",
  ));
  const docs = await readFile("docs/README.md", "utf8");
  const phaseIndex = await readFile("docs/phases/README.md", "utf8");
  const evidence = await readFile(
    "docs/evidence/phase-14/151-phase-14-presented-startup-lifecycle-exit-evidence.md",
    "utf8",
  );
  assert.equal(contract.status, "complete");
  assert.equal(contract.activeWorkUnit, null);
  assert.deepEqual(contract.completedWorkUnits, ["14A"]);
  assert.equal(contract.publicApi.startResolution,
    "current-session-first-frame-presented");
  assert.equal(contract.startupBarrier.stateAcknowledgementAloneIsSuccess, false);
  assert.equal(contract.verificationBudget.focusedChromeRunsMaximum, 1);
  assert.equal(contract.verificationBudget.historicalMatrixRuns, 0);
  assert.equal(contract.verificationBudget.mobileProjectMutations, 0);
  assert.match(docs, /当前阶段 \| None/u);
  assert.match(docs, /Phase 14 已关闭/u);
  assert.doesNotMatch(phaseIndex, /14-presented-startup-lifecycle\.md/u);
  assert.match(evidence, /`pico8-mobile` 和 official runtime 均未修改/u);
  await assert.rejects(
    readFile("docs/phases/14-presented-startup-lifecycle.md", "utf8"),
    { code: "ENOENT" },
  );
});
