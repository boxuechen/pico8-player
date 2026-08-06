import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { before } from "node:test";

import { decodeCart } from "@pico8-web/cart-codec";
import {
  CartSession,
  FrameSliceRuntime,
} from "@pico8-web/runtime-core";
import {
  createPicoApiHostRouter,
  Z8LuaFrameVm,
} from "@pico8-web/z8lua-bridge";
import {
  CartRepositoryAdapter,
} from "../../apps/web-player/dist/worker/adapters/cart-repository-adapter.js";
import {
  createPlayerWorkerController,
} from "../../apps/web-player/dist/worker/compose-runtime.js";
import {
  WorkerPcmTransport,
} from "../../apps/web-player/dist/worker/audio-transport.js";
import { inputSnapshot } from "../helpers/input.mjs";
import createZ8LuaModule from "../../wasm/dist/z8lua-runtime-v1.mjs";

const projectRoot = new URL("../../", import.meta.url);
const manifestUrl = new URL("manifests/phase-3h-exit.json", import.meta.url);
let module;
let manifest;
let phaseContract;
let reviewedEvidence;
let reviewedEvidenceBytes;

before(async () => {
  [module, manifest, phaseContract, reviewedEvidenceBytes] = await Promise.all([
    createZ8LuaModule(),
    readFile(manifestUrl, "utf8").then(JSON.parse),
    readFile(new URL(
      "../../spec/phase-3-audio-input-persistence-contract.json",
      import.meta.url,
    ), "utf8").then(JSON.parse),
    readFile(new URL(
      "../../benchmarks/phase-3/results/chromium-macos-arm64-phase-3-exit.json",
      import.meta.url,
    )),
  ]);
  reviewedEvidence = JSON.parse(reviewedEvidenceBytes.toString("utf8"));
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

function cartBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function loadCase(entry) {
  const source = new Uint8Array(await readFile(new URL(entry.source, projectRoot)));
  return { source, cart: decodeCart(source) };
}

function createSession(cart, repository, seedsRef) {
  repository.registerCart(cart);
  return new CartSession({
    createRuntime(context) {
      const vm = new Z8LuaFrameVm(module, createPicoApiHostRouter(module));
      try {
        return new FrameSliceRuntime(vm, {
          instructionBudget: 2_000_000,
          cartDataSeeds: seedsRef.current,
          currentCart: {
            identity: context.cart.identity,
            repository,
          },
        });
      } catch (error) {
        vm.destroy();
        throw error;
      }
    },
  });
}

function audioInputAt(index) {
  if (index === 0) {
    return inputSnapshot([1, 16, 0, 0, 0, 0, 0, 0], {
      mouseXRaw: 12 * 65_536,
      mouseYRaw: 34 * 65_536,
      mouseButtons: 1,
      wheelRaw: 65_536,
      movementXRaw: 2 * 65_536,
      movementYRaw: -65_536,
      keypresses: [113],
    });
  }
  if (index === 1) {
    return inputSnapshot([1, 16, 0, 0, 0, 0, 0, 0], {
      mouseXRaw: 12 * 65_536,
      mouseYRaw: 34 * 65_536,
    });
  }
  return inputSnapshot();
}

function inspectAudioSlice(audio) {
  return {
    firstSample: audio.firstSample,
    frameCount: audio.frameCount,
    pcmSha256: sha256(audio.pcm16le),
  };
}

function captureAudioInput(session, entry, boot) {
  const pcm = [boot.audio.pcm16le];
  const trace = [];
  let finalFrame;
  for (let index = 0; index < entry.frameCount; index += 1) {
    const result = session.step(audioInputAt(index));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.value.kind, "frame");
    finalFrame = result.value.frame;
    pcm.push(finalFrame.audio.pcm16le);
    const observation = session.copyRam(0x5000, 16);
    assert.equal(observation.ok, true, JSON.stringify(observation));
    trace.push({
      frameId: finalFrame.frameId,
      completedSlices: finalFrame.completedSlices,
      timeRawBeforeStep: finalFrame.timeRawBeforeStep,
      devkitFlags: finalFrame.devkitFlags,
      audio: inspectAudioSlice(finalFrame.audio),
      observationHex: hex(observation.value),
      screenSha256: sha256(finalFrame.screen),
    });
  }
  return {
    bootAudio: inspectAudioSlice(boot.audio),
    pcmBytes: pcm.reduce((total, bytes) => total + bytes.byteLength, 0),
    pcmSha256: sha256(Buffer.concat(pcm.map((bytes) => Buffer.from(bytes)))),
    traceSha256: sha256(Buffer.from(JSON.stringify(trace))),
    finalObservationHex: trace.at(-1).observationHex,
    finalScreenSha256: sha256(finalFrame.screen),
    displayPaletteSha256: sha256(finalFrame.displayPalette),
    displayPaletteHex: hex(finalFrame.displayPalette),
  };
}

function runAudioScenario(entry, cart) {
  const repository = new CartRepositoryAdapter();
  const seedsRef = { current: [] };
  const session = createSession(cart, repository, seedsRef);
  try {
    const loaded = session.load(cart);
    assert.equal(loaded.ok, true, JSON.stringify(loaded));
    assert.equal(loaded.value.kind, "ready");
    const initial = captureAudioInput(session, entry, loaded.value);
    const reset = session.reset();
    assert.equal(reset.ok, true, JSON.stringify(reset));
    assert.equal(reset.value.kind, "ready");
    const replay = captureAudioInput(session, entry, reset.value);
    assert.deepEqual(replay, initial, "audio/input cold reset must replay exactly");
    return {
      initial,
      reset: replay,
      generations: [loaded.value.generation, reset.value.generation],
    };
  } finally {
    session.dispose();
    repository.dispose();
  }
}

function committedSeed(commit) {
  assert.notEqual(commit, undefined, "persistence flow must publish a cartdata commit");
  return Object.freeze({ id: commit.id, bytes: commit.bytes.slice() });
}

function capturePersistenceGeneration(session, ready, input = inputSnapshot([32])) {
  assert.equal(ready.kind, "ready");
  const stepped = session.step(input);
  assert.equal(stepped.ok, true, JSON.stringify(stepped));
  assert.equal(stepped.value.kind, "frame");
  const frame = stepped.value.frame;
  const observation = session.copyRam(0x5100, 4);
  assert.equal(observation.ok, true, JSON.stringify(observation));
  const commit = frame.cartDataCommit ?? ready.cartDataCommit;
  const seed = committedSeed(commit);
  return {
    seed,
    result: {
      generation: ready.generation,
      observationHex: hex(observation.value),
      overlayByte: session.copyRam(0x100, 1).value[0],
      cartdataId: commit.id,
      cartdataRevision: commit.revision,
      cartdataSha256: sha256(commit.bytes),
      screenSha256: sha256(frame.screen),
      displayPaletteSha256: sha256(frame.displayPalette),
      displayPaletteHex: hex(frame.displayPalette),
      audio: inspectAudioSlice(frame.audio),
    },
  };
}

function runPersistenceScenario(cart) {
  const repository = new CartRepositoryAdapter();
  const seedsRef = { current: [] };
  const session = createSession(cart, repository, seedsRef);
  try {
    const loaded = session.load(cart);
    assert.equal(loaded.ok, true, JSON.stringify(loaded));
    const initial = capturePersistenceGeneration(session, loaded.value);
    seedsRef.current = [initial.seed];

    const reset = session.reset();
    assert.equal(reset.ok, true, JSON.stringify(reset));
    const replay = capturePersistenceGeneration(session, reset.value);
    seedsRef.current = [replay.seed];

    const repeated = session.load(cart);
    assert.equal(repeated.ok, true, JSON.stringify(repeated));
    const sameIdentity = capturePersistenceGeneration(session, repeated.value);
    return {
      initial: initial.result,
      reset: replay.result,
      sameIdentity: sameIdentity.result,
      repositoryOverlayByte: repository.readData(cart.identity, 0x100, 1)[0],
    };
  } finally {
    session.dispose();
    repository.dispose();
  }
}

function command(type, requestId, sessionGeneration, overrides = {}) {
  return {
    v: 1,
    type,
    requestId,
    workerGeneration: 1,
    sessionGeneration,
    ...overrides,
  };
}

class FaultInjectingPersistence {
  diagnostics = [];
  durable = new Map();
  pending = new Map();
  failReads = 0;
  failWrites = 0;

  async hydrate() {
    if (this.failReads > 0) {
      this.failReads -= 1;
      this.diagnostics.push({
        code: "E_PERSISTENCE_READ",
        message: "phase 3h injected hydrate failure",
        phase: "none",
        recoverable: true,
      });
      return [];
    }
    return [...this.durable].map(([id, bytes]) => ({ id, bytes: bytes.slice() }));
  }

  enqueue(commit) {
    this.pending.set(commit.id, commit.bytes.slice());
  }

  async flush() {
    if (this.failWrites > 0) {
      this.failWrites -= 1;
      this.diagnostics.push({
        code: "E_PERSISTENCE_WRITE",
        message: "phase 3h injected flush failure",
        phase: "none",
        recoverable: true,
      });
      return;
    }
    for (const [id, bytes] of this.pending) this.durable.set(id, bytes.slice());
    this.pending.clear();
  }

  takeDiagnostics() {
    return this.diagnostics.splice(0);
  }

  async dispose() {
    await this.flush();
  }
}

function recordingPort(records) {
  return {
    postMessage(message) {
      records.push({ ...message, ...(message.pcm16le === undefined ? {} : {
        pcm16le: new Uint8Array(message.pcm16le).slice(),
      }) });
    },
    close() {},
  };
}

test("Phase 3H project-owned carts lock real-WASM PCM, input, RAM, persistence and overlay oracles", async () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.cases.length, 2);
  assert.match(manifest.ownership, /Project-authored/u);
  assert.doesNotMatch(JSON.stringify(manifest), /(?:ref\/|bbs-download|third-party cart)/iu);

  const actual = [];
  for (const entry of manifest.cases) {
    const loaded = await loadCase(entry);
    const scenario = entry.id === "phase-3/audio-input"
      ? runAudioScenario(entry, loaded.cart)
      : runPersistenceScenario(loaded.cart);
    if (entry.id === "phase-3/audio-input") {
      assert.deepEqual(runAudioScenario(entry, loaded.cart), scenario,
        "audio/input fresh session must replay exactly");
    } else {
      assert.deepEqual(runPersistenceScenario(loaded.cart), scenario,
        "persistence/overlay fresh scenario must replay exactly");
    }
    const inspected = {
      id: entry.id,
      sourceSha256: sha256(loaded.source),
      cartSha256: loaded.cart.identity.contentSha256,
      scenario,
    };
    actual.push(inspected);
    if (entry.sourceSha256 !== "TBD" && entry.expected !== "TBD") {
      assert.equal(inspected.sourceSha256, entry.sourceSha256, `${entry.id} source`);
      assert.equal(inspected.cartSha256, entry.cartSha256, `${entry.id} cart`);
      assert.deepEqual(inspected.scenario, entry.expected, `${entry.id} scenario`);
    }
  }
  if (manifest.cases.some(({ sourceSha256, expected }) =>
    sourceSha256 === "TBD" || expected === "TBD")) {
    assert.fail(`review and lock Phase 3H manifest:\n${JSON.stringify(actual, null, 2)}`);
  }
});

