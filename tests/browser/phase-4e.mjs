import { mountPico8Player } from "../../apps/web-player/dist/main/main.js";
import { inputSnapshot } from "../helpers/input.mjs";

const DATABASE_NAME = "pico8-web-player";
const STORE_NAME = "cartdata";
const resultNode = document.querySelector("#result");
const startButton = document.querySelector("#start");
const workerErrors = [];
let workersCreated = 0;
let workersTerminated = 0;

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

async function sha256(value) {
  const bytes = value instanceof Uint8Array ? value.slice() : new Uint8Array(value).slice();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fetchBytes(path, expectedHash) {
  const response = await fetch(`/${path}`);
  check(response.ok, `failed to fetch ${path}: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  check(await sha256(bytes) === expectedHash, `${path} source hash drifted`);
  return bytes;
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

function copyFrame(event) {
  return {
    frameId: event.frameId,
    completedSlices: event.completedSlices,
    timeRawBeforeStep: event.timeRawBeforeStep,
    screen: new Uint8Array(event.packedScreen).slice(),
    palette: new Uint8Array(event.displayPalette).slice(),
  };
}

async function run() {
  await deleteDatabase();
  const manifest = await fetch(
    "/tests/conformance/manifests/phase-4e-system-integration.json",
  ).then((response) => response.json());
  const [cart, faultCart] = await Promise.all([
    fetchBytes(manifest.case.source, manifest.case.sourceSha256),
    fetchBytes(manifest.faultCase.source, manifest.faultCase.sourceSha256),
  ]);
  const mounted = await mountPico8Player({
    root: document.querySelector("#player"),
    runtimeWorkerFactory,
    commandTimeoutMs: 5_000,
    workletModuleUrl: "/apps/web-player/dist/worklet/pico8-audio-processor.js",
    audio: { requestedSampleRate: 48_000, outputGain: 0 },
  });
  const { composition, controller, elements } = mounted;
  const frames = [];
  const controls = [];
  const states = [];
  const remove = composition.runtime.onEvent((event) => {
    if (event.type === "frame") frames.push(copyFrame(event));
    if (event.type === "runtime-control") {
      controls.push({
        control: event.control,
        payload: new TextDecoder().decode(event.payload),
      });
    }
    if (event.type === "state") states.push(event.state);
  });
  const audio = composition.audio;
  try {
    const ready = await composition.loadCart(cart, manifest.case.instructionBudget);
    check(ready.type === "state" && ready.state === "ready", "Phase 4E cart did not load");
    startButton.disabled = false;
    document.body.dataset.status = "awaiting-gesture";
    document.body.dataset.progress = "awaiting trusted AudioContext gesture";

    const deterministic = await new Promise((resolve, reject) => {
      startButton.addEventListener("click", async (event) => {
        try {
          startButton.disabled = true;
          const gesture = {
            eventIsTrusted: event.isTrusted,
            userActivationIsActive: navigator.userActivation.isActive,
          };
          await composition.resumeAudio();
          await composition.start();
          await composition.pulse(1_000, inputSnapshot());

          let before = frames.length;
          let heartbeat = await composition.pulse(1_000 + 1_000 / 30, inputSnapshot([16]));
          check(heartbeat.type === "heartbeat" && heartbeat.tickCount === 1,
            "first deterministic tick drifted");
          check(frames.length === before + 1, "first deterministic frame was missing");
          const first = frames.at(-1);

          before = frames.length;
          heartbeat = await composition.pulse(1_000 + 2_000 / 30, inputSnapshot());
          check(heartbeat.type === "heartbeat" && heartbeat.tickCount === 1,
            "guest run tick drifted");
          check(frames.length === before, "guest run published a partial frame");
          check(controls.at(-1)?.control === "run" &&
            controls.at(-1)?.payload === manifest.case.expected.runParameter,
          "guest run event drifted");

          await composition.pulse(2_000, inputSnapshot());
          heartbeat = await composition.pulse(2_000 + 1_000 / 30, inputSnapshot([16]));
          check(heartbeat.type === "heartbeat" && heartbeat.tickCount === 1,
            "restart first tick drifted");
          const restartFirst = frames.at(-1);
          heartbeat = await composition.pulse(2_000 + 2_000 / 30, inputSnapshot());
          check(heartbeat.type === "heartbeat" && heartbeat.tickCount === 1,
            "restart second tick drifted");
          const restartSecond = frames.at(-1);
          const activeAudioStats = await audio.requestStats();
          check(activeAudioStats.receivedChunks > 0,
            "AudioWorklet did not receive canonical audio before stop");
          before = frames.length;
          heartbeat = await composition.pulse(2_000 + 3_000 / 30, inputSnapshot());
          check(heartbeat.type === "heartbeat" && heartbeat.tickCount === 1,
            "guest stop tick drifted");
          check(frames.length === before, "guest stop published a partial frame");
          check(controls.at(-1)?.control === "stop" &&
            controls.at(-1)?.payload === manifest.case.expected.stopMessage,
          "guest stop event drifted");
          check(states.at(-1) === "stopped", "Worker did not enter stopped state");
          await composition.suspendAudio();

          resolve({ gesture, first, restartFirst, restartSecond, activeAudioStats });
        } catch (error) {
          reject(error);
        }
      }, { once: true });
    });

    document.body.dataset.status = "running";
    document.body.dataset.progress = "checking Worker/Canvas/AudioWorklet/IndexedDB oracle";
    check(await sha256(deterministic.first.screen) ===
      manifest.case.expected.firstScreenSha256, "Chrome first screen disagreed with Node");
    check(await sha256(deterministic.restartFirst.screen) ===
      manifest.case.expected.restartScreenSha256,
    "Chrome restart first screen disagreed with Node");
    check(await sha256(deterministic.restartSecond.screen) ===
      manifest.case.expected.restartSecondScreenSha256,
    "Chrome restart second screen disagreed with Node");
    check(composition.presenter.lastFrameId === deterministic.restartSecond.frameId,
      "Canvas presenter did not own the final complete frame");
    const canvasPixels = elements.canvas.getContext("2d").getImageData(0, 0, 128, 128).data;
    const canvasSha256 = await sha256(canvasPixels);

    const record = await readCartdataRecord("phase4e");
    check(record?.bytes instanceof ArrayBuffer, "guest stop did not flush IndexedDB cartdata");
    check(await sha256(record.bytes) === manifest.case.expected.cartdataSha256,
      "Chrome IndexedDB cartdata disagreed with Node");
    const audioStats = deterministic.activeAudioStats;
    check(audioStats.sessionGeneration === composition.runtime.sessionGeneration,
      "AudioWorklet retained a stale generation");

    document.body.dataset.progress = "structured fault and recovery";
    let faultCode = null;
    try {
      await composition.loadCart(faultCart, manifest.case.instructionBudget);
      await composition.start();
      await composition.pulse(3_000, inputSnapshot());
      await composition.pulse(3_000 + 1_000 / 30, inputSnapshot());
    } catch (error) {
      faultCode = error?.record?.code ?? null;
    }
    check(faultCode === manifest.faultCase.expectedCode,
      `Chrome fault was not structured: ${faultCode}`);

    const recoveredReady = await composition.loadCart(cart, manifest.case.instructionBudget);
    check(recoveredReady.type === "state" && recoveredReady.state === "ready",
      "valid cart did not recover after fault");
    await composition.start();
    await composition.pulse(4_000, inputSnapshot());
    const beforeRecovery = frames.length;
    await composition.pulse(4_000 + 1_000 / 30, inputSnapshot([16]));
    check(frames.length === beforeRecovery + 1, "recovered cart did not publish a frame");
    await composition.pause();
    await composition.suspendAudio();

    remove();
    await controller.dispose();
    await waitFor(() => workersTerminated === workersCreated,
      "disposed Phase 4E player retained its Worker", 5_000);
    check(audio.contextState === "closed", "AudioContext did not close on dispose");
    check(workerErrors.length === 0, `production Worker errors: ${workerErrors.join("; ")}`);
    return {
      phase: "4E",
      apiCount: manifest.requiredApis.length,
      gesture: deterministic.gesture,
      controls,
      frameHashes: {
        first: await sha256(deterministic.first.screen),
        restartFirst: await sha256(deterministic.restartFirst.screen),
        restartSecond: await sha256(deterministic.restartSecond.screen),
        canvas: canvasSha256,
      },
      cartdataSha256: await sha256(record.bytes),
      faultCode,
      recoveredFrames: frames.length - beforeRecovery,
      audio: {
        requestedSampleRate: 48_000,
        actualSampleRate: audio.deviceSampleRate,
        stats: audioStats,
        stateAfterDispose: audio.contextState,
      },
      resources: { workersCreated, workersTerminated },
      workerErrors,
      userAgent: navigator.userAgent,
    };
  } finally {
    remove();
    await controller.dispose().catch(() => undefined);
  }
}

try {
  const result = await run();
  window.phase4eResult = result;
  resultNode.textContent = JSON.stringify(result, null, 2);
  document.body.dataset.progress = "complete";
  document.body.dataset.status = "complete";
} catch (error) {
  resultNode.textContent = error instanceof Error
    ? `${error.message}\n${error.stack ?? ""}`
    : String(error);
  document.body.dataset.status = "error";
}
