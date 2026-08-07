import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  ExpandedCorpusError,
  discoverExpandedCorpus,
  prepareExpandedCorpus,
} from "../../tools/compat/expanded-corpus-v1.mjs";
import { loadLocalCorpusManifest } from "../../tools/compat/local-qualification-v1.mjs";

const projectRoot = new URL("../../", import.meta.url).pathname;
const source = {
  repository: "https://example.invalid/project-owned-test-corpus.git",
  revision: "0123456789abcdef0123456789abcdef01234567",
  label: "project-owned generated test corpus",
};

function p8Bytes(index) {
  return Buffer.from(`pico-8 cartridge // http://www.pico-8.com\nversion 43\n__lua__\nfunction _draw() cls(${index % 16}) end\n`);
}

async function makeFixture(root, { symlinkEscape = false } = {}) {
  const sourceRoot = join(root, "source");
  const cartsRoot = join(sourceRoot, "carts");
  await mkdir(cartsRoot, { recursive: true });
  for (let index = 1; index <= 12; index += 1) {
    const project = `project-${String(index).padStart(2, "0")}`;
    const projectRootPath = join(cartsRoot, project);
    await mkdir(projectRootPath, { recursive: true });
    await writeFile(join(projectRootPath, `${project}.p8`), p8Bytes(index));
    if (index <= 6) {
      const exportRoot = join(projectRootPath, "export");
      await mkdir(exportRoot);
      await writeFile(join(exportRoot, `${project}.p8.png`), Buffer.from(`png-export-${index}`));
    }
  }
  const duplicateRoot = join(cartsRoot, "zz-duplicate");
  await mkdir(duplicateRoot);
  await writeFile(join(duplicateRoot, "project-12.p8"), p8Bytes(12));
  if (symlinkEscape) {
    const outside = join(root, "outside.p8");
    await writeFile(outside, p8Bytes(99));
    await symlink(outside, join(cartsRoot, "project-01", "escape.p8"));
  }
  return sourceRoot;
}

const expectedInventory = {
  topLevelProjects: 13,
  cartFiles: 19,
  p8Files: 13,
  p8PngFiles: 6,
  byteUniqueFiles: 18,
  logicalIdentities: 13,
  canonicalLogicalCarts: 12,
  formatPairs: 6,
};