test("Phase 3H recovery contains host faults, resets audio, rejects stale work and keeps persistence failure nonfatal", async () => {
  const [faultBytes, validBytes] = await Promise.all([
    readFile(new URL(manifest.faultCase.source, projectRoot)),
    readFile(new URL(manifest.cases[1].source, projectRoot)),
  ]);
  const records = [];
  const transport = new WorkerPcmTransport();
  transport.attach(recordingPort(records), 1);
  const persistence = new FaultInjectingPersistence();
  const controller = createPlayerWorkerController(module, {
    audioTransport: transport,
    persistence,
  });
  try {
    const loadedFault = await controller.handle(command("loadCart", 1, 1, {
      cartBytes: cartBuffer(faultBytes),
      instructionBudget: 2_000_000,
    }));
    assert.equal(loadedFault.at(-1).state, "ready");
    await controller.handle(command("start", 2, 1));
    await controller.handle(command("vsync", 3, 1, { sequence: 1, timestampMs: 0 }));
    const fault = await controller.handle(command("vsync", 4, 1, {
      sequence: 2,
      timestampMs: 17,
    }));
    const faultEvent = fault.find(({ type }) => type === "fault");
    assert.equal(faultEvent.error.code, manifest.faultCase.expectedCode);
    assert.equal(records.at(-1).type, "audioReset");
    assert.equal(records.at(-1).sessionGeneration, 1);

    persistence.failReads = 1;
    const recoveredLoad = await controller.handle(command("loadCart", 5, 2, {
      cartBytes: cartBuffer(validBytes),
      instructionBudget: 2_000_000,
    }));
    assert.equal(recoveredLoad.some(({ type, error }) =>
      type === "diagnostic" && error.code === "E_PERSISTENCE_READ"), true);
    assert.equal(recoveredLoad.at(-1).state, "ready");

    const staleInput = await controller.handle(command("input", 6, 1, {
      sequence: 999,
      input: inputSnapshot([63, 63, 63, 63, 63, 63, 63, 63], {
        keypresses: [113],
      }),
    }));
    assert.deepEqual(staleInput, []);
    const staleWork = await controller.handle(command("start", 7, 1));
    assert.equal(staleWork[0].error.code, "E_INVALID_STATE");

    await controller.handle(command("start", 8, 2));
    await controller.handle(command("input", 9, 2, {
      sequence: 1,
      input: inputSnapshot([32]),
    }));
    await controller.handle(command("vsync", 10, 2, { sequence: 1, timestampMs: 0 }));
    const recovered = await controller.handle(command("vsync", 11, 2, {
      sequence: 2,
      timestampMs: 17,
    }));
    assert.equal(recovered.some(({ type }) => type === "frame"), true);
    assert.equal(recovered.some(({ type }) => type === "fault"), false);

    persistence.failWrites = 1;
    const paused = await controller.handle(command("pause", 12, 2));
    assert.equal(paused.some(({ type, error }) =>
      type === "diagnostic" && error.code === "E_PERSISTENCE_WRITE"), true);
    assert.equal(paused.some(({ type }) => type === "fault"), false);
    assert.equal(paused.at(-1).state, "paused");
    assert.equal(records.at(-1).sessionGeneration, 2);
  } finally {
    await controller.handle(command("dispose", 13, 2));
    await controller.dispose();
    transport.dispose();
  }

  if (manifest.faultCase.sourceSha256 === "TBD") {
    assert.fail(`lock Phase 3H fault source SHA-256: ${sha256(faultBytes)}`);
  }
});

