import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIRECTORY, "../..");

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, relativePath), "utf8"));
}

function sha256(relativePath) {
  return createHash("sha256")
    .update(readFileSync(path.join(REPO_ROOT, relativePath)))
    .digest("hex");
}

test("Phase 4 API inventory has orthogonal status dimensions and unique names", () => {
  const inventory = readJson("spec/pico-api-inventory.yaml");
  const phase = readJson("spec/phase-4-l2-mvp-contract.json");
  const names = inventory.apis.map(({ name }) => name);

  assert.equal(inventory.schemaVersion, 2);
  assert.equal(inventory.target, "pico-8-v0.2.7-player");
  assert.equal(inventory.apis.length, phase.workUnits["4A"].result.apiCount);
  assert.equal(new Set(names).size, names.length, "API names must be unique");

  for (const api of inventory.apis) {
    assert.match(api.name, /^[a-z][a-z0-9_]*$/);
    assert.ok(inventory.dimensions.mvpDisposition.includes(api.mvpDisposition), api.name);
    assert.ok(
      inventory.dimensions.implementationStatus.includes(api.implementationStatus),
      api.name,
    );
    assert.ok(inventory.dimensions.conformanceStatus.includes(api.conformanceStatus), api.name);
    if (api.conformanceStatus === "compatible") {
      assert.equal(typeof api.evidence, "string", `${api.name} needs evidence`);
      assert.equal(existsSync(path.join(REPO_ROOT, api.evidence)), true, api.evidence);
    }
    if (api.mvpDisposition === "excluded") {
      assert.equal(api.implementationStatus, "unsupported", api.name);
      assert.equal(api.conformanceStatus, "unsupported", api.name);
    }
  }

  const implementationCounts = Object.fromEntries(
    inventory.dimensions.implementationStatus.map((status) => [
      status,
      inventory.apis.filter((api) => api.implementationStatus === status).length,
    ]),
  );
  const conformanceCounts = Object.fromEntries(
    inventory.dimensions.conformanceStatus.map((status) => [
      status,
      inventory.apis.filter((api) => api.conformanceStatus === status).length,
    ]),
  );
  const expectedCounts = phase.completedWorkUnits.includes("4C")
    ? phase.workUnits["4C"].result.inventoryCounts
    : phase.workUnits["4A"].result;
  assert.deepEqual(implementationCounts, expectedCounts.implementationCounts);
  assert.deepEqual(conformanceCounts, expectedCounts.conformanceCounts);
});

test("all 38 append-only host bindings reconcile with the inventory", () => {
  const inventory = readJson("spec/pico-api-inventory.yaml");
  const abi = readJson("spec/abi/pico-host-api-v1.json");
  const byBindingId = new Map(
    inventory.apis
      .filter(({ hostBindingId }) => hostBindingId !== undefined)
      .map((api) => [api.hostBindingId, api]),
  );

  assert.equal(abi.bindings.length, 38);
  assert.equal(byBindingId.size, abi.bindings.length);
  assert.deepEqual(abi.bindings.map(({ id }) => id), Array.from({ length: 38 }, (_, i) => i + 1));

  for (const binding of abi.bindings) {
    const api = byBindingId.get(binding.id);
    assert.ok(api, `missing inventory entry for binding ${binding.id}`);
    assert.equal(api.name, binding.guestName, `binding ${binding.id}`);
    assert.equal(api.surface, "host-binding", api.name);
    assert.notEqual(api.implementationStatus, "unimplemented", api.name);
    assert.notEqual(api.implementationStatus, "unsupported", api.name);
  }
});

test("frozen project corpus has provenance, flows, observables and exact source hashes", () => {
  const corpus = readJson("tests/conformance/manifests/phase-4-l2-corpus.json");
  const phase = readJson("spec/phase-4-l2-mvp-contract.json");
  const ids = corpus.cases.map(({ id }) => id);
  const coveredLanes = new Set(corpus.cases.flatMap(({ capabilityLanes }) => capabilityLanes));

  assert.equal(corpus.cases.length, phase.workUnits["4A"].result.projectCorpusCases);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...coveredLanes].sort(), [...corpus.requiredCapabilityLanes].sort());
  assert.equal(corpus.claimPolicy.minimumPlayableRate, phase.corpusPolicy.minimumPlayableRate);
  assert.equal(corpus.claimPolicy.maximumOpenP0, phase.corpusPolicy.openP0Maximum);
  assert.equal(corpus.claimPolicy.maximumOpenP1, phase.corpusPolicy.openP1Maximum);
  assert.equal(corpus.claimPolicy.thirdPartyExcludedFromPublishedRate, true);

  for (const entry of corpus.cases) {
    assert.equal(entry.provenance, "project-authored", entry.id);
    assert.equal(entry.license, "project-owned-test-fixture", entry.id);
    assert.equal(existsSync(path.join(REPO_ROOT, entry.source)), true, entry.source);
    assert.equal(sha256(entry.source), entry.sourceSha256, entry.id);
    assert.ok(entry.criticalFlow.length > 0, entry.id);
    assert.ok(entry.observables.length > 0, entry.id);
    assert.ok(entry.capabilityLanes.length > 0, entry.id);
    assert.ok(corpus.claimPolicy.classifications.includes(entry.phase4Classification), entry.id);
    if (phase.completedWorkUnits.includes("4B")) {
      assert.equal(entry.phase4Classification, "C3", entry.id);
    }
    assert.equal(existsSync(path.join(REPO_ROOT, entry.priorEvidence)), true, entry.priorEvidence);
  }
});

test("local external corpus bytes and results remain outside tracked claims", () => {
  const ignore = readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8");
  const example = readJson("tests/conformance/local-corpus.example.json");
  const phase = readJson("spec/phase-4-l2-mvp-contract.json");

  assert.match(ignore, /^\/tests\/conformance\/local-corpus\.json$/m);
  assert.match(ignore, /^\/tests\/conformance\/local-corpus\/$/m);
  assert.equal(example.schemaVersion, 1);
  assert.match(example.policy, /never committed/);
  assert.equal(phase.corpusPolicy.publishedDenominator, "project-authored tracked corpus only");
  assert.equal(phase.nonGoals.includes("bbs-network-access"), true);
});
