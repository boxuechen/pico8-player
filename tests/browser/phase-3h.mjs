import {
  mountPico8Player,
  PlayerRuntimeClient,
} from "../../apps/web-player/dist/main/main.js";
import { inputSnapshot } from "../helpers/input.mjs";

const DATABASE_NAME = "pico8-web-player";
const STORE_NAME = "cartdata";
const resultNode = document.querySelector("#result");
const startButton = document.querySelector("#start");
const workerErrors = [];
let workersCreated = 0;
let workersTerminated = 0;
window.__phase3hInputReady = false;
window.__phase3hInputDone = false;

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(predicate, message, timeoutMs = 10_000) {
  const deadline = performance.now() + timeoutMs;
  while (!(await predicate())) {
    if (performance.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function runtimeWorkerFactory() {
  const worker = new Worker(
    "/apps/web-player/dist/browser/player-worker.mjs",
    { type: "module" },
  );
  workersCreated += 1;
  worker.addEventListener("error", (event) => {
    workerErrors.push(`${event.message} @ ${event.filename}:${event.lineno}`);
  });
  const terminate = worker.terminate.bind(worker);
  worker.terminate = () => {
    workersTerminated += 1;
    terminate();
  };
  return worker;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
    request.addEventListener("blocked", () => reject(new Error("IndexedDB request blocked")), {
      once: true,
    });
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", resolve, { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error), { once: true });
  });
}

async function deleteDatabase() {
  await requestResult(indexedDB.deleteDatabase(DATABASE_NAME));
}

async function readCartdataRecord(id) {
  const database = await requestResult(indexedDB.open(DATABASE_NAME));
  try {
    if (!database.objectStoreNames.contains(STORE_NAME)) return undefined;
    const transaction = database.transaction(STORE_NAME, "readonly");
    const record = await requestResult(
      transaction.objectStore(STORE_NAME).get(["default", id]),
    );
    await transactionDone(transaction);
    return record;
  } finally {
    database.close();
  }
}

async function dropCartdataStore() {
  const request = indexedDB.open(DATABASE_NAME, 2);
  request.addEventListener("upgradeneeded", () => {
    if (request.result.objectStoreNames.contains(STORE_NAME)) {
      request.result.deleteObjectStore(STORE_NAME);
    }
  });
  const database = await requestResult(request);
  database.close();
}

function asBytes(value) {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

async function sha256(value) {
  const bytes = asBytes(value).slice();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fetchBytes(path) {
  const response = await fetch(`/${path}`);
  check(response.ok, `failed to fetch ${path}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function loadAssets(manifest) {
  const assets = new Map();
  for (const entry of [...manifest.cases, manifest.faultCase]) {
    const source = await fetchBytes(entry.source);
    check(await sha256(source) === entry.sourceSha256, `${entry.id} source hash drifted`);
    assets.set(entry.id, source);
  }
  return assets;
}

function copyFrame(event) {
  return {
    frameId: event.frameId,
    completedSlices: event.completedSlices,
    timeRawBeforeStep: event.timeRawBeforeStep,
    screen: new Uint8Array(event.packedScreen).slice(),
    displayPalette: new Uint8Array(event.displayPalette).slice(),
  };
}

function audioInputAt(index) {
  if (index === 0) {
    return inputSnapshot([1, 16], {
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
    return inputSnapshot([1, 16], {
      mouseXRaw: 12 * 65_536,
      mouseYRaw: 34 * 65_536,
    });
  }
  return inputSnapshot();
}

async function exactFrames(client, frames, entry, anchorMs, inputAt) {
  const beforeAnchor = frames.length;
  const anchor = await client.pulse(anchorMs, inputSnapshot());
  check(anchor.type === "heartbeat" && anchor.tickCount === 0, `${entry.id} anchor drifted`);
  check(frames.length === beforeAnchor, `${entry.id} anchor published a frame`);
  const tickMs = 1_000 / entry.targetFps;
  const captured = [];
  for (let index = 0; index < entry.frameCount; index += 1) {
    const before = frames.length;
    const heartbeat = await client.pulse(anchorMs + (index + 1) * tickMs, inputAt(index));
    check(heartbeat.type === "heartbeat" && heartbeat.tickCount === 1,
      `${entry.id} frame ${index} did not execute exactly once`);
    check(frames.length === before + 1, `${entry.id} frame ${index} was not published`);
    captured.push(frames.at(-1));
  }
  return captured;
}

async function deterministicAudioCase(entry, cart) {
  const client = new PlayerRuntimeClient(runtimeWorkerFactory, { commandTimeoutMs: 5000 });
  const frames = [];
  const remove = client.onEvent((event) => {
    if (event.type === "frame") frames.push(copyFrame(event));
  });
  try {
    await client.loadCart(cart, 2_000_000);
    await client.start();
    const initial = await exactFrames(client, frames, entry, 1_000, audioInputAt);
    const first = initial.at(-1);
    check(await sha256(first.screen) === entry.expected.initial.finalScreenSha256,
      "audio/input Chrome final screen drifted from Node");
    check(await sha256(first.displayPalette) === entry.expected.initial.displayPaletteSha256,
      "audio/input Chrome display palette drifted from Node");
    const generationBeforeReset = client.sessionGeneration;
    await client.reset();
    await client.start();
    const replay = await exactFrames(client, frames, entry, 10_000, audioInputAt);
    const reset = replay.at(-1);
    check(await sha256(reset.screen) === entry.expected.reset.finalScreenSha256,
      "audio/input Chrome reset screen drifted from Node");
    check(JSON.stringify(replay.map(({ frameId, completedSlices, timeRawBeforeStep }) => ({
      frameId, completedSlices, timeRawBeforeStep,
    }))) === JSON.stringify(initial.map(({ frameId, completedSlices, timeRawBeforeStep }) => ({
      frameId, completedSlices, timeRawBeforeStep,
    }))), "audio/input Chrome reset clock trace was not exact");
    return {
      id: entry.id,
      finalScreenSha256: await sha256(first.screen),
      displayPaletteSha256: await sha256(first.displayPalette),
      resetScreenSha256: await sha256(reset.screen),
      generationBeforeReset,
      generationAfterReset: client.sessionGeneration,
    };
  } finally {
    remove();
    await client.dispose();
  }
}

async function deterministicPersistenceCase(entry, cart) {
  await deleteDatabase();
  const client = new PlayerRuntimeClient(runtimeWorkerFactory, { commandTimeoutMs: 5000 });
  const frames = [];
  const remove = client.onEvent((event) => {
    if (event.type === "frame") frames.push(copyFrame(event));
  });
  async function generation(action, anchorMs, expected) {
    await action();
    await client.start();
    const captured = await exactFrames(client, frames, entry, anchorMs, () => inputSnapshot([32]));
    const frame = captured.at(-1);
    check(await sha256(frame.screen) === expected.screenSha256,
      `persistence Chrome generation ${expected.generation} screen drifted from Node`);
    check(await sha256(frame.displayPalette) === expected.displayPaletteSha256,
      `persistence Chrome generation ${expected.generation} palette drifted from Node`);
    await client.pause();
    return {
      generation: client.sessionGeneration,
      screenSha256: await sha256(frame.screen),
      displayPaletteSha256: await sha256(frame.displayPalette),
    };
  }
  try {
    const initial = await generation(
      () => client.loadCart(cart, 2_000_000),
      1_000,
      entry.expected.initial,
    );
    const reset = await generation(() => client.reset(), 10_000, entry.expected.reset);
    const sameIdentity = await generation(
      () => client.loadCart(cart, 2_000_000),
      20_000,
      entry.expected.sameIdentity,
    );
    return { id: entry.id, initial, reset, sameIdentity };
  } finally {
    remove();
    await client.dispose();
  }
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

async function performanceProbe(entry, cart, performanceContract) {
  await deleteDatabase();
  const client = new PlayerRuntimeClient(runtimeWorkerFactory, { commandTimeoutMs: 5000 });
  try {
    await client.loadCart(cart, 2_000_000);
    await client.start();
    await client.pulse(0, inputSnapshot());
    const durations = [];
    const total = performanceContract.warmupTicks + performanceContract.measuredTicks;
    const tickMs = 1_000 / entry.targetFps;
    for (let index = 1; index <= total; index += 1) {
      const started = performance.now();
      const heartbeat = await client.pulse(
        index * tickMs,
        entry.id.endsWith("persistence-overlay") ? inputSnapshot([32]) : audioInputAt(index),
      );
      const elapsed = performance.now() - started;
      check(heartbeat.type === "heartbeat" && heartbeat.tickCount === 1,
        `${entry.id} performance pulse ${index} drifted`);
      if (index > performanceContract.warmupTicks) durations.push(elapsed);
    }
    const p95Ms = percentile(durations, 0.95);
    check(p95Ms <= performanceContract.p95MillisecondsMaximum,
      `${entry.id} p95 ${p95Ms}ms exceeded ${performanceContract.p95MillisecondsMaximum}ms`);
    return {
      id: entry.id,
      warmupTicks: performanceContract.warmupTicks,
      measuredTicks: durations.length,
      p50Ms: median(durations),
      p95Ms,
      p99Ms: percentile(durations, 0.99),
      minMs: Math.min(...durations),
      maxMs: Math.max(...durations),
      over16_67Ms: durations.filter((duration) => duration > 1_000 / 60).length,
    };
  } finally {
    await client.dispose();
  }
}

function whitePixelX(canvas, y) {
  const pixels = canvas.getContext("2d").getImageData(0, y, 128, 1).data;
  for (let x = 0; x < 128; x += 1) {
    const offset = x * 4;
    if (
      pixels[offset] === 0xff && pixels[offset + 1] === 0xf1 &&
      pixels[offset + 2] === 0xe8 && pixels[offset + 3] === 0xff
    ) return x;
  }
  return -1;
}

async function waitFrames(composition, count) {
  const target = composition.presenter.lastFrameId + count;
  await waitFor(() => composition.presenter.lastFrameId >= target,
    `production Canvas did not advance ${count} frames`);
}

async function runAudioSoakAndRecovery(manifest, assets) {
  await deleteDatabase();
  const mounted = await mountPico8Player({
    root: document.querySelector("#player"),
    runtimeWorkerFactory,
    commandTimeoutMs: 5000,
    workletModuleUrl: "/apps/web-player/dist/worklet/pico8-audio-processor.js",
    audio: { requestedSampleRate: 48_000, outputGain: 0 },
  });
  const { controller, composition, elements } = mounted;
  const diagnostics = [];
  let runtimeFrames = 0;
  const remove = composition.runtime.onEvent((event) => {
    if (event.type === "frame") runtimeFrames += 1;
    if (event.type === "diagnostic") diagnostics.push(event.error);
  });
  try {
    await controller.loadCart(assets.get("phase-3/audio-input"), "audio-input.p8");
    await controller.start();
    const prebufferStats = await composition.audio.waitForStats(
      (stats) => stats.queuedSourceFrames >= 11_025,
      10_000,
    );
    startButton.disabled = false;
    document.body.dataset.status = "awaiting-gesture";
    document.body.dataset.progress = "awaiting trusted audio gesture";
    const gesture = await new Promise((resolve, reject) => {
      startButton.addEventListener("click", async (event) => {
        try {
          startButton.disabled = true;
          const record = {
            eventIsTrusted: event.isTrusted,
            userActivationIsActive: navigator.userActivation.isActive,
          };
          await composition.resumeAudio();
          resolve(record);
        } catch (error) {
          reject(error);
        }
      }, { once: true });
    });
    check(composition.audio.contextState === "running", "AudioContext did not resume");

    document.body.dataset.status = "awaiting-input";
    document.body.dataset.progress = "awaiting trusted controller and devkit input";
    window.__phase3hInputReady = true;
    await waitFor(() => window.__phase3hInputDone, "CDP input did not complete", 30_000);
    await waitFrames(composition, 8);
    const inputObservation = Array.from({ length: 9 }, (_, y) => whitePixelX(elements.canvas, y));
    check(inputObservation[1] > 0 && inputObservation[2] > 0,
      `controller input did not reach the cart: ${inputObservation}`);
    check(inputObservation[3] === 1, `devkit keypress was missing or duplicated: ${inputObservation}`);
    check(inputObservation[6] > 0, `devkit wheel was not observed: ${inputObservation}`);

    document.body.dataset.status = "running";
    document.body.dataset.progress = `bounded ${manifest.performance.soakSeconds}s audio soak`;
    const soakBaselineStats = await composition.audio.requestStats();
    const framesBeforeSoak = runtimeFrames;
    const soakStartedAt = performance.now();
    let elapsed = 0;
    while (elapsed < manifest.performance.soakSeconds * 1_000) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      elapsed = performance.now() - soakStartedAt;
    }
    const finalStats = await composition.audio.requestStats();
    const soak = {
      requestedSeconds: manifest.performance.soakSeconds,
      actualDurationMs: performance.now() - soakStartedAt,
      runtimeFrames: runtimeFrames - framesBeforeSoak,
      timeDiscontinuities: diagnostics.filter(({ code }) => code === "E_TIME_DISCONTINUITY").length,
      baselineAudioStats: soakBaselineStats,
      audioStats: finalStats,
      startupUnderrunDelta: finalStats.startupUnderruns - soakBaselineStats.startupUnderruns,
      steadyUnderrunDelta: finalStats.steadyUnderruns - soakBaselineStats.steadyUnderruns,
    };

    document.body.dataset.progress = "structured host fault and recovery";
    const faultGenerationBefore = composition.runtime.sessionGeneration;
    let caughtCode = null;
    try {
      await controller.loadCart(assets.get("phase-3/host-api-fault"), "host-api-fault.p8");
      await controller.start();
      await waitFor(() => controller.state === "faulted", "host fault was not contained");
    } catch (error) {
      caughtCode = error?.record?.code ?? null;
    }
    await waitFor(() => controller.state === "faulted", "controller did not enter faulted state");
    const faultGeneration = composition.runtime.sessionGeneration;
    check(faultGeneration > faultGenerationBefore, "fault cart did not advance generation");
    const faultResetStats = await composition.audio.waitForStats(
      (stats) => stats.sessionGeneration === faultGeneration &&
        stats.receivedChunks === 0 && stats.queuedSourceFrames === 0,
      5000,
    );

    let recoveredFrames = 0;
    const removeRecovery = composition.runtime.onEvent((event) => {
      if (event.type === "frame") recoveredFrames += 1;
    });
    await controller.loadCart(assets.get("phase-3/audio-input"), "audio-input-recovery.p8");
    const recoveryGeneration = composition.runtime.sessionGeneration;
    await controller.start();
    await waitFor(() => recoveredFrames > 0, "valid cart did not recover after host fault");
    await controller.pause();
    removeRecovery();
    const recovery = {
      code: "E_HOST_API",
      caughtCode,
      faultGeneration,
      recoveryGeneration,
      recoveredFrames,
      faultResetStats,
    };

    const audio = composition.audio;
    await controller.dispose();
    return {
      gesture,
      requestedSampleRate: 48_000,
      actualSampleRate: audio.deviceSampleRate,
      prebufferStats,
      inputObservation,
      soak,
      recovery,
      audioStateAfterDispose: audio.contextState,
    };
  } finally {
    remove();
    await controller.dispose().catch(() => undefined);
  }
}

async function runPersistenceCanvasAndFailure(assets) {
  await deleteDatabase();
  const mounted = await mountPico8Player({
    root: document.querySelector("#player"),
    runtimeWorkerFactory,
    commandTimeoutMs: 5000,
  });
  const { controller, composition, elements } = mounted;
  const diagnostics = [];
  const remove = composition.runtime.onEvent((event) => {
    if (event.type === "diagnostic") diagnostics.push(event.error);
  });
  try {
    document.body.dataset.progress = "IndexedDB and current-cart overlay lifecycle";
    const cart = assets.get("phase-3/persistence-overlay");
    await controller.loadCart(cart, "persistence-overlay.p8");
    await controller.start();
    await waitFrames(composition, 2);
    const initial = Array.from({ length: 4 }, (_, y) => whitePixelX(elements.canvas, y));
    await controller.pause();
    const firstRecord = await readCartdataRecord("phase3h_store");
    check(firstRecord !== undefined, "pause did not flush Phase 3H cartdata");

    const generationBeforeReset = composition.runtime.sessionGeneration;
    await controller.reset();
    await controller.start();
    await waitFrames(composition, 2);
    const reset = Array.from({ length: 4 }, (_, y) => whitePixelX(elements.canvas, y));
    const generationAfterReset = composition.runtime.sessionGeneration;
    await controller.pause();
    const resetRecord = await readCartdataRecord("phase3h_store");

    await dropCartdataStore();
    await controller.resume();
    elements.canvas.focus();
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "x", code: "KeyX", bubbles: true, cancelable: true,
    }));
    await waitFrames(composition, 2);
    window.dispatchEvent(new KeyboardEvent("keyup", {
      key: "x", code: "KeyX", bubbles: true, cancelable: true,
    }));
    await controller.pause();
    const failureState = controller.state;
    const result = {
      initial,
      reset,
      generationBeforeReset,
      generationAfterReset,
      firstSchemaVersion: firstRecord.schemaVersion,
      firstBytes: firstRecord.bytes.byteLength,
      resetBytes: resetRecord.bytes.byteLength,
      writeFailureDiagnostic: diagnostics.some(({ code }) => code === "E_PERSISTENCE_WRITE"),
      failureState,
    };
    await controller.dispose();
    return result;
  } finally {
    remove();
    await controller.dispose().catch(() => undefined);
  }
}

async function run() {
  const manifest = await fetch("/tests/conformance/manifests/phase-3h-exit.json")
    .then((response) => response.json());
  const assets = await loadAssets(manifest);
  const audioEntry = manifest.cases.find(({ id }) => id === "phase-3/audio-input");
  const persistenceEntry = manifest.cases.find(({ id }) => id === "phase-3/persistence-overlay");

  document.body.dataset.progress = "Node/Chrome deterministic cross-oracles";
  const deterministic = [
    await deterministicAudioCase(audioEntry, assets.get(audioEntry.id)),
    await deterministicPersistenceCase(persistenceEntry, assets.get(persistenceEntry.id)),
  ];

  document.body.dataset.progress = "representative 120-tick performance";
  const performanceCases = [];
  for (const entry of manifest.cases) {
    performanceCases.push(await performanceProbe(entry, assets.get(entry.id), manifest.performance));
  }
  const maxP95Ms = Math.max(...performanceCases.map(({ p95Ms }) => p95Ms));

  const audio = await runAudioSoakAndRecovery(manifest, assets);
  const persistence = await runPersistenceCanvasAndFailure(assets);
  await waitFor(() => workersTerminated === workersCreated,
    "disposed players retained a production Worker", 5000);
  check(workerErrors.length === 0, `production Worker errors: ${workerErrors.join("; ")}`);
  return {
    schemaVersion: 1,
    phase: "3H",
    target: manifest.target,
    deterministic,
    performance: { cases: performanceCases, maxP95Ms },
    audio,
    persistence,
    resources: { workersCreated, workersTerminated },
    workerErrors,
    userAgent: navigator.userAgent,
  };
}

try {
  const result = await run();
  window.phase3hResult = result;
  resultNode.textContent = JSON.stringify(result, null, 2);
  document.body.dataset.progress = "complete";
  document.body.dataset.status = "complete";
} catch (error) {
  resultNode.textContent = error instanceof Error
    ? `${error.message}\n${error.stack ?? ""}`
    : String(error);
  document.body.dataset.status = "error";
}
