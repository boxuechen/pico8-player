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
    generation: event.sessionGeneration,
    frameId: event.frameId,
    completedSlices: event.completedSlices,
    timeRawBeforeStep: event.timeRawBeforeStep,
    targetFps: event.targetFps,
    cpuInstructions: event.cpuInstructions,
    cpuFractionRaw: event.cpuFractionRaw,
    slowFrame: event.slowFrame,
    screen: new Uint8Array(event.packedScreen).slice(),
  };
}

function compareFrame(frame, expected, targetFps) {
  check(frame.targetFps === targetFps, "logical target FPS drifted");
  check(frame.cpuInstructions === expected.cpuInstructions, "instruction count drifted");
  check(frame.cpuFractionRaw === expected.cpuFractionRaw, "CPU Q16.16 fraction drifted");
  check(frame.slowFrame === expected.slowFrame, "slow-frame classification drifted");
  check(frame.completedSlices === expected.completedSlices, "logical slice drifted");
  check(frame.timeRawBeforeStep === expected.timeRaw, "logical time drifted");
}

async function runFrames(composition, frames, cart, entry, baseMs) {
  const ready = await composition.loadCart(cart, entry.instructionBudget);
  check(ready.type === "state" && ready.state === "ready", `${entry.id} did not load`);
  check(ready.mode === entry.mode && ready.targetFps === entry.targetFps,
    `${entry.id} mode/cadence drifted`);
  const generation = composition.runtime.sessionGeneration;
  await composition.start();
  let heartbeat = await composition.pulse(baseMs, inputSnapshot());
  check(heartbeat.type === "heartbeat" && heartbeat.tickCount === 0,
    `${entry.id} anchor pulse drifted`);
  const result = [];
  for (let index = 0; index < entry.frames.length; index += 1) {
    const before = frames.length;
    heartbeat = await composition.pulse(
      baseMs + (index + 1) * 1_000 / entry.targetFps,
      inputSnapshot(),
    );
    check(heartbeat.type === "heartbeat" && heartbeat.tickCount === 1,
      `${entry.id} tick ${index} drifted`);
    check(frames.length === before + 1, `${entry.id} frame ${index} was missing`);
    const frame = frames.at(-1);
    check(frame.generation === generation, `${entry.id} emitted a stale generation`);
    compareFrame(frame, entry.frames[index], entry.targetFps);
    result.push({
      frameId: frame.frameId,
      completedSlices: frame.completedSlices,
      timeRawBeforeStep: frame.timeRawBeforeStep,
      targetFps: frame.targetFps,
      cpuInstructions: frame.cpuInstructions,
      cpuFractionRaw: frame.cpuFractionRaw,
      slowFrame: frame.slowFrame,
    });
  }
  await composition.pause();
  return result;
}

