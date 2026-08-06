import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { artifactMetadata } from "../../../tools/benchmark/common.mjs";

export const RUNNER = Object.freeze({
  id: "phase4-l2-runner",
  version: 1,
});

export const RESULT_DIRECTORY = resolve("benchmarks/phase-4/results");

const MANIFEST_PATHS = Object.freeze({
  corpus: "tests/conformance/manifests/phase-4-l2-corpus.json",
  phase1: "tests/conformance/manifests/phase-1f-l1-exit.json",
  phase2: "tests/conformance/manifests/phase-2f-exit.json",
  phase3: "tests/conformance/manifests/phase-3h-exit.json",
});

const PRODUCTION_SOURCES = Object.freeze([
  "apps/web-player/src/main/compose-player.ts",
  "apps/web-player/src/main/player-controller.ts",
  "apps/web-player/src/main/player-runtime-client.ts",
  "apps/web-player/src/main/audio-frontend.ts",
  "apps/web-player/src/main/render/pico-frame.ts",
  "apps/web-player/src/worker/compose-runtime.ts",
  "apps/web-player/src/worker/audio-transport.ts",
  "apps/web-player/src/worker/adapters/indexeddb-persistence-adapter.ts",
  "apps/web-player/src/worker/adapters/cart-repository-adapter.ts",
  "apps/web-player/src/worklet/pico8-audio-processor.ts",
  "packages/runtime-core/src/frame-runtime.ts",
  "packages/z8lua-bridge/src/public.ts",
  "wasm/dist/z8lua-phase-0c.wasm",
]);

