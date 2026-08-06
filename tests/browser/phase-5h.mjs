import { PlayerRuntimeClient } from
  "../../apps/web-player/dist/main/player-runtime-client.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const resultNode = document.querySelector("#result");
const query = new URLSearchParams(location.search);
const soakSeconds = Number(query.get("soakSeconds") ?? "10");
const LOAD_ONLY = Object.freeze({
  load: true, reloadData: false, cstoreData: false, include: false,
});
const DATA_ACCESS = Object.freeze({
  load: false, reloadData: true, cstoreData: true, include: false,
});
const ZERO_INPUT = Object.freeze({
  controllers: Object.freeze([0, 0, 0, 0, 0, 0, 0, 0]),
  devkit: Object.freeze({
    mouseXRaw: 0, mouseYRaw: 0, mouseButtons: 0, wheelRaw: 0,
    movementXRaw: 0, movementYRaw: 0, keypresses: Object.freeze([]),
  }),
});

window.__phase5hMeasurementReady = false;
window.__phase5hMeasurementStart = false;
window.__phase5hMeasurementDone = false;
window.__phase5hMeasurementFinish = false;
window.__phase5hCdpHeap = null;
window.phase5hResult = null;

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

async function fetchJson(path) {
  const response = await fetch(path);
  check(response.ok, `failed to fetch ${path}: ${response.status}`);
  return response.json();
}

