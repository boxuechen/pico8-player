import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../../", import.meta.url);

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, projectRoot), "utf8"));
}

async function sha256(relativePath) {
  return createHash("sha256")
    .update(await readFile(new URL(relativePath, projectRoot)))
    .digest("hex");
}

const contract = await readJson("spec/phase-6-real-cart-qualification-contract.json");

test("Phase 6A remains anchored to the closed Phase 5 baseline after Phase 6 exit", async () => {
  assert.equal(contract.phase, "6");
  assert.ok(["active", "complete"].includes(contract.status));
  assert.deepEqual(contract.browserGate, ["chrome", "chromium"]);
  assert.ok(contract.completedWorkUnits.includes("6A"));
  assert.equal(contract.workUnits["6A"].status, "complete");
  if (contract.status === "active") {
    assert.match(contract.activeWorkUnit, /^6[B-H]$/u);
    assert.equal(contract.workUnits[contract.activeWorkUnit].status, "active");
    assert.equal(
      Object.values(contract.workUnits).filter((unit) => unit.status === "active").length,
      1,
    );
  } else {
    assert.equal(contract.activeWorkUnit, null);
    assert.equal(contract.nextWorkUnit, null);
    assert.ok(Object.values(contract.workUnits).every((unit) => unit.status === "complete"));
  }

  for (const [pathKey, hashKey] of [
    ["phase5Contract", "phase5ContractSha256"],
    ["phase5Evidence", "phase5EvidenceSha256"],
    ["phase5ExitManifest", "phase5ExitManifestSha256"],
    ["runtimeManifest", "runtimeManifestSha256"],
  ]) {
    assert.match(contract.baseline[hashKey], /^[0-9a-f]{64}$/u);
    if (pathKey !== "runtimeManifest") {
      assert.equal(await sha256(contract.baseline[pathKey]), contract.baseline[hashKey]);
    }
  }
});

test("Phase 6A freezes a local-only external corpus policy", () => {
  assert.equal(contract.corpusPolicy.mode, "developer-supplied-local-only");
  assert.equal(contract.corpusPolicy.minimumCases, 12);
  assert.equal(contract.corpusPolicy.sourceRevisionRequired, true);
  assert.equal(contract.corpusPolicy.cartSha256Required, true);
  assert.equal(contract.corpusPolicy.permissionStatusRequired, true);
  assert.equal(contract.corpusPolicy.networkAccess, false);
  assert.equal(contract.corpusPolicy.automatedBbsAccess, false);
  assert.equal(contract.corpusPolicy.repositoryCartBytes, 0);
  assert.equal(contract.corpusPolicy.repositoryThirdPartyScreenshots, 0);
  assert.equal(contract.corpusPolicy.ciDependency, false);
  assert.equal(contract.corpusPolicy.publicDenominatorContribution, 0);
  assert.equal(contract.corpusPolicy.refRuntimeDependency, false);
  assert.ok(contract.capabilityProfile.excluded.includes("cart-specific-runtime-hack"));
  assert.ok(contract.capabilityProfile.excluded.includes("non-chrome-browser-gate"));
});

test("Phase 6A publishes explicit qualification and exit gates", () => {
  assert.deepEqual(contract.classification.cartResults, ["C0", "C1", "C2", "C3", "CU"]);
  assert.ok(contract.classification.failureClusters.includes("timing"));
  assert.ok(contract.classification.failureClusters.includes("unsupported-host-feature"));
  assert.ok(contract.classification.requiredEnvironmentFields.includes("chromeVersion"));
  assert.ok(contract.classification.requiredEnvironmentFields.includes("permissionStatus"));
  assert.equal(contract.phaseExitGate.minimumLocalCorpusCases, 12);
  assert.equal(contract.phaseExitGate.minimumC2ManualCases, 3);
  assert.equal(contract.phaseExitGate.openP0, 0);
  assert.equal(contract.phaseExitGate.openP1, 0);
  assert.equal(contract.phaseExitGate.networkAccess, false);
  assert.equal(contract.phaseExitGate.thirdPartyBytesTracked, false);
  assert.equal(contract.phaseExitGate.thirdPartyScreenshotsTracked, false);
  assert.equal(contract.phaseExitGate.publicCompatibilityRateClaimed, false);
});

test("Phase 6A routes Codex and keeps local corpus paths ignored", async () => {
  const docsReadme = await readFile(new URL("docs/README.md", projectRoot), "utf8");
  const phaseIndex = await readFile(new URL("docs/phases/README.md", projectRoot), "utf8");
  const gitignore = await readFile(new URL(".gitignore", projectRoot), "utf8");
  const packageJson = await readJson("package.json");

  if (contract.status === "active") {
    const phase = await readFile(
      new URL("docs/phases/6-real-cart-qualification.md", projectRoot),
      "utf8",
    );
    assert.match(docsReadme, /Active work unit \| 6[B-H]/u);
    assert.ok(phaseIndex.includes("6-real-cart-qualification.md"));
    assert.match(phase, /Active work unit：6[B-H]/u);
    assert.ok(phase.includes("不自动访问 BBS"));
  } else {
    const phase7 = await readJson("spec/phase-7-web-player-release-candidate-contract.json");
    const phase8 = await readJson("spec/phase-8-expanded-real-cart-qualification-contract.json");
    assert.ok(!phaseIndex.includes("6-real-cart-qualification.md"));
    assert.equal(phase7.status, "complete");
    assert.ok(!phaseIndex.includes("7-web-player-release-candidate.md"));
    if (phase8.status === "active") {
      assert.match(docsReadme, /当前阶段 \| Phase 8/u);
      assert.match(docsReadme, /Active work unit \| 8[B-H]/u);
      assert.ok(docsReadme.includes("81-phase-7-web-player-release-candidate-exit-evidence.md"));
      assert.ok(phaseIndex.includes("8-expanded-real-cart-qualification.md"));
    } else {
      assert.match(docsReadme, /最近完成 \| Phase 8/u);
      assert.match(docsReadme, /当前阶段 \| Phase 9/u);
      assert.match(docsReadme, /Active work unit \| 9A/u);
      assert.ok(docsReadme.includes("91-phase-8-expanded-real-cart-qualification-exit-evidence.md"));
      assert.ok(phaseIndex.includes("9-supplemental-compatibility-remediation.md"));
    }
    await assert.rejects(
      readFile(new URL("docs/phases/6-real-cart-qualification.md", projectRoot)),
      { code: "ENOENT" },
    );
  }
  assert.ok(gitignore.includes("/tests/conformance/local-corpus.json"));
  assert.ok(gitignore.includes("/tests/conformance/local-corpus/"));
  assert.equal(
    packageJson.scripts["test:phase-6a"],
    "node --test tests/contract/phase-6a-activation.test.mjs",
  );
  assert.ok(packageJson.scripts.test.includes("test:phase-6a"));
  assert.ok(packageJson.scripts.verify.includes("test:phase-6a"));
});