async function run() {
  await deleteDatabase();
  const manifest = await fetch(
    "/tests/conformance/manifests/phase-4f-cpu-scheduler.json",
  ).then((response) => response.json());
  const carts = new Map();
  await Promise.all([
    ...manifest.cases,
    manifest.transactionCase,
    manifest.faultCase,
  ].map(async (entry) => {
    carts.set(entry.id, await fetchBytes(entry.source, entry.sourceSha256));
  }));

  const mounted = await mountPico8Player({
    root: document.querySelector("#player"),
    runtimeWorkerFactory,
    commandTimeoutMs: 5_000,
    workletModuleUrl: "/apps/web-player/dist/worklet/pico8-audio-processor.js",
    audio: { requestedSampleRate: 48_000, outputGain: 0 },
  });
  const { composition, controller, elements } = mounted;
  const frames = [];
  const remove = composition.runtime.onEvent((event) => {
    if (event.type === "frame") frames.push(copyFrame(event));
  });
  try {
    startButton.disabled = false;
    document.body.dataset.status = "awaiting-gesture";
    document.body.dataset.progress = "awaiting trusted AudioContext gesture";

    const result = await new Promise((resolve, reject) => {
      startButton.addEventListener("click", async (event) => {
        try {
          startButton.disabled = true;
          const gesture = {
            eventIsTrusted: event.isTrusted,
            userActivationIsActive: navigator.userActivation.isActive,
          };
          await composition.resumeAudio();
          const traces = {};
          let baseMs = 1_000;
          for (const entry of manifest.cases) {
            document.body.dataset.progress = `calibrating ${entry.id}`;
            traces[entry.id] = await runFrames(
              composition,
              frames,
              carts.get(entry.id),
              entry,
              baseMs,
            );
            baseMs += 10_000;
          }

          document.body.dataset.progress = "checking slow-frame transaction";
          const transaction = manifest.transactionCase;
          const ready = await composition.loadCart(
            carts.get(transaction.id),
            transaction.instructionBudget,
          );
          check(ready.type === "state" && ready.state === "ready",
            "transaction cart did not load");
          await composition.start();
          await composition.pulse(baseMs, inputSnapshot());
          const before = frames.length;
          const heartbeat = await composition.pulse(
            baseMs + 1_000 / 30,
            inputSnapshot([transaction.inputButtons]),
          );
          check(heartbeat.type === "heartbeat" && heartbeat.tickCount === 1,
            "slow transaction tick drifted");
          check(frames.length === before + 1, "slow transaction did not publish atomically");
          const transactionFrame = frames.at(-1);
          compareFrame(transactionFrame, {
            cpuInstructions: transaction.expected.cpuInstructions,
            cpuFractionRaw: transaction.expected.cpuFractionRaw,
            slowFrame: transaction.expected.slowFrame,
            completedSlices: transaction.expected.completedSlices,
            timeRaw: transaction.expected.timeRaw,
          }, 30);
          check(await sha256(transactionFrame.screen) === transaction.expected.screenSha256,
            "slow transaction screen drifted");
          await composition.pause();
          const audioStats = await composition.audio.requestStats();
          check(audioStats.receivedChunks > 0, "AudioWorklet received no committed PCM");
          const record = await readCartdataRecord("phase4f");
          check(record?.bytes instanceof ArrayBuffer, "slow transaction was not persisted");
          check(await sha256(record.bytes) === transaction.expected.cartDataSha256,
            "slow transaction cartdata drifted");

          document.body.dataset.progress = "checking hard-cap fault and recovery";
          let faultCode = null;
          try {
            await composition.loadCart(
              carts.get(manifest.faultCase.id),
              manifest.faultCase.instructionBudget,
            );
            await composition.start();
            await composition.pulse(baseMs + 10_000, inputSnapshot());
            await composition.pulse(baseMs + 10_000 + 1_000 / 30, inputSnapshot());
          } catch (error) {
            faultCode = error?.record?.code ?? null;
          }
          check(faultCode === manifest.faultCase.expectedCode,
            `hard-cap fault was not structured: ${faultCode}`);

          const valid = manifest.cases[0];
          const recovered = await composition.loadCart(
            carts.get(valid.id),
            valid.instructionBudget,
          );
          check(recovered.type === "state" && recovered.state === "ready",
            "valid cart did not recover after hard-cap fault");
          await composition.start();
          await composition.pulse(baseMs + 20_000, inputSnapshot());
          const recoveryBefore = frames.length;
          await composition.pulse(baseMs + 20_000 + 1_000 / 30, inputSnapshot());
          check(frames.length === recoveryBefore + 1, "recovered cart emitted no frame");
          check(frames.at(-1).slowFrame === false, "recovered cart retained slow state");
          await composition.pause();
          await composition.suspendAudio();

          const pixels = elements.canvas.getContext("2d").getImageData(0, 0, 128, 128).data;
          resolve({
            phase: "4F",
            gesture,
            traces,
            transaction: {
              cpuInstructions: transactionFrame.cpuInstructions,
              cpuFractionRaw: transactionFrame.cpuFractionRaw,
              slowFrame: transactionFrame.slowFrame,
              screenSha256: await sha256(transactionFrame.screen),
              cartDataSha256: await sha256(record.bytes),
              audioStats,
            },
            faultCode,
            recoveredFrames: frames.length - recoveryBefore,
            canvasSha256: await sha256(pixels),
          });
        } catch (error) {
          reject(error);
        }
      }, { once: true });
    });

    remove();
    await controller.dispose();
    await waitFor(() => workersTerminated === workersCreated,
      "disposed Phase 4F player retained its Worker", 5_000);
    check(composition.audio.contextState === "closed", "AudioContext did not close on dispose");
    check(workerErrors.length === 0, `production Worker errors: ${workerErrors.join("; ")}`);
    return {
      ...result,
      audioStateAfterDispose: composition.audio.contextState,
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
  window.phase4fResult = result;
  resultNode.textContent = JSON.stringify(result, null, 2);
  document.body.dataset.progress = "complete";
  document.body.dataset.status = "complete";
} catch (error) {
  resultNode.textContent = error instanceof Error
    ? `${error.message}\n${error.stack ?? ""}`
    : String(error);
  document.body.dataset.status = "error";
}
