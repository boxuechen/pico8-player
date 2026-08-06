import { PlayerRuntimeClient } from
  "../../apps/web-player/dist/main/player-runtime-client.js";

const resultNode = document.querySelector("#result");
const DATA_ACCESS = Object.freeze({
  load: false,
  reloadData: true,
  cstoreData: true,
  include: false,
});
const ZERO_INPUT = Object.freeze({
  controllers: Object.freeze([0, 0, 0, 0, 0, 0, 0, 0]),
  devkit: Object.freeze({
    mouseXRaw: 0, mouseYRaw: 0, mouseButtons: 0, wheelRaw: 0,
    movementXRaw: 0, movementYRaw: 0, keypresses: Object.freeze([]),
  }),
});

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function fixture(name) {
  const response = await fetch(`/tests/conformance/carts/phase-5/${name}`);
  if (!response.ok) throw new Error(`fixture fetch failed: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function pixel(screen, x, y) {
  const byte = screen[y * 64 + (x >> 1)];
  return (x & 1) === 0 ? byte & 0x0f : byte >> 4;
}

async function runFrame(runtime, events, generation) {
  await runtime.start();
  await runtime.pulse(0, ZERO_INPUT);
  await runtime.pulse(34, ZERO_INPUT);
  const frame = events.find((event) =>
    event.type === "frame" && event.sessionGeneration === generation);
  check(frame !== undefined, `generation ${generation} did not publish a frame`);
  return frame;
}

async function run() {
  const rawMessages = [];
  const workerErrors = [];
  globalThis.__phase5eDebug = { rawMessages, workerErrors };
  const runtime = new PlayerRuntimeClient(() => {
    const worker = new Worker(
      "/apps/web-player/dist/browser/phase-5e-worker.mjs",
      { type: "module" },
    );
    worker.addEventListener("message", (event) => rawMessages.push(event.data));
    worker.addEventListener("error", (event) => workerErrors.push({
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      error: String(event.error),
    }));
    return worker;
  }, { commandTimeoutMs: 3000 });
  const events = [];
  const generations = [];
  runtime.onEvent((event) => events.push(event));
  runtime.onSessionGenerationChange((generation) => generations.push(generation));
  const dataCart = await fixture("data-cart.p8");
  const bundle = [{ ref: "data-cart.p8", bytes: dataCart, access: DATA_ACCESS }];

  document.body.dataset.progress = "external reload";
  const reloadReady = await runtime.loadCart(
    await fixture("external-reload.p8"),
    undefined,
    bundle,
  );
  check(reloadReady.type === "state" && reloadReady.state === "ready",
    "external reload did not resume to ready");
  check(runtime.sessionGeneration === 1, "external reload changed its generation");
  const reloadFrame = await runFrame(runtime, events, 1);
  const reloadScreen = new Uint8Array(reloadFrame.packedScreen);
  const reloadRows = [16, 50, 84, 118, 24, 58, 92, 126, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let index = 0; index < 16; index += 1) {
    check(pixel(reloadScreen, index, reloadRows[index]) === 7,
      `external reload byte ${index} diverged`);
  }

  document.body.dataset.progress = "external cstore";
  const cstoreReady = await runtime.loadCart(
    await fixture("external-cstore.p8"),
    undefined,
    bundle,
  );
  check(cstoreReady.type === "state" && cstoreReady.state === "ready",
    "external cstore/reload did not resume to ready");
  check(runtime.sessionGeneration === 2, "external cstore changed its generation");
  const cstoreFrame = await runFrame(runtime, events, 2);
  const cstoreScreen = new Uint8Array(cstoreFrame.packedScreen);
  for (let index = 0; index < 16; index += 1) {
    check(pixel(cstoreScreen, index, index) === 10,
      `external cstore byte ${index} diverged`);
  }

  const handshakeCount = rawMessages.filter((event) =>
    event.type === "session-replaced").length;
  const waitingCount = rawMessages.filter((event) =>
    event.type === "state" && event.state === "waiting-host").length;
  check(handshakeCount === 0, "external cart-data emitted a replacement handshake");
  check(waitingCount >= 3, "Chrome did not observe reload/cstore suspension boundaries");
  check(generations.join(",") === "1,2", `unexpected generation sequence: ${generations}`);
  check(workerErrors.length === 0, "Chrome Worker reported an error");

  const result = {
    handshakeCount,
    waitingCount,
    generations,
    reloadCompletedSlices: reloadFrame.completedSlices,
    cstoreCompletedSlices: cstoreFrame.completedSlices,
    reloadOracle: 16,
    cstoreOracle: 16,
    workerErrors,
    finalSessionGeneration: runtime.sessionGeneration,
    userAgent: navigator.userAgent,
  };
  await runtime.dispose();
  return result;
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