async function withTemporaryDirectory(fn) {
  const root = await mkdtemp(join(tmpdir(), "p8w-phase8b-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("Phase 8B selects canonical exports, format pairs and byte-unique programs deterministically", async () => {
  await withTemporaryDirectory(async (root) => {
    const sourceRoot = await makeFixture(root);
    const discovery = await discoverExpandedCorpus({ sourceRoot });
    assert.deepEqual(discovery.inventory, expectedInventory);
    assert.equal(discovery.duplicateCanonical.length, 1);
    assert.equal(discovery.duplicateCanonical[0].dropped, "zz-duplicate/project-12");
    assert.equal(discovery.canonical.length, 12);
    assert.equal(discovery.pairs.length, 6);
    for (const identity of discovery.canonical.slice(0, 6)) {
      assert.equal(identity.canonical.format, "p8.png");
      assert.match(identity.canonical.relativePath, /\/export\//u);
    }

    const first = await prepareExpandedCorpus({
      sourceRoot,
      outputRoot: join(root, "output-a"),
      source,
      expectedInventory,
    });
    const second = await prepareExpandedCorpus({
      sourceRoot,
      outputRoot: join(root, "output-b"),
      source,
      expectedInventory,
    });
    assert.equal(first.indexSha256, second.indexSha256);
    assert.match(first.index.corpusFingerprint, /^[a-f0-9]{64}$/u);
    assert.equal(first.index.corpusFingerprint, second.index.corpusFingerprint);
    assert.deepEqual(first.index.inventory, expectedInventory);
    assert.deepEqual(first.index.canonical.batches.map(({ cases }) => cases), [12]);
    assert.deepEqual(first.index.formatPairs.batches.map(({ cases }) => cases), [12]);
    assert.equal(first.index.canonical.cases.length, 12);
    assert.equal(first.index.formatPairs.pairs.length, 6);

    const canonicalManifest = join(first.outputRoot, first.index.canonical.batches[0].file);
    const loaded = await loadLocalCorpusManifest({
      manifestPath: canonicalManifest,
      projectRoot,
      minimumCases: 12,
    });
    assert.equal(loaded.entries.length, 12);
    assert.ok(loaded.entries.every(({ source: entrySource }) =>
      entrySource.permissionStatus === "caller-authorized-local-research"));
  });
});

test("Phase 8B rejects repository paths, URLs, inventory drift and symlink escape", async () => {
  await assert.rejects(discoverExpandedCorpus({ sourceRoot: projectRoot }), (error) =>
    error instanceof ExpandedCorpusError && error.code === "E_PATH_REPOSITORY");
  await assert.rejects(discoverExpandedCorpus({ sourceRoot: "https://example.invalid/carts" }), (error) =>
    error instanceof ExpandedCorpusError && error.code === "E_PATH_URL");
  await withTemporaryDirectory(async (root) => {
    const sourceRoot = await makeFixture(root);
    await assert.rejects(prepareExpandedCorpus({
      sourceRoot,
      outputRoot: join(root, "bad-inventory"),
      source,
      expectedInventory: { ...expectedInventory, canonicalLogicalCarts: 13 },
    }), (error) => error instanceof ExpandedCorpusError && error.code === "E_INVENTORY");
    await assert.rejects(prepareExpandedCorpus({
      sourceRoot,
      outputRoot: new URL("../conformance/phase-8b-output", import.meta.url).pathname,
      source,
      expectedInventory,
    }), (error) => error instanceof ExpandedCorpusError && error.code === "E_PATH_REPOSITORY");
  });
  await withTemporaryDirectory(async (root) => {
    const sourceRoot = await makeFixture(root, { symlinkEscape: true });
    await assert.rejects(discoverExpandedCorpus({ sourceRoot }), (error) =>
      error instanceof ExpandedCorpusError && error.code === "E_PATH_SYMLINK");
  });
});

test("Phase 8B keeps Phase 6 at exactly 12 cases and exposes a separate expanded wrapper", async () => {
  const [phase6Runner, expandedRunner, schema] = await Promise.all([
    readFile(new URL("../../tools/compat/run-chrome-baseline.mjs", import.meta.url), "utf8"),
    readFile(new URL("../../tools/compat/run-expanded-chrome-baseline.mjs", import.meta.url), "utf8"),
    readFile(new URL("../../spec/compat/expanded-local-corpus-v1.schema.json", import.meta.url), "utf8"),
  ]);
  assert.match(phase6Runner, /expectedCaseCount = 12/u);
  assert.match(phase6Runner, /Phase 6C requires exactly/u);
  assert.match(expandedRunner, /expectedCaseCount: null/u);
  assert.equal(JSON.parse(schema).properties.runner.const, "phase-8-expanded-corpus-v1");
});

test("Phase 8B remains closed under its active successor", async () => {
  const [contract, packageJson] = await Promise.all([
    readFile(new URL("../../spec/phase-8-expanded-real-cart-qualification-contract.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../../package.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  assert.ok(contract.completedWorkUnits.includes("8B"));
  assert.equal(contract.workUnits["8B"].status, "complete");
  assert.match(contract.activeWorkUnit, /^8[C-H]$/u);
  assert.equal(contract.workUnits[contract.activeWorkUnit].status, "active");
  assert.equal(contract.workUnits["8B"].result.corpusFingerprint,
    "941bcc486bbf18fa22936d4ff9f6d9a8f3eb00f3eb76b35619687c89cb30e33c");
  assert.deepEqual(contract.workUnits["8B"].result.canonicalBatchCases, [50, 50]);
  assert.deepEqual(contract.workUnits["8B"].result.formatPairBatchCases, [44, 44, 42]);
  assert.equal(packageJson.scripts["test:phase-8b"],
    "node --test tests/compat/phase-8b-expanded-corpus.test.mjs");
  assert.match(packageJson.scripts["prepare:phase-8:local"], /prepare-expanded-corpus\.mjs/u);
  assert.match(packageJson.scripts["qualification:phase-8:chrome"], /run-expanded-chrome-baseline\.mjs/u);
  assert.match(packageJson.scripts.test, /test:phase-8b/u);
  assert.match(packageJson.scripts.verify, /test:phase-8b/u);
});
