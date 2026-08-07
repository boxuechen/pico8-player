import { PlayerRuntimeClient } from "../../apps/web-player/dist/main/main.js";
import { inputSnapshot } from "../helpers/input.mjs";

const resultNode = document.querySelector("#result");
const workerErrors = [];

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function runtimeWorkerFactory() {
  const worker = new Worker("/apps/web-player/dist/browser/player-worker.mjs", { type: "module" });
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
  };
}

async function oneFrame(client, frames, entry, anchorMs) {
  const before = frames.length;
  const anchor = await client.pulse(anchorMs, inputSnapshot());
  check(anchor.type === "heartbeat" && anchor.tickCount === 0, `${entry.id} anchor drifted`);
  const heartbeat = await client.pulse(anchorMs + 1_000 / entry.targetFps, inputSnapshot());
  check(heartbeat.type === "heartbeat" && heartbeat.tickCount === 1, `${entry.id} frame pulse drifted`);
  check(frames.length === before + 1, `${entry.id} did not publish one frame`);
  const frame = frames.at(-1);
  const observation = frame.screen.subarray(0, entry.expected.length);
  check(hex(observation) === entry.expected.hex, `${entry.id} observation disagreed with Node`);
  check(await sha256(frame.screen) === entry.expected.screenSha256, `${entry.id} screen hash drifted`);
  return {
    observationHex: hex(observation),
    screenSha256: await sha256(frame.screen),
    completedSlices: frame.completedSlices,
  };
}

async function run() {
  const manifest = await fetchJson("/tests/conformance/manifests/phase-7f-required-api.json");
  const carts = new Map();
  for (const entry of [...manifest.cases, manifest.faultCase]) {
    carts.set(entry.id, await fetchBytes(entry.source, entry.sourceSha256));
  }

  const client = new PlayerRuntimeClient(runtimeWorkerFactory, { commandTimeoutMs: 5_000 });
  const frames = [];
  const remove = client.onEvent((event) => {
    if (event.type === "frame") frames.push(copyFrame(event));
  });
  const cases = [];
  try {
    let anchorMs = 1_000;
    for (const entry of manifest.cases) {
      document.body.dataset.progress = entry.id;
      const ready = await client.loadCart(carts.get(entry.id), entry.instructionBudget);
      check(ready.type === "state" && ready.state === "ready", `${entry.id} did not load`);
      check(ready.mode === entry.mode && ready.targetFps === entry.targetFps, `${entry.id} mode drifted`);
      await client.start();
      const initial = await oneFrame(client, frames, entry, anchorMs);
      await client.pause();

      const resetReady = await client.reset();
      check(resetReady.type === "state" && resetReady.state === "ready", `${entry.id} reset failed`);
      await client.start();
      const reset = await oneFrame(client, frames, entry, anchorMs + 1_000);
      await client.pause();
      check(JSON.stringify(reset) === JSON.stringify(initial), `${entry.id} reset replay drifted`);
      cases.push({ id: entry.id, initial, reset });
      anchorMs += 10_000;
    }

    document.body.dataset.progress = "fault containment";
    let faultCode = null;
    try {
      await client.loadCart(carts.get(manifest.faultCase.id), manifest.faultCase.instructionBudget);
    } catch (error) {
      faultCode = error?.record?.code ?? null;
    }
    check(faultCode === manifest.faultCase.expectedCode, `fault was not structured: ${faultCode}`);

    const recoveryEntry = manifest.cases[0];
    const recoveredReady = await client.loadCart(carts.get(recoveryEntry.id), recoveryEntry.instructionBudget);
    check(recoveredReady.type === "state" && recoveredReady.state === "ready", "fresh generation did not recover");
    await client.start();
    const recovered = await oneFrame(client, frames, recoveryEntry, 50_000);
    check(JSON.stringify(recovered) === JSON.stringify(cases[0].initial), "recovered generation drifted");
    check(workerErrors.length === 0, `production Worker errors: ${workerErrors.join("; ")}`);

    return {
      phase: "7F",
      apiCount: manifest.requiredApis.length,
      cases,
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
  window.phase7fResult = result;
  resultNode.textContent = JSON.stringify(result);
  document.body.dataset.progress = "complete";
  document.body.dataset.status = "complete";
} catch (error) {
  resultNode.textContent = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  document.body.dataset.status = "error";
}
