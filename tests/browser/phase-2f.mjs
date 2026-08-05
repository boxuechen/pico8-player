import {
  mountPico8Player,
  PlayerRuntimeClient,
} from "../../apps/web-player/dist/main/main.js";

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

function asBytes(value) {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

async function sha256(value) {
  const source = asBytes(value);
  const copy = source.slice();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hex(value) {
  return [...asBytes(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fetchBytes(path) {
  const response = await fetch(`/${path}`);
  check(response.ok, `failed to fetch ${path}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function loadAssets(manifest) {
  const assets = new Map();
  for (const entry of manifest.cases) {
    const source = await fetchBytes(entry.source);
    check(await sha256(source) === entry.sourceSha256, `${entry.id} source hash drifted`);
    check(await sha256(source) === entry.cartSha256, `${entry.id} cart hash drifted`);
    assets.set(entry.id, source);
  }
  return assets;
}

function packedPixel(screen, x, y) {
  const packed = screen[y * 64 + (x >>> 1)];
  return (packed >>> ((x & 1) * 4)) & 0x0f;
}

function copyFrame(event) {
  return {
    frameId: event.frameId,
    completedSlices: event.completedSlices,
    timeRawBeforeStep: event.timeRawBeforeStep,
    targetFps: event.targetFps,
    screen: new Uint8Array(event.packedScreen).slice(),
    displayPalette: new Uint8Array(event.displayPalette).slice(),
  };
}

async function inspectFrame(frame) {
  return {
    frameId: frame.frameId,
    completedSlices: frame.completedSlices,
    timeRawBeforeStep: frame.timeRawBeforeStep,
    targetFps: frame.targetFps,
    screenSha256: await sha256(frame.screen),
    displayPaletteSha256: await sha256(frame.displayPalette),
  };
}

async function advanceFourFrames(client, frames, entry, anchorMs) {
  const beforeAnchor = frames.length;
  const anchor = await client.pulse(anchorMs, { buttons: 0 });
  check(anchor.type === "heartbeat" && anchor.tickCount === 0,
    `${entry.id} anchor advanced`);
  check(frames.length === beforeAnchor, `${entry.id} anchor published a frame`);

  const tickMs = 1_000 / entry.targetFps;
  const captured = [];
  for (let index = 0; index < 4; index += 1) {
    const before = frames.length;
    const heartbeat = await client.pulse(
      anchorMs + (index + 1) * tickMs,
      { buttons: 0 },
    );
    check(heartbeat.type === "heartbeat" && heartbeat.tickCount === 1,
      `${entry.id} frame ${index} did not execute exactly one tick`);
    check(frames.length === before + 1, `${entry.id} frame ${index} was not published`);
    captured.push(frames.at(-1));
  }
  const trace = [];
  for (const frame of captured) trace.push(await inspectFrame(frame));
  const finalFrame = captured.at(-1);
  return {
    trace,
    traceSha256: await sha256(encoder.encode(JSON.stringify(trace))),
    screenSha256: await sha256(finalFrame.screen),
    displayPaletteSha256: await sha256(finalFrame.displayPalette),
    displayPaletteHex: hex(finalFrame.displayPalette),
    finalFrame,
  };
}

function assertSemanticPixels(entry, screen) {
  for (const item of entry.expected.semanticPixels) {
    check(packedPixel(screen, item.x, item.y) === item.color,
      `${entry.id} pixel (${item.x},${item.y}) drifted`);
  }
}

function assertCapture(entry, capture, label) {
  check(capture.traceSha256 === entry.expected.traceSha256,
    `${entry.id} ${label} trace drifted`);
  check(capture.screenSha256 === entry.expected.screenSha256,
    `${entry.id} ${label} screen drifted`);
  check(capture.displayPaletteSha256 === entry.expected.displayPaletteSha256,
    `${entry.id} ${label} display palette drifted`);
  check(capture.displayPaletteHex === entry.expected.displayPaletteHex,
    `${entry.id} ${label} display palette bytes drifted`);
  assertSemanticPixels(entry, capture.finalFrame.screen);
}

async function deterministicCase(entry, cart) {
  const client = new PlayerRuntimeClient(runtimeWorkerFactory, { commandTimeoutMs: 3_000 });
  const frames = [];
  const remove = client.onEvent((event) => {
    if (event.type === "frame") frames.push(copyFrame(event));
  });
  try {
    const ready = await client.loadCart(cart, 2_000_000);
    check(ready.type === "state" && ready.state === "ready", `${entry.id} did not load`);
    check(ready.mode === entry.mode, `${entry.id} mode drifted`);
    check(ready.targetFps === entry.targetFps, `${entry.id} target fps drifted`);
    await client.start();
    const initial = await advanceFourFrames(client, frames, entry, 1_000);
    assertCapture(entry, initial, "initial");

    await client.reset();
    await client.start();
    const replay = await advanceFourFrames(client, frames, entry, 10_000);
    assertCapture(entry, replay, "cold reset");
    check(JSON.stringify(replay.trace) === JSON.stringify(initial.trace),
      `${entry.id} cold reset trace was not exact`);

    return {
      id: entry.id,
      mode: ready.mode,
      targetFps: ready.targetFps,
      cartSha256: entry.cartSha256,
      traceSha256: initial.traceSha256,
      finalScreenSha256: initial.screenSha256,
      displayPaletteSha256: initial.displayPaletteSha256,
      displayPaletteHex: initial.displayPaletteHex,
      resetTraceSha256: replay.traceSha256,
      resetScreenSha256: replay.screenSha256,
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

async function performanceProbe(entry, cart) {
  const client = new PlayerRuntimeClient(runtimeWorkerFactory, { commandTimeoutMs: 3_000 });
  try {
    await client.loadCart(cart, 2_000_000);
    await client.start();
    await client.pulse(0, { buttons: 0 });
    const warmupTicks = 20;
    const measuredTicks = 120;
    const durations = [];
    const tickMs = 1_000 / entry.targetFps;
    for (let index = 1; index <= warmupTicks + measuredTicks; index += 1) {
      const started = performance.now();
      const heartbeat = await client.pulse(index * tickMs, { buttons: 0 });
      const elapsed = performance.now() - started;
      check(heartbeat.type === "heartbeat" && heartbeat.tickCount === 1,
        `${entry.id} performance pulse ${index} drifted`);
      if (index > warmupTicks) durations.push(elapsed);
    }
    const p95Ms = percentile(durations, 0.95);
    check(p95Ms <= 8, `${entry.id} Worker round-trip p95 ${p95Ms}ms exceeded 8ms`);
    return {
      id: entry.id,
      warmupTicks,
      measuredTicks,
      p50Ms: median(durations),
      p95Ms,
      p99Ms: percentile(durations, 0.99),
      minMs: Math.min(...durations),
      maxMs: Math.max(...durations),
      over16_67Ms: durations.filter((value) => value > 1_000 / 60).length,
    };
  } finally {
    await client.dispose();
  }
}

async function canvasCase(controller, composition, canvas, entry, cart) {
  const frames = [];
  const remove = composition.runtime.onEvent((event) => {
    if (event.type === "frame") frames.push(copyFrame(event));
  });
  try {
    await controller.loadCart(cart, `${entry.id}.p8`);
    await controller.start();
    await waitFor(() => frames.length >= 4, `${entry.id} Canvas path did not produce four frames`);
    await controller.pause();
    const rgba = new Uint8Array(canvas.getContext("2d").getImageData(0, 0, 128, 128).data);
    const rgbaSha256 = await sha256(rgba);
    check(rgbaSha256 === entry.expected.rgbaSha256, `${entry.id} Canvas RGBA drifted`);
    const latest = frames.at(-1);
    check(await sha256(latest.screen) === entry.expected.screenSha256,
      `${entry.id} Canvas source screen drifted`);
    check(await sha256(latest.displayPalette) === entry.expected.displayPaletteSha256,
      `${entry.id} Canvas display palette drifted`);
    return {
      id: entry.id,
      frameCount: frames.length,
      finalFrameId: latest.frameId,
      screenSha256: await sha256(latest.screen),
      displayPaletteSha256: await sha256(latest.displayPalette),
      rgbaSha256,
    };
  } finally {
    remove();
  }
}

async function faultAndRecovery(controller, composition, elements, manifest, validCart) {
  const faultCart = await fetchBytes(manifest.faultCase.source);
  check(await sha256(faultCart) === manifest.faultCase.sourceSha256,
    "resource fault source hash drifted");
  let mainThreadResponsive = false;
  setTimeout(() => { mainThreadResponsive = true; }, 0);
  let caughtCode = null;
  try {
    await controller.loadCart(faultCart, "resource-limit-fault.p8");
    await controller.start();
    await waitFor(() => controller.state === "faulted", "resource fault was not contained");
  } catch (error) {
    caughtCode = error?.record?.code ?? null;
  }
  await waitFor(() => mainThreadResponsive, "main thread did not remain responsive");
  check(controller.state === "faulted", `fault state was ${controller.state}`);
  check(elements.diagnostic.textContent.includes(manifest.faultCase.expectedCode),
    `fault diagnostic was ${elements.diagnostic.textContent}`);
  if (caughtCode !== null) {
    check(caughtCode === manifest.faultCase.expectedCode, `caught fault code was ${caughtCode}`);
  }
  const faultSessionGeneration = composition.runtime.sessionGeneration;

  let recoveredFrames = 0;
  const remove = composition.runtime.onEvent((event) => {
    if (event.type === "frame") recoveredFrames += 1;
  });
  try {
    await controller.loadCart(validCart, "graphics-memory.p8");
    const recoverySessionGeneration = composition.runtime.sessionGeneration;
    check(recoverySessionGeneration > faultSessionGeneration,
      "recovery did not advance the session generation");
    await controller.start();
    await waitFor(() => recoveredFrames > 0, "valid cart did not recover after resource fault");
    await controller.pause();
    return {
      code: manifest.faultCase.expectedCode,
      caughtCode,
      cartSha256: manifest.faultCase.sourceSha256,
      mainThreadResponsive,
      faultSessionGeneration,
      recoverySessionGeneration,
      recoveredFrames,
    };
  } finally {
    remove();
  }
}

async function run() {
  const manifest = await fetch("/tests/conformance/manifests/phase-2f-exit.json")
    .then((response) => response.json());
  const assets = await loadAssets(manifest);

  document.body.dataset.progress = "deterministic production Worker matrix";
  const deterministic = [];
  for (const entry of manifest.cases) {
    deterministic.push(await deterministicCase(entry, assets.get(entry.id)));
  }

  document.body.dataset.progress = "production Canvas matrix";
  const mounted = await mountPico8Player({
    root: document.querySelector("#player"),
    runtimeWorkerFactory,
    commandTimeoutMs: 3_000,
  });
  const { controller, composition, elements } = mounted;
  try {
    const canvas = [];
    for (const entry of manifest.cases) {
      canvas.push(await canvasCase(
        controller,
        composition,
        elements.canvas,
        entry,
        assets.get(entry.id),
      ));
    }

    document.body.dataset.progress = "resource fault and generation recovery";
    const faultRecovery = await faultAndRecovery(
      controller,
      composition,
      elements,
      manifest,
      assets.get(manifest.cases[0].id),
    );

    document.body.dataset.progress = "representative Phase 2 performance";
    const performanceCases = [];
    for (const entry of manifest.cases) {
      performanceCases.push(await performanceProbe(entry, assets.get(entry.id)));
    }
    const maxP95Ms = Math.max(...performanceCases.map(({ p95Ms }) => p95Ms));
    check(maxP95Ms <= 8, `Phase 2 maximum Worker p95 ${maxP95Ms}ms exceeded 8ms`);

    return {
      schemaVersion: 1,
      phase: "2F",
      target: manifest.target,
      deterministic,
      canvas,
      performance: {
        cases: performanceCases,
        maxP95Ms,
      },
      faultRecovery,
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
