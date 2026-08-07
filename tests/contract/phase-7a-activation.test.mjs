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

const contract = await readJson("spec/phase-7-web-player-release-candidate-contract.json");

test("Phase 7A remains anchored to the completed Phase 6 baseline", async () => {
  assert.equal(contract.phase, "7");
  assert.ok(["active", "complete"].includes(contract.status));
  assert.equal(
    contract.target,
    "reproducible embeddable PICO-8 v0.2.7 web-player release candidate for Chrome/Chromium desktop",
  );
  assert.deepEqual(contract.browserGate, ["chrome", "chromium"]);
  assert.ok(contract.completedWorkUnits.includes("7A"));
  assert.equal(contract.workUnits["7A"].status, "complete");
  if (contract.status === "active") {
    assert.match(contract.activeWorkUnit, /^7[B-H]$/u);
    assert.equal(contract.nextWorkUnit, contract.activeWorkUnit);
    assert.equal(contract.workUnits[contract.activeWorkUnit].status, "active");
    assert.equal(
      Object.values(contract.workUnits).filter((unit) => unit.status === "active").length,
      1,
    );
  } else {
    assert.equal(contract.activeWorkUnit, null);
    assert.equal(contract.nextWorkUnit, null);
    assert.deepEqual(contract.completedWorkUnits, [
      "7A", "7B", "7C", "7D", "7E", "7F", "7G", "7H",
    ]);
    assert.ok(Object.values(contract.workUnits).every((unit) => unit.status === "complete"));
  }

  for (const [pathKey, hashKey] of [
    ["phase6Contract", "phase6ContractSha256"],
    ["phase6Evidence", "phase6EvidenceSha256"],
    ["phase6ExitManifest", "phase6ExitManifestSha256"],
  ]) {
    assert.equal(await sha256(contract.baseline[pathKey]), contract.baseline[hashKey]);
  }
  const phase6Exit = await readJson(contract.baseline.phase6ExitManifest);
  assert.equal(
    phase6Exit.inputs[contract.baseline.runtimeManifest],
    contract.baseline.runtimeManifestSha256,
  );
});

test("Phase 7A freezes a bytes-first local-only release profile", () => {
  assert.equal(contract.releaseProfile.pico8Version, "0.2.7");
  assert.equal(contract.releaseProfile.platform, "desktop Chrome/Chromium");
  assert.equal(contract.releaseProfile.networkAccess, false);
  assert.equal(contract.releaseProfile.automatedBbsAccess, false);
  assert.equal(contract.releaseProfile.arbitraryUrlAccess, false);
  assert.equal(contract.releaseProfile.hostFilesystemAccess, false);
  assert.equal(contract.releaseProfile.repositoryThirdPartyCartBytes, 0);
  assert.equal(contract.releaseProfile.repositoryThirdPartyScreenshots, 0);
  assert.equal(contract.releaseProfile.releasePublicationAuthorized, false);
  assert.ok(contract.capabilityDelta.excluded.includes("non-chrome-browser-gate"));
  assert.ok(contract.capabilityDelta.excluded.includes("npm-registry-publication"));
  assert.match(contract.embedApiContract.inputAuthority, /Uint8Array bytes/u);
});

test("Phase 7A makes execution-domain and menu ownership explicit", () => {
  assert.match(contract.architectureBoundaries.runtimeCore, /browser-neutral/u);
  assert.match(contract.architectureBoundaries.runtimeCore, /no DOM/u);
  assert.match(contract.architectureBoundaries.main, /DOM shell/u);
  assert.match(contract.architectureBoundaries.worker, /only composition root/u);
  assert.match(contract.architectureBoundaries.worklet, /PCM queue only/u);
  assert.match(contract.architectureBoundaries.menuitem, /VM-local/u);
  assert.match(contract.architectureBoundaries.menuitem, /copied slot DTOs/u);
  assert.deepEqual(contract.artifactContract.stableKeys, [
    "main", "worker", "worklet", "wasm", "styles", "demo",
  ]);
});

test("Phase 7A records compatibility debt and measurable exit gates", () => {
  assert.equal(contract.compatibilityBaseline.totalApis, 113);
  assert.equal(contract.compatibilityBaseline.compatible, 72);
  assert.equal(contract.compatibilityBaseline.unknownRequired, 28);
  assert.deepEqual(contract.compatibilityBaseline.partialApis, [
    "flip", "stat", "print", "menuitem",
  ]);
  assert.match(contract.compatibilityBaseline.closureRule, /never become compatible by relabeling/u);
  assert.equal(contract.releaseCandidateExitGate.unknownRequiredReleaseModes, 0);
  assert.equal(contract.releaseCandidateExitGate.desktopSoakSeconds, 600);
  assert.equal(contract.releaseCandidateExitGate.audioUnderruns, 0);
  assert.equal(contract.releaseCandidateExitGate.hangRecoveryCycles, 20);
  assert.equal(contract.releaseCandidateExitGate.networkAccess, false);
});

test("Phase 7A routes Codex to one active unit or the closed Phase 7 evidence", async () => {
  const docsReadme = await readFile(new URL("docs/README.md", projectRoot), "utf8");
  const phaseIndex = await readFile(new URL("docs/phases/README.md", projectRoot), "utf8");
  const rootReadme = await readFile(new URL("README.md", projectRoot), "utf8");
  const packageJson = await readJson("package.json");

  if (contract.status === "active") {
    const phase = await readFile(
      new URL("docs/phases/7-web-player-release-candidate.md", projectRoot),
      "utf8",
    );
    assert.match(docsReadme, /当前阶段 \| Phase 7/u);
    assert.match(docsReadme, /Active work unit \| 7[B-H]/u);
    assert.ok(phaseIndex.includes("7-web-player-release-candidate.md"));
    assert.match(phase, /Active work unit：7[B-H]/u);
    assert.ok(phase.includes("不新增网络、BBS、任意 URL"));
  } else {
    const phase8 = await readJson("spec/phase-8-expanded-real-cart-qualification-contract.json");
    assert.match(docsReadme, /最近完成 \| Phase 7/u);
    assert.ok(!phaseIndex.includes("7-web-player-release-candidate.md"));
    if (phase8.status === "active") {
      assert.match(docsReadme, /当前阶段 \| Phase 8/u);
      assert.match(docsReadme, /Active work unit \| 8[B-H]/u);
      assert.ok(phaseIndex.includes("8-expanded-real-cart-qualification.md"));
    } else {
      assert.match(docsReadme, /当前阶段 \| 无/u);
      assert.match(docsReadme, /Active work unit \| 无/u);
    }
    await assert.rejects(
      readFile(new URL("docs/phases/7-web-player-release-candidate.md", projectRoot)),
      { code: "ENOENT" },
    );
  }
  assert.ok(rootReadme.includes("release-candidate PICO-8 v0.2.7 web player"));
  assert.doesNotMatch(rootReadme, /Full cart hardware.+not implemented/u);
  assert.equal(
    packageJson.scripts["test:phase-7a"],
    "node --test tests/contract/phase-7a-activation.test.mjs",
  );
  assert.ok(packageJson.scripts.test.includes("test:phase-7a"));
  assert.ok(packageJson.scripts.verify.includes("test:phase-7a"));
});
