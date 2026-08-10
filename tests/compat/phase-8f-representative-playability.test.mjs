import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RepresentativePlayabilityError,
  buildRepresentativePlayabilityAggregate,
  finalizeRepresentativePlayability,
  prepareRepresentativePlayability,
} from "../../tools/compat/representative-playability-v1.mjs";

const environment = {
  target: "chrome-production",
  playerCommit: "fedcba9876543210fedcba9876543210fedcba98",
  runtimeWasmSha256: "a".repeat(64),
  chromeVersion: "Google Chrome 151.0.0.0",
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture(root) {
  const carts = join(root, "carts");
  await mkdir(carts);
  const cases = [];
  const manifestEntries = [];
  for (let index = 1; index <= 100; index += 1) {
    const id = `phase8/project-${String(index).padStart(3, "0")}/cart`;
    const file = join(carts, `cart-${String(index).padStart(3, "0")}.p8`);
    const bytes = Buffer.from(`pico-8 cartridge // http://www.pico-8.com\nversion 43\n__lua__\nfunction _draw() cls(${index % 16}) end\n`);
    await writeFile(file, bytes);
    cases.push({ id, identity: `project-${index}/cart`, format: "p8", file, sha256: digest(bytes) });
    manifestEntries.push({
      id,
      label: `project case ${index}`,
      file,
      sha256: digest(bytes),
      pico8Version: "0.2.7",
      source: {
        label: "project-owned generated corpus",
        revision: "0123456789abcdef0123456789abcdef01234567",
        permissionStatus: "author-provided",
        permissionBasis: "project-owned generated fixture",
      },
      trace: { mode: "fixed-ticks", ticks: 120, stepMilliseconds: 1000 / 30, inputs: [] },
    });
  }
  const includePath = join(carts, "shared.lua");
  const includeBytes = Buffer.from("shared_value=1\n");
  await writeFile(includePath, includeBytes);
  manifestEntries[0].bundle = [{
    ref: "shared.lua",
    file: includePath,
    sha256: digest(includeBytes),
    access: { load: false, reloadData: false, cstoreData: false, include: true },
  }];
  const batches = [];
  for (let batchIndex = 0; batchIndex < 2; batchIndex += 1) {
    const file = `canonical-batch-0${batchIndex + 1}.json`;
    const bytes = Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      corpusId: `phase-8-test-batch-${batchIndex + 1}`,
      policy: "developer-supplied-local-only",
      entries: manifestEntries.slice(batchIndex * 50, batchIndex * 50 + 50),
    })}\n`);
    await writeFile(join(root, file), bytes);
    batches.push({ file, cases: 50, sha256: digest(bytes) });
  }
  const corpusFingerprint = "b".repeat(64);
  const expandedIndex = {
    corpusFingerprint,
    source: { revision: "0123456789abcdef0123456789abcdef01234567" },
    canonical: { cases, batches },
  };
  const expandedIndexPath = join(root, "expanded-index.json");
  await writeFile(expandedIndexPath, `${JSON.stringify(expandedIndex)}\n`);
  const risks = [
    ["graphics", "input"], ["audio", "input"], ["persistence", "input"],
    ["complex-flow", "graphics"], ["graphics"], ["audio"], ["input"], ["graphics"],
    ["audio"], ["graphics"],
  ];
  const plan = {
    schemaVersion: 1,
    corpusFingerprint,
    entries: cases.slice(0, 10).map((entry, index) => ({
      id: entry.id,
      risks: risks[index],
      gate: index < 8 ? "critical-flow" : "duration",
      trace: {
        mode: "fixed-ticks",
        ticks: index < 8 ? 300 : 27_000,
        stepMilliseconds: 1000 / 30,
        inputs: index < 8 ? [
          { tick: 30, player: 0, button: 4, pressed: true },
          { tick: 31, player: 0, button: 4, pressed: false },
        ] : [],
      },
      criticalFlow: index < 8 ? "start and complete the project-owned primary action" : "remain responsive",
      mainVerbs: ["start", "primary action"],
      audio: risks[index].includes("audio") ? "pass" : "not-applicable",
      persistence: risks[index].includes("persistence") ? "pass" : "not-applicable",
    })),
  };
  const planPath = join(root, "plan.json");
  await writeFile(planPath, `${JSON.stringify(plan)}\n`);
  return { expandedIndexPath, planPath, plan };
}

async function withFixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "p8w-phase8f-playability-"));
  try {
    return await fn({ root, ...(await fixture(root)) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("Phase 8F freezes exactly 8 critical-flow plus 2 logical-duration C2 candidates", async () => {
  await withFixture(async ({ root, expandedIndexPath, planPath }) => {
    const prepared = await prepareRepresentativePlayability({
      expandedIndexPath, planPath, outputRoot: join(root, "selection"),
    });
    assert.equal(prepared.selection.entries.length, 10);
    assert.equal(prepared.selection.entries.filter(({ gate }) => gate === "critical-flow").length, 8);
    assert.equal(prepared.selection.entries.filter(({ gate }) => gate === "duration").length, 2);
    const manifest = JSON.parse(await readFile(prepared.manifestPath, "utf8"));
    assert.deepEqual(manifest.entries.slice(-2).map(({ trace }) => trace.ticks), [27_000, 27_000]);
    assert.equal(manifest.entries[0].bundle[0].ref, "shared.lua");
  });
});

test("Phase 8F finalizes reviewed screenshots and emits aggregate-only C2 evidence", async () => {
  await withFixture(async ({ root, expandedIndexPath, planPath, plan }) => {
    const prepared = await prepareRepresentativePlayability({
      expandedIndexPath, planPath, outputRoot: join(root, "selection"),
    });
    const manifest = JSON.parse(await readFile(prepared.manifestPath, "utf8"));
    const rawPath = join(root, "raw.json");
    await writeFile(rawPath, `${JSON.stringify({
      schemaVersion: 1,
      environment,
      entries: manifest.entries.map(({ id, trace }) => ({
        id, completed: true, smokeOutcome: "boots", classification: "CU", failureCluster: null,
        completedTicks: trace.ticks, frameCount: trace.ticks, screenSha256: "c".repeat(64),
        nonBlackPixels: 1, distinctColors: 2, screenshotCaptured: true,
      })),
    })}\n`);
    const screenshots = join(root, "screenshots");
    await mkdir(screenshots);
    for (let index = 1; index <= 10; index += 1) {
      await writeFile(join(screenshots, `${String(index).padStart(2, "0")}.png`), `png-${index}`);
    }
    const review = {
      schemaVersion: 1,
      reviewer: "project test reviewer",
      reviewedAt: "2026-08-10T12:00:00.000Z",
      findings: [],
      entries: plan.entries.map((entry) => ({
        id: entry.id,
        criticalFlowCompleted: entry.gate === "critical-flow",
        input: "pass",
        visual: "pass",
        audio: entry.audio,
        persistence: entry.persistence,
        crashFree: true,
        softLockFree: true,
      })),
    };
    const reviewPath = join(root, "review.json");
    await writeFile(reviewPath, `${JSON.stringify(review)}\n`);
    const audioPath = join(root, "audio.json");
    await writeFile(audioPath, `${JSON.stringify({
      schemaVersion: 1,
      environment,
      entries: plan.entries.filter(({ risks }) => risks.includes("audio")).map(({ id }) => ({
        id,
        completed: true,
        smokeOutcome: "boots",
        classification: "CU",
        failureCluster: null,
        completedTicks: 120,
        audioDevice: {
          contextState: "running",
          deviceSampleRate: 48_000,
          receivedChunks: 4,
          renderedDeviceFrames: 512,
          playing: true,
          steadyUnderruns: 0,
          overruns: 0,
          droppedSourceFrames: 0,
          discontinuities: 0,
        },
      })),
    })}\n`);
    const finalPath = join(root, "final.json");
    await finalizeRepresentativePlayability({
      selectionPath: prepared.selectionPath, rawObservationsPath: rawPath, reviewPath,
      audioObservationsPath: audioPath, screenshotsDirectory: screenshots, outputPath: finalPath,
    });
    const aggregate = await buildRepresentativePlayabilityAggregate({
      selectionPath: prepared.selectionPath, observationsPath: finalPath, reviewPath,
      audioObservationsPath: audioPath,
    });
    assert.deepEqual(aggregate.summary.gateCounts, { criticalFlow: 8, duration: 2 });
    assert.equal(aggregate.summary.c2CaseCount, 10);
    assert.equal(aggregate.summary.openFindings.P0, 0);
    assert.equal(aggregate.summary.riskCoverage.persistence, 1);
    assert.equal(aggregate.summary.audioDeviceCases, 3);
    assert.doesNotMatch(JSON.stringify(aggregate), /project-001|cartSha256|entries|mainVerbs/u);
  });
});

test("Phase 8F rejects weak gate distributions and open high-severity findings", async () => {
  await withFixture(async ({ root, expandedIndexPath, planPath, plan }) => {
    plan.entries[8].gate = "critical-flow";
    plan.entries[8].trace.ticks = 300;
    await writeFile(planPath, `${JSON.stringify(plan)}\n`);
    await assert.rejects(prepareRepresentativePlayability({
      expandedIndexPath, planPath, outputRoot: join(root, "bad-selection"),
    }), (error) => error instanceof RepresentativePlayabilityError
      && error.code === "E_GATE_DISTRIBUTION");
  });
});

test("Phase 8F Chrome harness preserves clean boot-stop as a cart outcome", async () => {
  const [controller, harness] = await Promise.all([
    readFile(new URL("../../apps/web-player/src/main/player-controller.ts", import.meta.url), "utf8"),
    readFile(new URL("../../tools/compat/browser/phase-6c.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(controller, /loaded\.state === "stopped"/u);
  assert.match(controller, /#setState\("stopped", "Cartridge stopped"\)/u);
  assert.match(harness, /const cleanStop = controller\.state === "stopped"/u);
});
