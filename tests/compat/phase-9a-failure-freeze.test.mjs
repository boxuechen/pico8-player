import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PHASE_9_BASELINE_AGGREGATE_SHA256,
  Phase9FailureFreezeError,
  buildPhase9FailureFreeze,
  writePhase9FailureFreeze,
} from "../../tools/compat/phase-9-failure-freeze-v1.mjs";

const projectRoot = new URL("../../", import.meta.url).pathname;
const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const tracked = await readJson("../../spec/compat/phase-9-root-cause-contract-v1.json");
const schema = await readJson("../../spec/compat/phase-9-root-cause-contract-v1.schema.json");
const environment = {
  target: "chrome-production",
  playerCommit: "1234567890abcdef1234567890abcdef12345678",
  runtimeWasmSha256: "a".repeat(64),
  chromeVersion: "Chromium 151.0.0.0",
};

const failureTemplates = [
  {
    count: 19,
    cluster: "language",
    faultCode: "E_VM_RUNTIME",
    faultMessage: "E_VM_RUNTIME: project-owned fixture: attempt to compare number with boolean",
    signals: [14, 2, 3],
    maximumTick: 118,
  },
  {
    count: 3,
    cluster: "language",
    faultCode: "E_VM_RUNTIME",
    faultMessage: "E_VM_RUNTIME: project-owned fixture: bad argument #2 to 'poke' (number expected, got no value)",
    signals: [3, 0, 0],
    maximumTick: 0,
  },
  {
    count: 4,
    cluster: "language",
    faultCode: "E_VM_RUNTIME",
    faultMessage: "E_VM_RUNTIME: project-owned fixture: attempt to call global 'extcmd' (a nil value)",
    signals: [3, 1, 0],
    maximumTick: 2,
  },
  {
    count: 2,
    cluster: "language",
    faultCode: "E_HOST_API",
    faultMessage: "E_HOST_API: cartdata index must be between 0 and 63",
    signals: [2, 0, 0],
    maximumTick: 0,
  },
  {
    count: 3,
    cluster: "language",
    faultCode: "E_VM_RUNTIME",
    faultMessage: "E_VM_RUNTIME: project-owned fixture: bad argument #1 to 'cls' (number expected, got string)",
    signals: [3, 0, 0],
    maximumTick: 0,
  },
  {
    count: 4,
    cluster: "language",
    faultCode: "E_VM_RUNTIME",
    faultMessage: "E_VM_RUNTIME: project-owned fixture: attempt to call global 'flr' (a nil value)",
    signals: [3, 1, 0],
    maximumTick: 4,
  },
  {
    count: 2,
    cluster: "language",
    faultCode: "E_VM_SYNTAX",
    faultMessage: "E_VM_SYNTAX: project-owned fixture: 'then' expected near 'do'",
    signals: [2, 0, 0],
    maximumTick: 0,
  },
  {
    count: 2,
    cluster: "language",
    faultCode: "E_VM_OOM",
    faultMessage: "E_VM_OOM: not enough memory",
    signals: [0, 1, 1],
    minimumTick: 1,
    maximumTick: 3,
  },
  {
    count: 1,
    cluster: "language",
    faultCode: "E_VM_RUNTIME",
    faultMessage: "E_VM_RUNTIME: project-owned fixture: attempt to perform arithmetic on local 'value' (a nil value)",
    signals: [0, 1, 0],
    minimumTick: 1,
    maximumTick: 1,
  },
  {
    count: 1,
    cluster: "language",
    faultCode: "E_VM_SYNTAX",
    faultMessage: "E_VM_SYNTAX: project-owned fixture: unexpected symbol near ?",
    signals: [1, 0, 0],
    maximumTick: 0,
  },
  {
    count: 2,
    cluster: "language",
    faultCode: "E_VM_RUNTIME",
    faultMessage: "E_VM_RUNTIME: project-owned fixture: bad argument #1 to 'all' (table expected, got no value)",
    signals: [2, 0, 0],
    maximumTick: 0,
  },
  {
    count: 1,
    cluster: "language",
    faultCode: "E_INVARIANT",
    faultMessage: "E_INVARIANT: runtime boot threw: unreachable",
    signals: [1, 0, 0],
    maximumTick: 0,
  },
  {
    count: 1,
    cluster: "language",
    faultCode: "E_VM_RUNTIME",
    faultMessage: "E_VM_RUNTIME: project-owned fixture: bad argument #1 to 'rnd' (number expected, got string)",
    signals: [1, 0, 0],
    maximumTick: 0,
  },
  {
    count: 5,
    cluster: "timing",
    faultCode: "E_VM_INSTRUCTION_BUDGET",
    faultMessage: "E_VM_INSTRUCTION_BUDGET: instruction budget exceeded",
    signals: [4, 1, 0],
    maximumTick: 3,
  },
  {
    count: 1,
    cluster: "unsupported-host-feature",
    faultCode: "E_HOST_REQUEST",
    faultMessage: "E_HOST_REQUEST: project-owned fixture: external cart-data request failed",
    signals: [1, 0, 0],
    maximumTick: 0,
  },
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function makeFailures() {
  const entries = [];
  for (const template of failureTemplates) {
    const signalNames = ["pre", "black", "visible"];
    let ordinal = 0;
    for (const [signalIndex, count] of template.signals.entries()) {
      for (let index = 0; index < count; index += 1) {
        const isLast = ordinal === template.count - 1;
        const completedTicks = isLast
          ? template.maximumTick
          : (template.minimumTick ?? 0);
        entries.push({
          completed: true,
          smokeOutcome: "fails",
          classification: "C0",
          failureCluster: template.cluster,
          completedTicks,
          faultCode: template.faultCode,
          faultMessage: template.faultMessage,
          frameCount: signalIndex === 0 ? 0 : 1,
          nonBlackPixels: signalIndex === 2 ? 16 : 0,
          distinctColors: signalIndex === 2 ? 2 : 1,
          screenshotCaptured: true,
          _fixtureSignal: signalNames[signalIndex],
        });
        ordinal += 1;
      }
    }
    assert.equal(ordinal, template.count);
  }
  return entries;
}

async function makeExternalInputs(root) {
  const failures = makeFailures();
  const boots = Array.from({ length: 149 }, () => ({
    completed: true,
    smokeOutcome: "boots",
    classification: "CU",
    failureCluster: null,
    completedTicks: 120,
    frameCount: 120,
    nonBlackPixels: 32,
    distinctColors: 3,
    screenshotCaptured: true,
  }));
  const entries = [...failures, ...boots].map((entry, index) => {
    const { _fixtureSignal, ...clean } = entry;
    return {
      id: `project-phase9/case-${String(index + 1).padStart(3, "0")}`,
      ...clean,
      screenSha256: String((index % 15) + 1).repeat(64).slice(0, 64),
    };
  });
  assert.equal(entries.length, 200);
  const observationPaths = [];
  for (let batch = 0; batch < 4; batch += 1) {
    const path = join(root, `observations-${batch + 1}.json`);
    await writeFile(path, `${JSON.stringify({
      schemaVersion: 1,
      environment,
      entries: entries.slice(batch * 50, (batch + 1) * 50),
    }, null, 2)}\n`);
    observationPaths.push(path);
  }
  const aggregate = {
    schemaVersion: 1,
    runner: "phase-8f-supplemental-top200-smoke-v1",
    targetRuntime: "PICO-8 v0.2.7",
    corpusFingerprint: "e".repeat(64),
    sourceSnapshot: "project-owned-sensitive-source-sentinel",
    formalPhase8DenominatorChanged: false,
    environment,
    summary: {
      caseCount: 200,
      completedCaseCount: 200,
      smokeOutcomes: { boots: 149, fails: 51, notRun: 0 },
      counts: { C0: 51, C1: 0, C2: 0, C3: 0, CU: 149 },
      failureClusters: {
        parse: 0,
        language: 45,
        ram: 0,
        graphics: 0,
        audio: 0,
        input: 0,
        timing: 5,
        persistence: 0,
        "unsupported-host-feature": 1,
      },
      framebuffer: { withFrame: 157, nonBlack: 153, blackOnly: 47 },
      screenshots: { captured: 200, missing: 0 },
      resources: { completedBatchRuns: 4, infrastructureFailures: 0 },
    },
  };
  const aggregateBytes = Buffer.from(`${JSON.stringify(aggregate, null, 2)}\n`);
  const aggregatePath = join(root, "aggregate.json");
  await writeFile(aggregatePath, aggregateBytes);
  return {
    aggregatePath,
    aggregateSha256: sha256(aggregateBytes),
    observationPaths,
    entries,
    aggregate,
  };
}

async function withFixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "p8w-phase9a-"));
  try {
    return await fn({ root, ...await makeExternalInputs(root) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("Phase 9A freezes all 51 failures into the tracked 15-candidate contract", async () => {
  await withFixture(async ({ aggregatePath, aggregateSha256, observationPaths }) => {
    const report = await buildPhase9FailureFreeze({
      aggregatePath,
      observationsPaths: observationPaths,
      expectedAggregateSha256: aggregateSha256,
    });
    const normalized = { ...report, sourceAggregateSha256: PHASE_9_BASELINE_AGGREGATE_SHA256 };
    assert.deepEqual(normalized, tracked);
    assert.equal(report.summary.candidateCases, 51);
    assert.equal(report.summary.unclassifiedCases, 0);
    assert.deepEqual(report.summary.clusters,
      { language: 45, timing: 5, "unsupported-host-feature": 1 });
    assert.equal(report.candidates.reduce((sum, entry) => sum + entry.cases, 0), 51);
    assert.ok(report.candidates.every((entry) => entry.evidenceGap.length > 0));
    assert.ok(report.candidates.every((entry) => entry.reproducerPlan.fixture
      .startsWith("tests/fixtures/phase-9/")));
  });
});

test("Phase 9A grouping is order-independent and redacts every per-case signal", async () => {
  await withFixture(async ({
    root,
    aggregatePath,
    aggregateSha256,
    observationPaths,
    entries,
    aggregate,
  }) => {
    const first = await buildPhase9FailureFreeze({
      aggregatePath,
      observationsPaths: observationPaths,
      expectedAggregateSha256: aggregateSha256,
    });
    const reversedPaths = [];
    for (let batch = 0; batch < 4; batch += 1) {
      const path = join(root, `reversed-${batch + 1}.json`);
      const slice = entries.slice(batch * 50, (batch + 1) * 50).reverse();
      await writeFile(path, `${JSON.stringify({ schemaVersion: 1, environment, entries: slice })}\n`);
      reversedPaths.push(path);
    }
    const second = await buildPhase9FailureFreeze({
      aggregatePath,
      observationsPaths: reversedPaths.reverse(),
      expectedAggregateSha256: aggregateSha256,
    });
    assert.deepEqual(second, first);
    const serialized = JSON.stringify(first);
    for (const entry of entries) {
      assert.equal(serialized.includes(entry.id), false);
      assert.equal(serialized.includes(entry.screenSha256), false);
      if (entry.faultMessage) assert.equal(serialized.includes(entry.faultMessage), false);
    }
    assert.equal(serialized.includes(aggregate.corpusFingerprint), false);
    assert.equal(serialized.includes(aggregate.sourceSnapshot), false);
    assert.doesNotMatch(serialized, /cart\.p8|screenshotCaptured/u);
    assert.equal(first.privacy.faultMessagesTracked, false);
    assert.equal(first.privacy.screenshotsTracked, false);
  });
});

test("Phase 9A fails closed on hash, coverage, environment and unclassified drift", async () => {
  await withFixture(async ({
    root,
    aggregatePath,
    aggregateSha256,
    observationPaths,
    entries,
  }) => {
    await assert.rejects(
      buildPhase9FailureFreeze({ aggregatePath, observationsPaths: observationPaths }),
      { code: "E_AGGREGATE_HASH" },
    );

    const duplicatePath = join(root, "duplicate.json");
    await writeFile(duplicatePath, `${JSON.stringify({
      schemaVersion: 1,
      environment,
      entries: entries.slice(0, 50),
    })}\n`);
    await assert.rejects(
      buildPhase9FailureFreeze({
        aggregatePath,
        observationsPaths: [duplicatePath, duplicatePath, observationPaths[2], observationPaths[3]],
        expectedAggregateSha256: aggregateSha256,
      }),
      { code: "E_OBSERVATION_COVERAGE" },
    );

    const drift = JSON.parse(await readFile(observationPaths[0], "utf8"));
    drift.environment.chromeVersion = "Chromium 152.0.0.0";
    const driftPath = join(root, "environment-drift.json");
    await writeFile(driftPath, `${JSON.stringify(drift)}\n`);
    await assert.rejects(
      buildPhase9FailureFreeze({
        aggregatePath,
        observationsPaths: [driftPath, ...observationPaths.slice(1)],
        expectedAggregateSha256: aggregateSha256,
      }),
      { code: "E_ENVIRONMENT_DRIFT" },
    );

    const unknown = JSON.parse(await readFile(observationPaths[0], "utf8"));
    unknown.entries[0].faultMessage = "E_VM_RUNTIME: project-owned unknown diagnostic";
    const unknownPath = join(root, "unknown.json");
    await writeFile(unknownPath, `${JSON.stringify(unknown)}\n`);
    await assert.rejects(
      buildPhase9FailureFreeze({
        aggregatePath,
        observationsPaths: [unknownPath, ...observationPaths.slice(1)],
        expectedAggregateSha256: aggregateSha256,
      }),
      { code: "E_EVIDENCE_GAP" },
    );
  });
});

test("Phase 9A rejects repository/ref inputs, symlinks and tracked output paths", async () => {
  await withFixture(async ({
    root,
    aggregatePath,
    aggregateSha256,
    observationPaths,
  }) => {
    const repositoryInput = new URL(
      "../../spec/compat/phase-9-root-cause-contract-v1.json",
      import.meta.url,
    ).pathname;
    await assert.rejects(
      buildPhase9FailureFreeze({
        aggregatePath: repositoryInput,
        observationsPaths: observationPaths,
        expectedAggregateSha256: aggregateSha256,
      }),
      { code: "E_PATH_REPOSITORY" },
    );

    const link = join(root, "aggregate-link.json");
    await symlink(aggregatePath, link);
    await assert.rejects(
      buildPhase9FailureFreeze({
        aggregatePath: link,
        observationsPaths: observationPaths,
        expectedAggregateSha256: aggregateSha256,
      }),
      { code: "E_PATH_SYMLINK" },
    );

    await assert.rejects(
      writePhase9FailureFreeze({ outputPath: repositoryInput, report: tracked }),
      { code: "E_PATH_REPOSITORY" },
    );
    const externalOutput = join(root, "generated-contract.json");
    assert.equal(await writePhase9FailureFreeze({ outputPath: externalOutput, report: tracked }),
      externalOutput);
    await assert.rejects(
      writePhase9FailureFreeze({ outputPath: externalOutput, report: tracked }),
      { code: "E_OUTPUT_WRITE" },
    );
  });
});

test("Phase 9A schema locks exact aggregate, coverage, redaction and candidate shape", () => {
  assert.equal(schema.properties.sourceAggregateSha256.const,
    PHASE_9_BASELINE_AGGREGATE_SHA256);
  assert.equal(schema.properties.summary.properties.failureCases.const, 51);
  assert.equal(schema.properties.summary.properties.unclassifiedCases.const, 0);
  assert.equal(schema.properties.summary.properties.rootCauseCandidates.const, 15);
  assert.equal(schema.properties.candidates.minItems, 15);
  assert.equal(schema.properties.candidates.maxItems, 15);
  assert.equal(schema.$defs.candidate.additionalProperties, false);
  assert.deepEqual(schema.$defs.candidate.properties.ownerPhase.enum, ["9B", "9C", "9D"]);
  assert.equal(tracked.privacy.refInputAllowed, false);
  assert.equal(tracked.privacy.faultMessagesTracked, false);
  assert.equal(new Set(tracked.candidates.map(({ id }) => id)).size, 15);
});

test("Phase 9A error type exposes stable machine-readable codes", () => {
  const error = new Phase9FailureFreezeError("E_FIXTURE", "project-owned failure");
  assert.equal(error.code, "E_FIXTURE");
  assert.match(error.message, /^E_FIXTURE:/u);
});
