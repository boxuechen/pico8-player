import {
  PlayerRuntimeClient,
} from "../../apps/web-player/dist/main/player-runtime-client.js";

const encoder = new TextEncoder();
const resultNode = document.querySelector("#result");
const LOAD_ONLY = Object.freeze({
  load: true,
  reloadData: false,
  cstoreData: false,
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

function cart(lua) {
  return encoder.encode(`pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
${lua}
`);
}

async function fixture(name) {
  const response = await fetch(`/tests/conformance/carts/phase-5/${name}`);
  if (!response.ok) throw new Error(`fixture fetch failed: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function targetCart(parameter) {
  return cart(`
function _init()
 if stat(6)=="${parameter}" then poke(0x5000,1) end
end
function _update() end
function _draw()
 cls(0)
 pset(0,0,peek(0x5000))
end`);
}

function waitFor(predicate, message, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const poll = () => {
      if (predicate()) resolve();
      else if (performance.now() - started > timeoutMs) reject(new Error(message));
      else setTimeout(poll, 5);
    };
    poll();
  });
}

async function run() {
  const rawMessages = [];
  const workerErrors = [];
  const workers = [];
  globalThis.__phase5dDebug = { rawMessages, workerErrors };
  const runtime = new PlayerRuntimeClient(() => {
    const worker = new Worker(
      "/apps/web-player/dist/browser/phase-5d-worker.mjs",
      { type: "module" },
    );
    workers.push(worker);
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

  document.body.dataset.progress = "callback replacement";
  const callbackTarget = targetCart("from-launcher");
  const callbackResult = await runtime.loadCart(
    await fixture("load-launcher.p8"),
    undefined,
    [{ ref: "chapter-b.p8", bytes: callbackTarget, access: LOAD_ONLY }],
  );
  check(callbackResult.type === "state" && callbackResult.state === "ready",
    "callback target did not become ready");
  check(runtime.sessionGeneration === 2, "callback swap did not advance to generation 2");
  await runtime.start();
  await runtime.pulse(0, ZERO_INPUT);
  await runtime.pulse(34, ZERO_INPUT);
  const callbackFrame = events.find((event) =>
    event.type === "frame" && event.sessionGeneration === 2);
  check((new Uint8Array(callbackFrame.packedScreen)[0] & 0x0f) === 1,
    "callback target did not receive stat(6)");

  document.body.dataset.progress = "custom replacement";
  const customTarget = targetCart("from-custom");
  const customRoot = await runtime.loadCart(
    await fixture("custom-load-launcher.p8"),
    undefined,
    [{ ref: "chapter-b.p8", bytes: customTarget, access: LOAD_ONLY }],
  );
  check(customRoot.type === "state" && customRoot.state === "ready" &&
    customRoot.sessionGeneration === 3, "custom launcher did not load in generation 3");
  await runtime.start();
  await runtime.pulse(0, ZERO_INPUT);
  const supersededPulse = runtime.pulse(34, ZERO_INPUT).then(
    () => "resolved",
    (error) => error?.record?.code ?? "rejected",
  );
  await waitFor(
    () => runtime.sessionGeneration === 4 && events.some((event) =>
      event.type === "state" && event.state === "running" &&
      event.sessionGeneration === 4),
    "custom target did not atomically replace the running launcher",
  );
  check(await supersededPulse === "E_INVALID_STATE",
    "old custom pulse was not invalidated by replacement");
  await runtime.pulse(68, ZERO_INPUT);
  await runtime.pulse(102, ZERO_INPUT);
  const customFrame = events.find((event) =>
    event.type === "frame" && event.sessionGeneration === 4);
  check((new Uint8Array(customFrame.packedScreen)[0] & 0x0f) === 1,
    "custom target did not receive stat(6)");

  const callbackHandshake = rawMessages.find((event) =>
    event.type === "session-replaced" && event.nextSessionGeneration === 2);
  const customHandshake = rawMessages.find((event) =>
    event.type === "session-replaced" && event.nextSessionGeneration === 4);
  check(new TextDecoder().decode(callbackHandshake.breadcrumb) === "back to launcher",
    "callback breadcrumb was not committed");
  check(new TextDecoder().decode(customHandshake.breadcrumb) === "back from custom",
    "custom breadcrumb was not committed");
  for (const generation of [2, 4]) {
    const first = rawMessages.find((event) => event.sessionGeneration === generation);
    check(first?.type === "session-replaced", `generation ${generation} did not handshake first`);
  }
  const handshakeCount = rawMessages.filter((event) => event.type === "session-replaced").length;
  const staleFrames = rawMessages.filter((event) => event.type === "frame" &&
    event.sessionGeneration !== 2 && event.sessionGeneration !== 4).length;
  check(generations.join(",") === "1,2,3,4", `unexpected generation sequence: ${generations}`);
  check(staleFrames === 0, "a stale launcher frame crossed the replacement boundary");
  check(workerErrors.length === 0, "Chrome Worker reported an error");

  const result = {
    handshakeCount,
    generations,
    callbackPixel: new Uint8Array(callbackFrame.packedScreen)[0] & 0x0f,
    customPixel: new Uint8Array(customFrame.packedScreen)[0] & 0x0f,
    staleFrames,
    workerCount: workers.length,
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