test("Phase 3 exit contract hash-locks reviewed Chrome evidence and has no active work unit", async () => {
  assert.equal(phaseContract.status, "complete");
  assert.equal(phaseContract.activeWorkUnit, null);
  assert.equal(phaseContract.nextWorkUnit, null);
  assert.equal(phaseContract.nextPhase, "4");
  assert.deepEqual(phaseContract.completedWorkUnits,
    ["3A", "3B", "3C", "3D", "3E", "3F", "3G", "3H"]);
  assert.equal(phaseContract.workUnits["3H"].status, "complete");

  const result = phaseContract.workUnits["3H"].result;
  assert.equal(sha256(reviewedEvidenceBytes), result.rawEvidenceSha256);
  assert.equal(reviewedEvidence.phase, "3H");
  assert.equal(reviewedEvidence.browser, result.chromeGate.browser);
  assert.equal(reviewedEvidence.deterministic.length, result.projectOwnedCases.length);
  assert.equal(reviewedEvidence.performance.maxP95Ms,
    result.chromeGate.maximumP95Milliseconds);
  assert.ok(reviewedEvidence.performance.maxP95Ms <= 8);
  assert.equal(reviewedEvidence.performance.cases.every(
    ({ measuredTicks }) => measuredTicks >= 120,
  ), true);
  assert.ok(reviewedEvidence.audio.soak.actualDurationMs >= 60_000);
  assert.equal(reviewedEvidence.audio.soak.runtimeFrames,
    result.chromeGate.boundedSoakFrames);
  assert.equal(reviewedEvidence.audio.soak.startupUnderrunDelta, 0);
  assert.equal(reviewedEvidence.audio.soak.steadyUnderrunDelta, 0);
  assert.equal(reviewedEvidence.audio.soak.audioStats.steadyUnderruns, 0);
  assert.equal(reviewedEvidence.audio.soak.audioStats.discontinuities, 0);
  assert.equal(reviewedEvidence.audio.soak.audioStats.staleChunks, 0);
  assert.equal(reviewedEvidence.audio.recovery.code, result.recovery.faultCode);
  assert.ok(reviewedEvidence.audio.recovery.recoveryGeneration
    > reviewedEvidence.audio.recovery.faultGeneration);
  assert.equal(reviewedEvidence.persistence.writeFailureDiagnostic, true);
  assert.equal(reviewedEvidence.persistence.failureState, "paused");
  assert.equal(reviewedEvidence.resources.workersCreated,
    reviewedEvidence.resources.workersTerminated);
  assert.deepEqual(reviewedEvidence.workerErrors, []);
  assert.equal(result.openP0P1, 0);

  const evidenceDocument = await readFile(new URL(
    "../../docs/evidence/phase-3/41-phase-3-audio-input-persistence-exit-evidence.md",
    import.meta.url,
  ), "utf8");
  assert.match(evidenceDocument, new RegExp(result.rawEvidenceSha256, "u"));
  await assert.rejects(
    readFile(new URL("../../docs/phases/3-audio-input-persistence.md", import.meta.url)),
    { code: "ENOENT" },
  );
});
