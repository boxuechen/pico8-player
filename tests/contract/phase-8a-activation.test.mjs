import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const readJson = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));
const sha256 = async (path) => createHash("sha256")
  .update(await readFile(new URL(path, root)))
  .digest("hex");
const contract = await readJson("spec/phase-8-expanded-real-cart-qualification-contract.json");

test("Phase 8A freezes the completed Phase 7 release baseline", async () => {
  assert.equal(contract.phase, "8");
  assert.equal(contract.status, "active");
  assert.deepEqual(contract.browserGate, ["chrome", "chromium"]);
  assert.ok(contract.completedWorkUnits.includes("8A"));
  assert.match(contract.activeWorkUnit, /^8[B-H]$/u);
  assert.equal(contract.nextWorkUnit, contract.activeWorkUnit);
  assert.equal(contract.workUnits["8A"].status, "complete");
  assert.equal(contract.workUnits[contract.activeWorkUnit].status, "active");
  assert.equal(
    Object.values(contract.workUnits).filter(({ status }) => status === "active").length,
    1,
  );
  for (const [pathKey, hashKey] of [
    ["phase7Contract", "phase7ContractSha256"],
    ["phase7Evidence", "phase7EvidenceSha256"],
    ["phase7ExitManifest", "phase7ExitManifestSha256"],
    ["runtimeManifest", "runtimeManifestSha256"],
  ]) assert.equal(await sha256(contract.baseline[pathKey]), contract.baseline[hashKey]);
});

test("Phase 8A locks the expanded external corpus without granting redistribution", () => {
  assert.equal(contract.externalSource.revision, "9c846040438bdc649b30c115c355c8864cbba06e");
  assert.equal(contract.externalSource.userAuthorizedLocalResearch, true);
  assert.equal(contract.externalSource.rootLicensePresent, false);
  assert.equal(contract.externalSource.topLevelProjects, 71);
  assert.equal(contract.externalSource.cartFiles, 167);
  assert.equal(contract.externalSource.p8Files, 97);
  assert.equal(contract.externalSource.p8PngFiles, 70);
  assert.equal(contract.externalSource.byteUniqueFiles, 166);
  assert.equal(contract.externalSource.canonicalLogicalCarts, 100);
  assert.equal(contract.externalSource.formatPairs, 65);
  assert.equal(contract.externalSource.explicitCcByNcSaTopLevelProjects, 23);
  assert.equal(contract.externalSource.redistributionAuthorized, false);
  assert.equal(contract.corpusPolicy.refPathMayBeTestInput, false);
  assert.equal(contract.corpusPolicy.canonicalCases, 100);
  assert.equal(contract.corpusPolicy.formatPairCases, 65);
  assert.equal(contract.corpusPolicy.maximumBatchCases, 64);
});

test("Phase 8A preserves local-only privacy and measurable Chrome exits", () => {
  assert.equal(contract.corpusPolicy.networkAccess, false);
  assert.equal(contract.corpusPolicy.ciDependency, false);
  assert.equal(contract.corpusPolicy.releaseArtifactDependency, false);
  assert.equal(contract.corpusPolicy.repositoryCartBytes, 0);
  assert.equal(contract.corpusPolicy.repositoryThirdPartyScreenshots, 0);
  assert.equal(contract.corpusPolicy.publicCompatibilityRate, false);
  assert.equal(contract.phaseExitGate.canonicalCasesClassified, 100);
  assert.equal(contract.phaseExitGate.formatPairsQualified, 65);
  assert.equal(contract.phaseExitGate.minimumC2Cases, 10);
  assert.equal(contract.phaseExitGate.screenshotReviewRequired, true);
  assert.equal(contract.phaseExitGate.openP0, 0);
  assert.equal(contract.phaseExitGate.openP1, 0);
  assert.equal(contract.phaseExitGate.networkAccess, false);
  assert.ok(contract.capabilityDelta.excluded.includes("cart-specific-runtime-hacks"));
  assert.ok(contract.capabilityDelta.excluded.includes("non-chrome-browser-gate"));
});

test("Phase 8A routes one active phase and tracks no third-party artifacts", async () => {
  const [docsReadme, phaseIndex, phase, roadmap, references, packageJson] = await Promise.all([
    readFile(new URL("docs/README.md", root), "utf8"),
    readFile(new URL("docs/phases/README.md", root), "utf8"),
    readFile(new URL("docs/phases/8-expanded-real-cart-qualification.md", root), "utf8"),
    readFile(new URL("docs/05-delivery-plan.md", root), "utf8"),
    readFile(new URL("docs/10-reference-sources.md", root), "utf8"),
    readJson("package.json"),
  ]);
  assert.match(docsReadme, /当前阶段 \| Phase 8/u);
  assert.match(docsReadme, /Active work unit \| 8[B-H]/u);
  assert.ok(phaseIndex.includes("8-expanded-real-cart-qualification.md"));
  assert.match(phase, /Active work unit：8[B-H]/u);
  assert.match(phase, /100 个 canonical logical cart/u);
  assert.match(roadmap, /8 Expanded Real-cart Qualification（8A–8H） \| Active/u);
  assert.ok(references.includes("MiniMechMedia/pico8-games"));
  assert.ok(references.includes(contract.externalSource.revision));
  assert.equal(packageJson.scripts["test:phase-8a"],
    "node --test tests/contract/phase-8a-activation.test.mjs");
  assert.ok(packageJson.scripts.test.includes("test:phase-8a"));
  assert.ok(packageJson.scripts.verify.includes("test:phase-8a"));
  const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0").filter(Boolean);
  assert.equal(tracked.some((path) => path.startsWith("ref/")), false);
  assert.equal(tracked.some((path) => /third-party-cart|screenshots?\//u.test(path)), false);
});
