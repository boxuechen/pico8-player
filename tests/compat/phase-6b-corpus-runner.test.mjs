import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  assertSafeLocalOutputPath,
  buildLocalQualificationReport,
  loadLocalCorpusManifest,
  QualificationInputError,
  writeLocalQualificationReport,
} from "../../tools/compat/local-qualification-v1.mjs";

const projectRoot = resolve(new URL("../../", import.meta.url).pathname);
const fixturePath = new URL("fixtures/minimal-project-cart.p8", import.meta.url);
const cartBytes = await readFile(fixturePath);
const cartSha256 = createHash("sha256").update(cartBytes).digest("hex");
const runtimeWasmSha256 = "1".repeat(64);

async function temporaryCorpus({ cases = 12, mutateManifest, mutateObservations } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "p8w-phase6b-"));
  const cartPath = join(directory, "fixture.p8");
  const manifestPath = join(directory, "manifest.json");
  const observationsPath = join(directory, "observations.json");
  await writeFile(cartPath, cartBytes);
  const entries = Array.from({ length: cases }, (_, index) => ({
    id: `cart/${String(index + 1).padStart(2, "0")}`,
    label: `Project fixture ${index + 1}`,
    file: "fixture.p8",
    sha256: cartSha256,
    pico8Version: "0.2.7",
    source: {
      label: "pico8-web-player project fixture",
      revision: "phase-6b-v1",
      permissionStatus: "author-provided",
      permissionBasis: "Project-authored test fixture",
      url: "https://example.invalid/not-fetched",
    },
    trace: {
      mode: "fixed-ticks",
      ticks: 120,
      stepMilliseconds: 1000 / 60,
      inputs: [],
    },
  }));
  const manifest = {
    schemaVersion: 1,
    corpusId: "phase-6b/project-fixtures",
    policy: "developer-supplied-local-only",
    entries,
  };
  mutateManifest?.(manifest);
  const observations = {
    schemaVersion: 1,
    environment: {
      target: "chrome-production",
      playerCommit: "28ece16",
      runtimeWasmSha256,
      chromeVersion: "Google Chrome 150.0.0.0",
    },
    entries: manifest.entries.map((entry) => ({
      id: entry.id,
      completed: true,
      smokeOutcome: "boots",
      classification: "C2",
      failureCluster: null,
      completedTicks: 120,
      playability: {
        gate: "critical-flow",
        durationSeconds: 30,
        criticalFlow: "complete project-authored fixture flow",
        criticalFlowCompleted: true,
        mainVerbs: ["advance"],
        input: "pass",
        visual: "pass",
        audio: "not-applicable",
        persistence: "not-applicable",
        crashFree: true,
        softLockFree: true,
        reviewedAt: "2026-08-07T00:00:00Z",
        reviewer: "project-test",
        evidenceSha256: "2".repeat(64),
      },
    })),
  };
  mutateObservations?.(observations);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(observationsPath, `${JSON.stringify(observations, null, 2)}\n`);
  return { directory, manifestPath, observationsPath };
}

async function withCorpus(options, callback) {
  const corpus = await temporaryCorpus(options);
  try {
    return await callback(corpus);
  } finally {
    await rm(corpus.directory, { recursive: true, force: true });
  }
}

test("6B validates hashes and emits a deterministic path-redacted qualification report", async () => {
  await withCorpus({}, async ({ directory, manifestPath, observationsPath }) => {
    const report = await buildLocalQualificationReport({
      manifestPath,
      observationsPath,
      projectRoot,
    });
    const second = await buildLocalQualificationReport({
      manifestPath,
      observationsPath,
      projectRoot,
    });
    assert.deepEqual(report, second);
    assert.equal(report.runner, "phase-6-local-qualification-v1");
    assert.equal(report.corpus.caseCount, 12);
    assert.deepEqual(report.summary.counts, { C0: 0, C1: 0, C2: 12, C3: 0, CU: 0 });
    assert.equal(report.summary.qualificationComplete, true);
    assert.deepEqual(report.entries.map(({ id }) => id), [...report.entries.map(({ id }) => id)].sort());
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes(directory), false);
    assert.equal(serialized.includes("fixture.p8"), false);
    assert.equal(serialized.includes("example.invalid"), false);
    assert.ok(report.entries.every(({ cartSha256: hash }) => hash === cartSha256));
    assert.ok(report.entries.every(({ sourceRevision }) => sourceRevision === "phase-6b-v1"));
  });
});

