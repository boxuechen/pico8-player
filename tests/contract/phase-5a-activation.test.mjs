import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { decodeCart } from "@pico8-web/cart-codec";

const projectRoot = new URL("../../", import.meta.url);

async function readBytes(relativePath) {
  return new Uint8Array(await readFile(new URL(relativePath, projectRoot)));
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, projectRoot), "utf8"));
}

async function sha256(relativePath) {
  return createHash("sha256")
    .update(await readFile(new URL(relativePath, projectRoot)))
    .digest("hex");
}

const contract = await readJson("spec/phase-5-l3-multicart-contract.json");
const corpus = await readJson("tests/conformance/manifests/phase-5-l3-corpus.json");

test("Phase 5A remains anchored to the closed Phase 4 baseline after Phase 5 exit", async () => {
  assert.equal(contract.phase, "5");
  assert.equal(contract.status, "complete");
  assert.equal(
    contract.target,
    "PICO-8 v0.2.7 L3 local/multicart project profile on Chrome/Chromium desktop",
  );
  assert.deepEqual(contract.browserGate, ["chrome", "chromium"]);
  assert.ok(contract.completedWorkUnits.includes("5A"));
  assert.equal(contract.workUnits["5A"].status, "complete");
  assert.equal(contract.activeWorkUnit, null);
  assert.equal(contract.nextWorkUnit, null);
  assert.equal(
    Object.values(contract.workUnits).filter((unit) => unit.status === "active").length,
    0,
  );

  for (const [pathKey, hashKey] of [
    ["phase4Contract", "phase4ContractSha256"],
    ["phase4Evidence", "phase4EvidenceSha256"],
    ["phase4ExitManifest", "phase4ExitManifestSha256"],
  ]) {
    assert.equal(await sha256(contract.baseline[pathKey]), contract.baseline[hashKey]);
  }
  const phase4Exit = await readJson(contract.baseline.phase4ExitManifest);
  assert.equal(
    phase4Exit.inputs[contract.baseline.runtimeManifest],
    contract.baseline.runtimeManifestSha256,
  );
  assert.equal(
    await sha256(contract.activationPolicy.decision),
    contract.activationPolicy.decisionSha256,
  );
});

test("Phase 5A freezes a project-authored local-only L3 corpus", async () => {
  assert.equal(corpus.corpusId, "phase-5-l3-local-multicart-project-corpus-v1");
  assert.equal(corpus.ownership, "project-authored and tracked in this repository");
  assert.equal(corpus.networkAccess, false);
  assert.equal(corpus.thirdPartyOrBbsContent, false);
  assert.equal(corpus.cases.length, contract.corpus.cases);
  assert.equal(corpus.repository.length, contract.corpus.repositoryEntries);
  assert.equal(
    await sha256(contract.corpus.manifest),
    contract.corpus.manifestSha256,
  );
  assert.deepEqual(
    [...new Set(corpus.cases.flatMap((entry) => entry.capabilityLanes))].sort(),
    [...corpus.requiredCapabilityLanes].sort(),
  );

  const sources = [
    ...corpus.repository.map((entry) => ({ path: entry.source, hash: entry.sourceSha256 })),
    ...corpus.cases.map((entry) => ({ path: entry.entry, hash: entry.entrySha256 })),
  ];
  for (const source of sources) {
    assert.equal(await sha256(source.path), source.hash, source.path);
    const decoded = decodeCart(await readBytes(source.path));
    assert.equal(decoded.format, "p8");
    assert.equal(decoded.version, 42);
  }
  assert.ok(corpus.cases.every((entry) => entry.provenance === "project-authored"));
  assert.ok(corpus.cases.every((entry) => entry.activationClassification === "CU"));
  assert.ok(
    corpus.repository.every((entry) => !entry.ref.startsWith("#") && !entry.ref.includes("://")),
  );
});

test("Phase 5A capability and service policy fail closed", () => {
  assert.deepEqual(contract.capabilityProfile.accessBits, [
    "load",
    "reloadData",
    "cstoreData",
    "include",
  ]);
  assert.equal(contract.activationPolicy.bbsAccess, "deferred-no-automated-access");
  assert.equal(contract.activationPolicy.bbsIsCoreExitGate, false);
  assert.equal(contract.activationPolicy.thirdPartyCorpusPublishedDenominatorContribution, 0);
  assert.match(contract.activationPolicy.nestedHostSuspension, /^root-only/);
  assert.ok(contract.capabilityProfile.excluded.includes("arbitrary-url"));
  assert.ok(contract.capabilityProfile.excluded.includes("host-filesystem"));
  assert.ok(contract.capabilityProfile.excluded.includes("bbs-crawler"));
  assert.equal(contract.resourceLimits.maximumCartInputBytes, 1024 * 1024);
  assert.equal(contract.resourceLimits.maximumLocalBundleEntries, 64);
  assert.equal(contract.phaseExitGate.bbsCompatibilityClaimed, false);
});

test("Phase 5A activation history routes to closed Phase 5 evidence", async () => {
  const docsReadme = await readFile(new URL("docs/README.md", projectRoot), "utf8");
  const phaseIndex = await readFile(new URL("docs/phases/README.md", projectRoot), "utf8");
  const evidence = await readFile(
    new URL(
      "docs/evidence/phase-5/61-phase-5-l3-local-multicart-exit-evidence.md",
      projectRoot,
    ),
    "utf8",
  );
  const decisions = await readFile(
    new URL("docs/07-decisions-risks-open-questions.md", projectRoot),
    "utf8",
  );
  const packageJson = await readJson("package.json");

  assert.match(docsReadme, /最近完成 \| Phase 5/u);
  assert.doesNotMatch(docsReadme, /Active work unit/u);
  assert.doesNotMatch(phaseIndex, /5-l3-local-multicart\.md/u);
  assert.ok(evidence.includes("5A–5H"));
  assert.ok(evidence.includes("BBS"));
  assert.ok(decisions.includes("ADR-018"));
  assert.equal(
    packageJson.scripts["test:phase-5a"],
    "pnpm run build && node --test tests/contract/phase-5a-activation.test.mjs",
  );
  assert.ok(packageJson.scripts.test.includes("test:phase-5a"));
  assert.ok(packageJson.scripts.verify.includes("test:phase-5a"));
  await assert.rejects(
    readFile(new URL("docs/phases/5-l3-local-multicart.md", projectRoot)),
    { code: "ENOENT" },
  );
});
