import { PlayerRuntimeClient } from "../../apps/web-player/dist/main/main.js";
import {
  Canvas2DFramePresenter,
} from "../../apps/web-player/dist/main/render/canvas2d-frame-presenter.js";
import { inputSnapshot } from "../helpers/input.mjs";

const resultNode = document.querySelector("#result");
const workerErrors = [];

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function runtimeWorkerFactory() {
  const worker = new Worker(
    "/apps/web-player/dist/browser/player-worker.mjs",
    { type: "module" },
  );
  worker.addEventListener("error", (event) => {
    workerErrors.push(`${event.message} @ ${event.filename}:${event.lineno}`);
  });
  return worker;
}

async function sha256(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice()));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fetchJson(path) {
  const response = await fetch(path);
  check(response.ok, `failed to fetch ${path}: ${response.status}`);
  return response.json();
}

async function fetchBytes(path, expectedHash) {
  const response = await fetch(`/${path}`);
  check(response.ok, `failed to fetch ${path}: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  check(await sha256(bytes) === expectedHash, `${path} source hash drifted`);
  return bytes;
}

function copyFrame(event) {
  return {
    frameId: event.frameId,
    completedSlices: event.completedSlices,
    screen: new Uint8Array(event.packedScreen).slice(),
    palette: new Uint8Array(event.displayPalette).slice(),
  };
}

async function oneFrame(client, frames, presenter, entry, anchorMs) {
  const before = frames.length;
  const anchor = await client.pulse(anchorMs, inputSnapshot());
  check(anchor.type === "heartbeat" && anchor.tickCount === 0, "anchor pulse drifted");
  const heartbeat = await client.pulse(anchorMs + 1_000 / entry.targetFps, inputSnapshot());
  check(heartbeat.type === "heartbeat" && heartbeat.tickCount === 1, "frame pulse drifted");
  check(frames.length === before + 1, "production Worker did not publish one frame");
  const frame = frames.at(-1);
  presenter.reset(client.sessionGeneration);
  check(presenter.present({
    sessionGeneration: client.sessionGeneration,
    frameId: frame.frameId,
    packedScreen: frame.screen,
    displayPalette: frame.palette,
  }), "Canvas presenter rejected the current frame");
  const observation = frame.screen.subarray(0, entry.expected.length);
  check(hex(observation) === entry.expected.hex, "Chrome observation disagreed with Node");
  check(await sha256(frame.screen) === entry.expected.screenSha256,
    "Chrome packed screen disagreed with Node");
  return {
    frameId: frame.frameId,
    completedSlices: frame.completedSlices,
    observationHex: hex(observation),
    screenSha256: await sha256(frame.screen),
  };
}

async function run() {
  const manifest = await fetchJson(
    "/tests/conformance/manifests/phase-4d-graphics-memory-text.json",
  );
  const entry = manifest.cases[0];
  const [cart, faultCart] = await Promise.all([
    fetchBytes(entry.source, entry.sourceSha256),
    fetchBytes(manifest.faultCase.source, manifest.faultCase.sourceSha256),
  ]);
  const canvas = document.querySelector("#screen");
  const presenter = new Canvas2DFramePresenter(canvas);
  presenter.resize(128, 128);
  const client = new PlayerRuntimeClient(runtimeWorkerFactory, { commandTimeoutMs: 5_000 });
  const frames = [];
  const remove = client.onEvent((event) => {
    if (event.type === "frame") frames.push(copyFrame(event));
  });
  try {
    document.body.dataset.progress = "initial generation";
    const ready = await client.loadCart(cart, entry.instructionBudget);
    check(ready.type === "state" && ready.state === "ready", "4D cart did not load");
    check(ready.mode === entry.mode && ready.targetFps === entry.targetFps,
      "4D cart callback mode drifted");
    await client.start();
    const initial = await oneFrame(client, frames, presenter, entry, 1_000);
    await client.pause();

    document.body.dataset.progress = "cold reset";
    const resetReady = await client.reset();
    check(resetReady.type === "state" && resetReady.state === "ready", "reset failed");
    await client.start();
    const reset = await oneFrame(client, frames, presenter, entry, 10_000);
    check(JSON.stringify(reset) === JSON.stringify(initial), "Chrome reset was not exact");
    await client.pause();

    document.body.dataset.progress = "structured fault";
    let faultCode = null;
    try {
      await client.loadCart(faultCart, manifest.faultCase.instructionBudget);
    } catch (error) {
      faultCode = error?.record?.code ?? null;
    }
    check(faultCode === manifest.faultCase.expectedCode,
      `fault was not structured: ${faultCode}`);

    document.body.dataset.progress = "post-fault recovery";
    const recoveredReady = await client.loadCart(cart, entry.instructionBudget);
    check(recoveredReady.type === "state" && recoveredReady.state === "ready",
      "valid cart did not recover after fault");
    await client.start();
    const recovered = await oneFrame(client, frames, presenter, entry, 20_000);
    check(JSON.stringify(recovered) === JSON.stringify(initial),
      "post-fault recovery disagreed with initial oracle");
    check(workerErrors.length === 0, `production Worker errors: ${workerErrors.join("; ")}`);
    return {
      phase: "4D",
      apiCount: manifest.requiredApis.length,
      initial,
      reset,
      faultCode,
      recovered,
      sessionGeneration: client.sessionGeneration,
      workerErrors,
      userAgent: navigator.userAgent,
    };
  } finally {
    remove();
    await client.dispose();
  }
}

try {
  const result = await run();
  window.phase4dResult = result;
  resultNode.textContent = JSON.stringify(result);
  document.body.dataset.progress = "complete";
  document.body.dataset.status = "complete";
} catch (error) {
  resultNode.textContent = error instanceof Error
    ? `${error.message}\n${error.stack ?? ""}`
    : String(error);
  document.body.dataset.status = "error";
}