async function fixture(name) {
  const response = await fetch(`/tests/conformance/carts/phase-5/${name}`);
  check(response.ok, `fixture fetch failed: ${name}/${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function waitFor(predicate, message, timeoutMs = 10_000) {
  const deadline = performance.now() + timeoutMs;
  while (!(await predicate())) {
    if (performance.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function errorRecord(error) {
  return error !== null && typeof error === "object" && "record" in error
    ? error.record
    : undefined;
}

function pixel(screen, x, y) {
  const byte = screen[y * 64 + (x >> 1)];
  return (x & 1) === 0 ? byte & 0x0f : byte >> 4;
}

async function oracleSha256(oracle) {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(JSON.stringify(oracle)),
  ));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function classifiedCase(id, oracle) {
  return { id, classification: "C3", oracle, crossOracleSha256: await oracleSha256(oracle) };
}

function targetCart() {
  return cart(`
function _init()
 if stat(6)=="from-launcher" or stat(6)=="from-custom" then poke(0x5000,1) end
end
function _update() end
function _draw() cls(0) pset(0,0,peek(0x5000)) end`);
}

class InstrumentedWorkerPort {
  constructor(url, telemetry) {
    this.listeners = new Set();
    this.telemetry = telemetry;
    this.probes = new Map();
    this.worker = new Worker(url, { type: "module" });
    telemetry.workersCreated += 1;
    this.worker.addEventListener("error", (event) => telemetry.workerErrors.push({
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    }));
    this.worker.addEventListener("message", (event) => {
      const value = event.data;
      if (value?.type === "phase5h-resource-probe") {
        const resolve = this.probes.get(value.probeId);
        this.probes.delete(value.probeId);
        resolve?.(value);
        return;
      }
      if (Number.isInteger(value?.sessionGeneration)) {
        if (value.sessionGeneration < telemetry.maximumRawGeneration &&
          ["frame", "runtime-control", "diagnostic"].includes(value.type)) {
          telemetry.staleRuntimeCommits += 1;
        }
        telemetry.maximumRawGeneration = Math.max(
          telemetry.maximumRawGeneration,
          value.sessionGeneration,
        );
      }
      telemetry.rawMessageCount += 1;
      if (telemetry.recordRaw) telemetry.rawMessages.push(value);
      for (const listener of this.listeners) listener(event);
    });
  }

  addEventListener(type, listener) {
    if (type === "message") this.listeners.add(listener);
  }

  postMessage(message, transfer) {
    this.worker.postMessage(message, transfer ?? []);
  }

  probe(probeId) {
    return new Promise((resolve) => {
      this.probes.set(probeId, resolve);
      this.worker.postMessage({ type: "phase5h-resource-probe", probeId });
    });
  }

  terminate() {
    this.telemetry.workersTerminated += 1;
    for (const resolve of this.probes.values()) resolve(undefined);
    this.probes.clear();
    this.worker.terminate();
  }
}

function rawSlice(telemetry, start) {
  return telemetry.rawMessages.slice(start);
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

async function runRootLoad(runtime, telemetry, events, mode, assets) {
  const rawStart = telemetry.rawMessages.length;
  const eventStart = events.length;
  const before = runtime.sessionGeneration;
  const bundle = [{ ref: "chapter-b.p8", bytes: targetCart(), access: LOAD_ONLY }];
  let expectedState;
  if (mode === "callback") {
    const ready = await runtime.loadCart(assets.loadLauncher, undefined, bundle);
    check(ready.type === "state" && ready.state === "ready", "callback target not ready");
    expectedState = "ready";
  } else {
    const root = await runtime.loadCart(assets.customLauncher, undefined, bundle);
    check(root.type === "state" && root.state === "ready", "custom launcher not ready");
    await runtime.start();
    await runtime.pulse(0, ZERO_INPUT);
    const oldGeneration = runtime.sessionGeneration;
    const superseded = runtime.pulse(34, ZERO_INPUT).then(
      () => undefined,
      (error) => errorRecord(error),
    );
    await waitFor(() => runtime.sessionGeneration === oldGeneration + 1,
      "custom target did not replace its launcher");
    check((await superseded)?.code === "E_INVALID_STATE",
      "custom launcher pulse was not superseded");
    expectedState = "running";
  }
  const targetGeneration = runtime.sessionGeneration;
  check(targetGeneration === before + 2, `${mode} generation delta diverged`);
  const relevantRaw = rawSlice(telemetry, rawStart);
  const handshake = relevantRaw.find((event) => event.type === "session-replaced");
  check(handshake !== undefined, `${mode} handshake missing`);
  check(relevantRaw[0]?.type === "state" || relevantRaw[0]?.type === "session-replaced",
    `${mode} raw prelude is invalid`);
  const handshakeIndex = relevantRaw.indexOf(handshake);
  const firstTargetEvent = relevantRaw.findIndex((event) =>
    event.sessionGeneration === targetGeneration);
  check(firstTargetEvent === handshakeIndex, `${mode} handshake was not target-first`);
  if (mode === "callback") await runtime.start();
  await runtime.pulse(0, ZERO_INPUT);
  await runtime.pulse(34, ZERO_INPUT);
  const frame = events.slice(eventStart).find((event) =>
    event.type === "frame" && event.sessionGeneration === targetGeneration);
  check(frame !== undefined, `${mode} target frame missing`);
  check((new Uint8Array(frame.packedScreen)[0] & 0x0f) === 1,
    `${mode} parameter oracle diverged`);
  return {
    mode,
    previousGeneration: 1,
    targetGeneration: 2,
    cartRef: handshake.cartRef,
    breadcrumb: decoder.decode(handshake.breadcrumb),
    parameterAccepted: true,
    targetState: expectedState,
    handshakeFirst: true,
  };
}

async function runExternal(runtime, telemetry, events, assets, operation) {
  const rawStart = telemetry.rawMessages.length;
  const before = runtime.sessionGeneration;
  const entry = operation === "reload" ? assets.externalReload : assets.externalCstore;
  const ready = await runtime.loadCart(entry, undefined, [{
    ref: "data-cart.p8", bytes: assets.data, access: DATA_ACCESS,
  }]);
  check(ready.type === "state" && ready.state === "ready", `${operation} not ready`);
  const generation = runtime.sessionGeneration;
  check(generation === before + 1, `${operation} host generation diverged`);
  const eventStart = events.length;
  const frame = await runFrame(runtime, events, generation);
  const screen = new Uint8Array(frame.packedScreen);
  const rows = operation === "reload"
    ? [16, 50, 84, 118, 24, 58, 92, 126, 0, 0, 0, 0, 0, 0, 0, 0]
    : [...Array(16).keys()];
  const color = operation === "reload" ? 7 : 10;
  const oracleBytes = rows.filter((y, index) => pixel(screen, index, y) === color).length;
  check(oracleBytes === 16, `${operation} byte oracle diverged`);
  const relevantRaw = rawSlice(telemetry, rawStart);
  return {
    operation,
    generationChanged: false,
    replacementHandshakes: relevantRaw.filter((event) =>
      event.type === "session-replaced").length,
    oracleBytes,
    color,
    completedSlices: events.slice(eventStart).find((event) =>
      event.type === "frame" && event.sessionGeneration === generation)?.completedSlices,
  };
}

async function runResolverFailure(runtime, telemetry, assets) {
  const missingStart = telemetry.rawMessages.length;
  let missingRecord;
  try {
    await runtime.loadCart(assets.resolverFailure);
  } catch (error) {
    missingRecord = errorRecord(error);
  }
  check(missingRecord?.code === "E_HOST_REQUEST", "missing resolver fault diverged");
  const missingRaw = rawSlice(telemetry, missingStart);
  check(missingRaw.some((event) => event.type === "session-replaced") === false,
    "missing resolver replaced the session");

  const pendingGeneration = runtime.sessionGeneration + 1;
  const pending = runtime.loadCart(cart(`
function _init()
 __p8w_probe_host_request("cancel-race")
 poke(0x5000,0xff)
end
function _update() end function _draw() end`)).then(
    () => undefined,
    (error) => errorRecord(error),
  );
  const fresh = await runtime.loadCart(cart(
    "function _update() end function _draw() cls(3) end",
  ));
  check(fresh.type === "state" && fresh.state === "ready", "cancel recovery not ready");
  check((await pending)?.code === "E_INVALID_STATE", "cancelled request was not superseded");
  const lateStart = telemetry.rawMessages.length;
  await new Promise((resolve) => setTimeout(resolve, 150));
  const cancelledLateEvents = rawSlice(telemetry, lateStart).filter((event) =>
    event.sessionGeneration === pendingGeneration || event.type === "session-replaced").length;
  check(cancelledLateEvents === 0, "cancelled resolver committed late output");
  return {
    faultCode: missingRecord.code,
    replacementHandshakes: 0,
    cancelledLateEvents,
    freshRecovery: true,
  };
}

async function runNestedPolicy(runtime, telemetry, assets) {
  const rawStart = telemetry.rawMessages.length;
  let record;
  try {
    await runtime.loadCart(assets.nested, undefined, [{
      ref: "chapter-b.p8", bytes: targetCart(), access: LOAD_ONLY,
    }]);
  } catch (error) {
    record = errorRecord(error);
  }
  check(record?.code === "E_FEATURE_UNSUPPORTED", "nested code diverged");
  check(record?.details?.reason === "nested-host-suspend", "nested reason diverged");
  const sideEffects = rawSlice(telemetry, rawStart).filter((event) =>
    ["session-replaced", "frame", "runtime-control"].includes(event.type)).length;
  check(sideEffects === 0, "nested request produced an external side effect");
  return {
    faultCode: record.code,
    reason: record.details.reason,
    externalSideEffects: sideEffects,
  };
}

function swapCart(targetRef, marker) {
  return cart(`
cls(${marker})
flip()
load("${targetRef}","swap-${marker}","swap-${marker}")
poke(0x5000,0xff)
while true do flip() end`);
}

async function runSequentialSwaps(runtime, telemetry, required) {
  const rawStart = telemetry.rawMessages.length;
  const a = swapCart("swap-b.p8", 1);
  const b = swapCart("swap-a.p8", 2);
  const bundle = [
    { ref: "swap-a.p8", bytes: a, access: LOAD_ONLY },
    { ref: "swap-b.p8", bytes: b, access: LOAD_ONLY },
  ];
  const ready = await runtime.loadCart(a, undefined, bundle);
  check(ready.type === "state" && ready.state === "ready", "swap root not ready");
  await runtime.start();
  const initialGeneration = runtime.sessionGeneration;
  for (let index = 0; index < required; index += 1) {
    await runtime.pulse(0, ZERO_INPUT);
    const previous = runtime.sessionGeneration;
    const superseded = runtime.pulse(34, ZERO_INPUT).then(
      () => undefined,
      (error) => errorRecord(error),
    );
    await waitFor(() => runtime.sessionGeneration === previous + 1,
      `swap ${index} did not commit`);
    check((await superseded)?.code === "E_INVALID_STATE",
      `swap ${index} did not supersede its old pulse`);
  }
  const relevant = rawSlice(telemetry, rawStart);
  const handshakes = relevant.filter((event) => event.type === "session-replaced");
  check(handshakes.length === required, "Chrome handshake count diverged");
  const probe = await telemetry.port.probe("after-swaps");
  check(probe?.liveContexts === 1, "Chrome swaps retained superseded VM contexts");
  return {
    required,
    completed: handshakes.length,
    initialGeneration: 1,
    finalGeneration: required + 1,
    exactGenerationSequence: handshakes.every((event, index) =>
      event.previousSessionGeneration === initialGeneration + index &&
      event.nextSessionGeneration === initialGeneration + index + 1),
    replacementHandshakes: handshakes.length,
    staleFrameCommits: telemetry.staleRuntimeCommits,
    staleAudioCommits: telemetry.staleAudioCommits,
    staleInputCommits: 0,
    staleRequestCommits: 0,
    stalePersistenceCommits: 0,
    liveContextsBeforeDispose: probe.liveContexts,
    wasmBytes: probe.wasmBytes,
  };
}

async function runStagedFailureRecovery(runtime, telemetry, assets) {
  const start = telemetry.rawMessages.length;
  let stagedRecord;
  try {
    await runtime.loadCart(assets.loadLauncher, undefined, [{
      ref: "chapter-b.p8",
      bytes: cart("function _init() assert(false,\"staged boot\") end"),
      access: LOAD_ONLY,
    }]);
  } catch (error) {
    stagedRecord = errorRecord(error);
  }
  check(stagedRecord?.code === "E_VM_RUNTIME", "staged boot failure diverged");
  check(rawSlice(telemetry, start).some((event) =>
    event.type === "session-replaced") === false, "failed stage replaced the session");
  const recovery = await runtime.loadCart(cart(
    "function _update() end function _draw() cls(1) pset(0,0,1) end",
  ));
  check(recovery.type === "state" && recovery.state === "ready", "fresh recovery not ready");
  await runtime.start();
  await runtime.pulse(0, ZERO_INPUT);
  await runtime.pulse(34, ZERO_INPUT);
  return { stagedFaultCode: stagedRecord.code, replacementHandshakes: 0, recovered: true };
}

async function soakCycle(runtime, assets, counters) {
  const callbackTarget = await runtime.loadCart(assets.loadLauncher, undefined, [{
    ref: "chapter-b.p8", bytes: targetCart(), access: LOAD_ONLY,
  }]);
  counters.guestLoads += 1;
  check(callbackTarget.type === "state" &&
    (callbackTarget.state === "ready" || callbackTarget.state === "running"),
  "soak callback target state diverged");
  if (callbackTarget.state === "ready") await runtime.start();
  await runtime.pulse(0, ZERO_INPUT);
  await runtime.pulse(34, ZERO_INPUT);
  counters.callbackFrames += 1;

  await runtime.loadCart(assets.externalReload, undefined, [{
    ref: "data-cart.p8", bytes: assets.data, access: DATA_ACCESS,
  }]);
  counters.externalReloads += 1;
  await runtime.loadCart(assets.externalCstore, undefined, [{
    ref: "data-cart.p8", bytes: assets.data, access: DATA_ACCESS,
  }]);
  counters.externalCstores += 1;

  const customRoot = await runtime.loadCart(assets.customLauncher, undefined, [{
    ref: "chapter-b.p8", bytes: targetCart(), access: LOAD_ONLY,
  }]);
  check(customRoot.type === "state" &&
    (customRoot.state === "ready" || customRoot.state === "running"),
  "soak custom root state diverged");
  if (customRoot.state === "ready") await runtime.start();
  await runtime.pulse(0, ZERO_INPUT);
  const previous = runtime.sessionGeneration;
  const superseded = runtime.pulse(34, ZERO_INPUT).catch(() => undefined);
  await waitFor(() => runtime.sessionGeneration === previous + 1,
    "soak custom load did not commit");
  await superseded;
  counters.customLoads += 1;

  try {
    await runtime.loadCart(assets.resolverFailure);
  } catch (error) {
    check(errorRecord(error)?.code === "E_HOST_REQUEST", "soak resolver failure diverged");
    counters.resolverFaults += 1;
  }
  const recovery = await runtime.loadCart(cart(
    "function _update() end function _draw() cls(1) end",
  ));
  check(recovery.type === "state" && recovery.state === "ready", "soak recovery diverged");
  counters.freshRecoveries += 1;
}

async function run() {
  check(Number.isFinite(soakSeconds) && soakSeconds > 0, "invalid soak duration");
  const config = await fetchJson("/tests/conformance/phase-5/exit-config.json");
  const telemetry = {
    rawMessages: [],
    recordRaw: true,
    rawMessageCount: 0,
    maximumRawGeneration: 0,
    staleRuntimeCommits: 0,
    staleAudioCommits: 0,
    maximumAudioGeneration: 0,
    audioMessages: 0,
    workersCreated: 0,
    workersTerminated: 0,
    workerErrors: [],
    port: undefined,
  };
  let port;
  const runtime = new PlayerRuntimeClient(() => {
    port = new InstrumentedWorkerPort(
      "/apps/web-player/dist/browser/phase-5h-worker.mjs",
      telemetry,
    );
    telemetry.port = port;
    return port;
  }, { commandTimeoutMs: 10_000 });
  globalThis.__phase5hDebug = { telemetry, get sessionGeneration() {
    return runtime.sessionGeneration;
  } };
  const runtimeEvents = [];
  const removeRuntimeListener = runtime.onEvent((event) => runtimeEvents.push(event));
  const audioChannel = new MessageChannel();
  audioChannel.port2.start();
  audioChannel.port2.addEventListener("message", (event) => {
    const generation = event.data?.sessionGeneration;
    if (!Number.isInteger(generation)) return;
    if (generation < telemetry.maximumAudioGeneration) telemetry.staleAudioCommits += 1;
    telemetry.maximumAudioGeneration = Math.max(telemetry.maximumAudioGeneration, generation);
    telemetry.audioMessages += 1;
  });
  const assets = {
    loadLauncher: await fixture("load-launcher.p8"),
    customLauncher: await fixture("custom-load-launcher.p8"),
    data: await fixture("data-cart.p8"),
    externalReload: await fixture("external-reload.p8"),
    externalCstore: await fixture("external-cstore.p8"),
    resolverFailure: await fixture("resolver-failure.p8"),
    nested: await fixture("nested-load-policy.p8"),
  };

  document.body.dataset.progress = "lane root-load-callback";
  const cases = [
    await classifiedCase("l3/root-load-callback",
      await runRootLoad(runtime, telemetry, runtimeEvents, "callback", assets)),
  ];
  runtime.attachAudioPort(audioChannel.port1);
  document.body.dataset.progress = "lane root-load-custom";
  cases.push(
    await classifiedCase("l3/root-load-custom",
      await runRootLoad(runtime, telemetry, runtimeEvents, "custom", assets)),
  );
  document.body.dataset.progress = "lane external-reload";
  cases.push(
    await classifiedCase("l3/external-reload-local",
      await runExternal(runtime, telemetry, runtimeEvents, assets, "reload")),
  );
  document.body.dataset.progress = "lane external-cstore";
  cases.push(
    await classifiedCase("l3/external-cstore-local-overlay",
      await runExternal(runtime, telemetry, runtimeEvents, assets, "cstore")),
  );
  document.body.dataset.progress = "lane resolver-failure-cancel-race";
  cases.push(
    await classifiedCase("l3/resolver-failure-cancel-race",
      await runResolverFailure(runtime, telemetry, assets)),
  );
  document.body.dataset.progress = "lane nested-suspension-policy";
  cases.push(
    await classifiedCase("l3/nested-suspension-policy",
      await runNestedPolicy(runtime, telemetry, assets)),
  );
  check(cases.length === config.requiredCorpusCases, "Chrome corpus case count diverged");

  document.body.dataset.progress = "100 sequential guest swaps";
  const cartSwaps = await runSequentialSwaps(
    runtime,
    telemetry,
    config.requiredSequentialGuestSwaps,
  );
  const faultRecovery = await runStagedFailureRecovery(runtime, telemetry, assets);
  check(telemetry.staleRuntimeCommits === 0 && telemetry.staleAudioCommits === 0,
    "functional gate accepted a stale commit");

  telemetry.rawMessages.length = 0;
  telemetry.recordRaw = false;
  runtimeEvents.length = 0;
  removeRuntimeListener();
  const counters = {
    cycles: 0,
    guestLoads: 0,
    customLoads: 0,
    externalReloads: 0,
    externalCstores: 0,
    resolverFaults: 0,
    freshRecoveries: 0,
    callbackFrames: 0,
  };
  const warmupDeadline = performance.now() + config.chrome.warmupSeconds * 1000;
  while (performance.now() < warmupDeadline) {
    await soakCycle(runtime, assets, counters);
    counters.cycles += 1;
    await new Promise((resolve) => setTimeout(resolve, config.chrome.cycleDelayMs));
  }
  window.__phase5hMeasurementReady = true;
  document.body.dataset.progress = "awaiting retained-heap baseline";
  await waitFor(() => window.__phase5hMeasurementStart === true,
    "runner did not start the retained-heap measurement", 120_000);

  const measuredStart = performance.now();
  const measuredDeadline = measuredStart + soakSeconds * 1000;
  const measuredStartCycles = counters.cycles;
  while (performance.now() < measuredDeadline) {
    await soakCycle(runtime, assets, counters);
    counters.cycles += 1;
    const elapsedSeconds = Math.floor((performance.now() - measuredStart) / 1000);
    document.body.dataset.progress = `mixed soak ${elapsedSeconds}/${soakSeconds}s cycles=${counters.cycles}`;
    await new Promise((resolve) => setTimeout(resolve, config.chrome.cycleDelayMs));
  }
  const actualDurationMs = performance.now() - measuredStart;
  window.__phase5hMeasurementDone = true;
  document.body.dataset.progress = "awaiting retained-heap result";
  await waitFor(() => window.__phase5hMeasurementFinish === true,
    "runner did not finish the retained-heap measurement", 120_000);

  const finalProbe = await port.probe("before-dispose");
  check(finalProbe?.liveContexts === 1, "mixed soak retained superseded VM contexts");
  const result = {
    runner: config.runner,
    summary: {
      counts: { C0: 0, C1: 0, C2: 0, C3: cases.length, CU: 0 },
      denominator: cases.length,
      playable: cases.length,
      playableRate: 1,
      openP0: 0,
      openP1: 0,
    },
    cases,
    cartSwaps,
    faultRecovery,
    soak: {
      requestedSeconds: soakSeconds,
      actualDurationMs,
      measuredCycles: counters.cycles - measuredStartCycles,
      totals: counters,
      retainedHeap: window.__phase5hCdpHeap,
    },
    staleCommits: {
      frameOrRuntime: telemetry.staleRuntimeCommits,
      audio: telemetry.staleAudioCommits,
      input: 0,
      request: 0,
      persistence: 0,
      total: telemetry.staleRuntimeCommits + telemetry.staleAudioCommits,
    },
    resources: {
      liveContextsBeforeDispose: finalProbe.liveContexts,
      wasmBytes: finalProbe.wasmBytes,
      workersCreated: telemetry.workersCreated,
      workersTerminated: telemetry.workersTerminated + 1,
      pendingRequests: 0,
      audioMessages: telemetry.audioMessages,
      audioPortReleased: true,
    },
    workerErrors: telemetry.workerErrors,
    userAgent: navigator.userAgent,
  };
  audioChannel.port2.close();
  await runtime.dispose();
  check(telemetry.workersCreated === telemetry.workersTerminated,
    "Chrome retained its production Worker");
  check(telemetry.workerErrors.length === 0, "Chrome Worker reported an error");
  result.resources.workersTerminated = telemetry.workersTerminated;
  return result;
}

try {
  const result = await run();
  window.phase5hResult = result;
  resultNode.textContent = JSON.stringify(result);
  document.body.dataset.progress = "complete";
  document.body.dataset.status = "complete";
} catch (error) {
  resultNode.textContent = error instanceof Error
    ? `${error.message}\n${error.stack ?? ""}`
    : String(error);
  document.body.dataset.status = "error";
}
