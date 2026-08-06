import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../../", import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, projectRoot), "utf8");
}

async function readJson(relativePath) {
  return JSON.parse(await read(relativePath));
}

async function exists(relativePath) {
  try {
    await stat(new URL(relativePath, projectRoot));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

const contract = await readJson("spec/phase-5-l3-multicart-contract.json");
const corpus = await readJson("tests/conformance/manifests/phase-5-l3-corpus.json");

test("Phase 5G records one deferred outcome from current official sources", async () => {
  const unit = contract.workUnits["5G"];
  assert.equal(unit.status, "complete");
  assert.equal(unit.result.outcome, "deferred");
  assert.equal(unit.result.reviewedOn, "2026-08-06");
  assert.equal(unit.result.termsPageUpdated, "2026-06-22");
  assert.deepEqual(unit.decisionOutcomes, ["deferred"]);
  assert.equal(unit.result.productionNetworkCapabilityChanged, false);
  assert.equal(unit.result.bbsIsCoreExitGate, false);
  assert.equal(contract.activationPolicy.bbsAccess, "deferred-no-automated-access");
  assert.equal(contract.phaseExitGate.bbsCompatibilityClaimed, false);

  const adr = await read("docs/adr/020-phase-5-bbs-adapter.md");
  for (const required of [
    "状态：Deferred",
    "https://www.lexaloffle.com/info.php?page=tos",
    "https://www.lexaloffle.com/dl/docs/pico-8_manual.html",
    "https://www.lexaloffle.com/pico-8.php?page=resources",
    "第三方 Web Player",
    "唯一结论为 **`deferred`**",
  ]) {
    assert.ok(adr.includes(required), required);
  }
});

test("deferred outcome introduces no BBS production adapter or endpoint", async () => {
  assert.equal(
    await exists("apps/web-player/src/worker/adapters/bbs-cart-resolver-adapter.ts"),
    false,
  );

  const boundedProductionSources = await Promise.all([
    "apps/web-player/src/worker/adapters/host-cart-resolver-adapter.ts",
    "apps/web-player/src/worker/compose-runtime.ts",
    "apps/web-player/src/transport/player-protocol.ts",
    "apps/web-player/src/transport/worker-protocol.ts",
    "packages/runtime-core/src/cart/cart-loader.ts",
  ].map(read));
  const productionText = boundedProductionSources.join("\n");
  assert.doesNotMatch(productionText, /lexaloffle\.com|\/bbs\/|bbs-cart|bbsCart/iu);
  assert.doesNotMatch(productionText, /\bfetch\s*\(|XMLHttpRequest|WebSocket/iu);
  assert.match(productionText, /URL fetch, filesystem lookup or capability inference/u);
});

test("tracked Phase 5 corpus remains project-authored and offline", () => {
  assert.equal(corpus.ownership, "project-authored and tracked in this repository");
  assert.equal(corpus.networkAccess, false);
  assert.equal(corpus.thirdPartyOrBbsContent, false);
  assert.equal(corpus.claimPolicy.thirdPartyExcludedFromPublishedRate, true);
  assert.equal(contract.activationPolicy.thirdPartyCorpusPublishedDenominatorContribution, 0);
  assert.equal(contract.corpus.thirdPartyOrBbsContent, false);
  assert.equal(contract.corpus.networkAccess, false);
  assert.ok(corpus.cases.every((entry) => entry.provenance === "project-authored"));
  assert.ok(corpus.repository.every((entry) => !entry.ref.startsWith("#")));
  assert.ok(corpus.repository.every((entry) => !entry.ref.includes("://")));
});

test("5G deferred policy remains closed after the independent 5H exit", async () => {
  assert.ok(contract.completedWorkUnits.includes("5G"));
  assert.equal(contract.activeWorkUnit, null);
  assert.equal(contract.nextWorkUnit, null);
  assert.equal(contract.workUnits["5H"].status, "complete");
  assert.equal(
    Object.values(contract.workUnits).filter((unit) => unit.status === "active").length,
    0,
  );

  const docsReadme = await read("docs/README.md");
  const evidence = await read(
    "docs/evidence/phase-5/61-phase-5-l3-local-multicart-exit-evidence.md",
  );
  const packageJson = await readJson("package.json");
  assert.match(docsReadme, /最近完成 \| Phase 5/u);
  assert.match(evidence, /ADR-020/u);
  assert.match(evidence, /Deferred/u);
  assert.equal(await exists("docs/phases/5-l3-local-multicart.md"), false);
  assert.equal(
    packageJson.scripts["test:phase-5g"],
    "pnpm run build && node --test tests/runtime/phase-5g-bbs-policy.test.mjs",
  );
  assert.ok(packageJson.scripts.test.includes("test:phase-5g"));
  assert.ok(packageJson.scripts.verify.includes("test:phase-5g"));
});
