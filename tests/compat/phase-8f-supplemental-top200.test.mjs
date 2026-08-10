import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SupplementalTop200Error,
  buildSupplementalTop200Aggregate,
  prepareSupplementalTop200,
} from "../../tools/compat/supplemental-top200-v1.mjs";

const projectRoot = new URL("../../", import.meta.url).pathname;
const environment = {
  target: "chrome-production",
  playerCommit: "fedcba9876543210fedcba9876543210fedcba98",
  runtimeWasmSha256: "a".repeat(64),
  chromeVersion: "Google Chrome 151.0.0.0",
};

async function sha256(bytes) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(bytes).digest("hex");
}

async function makeSource(root) {
  const sourceRoot = join(root, "source");
  await mkdir(join(sourceRoot, "carts"), { recursive: true });
  const entries = [];
  for (let rank = 1; rank <= 200; rank += 1) {
    const file = `carts/${String(rank).padStart(3, "0")}-fixture.p8.png`;
    const bytes = Buffer.from(`project-owned-p8png-fixture-${rank}`);
    await writeFile(join(sourceRoot, file), bytes);
    entries.push({
      rank,
      title: `fixture ${rank}`,
      developer: "project",
      rating: 201 - rank,
      pagePid: String(rank),
      bbsUrl: `https://example.invalid/bbs/${rank}`,
      status: "downloaded",
      cartUrl: `https://example.invalid/carts/${rank}`,
      file,
      byteLength: bytes.length,
      sha256: await sha256(bytes),
    });
  }
  const inventory = {
    schemaVersion: 1,
    source: {
      url: "https://example.invalid/top200",
      label: "project-owned generated Top 200 fixture",
      rankingWindow: "fixture",
      pageDataDate: "2026-01-01",
      fetchedAt: "2026-01-02T00:00:00.000Z",
      htmlSha256: "b".repeat(64),
    },
    policy: {
      localOnly: true,
      trackedInput: false,
      redistributionClaimed: false,
      downloadOrigin: "https://example.invalid/carts/",
    },
    counts: { ranked: 200, downloaded: 200, "no-public-p8png": 0, failed: 0 },
    entries,
  };
  await writeFile(join(sourceRoot, "inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`);
  return sourceRoot;
}

async function withFixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "p8w-phase8f-top200-"));
  try {
    const sourceRoot = await makeSource(root);
    return await fn({ root, sourceRoot });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("Phase 8F prepares an anonymous external 4x50 supplemental corpus", async () => {
  await withFixture(async ({ root, sourceRoot }) => {
    const first = await prepareSupplementalTop200({ sourceRoot, outputRoot: join(root, "output-a") });
    const second = await prepareSupplementalTop200({ sourceRoot, outputRoot: join(root, "output-b") });
    assert.equal(first.index.cases.length, 200);
    assert.deepEqual(first.index.batches.map(({ cases }) => cases), [50, 50, 50, 50]);
    assert.equal(first.index.corpusFingerprint, second.index.corpusFingerprint);
    assert.match(first.index.corpusFingerprint, /^[a-f0-9]{64}$/u);
    const manifest = JSON.parse(await readFile(join(first.outputRoot, "top200-batch-01.json"), "utf8"));
    assert.equal(manifest.entries.length, 50);
    assert.ok(manifest.entries.every((entry) => entry.trace.ticks === 120));
    assert.doesNotMatch(JSON.stringify(manifest), /fixture [0-9]|"developer"|"bbsUrl"|"cartUrl"/u);
  });
});

test("Phase 8F supplemental aggregate is complete and cannot publish per-cart detail", async () => {
  await withFixture(async ({ root, sourceRoot }) => {
    const prepared = await prepareSupplementalTop200({ sourceRoot, outputRoot: join(root, "output") });
    const observationsPaths = [];
    for (const [batchIndex, batch] of prepared.index.batches.entries()) {
      const manifest = JSON.parse(await readFile(join(prepared.outputRoot, batch.file), "utf8"));
      const observationsPath = join(root, `observations-${batchIndex + 1}.json`);
      await writeFile(observationsPath, `${JSON.stringify({
        schemaVersion: 1,
        environment,
        entries: manifest.entries.map(({ id }) => ({
          id,
          completed: true,
          smokeOutcome: "boots",
          classification: "CU",
          failureCluster: null,
          completedTicks: 120,
          frameCount: 120,
          screenSha256: "c".repeat(64),
          nonBlackPixels: 1,
          distinctColors: 2,
          screenshotCaptured: true,
        })),
      }, null, 2)}\n`);
      observationsPaths.push(observationsPath);
    }
    const aggregate = await buildSupplementalTop200Aggregate({
      indexPath: prepared.indexPath,
      observationsPaths,
    });
    assert.equal(aggregate.summary.caseCount, 200);
    assert.equal(aggregate.summary.smokeOutcomes.boots, 200);
    assert.equal(aggregate.formalPhase8DenominatorChanged, false);
    const serialized = JSON.stringify(aggregate);
    assert.doesNotMatch(serialized, /case-[0-9]|\.p8|cartSha256|screenSha256|entries/u);
  });
});

test("Phase 8F supplemental preparation rejects repository input and corpus drift", async () => {
  await assert.rejects(prepareSupplementalTop200({
    sourceRoot: projectRoot,
    outputRoot: join(tmpdir(), `never-${Date.now()}`),
  }), (error) => error instanceof SupplementalTop200Error && error.code === "E_PATH_REPOSITORY");
  await withFixture(async ({ root, sourceRoot }) => {
    const inventoryPath = join(sourceRoot, "inventory.json");
    const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
    inventory.entries.pop();
    await writeFile(inventoryPath, `${JSON.stringify(inventory)}\n`);
    await assert.rejects(prepareSupplementalTop200({
      sourceRoot,
      outputRoot: join(root, "bad-output"),
    }), (error) => error instanceof SupplementalTop200Error && error.code === "E_CASE_COUNT");
  });
});
