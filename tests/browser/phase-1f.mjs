import { mountPico8Player } from "../../apps/web-player/dist/main/main.js";
import { inputSnapshot } from "../helpers/input.mjs";
import {
  PlayerRuntimeClient,
} from "../../apps/web-player/dist/main/player-runtime-client.js";

const resultNode = document.querySelector("#result");
const encoder = new TextEncoder();

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(predicate, message, timeoutMs = 10_000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function runtimeWorkerFactory() {
  const worker = new Worker(
    "/apps/web-player/dist/browser/player-worker.mjs",
    { type: "module" },
  );
  worker.addEventListener("error", (event) => {
    document.body.dataset.workerError = `${event.message} @ ${event.filename}:${event.lineno}`;
  });
  return worker;
}

async function sha256(bytes) {
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", source.slice().buffer));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fetchBytes(path) {
  const response = await fetch(`/${path}`);
  check(response.ok, `failed to fetch ${path}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function injectedP8Png() {
  const encoded = globalThis.__phase1fP8PngBase64;
  check(typeof encoded === "string" && encoded.length > 0, "generated .p8.png was not injected");
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function textCart(source) {
  return encoder.encode(
    `pico-8 cartridge // http://www.pico-8.com\nversion 43\n__lua__\n${source}\n`,
  );
}

function inspectFrame(event) {
  return sha256(new Uint8Array(event.packedScreen)).then((screenSha256) => ({
    frameId: event.frameId,
    completedSlices: event.completedSlices,
    timeRawBeforeStep: event.timeRawBeforeStep,
    targetFps: event.targetFps,
    screenSha256,
  }));
}

async function loadAssets(manifest) {
  const assets = new Map();
  for (const entry of manifest.cases) {
    const source = await fetchBytes(entry.source);
    const cart = entry.format === "p8png-generated" ? injectedP8Png() : source.slice();
    check(await sha256(source) === entry.sourceSha256, `${entry.id} source hash drifted`);
    check(await sha256(cart) === entry.cartSha256, `${entry.id} cart hash drifted`);
    assets.set(entry.id, { source, cart });
  }
  return assets;
}

async function deterministicCase(entry, cart) {
  const client = new PlayerRuntimeClient(runtimeWorkerFactory, { commandTimeoutMs: 2_000 });
  const frames = [];
  const remove = client.onEvent((event) => {
    if (event.type === "frame") frames.push(event);
  });
  try {
    const ready = await client.loadCart(cart, 100_000);
    check(ready.type === "state" && ready.state === "ready", `${entry.id} did not load`);
    check(ready.mode === entry.mode, `${entry.id} mode was ${ready.mode}`);
    check(ready.targetFps === entry.targetFps, `${entry.id} fps was ${ready.targetFps}`);
    await client.start();
    const anchor = await client.pulse(1_000, inputSnapshot([0, 0, 0, 0, 0, 0, 0, 0]));
    check(anchor.type === "heartbeat" && anchor.tickCount === 0, `${entry.id} anchor advanced`);

    const tickMs = 1_000 / entry.targetFps;
    const trace = [];
    for (let index = 0; index < entry.inputTrace.length; index += 1) {
      const before = frames.length;
      const heartbeat = await client.pulse(
        1_000 + (index + 1) * tickMs,
        inputSnapshot([entry.inputTrace[index], 0, 0, 0, 0, 0, 0, 0]),
      );
      check(heartbeat.type === "heartbeat" && heartbeat.tickCount === 1,
        `${entry.id} frame ${index} tick count drifted`);
      check(frames.length === before + 1, `${entry.id} frame ${index} was not published`);
      trace.push(await inspectFrame(frames.at(-1)));
    }

    const final = trace.at(-1);
    const traceSha256 = await sha256(encoder.encode(JSON.stringify(trace)));
    check(final.frameId === entry.expected.finalFrameId, `${entry.id} final frame id drifted`);
    check(final.completedSlices === entry.expected.completedSlices,
      `${entry.id} completed slices drifted`);
    check(final.timeRawBeforeStep === entry.expected.timeRawBeforeStep,
      `${entry.id} logical time drifted`);
    check(final.screenSha256 === entry.expected.screenSha256, `${entry.id} screen drifted`);
    check(traceSha256 === entry.expected.traceSha256, `${entry.id} trace digest drifted`);

    await client.reset();
    await client.start();
    await client.pulse(10_000, inputSnapshot([0, 0, 0, 0, 0, 0, 0, 0]));
    const beforeResetFrame = frames.length;
    const resetHeartbeat = await client.pulse(10_000 + tickMs, inputSnapshot([0, 0, 0, 0, 0, 0, 0, 0]));
    check(resetHeartbeat.type === "heartbeat" && resetHeartbeat.tickCount === 1,
      `${entry.id} reset tick drifted`);
    check(frames.length === beforeResetFrame + 1, `${entry.id} reset frame was not published`);
    const resetFrame = await inspectFrame(frames.at(-1));
    check(resetFrame.frameId === 0, `${entry.id} reset frame id did not restart`);
    check(resetFrame.completedSlices === entry.reset.completedSlices,
      `${entry.id} reset slices drifted`);
    check(resetFrame.timeRawBeforeStep === entry.reset.timeRawBeforeStep,
      `${entry.id} reset time drifted`);
    check(resetFrame.screenSha256 === entry.reset.screenSha256,
      `${entry.id} reset screen drifted`);

    return {
      id: entry.id,
      mode: ready.mode,
      targetFps: ready.targetFps,
      cartSha256: entry.cartSha256,
      traceSha256,
      finalScreenSha256: final.screenSha256,
      resetScreenSha256: resetFrame.screenSha256,
      workerGeneration: client.workerGeneration,
      resetSessionGeneration: client.sessionGeneration,
    };
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

function key(type, code) {
  window.dispatchEvent(new KeyboardEvent(type, {
    code,
    bubbles: true,
    cancelable: true,
  }));
}

function paletteColorAt(canvas, x, y) {
  const data = canvas.getContext("2d").getImageData(x, y, 1, 1).data;
  const palette = [
    [0x00, 0x00, 0x00], [0x1d, 0x2b, 0x53], [0x7e, 0x25, 0x53],
    [0x00, 0x87, 0x51], [0xab, 0x52, 0x36], [0x5f, 0x57, 0x4f],
    [0xc2, 0xc3, 0xc7], [0xff, 0xf1, 0xe8], [0xff, 0x00, 0x4d],
    [0xff, 0xa3, 0x00], [0xff, 0xec, 0x27], [0x00, 0xe4, 0x36],
    [0x29, 0xad, 0xff], [0x83, 0x76, 0x9c], [0xff, 0x77, 0xa8],
    [0xff, 0xcc, 0xaa],
  ];
  return palette.findIndex(([red, green, blue]) =>
    data[0] === red && data[1] === green && data[2] === blue && data[3] === 0xff);
}

function findColorX(canvas, y, color) {
  for (let x = 0; x < 128; x += 1) {
    if (paletteColorAt(canvas, x, y) === color) return x;
  }
  return -1;
}

async function runRafCase(controller, composition, canvas, entry, cart, keyboard = false) {
  const frames = [];
  let ready;
  const remove = composition.runtime.onEvent((event) => {
    if (event.type === "state" && event.state === "ready") ready = event;
    if (event.type === "frame") {
      frames.push({
        atMs: performance.now(),
        frameId: event.frameId,
        completedSlices: event.completedSlices,
        timeRawBeforeStep: event.timeRawBeforeStep,
        targetFps: event.targetFps,
      });
    }
  });
  try {
    await controller.loadCart(cart, `${entry.id}.cart`);
    check(ready?.mode === entry.mode && ready?.targetFps === entry.targetFps,
      `${entry.id} UI ready metadata drifted`);
    await controller.start();
    await waitFor(() => frames.length >= 3, `${entry.id} real rAF did not produce frames`);
    let keyboardResult;
    if (keyboard) {
      const beforeX = findColorX(canvas, 8, 7);
      const beforeCount = frames.length;
      key("keydown", "ArrowRight");
      key("keydown", "KeyZ");
      await waitFor(() => frames.length >= beforeCount + 3, "keyboard input had no visible frames");
      key("keyup", "KeyZ");
      key("keyup", "ArrowRight");
      await waitFor(() => frames.length >= beforeCount + 4, "keyboard release had no visible frame");
      const afterX = findColorX(canvas, 8, 7);
      const pressCountColor = paletteColorAt(canvas, 1, 24);
      check(afterX > beforeX, `keyboard did not move cart: ${beforeX} -> ${afterX}`);
      check(pressCountColor === 9, "btnp edge was not visible in the next frames");
      keyboardResult = { beforeX, afterX, pressCountColor };
    }
    await waitFor(() => frames.length >= 16, `${entry.id} rAF sample was incomplete`);
    await controller.pause();
    check(controller.state === "paused", `${entry.id} did not pause after rAF sample`);
    const sample = frames.slice(3, 16);
    const intervals = sample.slice(1).map((frame, index) => frame.atMs - sample[index].atMs);
    check(sample.every((frame) => frame.targetFps === entry.targetFps),
      `${entry.id} frame target fps drifted`);
    for (let index = 1; index < sample.length; index += 1) {
      check(sample[index].frameId === sample[index - 1].frameId + 1,
        `${entry.id} rAF frame ids were not continuous`);
      check(BigInt(sample[index].completedSlices) === BigInt(sample[index - 1].completedSlices) + 1n,
        `${entry.id} rAF slices were not continuous`);
    }
    return {
      id: entry.id,
      frameCount: frames.length,
      medianIntervalMs: median(intervals),
      p95IntervalMs: percentile(intervals, 0.95),
      firstFrameId: sample[0].frameId,
      lastFrameId: sample.at(-1).frameId,
      keyboard: keyboardResult,
    };
  } finally {
    key("keyup", "KeyZ");
    key("keyup", "ArrowRight");
    remove();
  }
}

async function performanceProbe(cart) {
  const client = new PlayerRuntimeClient(runtimeWorkerFactory, { commandTimeoutMs: 2_000 });
  try {
    await client.loadCart(cart, 100_000);
    await client.start();
    await client.pulse(0, inputSnapshot([0, 0, 0, 0, 0, 0, 0, 0]));
    const durations = [];
    const tickMs = 1_000 / 60;
    const warmupTicks = 20;
    const measuredTicks = 120;
    for (let index = 1; index <= warmupTicks + measuredTicks; index += 1) {
      const started = performance.now();
      const heartbeat = await client.pulse(index * tickMs, inputSnapshot([0, 0, 0, 0, 0, 0, 0, 0]));
      const elapsed = performance.now() - started;
      check(heartbeat.type === "heartbeat" && heartbeat.tickCount === 1,
        `performance pulse ${index} did not execute exactly one tick`);
      if (index > warmupTicks) durations.push(elapsed);
    }
    const p95Ms = percentile(durations, 0.95);
    const overFrameBudget = durations.filter((value) => value > 1000 / 60).length;
    check(p95Ms <= 8, `ordinary 60Hz Worker round-trip p95 ${p95Ms}ms exceeded 8ms`);
    return {
      warmupTicks,
      measuredTicks,
      p50Ms: median(durations),
      p95Ms,
      p99Ms: percentile(durations, 0.99),
      minMs: Math.min(...durations),
      maxMs: Math.max(...durations),
      over16_67Ms: overFrameBudget,
      over16_67Ratio: overFrameBudget / durations.length,
    };
  } finally {
    await client.dispose();
  }
}

async function run() {
  const manifest = await fetch("/tests/conformance/manifests/phase-1f-l1-exit.json")
    .then((response) => response.json());
  const assets = await loadAssets(manifest);

  document.body.dataset.progress = "deterministic production Worker matrix";
  const deterministic = [];
  for (const entry of manifest.cases) {
    deterministic.push(await deterministicCase(entry, assets.get(entry.id).cart));
  }

  document.body.dataset.progress = "real rAF and keyboard matrix";
  const mounted = await mountPico8Player({
    root: document.querySelector("#player"),
    runtimeWorkerFactory,
    commandTimeoutMs: 2_000,
  });
  const { controller, composition, elements } = mounted;
  const entries = Object.fromEntries(manifest.cases.map((entry) => [entry.id, entry]));
  const raf = [];
  try {
    raf.push(await runRafCase(
      controller,
      composition,
      elements.canvas,
      entries["l1/callback-30-input"],
      assets.get("l1/callback-30-input").cart,
      true,
    ));
    raf.push(await runRafCase(
      controller,
      composition,
      elements.canvas,
      entries["l1/callback-60-p8png"],
      assets.get("l1/callback-60-p8png").cart,
    ));
    raf.push(await runRafCase(
      controller,
      composition,
      elements.canvas,
      entries["l1/custom-flip-30"],
      assets.get("l1/custom-flip-30").cart,
    ));
    const thirty = raf.find(({ id }) => id === "l1/callback-30-input");
    const sixty = raf.find(({ id }) => id === "l1/callback-60-p8png");
    check(thirty.medianIntervalMs >= sixty.medianIntervalMs * 1.5,
      `real rAF did not distinguish 30/60Hz: ${thirty.medianIntervalMs}/${sixty.medianIntervalMs}`);

    document.body.dataset.progress = "clean boot stop";
    await controller.loadCart(textCart("stop()"), "clean-boot-stop.p8");
    check(controller.state === "stopped", "clean boot stop was incorrectly exposed as ready");

    document.body.dataset.progress = "fault UI and recovery";
    const faultCart = await fetchBytes(manifest.faultCase.source);
    check(await sha256(faultCart) === manifest.faultCase.sourceSha256,
      "fault cart source hash drifted");
    let mainThreadResponsive = false;
    setTimeout(() => { mainThreadResponsive = true; }, 0);
    await controller.loadCart(faultCart, "instruction-budget-fault.p8");
    await controller.start();
    await waitFor(() => controller.state === "faulted", "instruction budget fault was not contained");
    check(mainThreadResponsive, "main thread did not remain responsive during guest fault");
    check(elements.diagnostic.textContent.includes(manifest.faultCase.expectedCode),
      `fault UI reported ${elements.diagnostic.textContent}`);
    const faultSessionGeneration = composition.runtime.sessionGeneration;
    await controller.reset();
    check(controller.state === "ready", "retained fault cart did not cold reset to ready");
    const resetSessionGeneration = composition.runtime.sessionGeneration;
    check(resetSessionGeneration > faultSessionGeneration, "fault reset did not advance generation");
    await controller.loadCart(
      assets.get("l1/callback-30-input").cart,
      "callback-30-input.p8",
    );
    await controller.start();
    await waitFor(() => composition.presenter.lastFrameId >= 2, "valid cart did not reload after fault");
    await controller.pause();

    document.body.dataset.progress = "ordinary 60Hz performance";
    const performanceResult = await performanceProbe(
      assets.get("l1/callback-60-p8png").cart,
    );

    return {
      schemaVersion: 1,
      phase: "1F",
      target: manifest.target,
      deterministic,
      raf,
      faultRecovery: {
        code: manifest.faultCase.expectedCode,
        cartSha256: manifest.faultCase.sourceSha256,
        mainThreadResponsive,
        faultSessionGeneration,
        resetSessionGeneration,
        reloadedFrameId: composition.presenter.lastFrameId,
      },
      performance: performanceResult,
      finalWorkerGeneration: composition.runtime.workerGeneration,
      finalSessionGeneration: composition.runtime.sessionGeneration,
      userAgent: navigator.userAgent,
      workerError: document.body.dataset.workerError ?? null,
    };
  } finally {
    await controller.dispose();
  }
}

try {
  const result = await run();
  resultNode.textContent = JSON.stringify(result);
  document.body.dataset.progress = "complete";
  document.body.dataset.status = "complete";
} catch (error) {
  resultNode.textContent = error instanceof Error
    ? `${error.message}\n${error.stack ?? ""}`
    : String(error);
  document.body.dataset.status = "error";
}