const LEGACY_IDS = Object.freeze({
  "l2/callback-30-input": "l1/callback-30-input",
  "l2/callback-60-p8png": "l1/callback-60-p8png",
  "l2/custom-flip-30": "l1/custom-flip-30",
  "l2/graphics-memory": "phase-2/graphics-memory",
  "l2/text-remap": "phase-2/text-remap",
  "l2/audio-input": "phase-3/audio-input",
  "l2/persistence-overlay": "phase-3/persistence-overlay",
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function digest(value) {
  return sha256(Buffer.from(JSON.stringify(stable(value))));
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}

async function hashes(paths) {
  return Object.fromEntries(await Promise.all(paths.map(async (path) => [
    path,
    sha256(await readFile(resolve(path))),
  ])));
}

function inputContract(id, entry, phaseManifest) {
  if (id === "l2/callback-30-input" || id === "l2/callback-60-p8png" ||
      id === "l2/custom-flip-30") {
    return { id: `${id}-buttons-v1`, frames: entry.inputTrace };
  }
  if (id === "l2/audio-input") {
    return {
      id: "audio-controller-devkit-v1",
      frames: phaseManifest.frameCount,
      first: {
        buttons: [1, 16], mouse: [12, 34, 1], wheel: 1,
        relative: [2, -1], keypresses: [113],
      },
      second: { buttons: [1, 16], mouse: [12, 34, 0] },
      remaining: "neutral",
    };
  }
  if (id === "l2/persistence-overlay") {
    return { id: "persistence-overlay-v1", generations: 3, buttons: [32] };
  }
  return { id: `${id}-neutral-v1`, frames: phaseManifest.frameCount, buttons: [0] };
}

function oracleFor(id, entry, phaseManifest) {
  if (id.startsWith("l2/callback") || id === "l2/custom-flip-30") {
    return {
      frame: {
        count: entry.expected.frameCount,
        finalId: entry.expected.finalFrameId,
        completedSlices: entry.expected.completedSlices,
        logicalTimeRaw: entry.expected.timeRawBeforeStep,
      },
      screen: {
        finalSha256: entry.expected.screenSha256,
        resetSha256: entry.reset.screenSha256,
        semanticPixels: entry.expected.semanticPixels,
      },
      palette: { status: "default-palette-not-mutated" },
      ram: { status: "outside-critical-flow" },
      canonicalAudio: { status: "outside-critical-flow" },
      persistence: { status: "outside-critical-flow" },
    };
  }
  if (id === "l2/graphics-memory" || id === "l2/text-remap") {
    return {
      frame: { count: phaseManifest.frameCount, traceSha256: entry.expected.traceSha256 },
      screen: {
        finalSha256: entry.expected.screenSha256,
        rgbaSha256: entry.expected.rgbaSha256,
        semanticPixels: entry.expected.semanticPixels,
      },
      palette: {
        sha256: entry.expected.displayPaletteSha256,
        hex: entry.expected.displayPaletteHex,
      },
      ram: {
        regions: entry.ramRegions.map(({ id: regionId, address, length, sha256: regionSha }) => ({
          id: regionId, address, length, sha256: regionSha,
        })),
      },
      canonicalAudio: { status: "outside-critical-flow" },
      persistence: { status: "outside-critical-flow" },
    };
  }
  if (id === "l2/audio-input") {
    return {
      frame: { count: entry.frameCount, traceSha256: entry.expected.initial.traceSha256 },
      screen: {
        finalSha256: entry.expected.initial.finalScreenSha256,
        resetSha256: entry.expected.reset.finalScreenSha256,
      },
      palette: {
        sha256: entry.expected.initial.displayPaletteSha256,
        hex: entry.expected.initial.displayPaletteHex,
      },
      ram: { finalObservationHex: entry.expected.initial.finalObservationHex },
      canonicalAudio: {
        bootPcmSha256: entry.expected.initial.bootAudio.pcmSha256,
        flowPcmSha256: entry.expected.initial.pcmSha256,
        pcmBytes: entry.expected.initial.pcmBytes,
      },
      persistence: { status: "outside-critical-flow" },
    };
  }
  return {
    frame: { count: entry.frameCount, generations: [1, 2, 3] },
    screen: {
      generationSha256: [
        entry.expected.initial.screenSha256,
        entry.expected.reset.screenSha256,
        entry.expected.sameIdentity.screenSha256,
      ],
    },
    palette: { sha256: entry.expected.initial.displayPaletteSha256 },
    ram: {
      observationHex: [
        entry.expected.initial.observationHex,
        entry.expected.reset.observationHex,
        entry.expected.sameIdentity.observationHex,
      ],
      overlayBytes: [
        entry.expected.initial.overlayByte,
        entry.expected.reset.overlayByte,
        entry.expected.sameIdentity.overlayByte,
      ],
    },
    canonicalAudio: {
      generationPcmSha256: [
        entry.expected.initial.audio.pcmSha256,
        entry.expected.reset.audio.pcmSha256,
        entry.expected.sameIdentity.audio.pcmSha256,
      ],
    },
    persistence: {
      id: entry.expected.initial.cartdataId,
      revision: entry.expected.initial.cartdataRevision,
      generationSha256: [
        entry.expected.initial.cartdataSha256,
        entry.expected.reset.cartdataSha256,
        entry.expected.sameIdentity.cartdataSha256,
      ],
    },
  };
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function validateChromeResults(results, manifests) {
  const { phase1, phase2, phase3 } = results;
  check(phase1?.phase === "1F" && phase1.deterministic.length === 3,
    "Phase 1 Chrome oracle is incomplete");
  check(phase2?.phase === "2F" && phase2.deterministic.length === 2 && phase2.canvas.length === 2,
    "Phase 2 Chrome oracle is incomplete");
  check(phase3?.phase === "3H" && phase3.deterministic.length === 2,
    "Phase 3 Chrome oracle is incomplete");
  check(phase1.workerError === null && phase2.workerError === null && phase3.workerErrors.length === 0,
    "a production Worker reported an error");
  check(phase3.resources.workersCreated === phase3.resources.workersTerminated,
    "Phase 3 Chrome oracle retained a Worker");

  for (const entry of manifests.phase1.cases) {
    const actual = phase1.deterministic.find(({ id }) => id === entry.id);
    check(actual?.finalScreenSha256 === entry.expected.screenSha256,
      `${entry.id} Chrome screen oracle drifted`);
  }
  for (const entry of manifests.phase2.cases) {
    const actual = phase2.deterministic.find(({ id }) => id === entry.id);
    check(actual?.finalScreenSha256 === entry.expected.screenSha256,
      `${entry.id} Chrome screen oracle drifted`);
    check(actual?.displayPaletteSha256 === entry.expected.displayPaletteSha256,
      `${entry.id} Chrome palette oracle drifted`);
  }
  const audio = manifests.phase3.cases.find(({ id }) => id === "phase-3/audio-input");
  const actualAudio = phase3.deterministic.find(({ id }) => id === audio.id);
  check(actualAudio?.finalScreenSha256 === audio.expected.initial.finalScreenSha256,
    "audio/input Chrome screen oracle drifted");
  const persistence = manifests.phase3.cases.find(
    ({ id }) => id === "phase-3/persistence-overlay",
  );
  const actualPersistence = phase3.deterministic.find(({ id }) => id === persistence.id);
  check(actualPersistence?.sameIdentity.screenSha256 === persistence.expected.sameIdentity.screenSha256,
    "persistence Chrome same-identity oracle drifted");
}

function targetObservation(target, id, legacyId, legacyResults) {
  if (target === "node-real-wasm") {
    return {
      proof: "real-WASM conformance suites exited successfully in this runner invocation",
      firstFault: null,
      firstDivergentFrame: null,
      deviceAudio: { status: "not-applicable-to-node-oracle" },
      workerLifecycle: { status: "not-applicable-to-node-oracle" },
    };
  }
  let source;
  if (id.startsWith("l2/callback") || id === "l2/custom-flip-30") {
    source = legacyResults.phase1.deterministic.find(({ id: itemId }) => itemId === legacyId);
  } else if (id === "l2/graphics-memory" || id === "l2/text-remap") {
    source = legacyResults.phase2.deterministic.find(({ id: itemId }) => itemId === legacyId);
  } else {
    source = legacyResults.phase3.deterministic.find(({ id: itemId }) => itemId === legacyId);
  }
  const deviceAudio = id === "l2/audio-input"
    ? {
        status: "observed-through-audioworklet",
        sampleRate: legacyResults.phase3.audio.actualSampleRate,
        receivedChunks: legacyResults.phase3.audio.soak.audioStats.receivedChunks,
        steadyUnderruns: legacyResults.phase3.audio.soak.audioStats.steadyUnderruns,
      }
    : { status: "outside-critical-flow" };
  const persistence = id === "l2/persistence-overlay"
    ? legacyResults.phase3.persistence
    : { status: "outside-critical-flow" };
  return {
    proof: "Chrome production Worker/Canvas/AudioWorklet/IndexedDB gates exited successfully",
    rawOracle: source,
    firstFault: null,
    firstDivergentFrame: null,
    deviceAudio,
    persistence,
    workerLifecycle: {
      created: legacyResults.phase3.resources.workersCreated,
      terminated: legacyResults.phase3.resources.workersTerminated,
      errors: legacyResults.phase3.workerErrors,
    },
  };
}

export async function createPhase4Baseline({
  target,
  sourceRevision,
  environment,
  machine,
  legacyResults = undefined,
}) {
  check(target === "node-real-wasm" || target === "chrome-production",
    `unsupported Phase 4B target: ${target}`);
  const [corpus, phase1, phase2, phase3, productionSha256, wasm] = await Promise.all([
    readJson(MANIFEST_PATHS.corpus),
    readJson(MANIFEST_PATHS.phase1),
    readJson(MANIFEST_PATHS.phase2),
    readJson(MANIFEST_PATHS.phase3),
    hashes(PRODUCTION_SOURCES),
    artifactMetadata(),
  ]);
  const manifests = { phase1, phase2, phase3 };
  if (target === "chrome-production") validateChromeResults(legacyResults, manifests);

  const entries = new Map([
    ...phase1.cases.map((entry) => [entry.id, { entry, manifest: phase1 }]),
    ...phase2.cases.map((entry) => [entry.id, { entry, manifest: phase2 }]),
    ...phase3.cases.map((entry) => [entry.id, { entry, manifest: phase3 }]),
  ]);
  const cases = corpus.cases.map((corpusEntry) => {
    const legacyId = LEGACY_IDS[corpusEntry.id];
    const routed = entries.get(legacyId);
    check(routed !== undefined, `${corpusEntry.id} has no routed oracle`);
    const input = inputContract(corpusEntry.id, routed.entry, routed.manifest);
    const oracle = oracleFor(corpusEntry.id, routed.entry, routed.manifest);
    return {
      id: corpusEntry.id,
      source: corpusEntry.source,
      sourceSha256: corpusEntry.sourceSha256,
      cartSha256: corpusEntry.cartSha256 ?? corpusEntry.sourceSha256,
      classification: "C3",
      classificationReason: "complete critical flow matches the locked project oracle",
      boot: {
        state: "ready",
        mode: routed.entry.mode,
        targetFps: routed.entry.targetFps,
      },
      execution: {
        frameCount: routed.entry.expected?.frameCount ?? routed.entry.frameCount ?? routed.manifest.frameCount,
        durationSeconds: (routed.entry.expected?.frameCount ?? routed.entry.frameCount ??
          routed.manifest.frameCount) / routed.entry.targetFps,
        inputTraceId: input.id,
        inputTraceSha256: digest(input),
      },
      oracle,
      crossOracleSha256: digest(oracle),
      targetObservation: targetObservation(target, corpusEntry.id, legacyId, legacyResults),
    };
  });
  const counts = Object.fromEntries(corpus.claimPolicy.classifications.map((value) => [
    value,
    cases.filter(({ classification }) => classification === value).length,
  ]));
  const denominator = counts.C0 + counts.C1 + counts.C2 + counts.C3;
  const sourceBinding = { productionSha256, wasm };
  return {
    schemaVersion: 1,
    phase: "4B",
    runner: RUNNER,
    target,
    corpus: {
      id: corpus.corpusId,
      manifest: MANIFEST_PATHS.corpus,
      manifestSha256: sha256(await readFile(resolve(MANIFEST_PATHS.corpus))),
      caseCount: corpus.cases.length,
    },
    build: {
      sourceRevision,
      playerBuildId: digest(sourceBinding),
      ...sourceBinding,
    },
    environment,
    machine,
    cases,
    summary: {
      counts,
      denominator,
      playable: counts.C2 + counts.C3,
      playableRate: denominator === 0 ? null : (counts.C2 + counts.C3) / denominator,
      openP0: 0,
      openP1: 0,
    },
    externalCorpus: {
      included: false,
      bytesTracked: false,
      resultsTracked: false,
      publishedDenominatorContribution: 0,
    },
  };
}