test("6B fails closed on corpus count, duplicate IDs and cart hash mismatch", async () => {
  await withCorpus({ cases: 11 }, async ({ manifestPath }) => {
    await assert.rejects(
      loadLocalCorpusManifest({ manifestPath, projectRoot }),
      (error) => error instanceof QualificationInputError && error.code === "E_CASE_COUNT",
    );
  });
  await withCorpus({ mutateManifest(manifest) { manifest.entries[1].id = manifest.entries[0].id; } }, async ({ manifestPath }) => {
    await assert.rejects(
      loadLocalCorpusManifest({ manifestPath, projectRoot }),
      (error) => error.code === "E_DUPLICATE_ID",
    );
  });
  await withCorpus({ mutateManifest(manifest) { manifest.entries[0].sha256 = "0".repeat(64); } }, async ({ manifestPath }) => {
    await assert.rejects(
      loadLocalCorpusManifest({ manifestPath, projectRoot }),
      (error) => error.code === "E_CART_HASH",
    );
  });
});

test("6B keeps incomplete cases CU and rejects contradictory classifications", async () => {
  await withCorpus({
    mutateObservations(observations) {
      observations.entries.pop();
      observations.entries[0] = {
        ...observations.entries[0],
        smokeOutcome: "fails",
        classification: "C0",
        failureCluster: "timing",
        faultCode: "E_VM_INSTRUCTION_BUDGET",
      };
      delete observations.entries[0].playability;
      observations.entries[1] = {
        ...observations.entries[1],
        classification: "CU",
      };
      delete observations.entries[1].playability;
    },
  }, async ({ manifestPath, observationsPath }) => {
    const report = await buildLocalQualificationReport({ manifestPath, observationsPath, projectRoot });
    assert.equal(report.summary.qualificationComplete, false);
    assert.equal(report.summary.incompleteCaseCount, 1);
    assert.equal(report.summary.counts.C0, 1);
    assert.equal(report.summary.counts.CU, 2);
    assert.equal(report.summary.failureClusters.timing, 1);
    assert.equal(report.entries.find(({ id }) => id === "cart/02").smokeOutcome, "boots");
  });
  await withCorpus({
    mutateObservations(observations) {
      observations.entries[0].completed = false;
    },
  }, async ({ manifestPath, observationsPath }) => {
    await assert.rejects(
      buildLocalQualificationReport({ manifestPath, observationsPath, projectRoot }),
      (error) => error.code === "E_INCOMPLETE",
    );
  });
  await withCorpus({
    mutateObservations(observations) {
      delete observations.entries[0].playability;
    },
  }, async ({ manifestPath, observationsPath }) => {
    await assert.rejects(
      buildLocalQualificationReport({ manifestPath, observationsPath, projectRoot }),
      (error) => error.code === "E_PLAYABILITY",
    );
  });
  await withCorpus({
    mutateObservations(observations) {
      observations.entries[0].playability = {
        ...observations.entries[0].playability,
        gate: "duration",
        durationSeconds: 899,
      };
    },
  }, async ({ manifestPath, observationsPath }) => {
    await assert.rejects(
      buildLocalQualificationReport({ manifestPath, observationsPath, projectRoot }),
      (error) => error.code === "E_PLAYABILITY",
    );
  });
});

test("6B machine contracts and implementation expose no network client", async () => {
  const [manifestSchema, observationsSchema, reportSchema, implementation] = await Promise.all([
    readFile(new URL("../../spec/compat/local-corpus-v1.schema.json", import.meta.url), "utf8"),
    readFile(new URL("../../spec/compat/local-observations-v1.schema.json", import.meta.url), "utf8"),
    readFile(new URL("../../spec/compat/local-qualification-report-v1.schema.json", import.meta.url), "utf8"),
    readFile(new URL("../../tools/compat/local-qualification-v1.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(JSON.parse(manifestSchema).$id, /local-corpus-v1/u);
  assert.match(JSON.parse(observationsSchema).$id, /local-observations-v1/u);
  assert.equal(
    JSON.parse(reportSchema).properties.runner.const,
    "phase-6-local-qualification-v1",
  );
  assert.doesNotMatch(implementation, /\bfetch\s*\(/u);
  assert.doesNotMatch(implementation, /node:https|node:http/u);
});

test("6B rejects ref/tracked paths and writes only to an approved local output", async () => {
  const refPath = resolve(projectRoot, "ref/phase-6b-do-not-read.json");
  await assert.rejects(
    loadLocalCorpusManifest({ manifestPath: refPath, projectRoot }),
    (error) => error.code === "E_PATH_REF",
  );
  assert.throws(
    () => assertSafeLocalOutputPath(resolve(projectRoot, "docs/report.json"), projectRoot),
    (error) => error.code === "E_OUTPUT_PATH",
  );
  await withCorpus({}, async ({ directory, manifestPath, observationsPath }) => {
    const report = await buildLocalQualificationReport({ manifestPath, observationsPath, projectRoot });
    const outputPath = join(directory, "report.json");
    await writeLocalQualificationReport({ outputPath, projectRoot, report });
    assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), report);
    await assert.rejects(
      writeLocalQualificationReport({ outputPath, projectRoot, report }),
      (error) => error.code === "EEXIST",
    );
  });
});
