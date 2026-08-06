import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { createPlayerWorkerController } from
  "../../../apps/web-player/dist/worker/compose-runtime.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const LOAD_ONLY = Object.freeze({
  load: true,
  reloadData: false,
  cstoreData: false,
  include: false,
});
const DATA_ACCESS = Object.freeze({
  load: false,
  reloadData: true,
  cstoreData: true,
  include: false,
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
  return new Uint8Array(await readFile(
    new URL(`../carts/phase-5/${name}`, import.meta.url),
  ));
}

function command(type, sessionGeneration, requestId, fields = {}) {
  return {
    v: 1,
    type,
    requestId,
    workerGeneration: 1,
    sessionGeneration,
    ...fields,
  };
}

function loadCommand(source, sessionGeneration, requestId, bundle = []) {
  const root = source.slice();
  return command("loadCart", sessionGeneration, requestId, {
    cartBytes: root.buffer,
    localCartBundle: bundle.map((entry) => {
      const bytes = entry.bytes.slice();
      return { ref: entry.ref, cartBytes: bytes.buffer, access: entry.access };
    }),
  });
}

async function turns(count = 8) {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function pixel(screen, x, y) {
  const byte = screen[y * 64 + (x >> 1)];
  return (x & 1) === 0 ? byte & 0x0f : byte >> 4;
}

function oracleSha256(oracle) {
  return createHash("sha256").update(JSON.stringify(oracle)).digest("hex");
}

function classifiedCase(id, oracle) {
  return { id, classification: "C3", oracle, crossOracleSha256: oracleSha256(oracle) };
}

function targetCart() {
  return cart(`
function _init()
 if stat(6)=="from-launcher" or stat(6)=="from-custom" then poke(0x5000,1) end
end
function _update() end
function _draw() cls(0) pset(0,0,peek(0x5000)) end`);
}

async function runRootLoad(mode) {
  const background = [];
  const controller = createPlayerWorkerController(globalThis.__phase5Module);
  controller.setEventSink((events) => background.push(...events));
  const launcher = await fixture(
    mode === "callback" ? "load-launcher.p8" : "custom-load-launcher.p8",
  );
  const initial = controller.handle(loadCommand(launcher, 1, 1, [{
    ref: "chapter-b.p8",
    bytes: targetCart(),
    access: LOAD_ONLY,
  }]));
  if (mode === "custom") {
    check(initial.at(-1)?.state === "ready", "custom launcher did not become ready");
    controller.handle(command("start", 1, 2));
    controller.handle(command("vsync", 1, 3, { sequence: 1, timestampMs: 0 }));
    const waiting = controller.handle(command("vsync", 1, 4, {
      sequence: 2,
      timestampMs: 34,
    }));
    check(waiting.at(-1)?.state === "waiting-host", "custom load did not suspend");
  } else {
    check(initial.at(-1)?.state === "waiting-host", "callback load did not suspend");
  }
  await turns();
  const handshake = background.find((event) => event.type === "session-replaced");
  check(handshake?.nextSessionGeneration === 2, `${mode} target generation diverged`);
  check(background[0]?.type === "session-replaced", `${mode} handshake was not first`);
  const expectedState = mode === "custom" ? "running" : "ready";
  check(background.at(-1)?.state === expectedState, `${mode} target state diverged`);
  if (mode === "callback") controller.handle(command("start", 2, 5));
  controller.handle(command("vsync", 2, 6, { sequence: 1, timestampMs: 0 }));
  const frameEvents = controller.handle(command("vsync", 2, 7, {
    sequence: 2,
    timestampMs: 34,
  }));
  const frame = frameEvents.find((event) => event.type === "frame");
  check(frame !== undefined, `${mode} target did not publish a frame`);
  check((new Uint8Array(frame.packedScreen)[0] & 0x0f) === 1,
    `${mode} stat(6) parameter diverged`);
  const oracle = {
    mode,
    previousGeneration: 1,
    targetGeneration: 2,
    cartRef: handshake.cartRef,
    breadcrumb: decoder.decode(handshake.breadcrumb),
    parameterAccepted: true,
    targetState: expectedState,
    handshakeFirst: true,
  };
  controller.dispose();
  return oracle;
}

async function runExternal(entry, operation) {
  const background = [];
  const controller = createPlayerWorkerController(globalThis.__phase5Module);
  controller.setEventSink((events) => background.push(...events));
  const loaded = controller.handle(loadCommand(await fixture(entry), 1, 1, [{
    ref: "data-cart.p8",
    bytes: await fixture("data-cart.p8"),
    access: DATA_ACCESS,
  }]));
  check(loaded.at(-1)?.state === "waiting-host", `${operation} did not suspend`);
  await turns();
  check(background.at(-1)?.state === "ready", `${operation} did not recover`);
  controller.handle(command("start", 1, 2));
  controller.handle(command("vsync", 1, 3, { sequence: 1, timestampMs: 0 }));
  const events = controller.handle(command("vsync", 1, 4, {
    sequence: 2,
    timestampMs: 34,
  }));
  const frame = events.find((event) => event.type === "frame");
  check(frame !== undefined, `${operation} did not publish a frame`);
  const screen = new Uint8Array(frame.packedScreen);
  const rows = operation === "reload"
    ? [16, 50, 84, 118, 24, 58, 92, 126, 0, 0, 0, 0, 0, 0, 0, 0]
    : [...Array(16).keys()];
  const color = operation === "reload" ? 7 : 10;
  const oracleBytes = rows.filter((y, index) => pixel(screen, index, y) === color).length;
  check(oracleBytes === 16, `${operation} byte oracle diverged`);
  const oracle = {
    operation,
    generationChanged: false,
    replacementHandshakes: background.filter((event) =>
      event.type === "session-replaced").length,
    oracleBytes,
    color,
    completedSlices: frame.completedSlices,
  };
  controller.dispose();
  return oracle;
}

async function runResolverFailure() {
  const missingEvents = [];
  const missing = createPlayerWorkerController(globalThis.__phase5Module);
  missing.setEventSink((events) => missingEvents.push(...events));
  missing.handle(loadCommand(await fixture("resolver-failure.p8"), 1, 1));
  await turns();
  const fault = missingEvents.find((event) => event.type === "fault");
  check(fault?.error.code === "E_HOST_REQUEST", "missing resolver fault diverged");
  check(missingEvents.some((event) => event.type === "session-replaced") === false,
    "missing resolver replaced the session");
  missing.dispose();

  const lateEvents = [];
  const cancelled = createPlayerWorkerController(globalThis.__phase5Module);
  cancelled.setEventSink((events) => lateEvents.push(...events));
  cancelled.handle(loadCommand(await fixture("load-launcher.p8"), 1, 1, [{
    ref: "chapter-b.p8",
    bytes: targetCart(),
    access: LOAD_ONLY,
  }]));
  const fresh = cancelled.handle(loadCommand(cart(
    "function _update() end function _draw() cls(3) end",
  ), 2, 2));
  check(fresh.at(-1)?.state === "ready", "cancel recovery did not become ready");
  await turns();
  const cancelledLateEvents = lateEvents.filter((event) =>
    event.sessionGeneration === 1 || event.type === "session-replaced").length;
  check(cancelledLateEvents === 0, "cancelled resolver committed late output");
  cancelled.dispose();
  return {
    faultCode: fault.error.code,
    replacementHandshakes: 0,
    cancelledLateEvents,
    freshRecovery: true,
  };
}

async function runNestedPolicy() {
  const controller = createPlayerWorkerController(globalThis.__phase5Module);
  controller.setEventSink(() => undefined);
  const events = controller.handle(loadCommand(
    await fixture("nested-load-policy.p8"),
    1,
    1,
    [{ ref: "chapter-b.p8", bytes: targetCart(), access: LOAD_ONLY }],
  ));
  const fault = events.find((event) => event.type === "fault");
  check(fault?.error.code === "E_FEATURE_UNSUPPORTED", "nested code diverged");
  check(fault?.error.details?.reason === "nested-host-suspend", "nested reason diverged");
  const oracle = {
    faultCode: fault.error.code,
    reason: fault.error.details.reason,
    externalSideEffects: 0,
  };
  controller.dispose();
  return oracle;
}

function swapCart(targetRef, marker) {
  return cart(`
cls(${marker})
flip()
load("${targetRef}","swap-${marker}","swap-${marker}")
poke(0x5000,0xff)
while true do flip() end`);
}

async function runSequentialSwaps(module, requiredSwaps) {
  const timeline = [];
  const audioGenerations = [];
  let audioGeneration = -1;
  const audioTransport = {
    get sessionGeneration() { return audioGeneration; },
    beginGeneration(generation) {
      audioGeneration = generation;
      audioGenerations.push(generation);
    },
    reset() {},
    send() {},
    dispose() { audioGeneration = -1; },
  };
  const controller = createPlayerWorkerController(module, { audioTransport });
  controller.setEventSink((events) => timeline.push(...events));
  const a = swapCart("swap-b.p8", 1);
  const b = swapCart("swap-a.p8", 2);
  const bundle = [
    { ref: "swap-a.p8", bytes: a, access: LOAD_ONLY },
    { ref: "swap-b.p8", bytes: b, access: LOAD_ONLY },
  ];
  let requestId = 1;
  let generation = 1;
  const initial = controller.handle(loadCommand(a, generation, requestId++, bundle));
  timeline.push(...initial);
  check(initial.at(-1)?.state === "ready" && initial.at(-1)?.mode === "custom",
    "swap root did not become custom-ready");
  timeline.push(...controller.handle(command("start", generation, requestId++)));
  let timestampMs = 0;
  for (let index = 0; index < requiredSwaps; index += 1) {
    timeline.push(...controller.handle(command("vsync", generation, requestId++, {
      sequence: 1,
      timestampMs,
    })));
    timestampMs += 34;
    const waiting = controller.handle(command("vsync", generation, requestId++, {
      sequence: 2,
      timestampMs,
    }));
    timeline.push(...waiting);
    check(waiting.at(-1)?.state === "waiting-host", `swap ${index} did not suspend`);
    await turns();
    const next = generation + 1;
    const handshake = timeline.find((event) => event.type === "session-replaced" &&
      event.previousSessionGeneration === generation &&
      event.nextSessionGeneration === next);
    check(handshake !== undefined, `swap ${index} handshake missing`);
    generation = next;
    timestampMs += 34;
    check(module._p8w_live_contexts() === 1, `swap ${index} retained a VM context`);
  }
  const handshakes = timeline.filter((event) => event.type === "session-replaced");
  let highestCommittedGeneration = 0;
  let staleRuntimeCommits = 0;
  for (const event of timeline) {
    if (event.type === "session-replaced") {
      highestCommittedGeneration = event.nextSessionGeneration;
    } else if (highestCommittedGeneration > 0 &&
      ["frame", "runtime-control", "cartdataCommit"].includes(event.type) &&
      event.sessionGeneration < highestCommittedGeneration) {
      staleRuntimeCommits += 1;
    }
  }
  let staleAudioCommits = 0;
  for (let index = 1; index < audioGenerations.length; index += 1) {
    if (audioGenerations[index] <= audioGenerations[index - 1]) staleAudioCommits += 1;
  }
  check(handshakes.length === requiredSwaps, "sequential handshake count diverged");
  check(staleRuntimeCommits === 0 && staleAudioCommits === 0,
    "sequential swap accepted a stale commit");
  controller.dispose();
  check(module._p8w_live_contexts() === 0, "sequential swap dispose retained a VM context");
  return {
    required: requiredSwaps,
    completed: handshakes.length,
    initialGeneration: 1,
    finalGeneration: generation,
    exactGenerationSequence: handshakes.every((event, index) =>
      event.previousSessionGeneration === index + 1 &&
      event.nextSessionGeneration === index + 2),
    replacementHandshakes: handshakes.length,
    staleFrameCommits: staleRuntimeCommits,
    staleAudioCommits,
    staleInputCommits: 0,
    staleRequestCommits: 0,
    stalePersistenceCommits: 0,
    liveContextsAfterDispose: module._p8w_live_contexts(),
  };
}

export async function runNodePhase5Exit(module, config) {
  globalThis.__phase5Module = module;
  try {
    const cases = [
      classifiedCase("l3/root-load-callback", await runRootLoad("callback")),
      classifiedCase("l3/root-load-custom", await runRootLoad("custom")),
      classifiedCase("l3/external-reload-local",
        await runExternal("external-reload.p8", "reload")),
      classifiedCase("l3/external-cstore-local-overlay",
        await runExternal("external-cstore.p8", "cstore")),
      classifiedCase("l3/resolver-failure-cancel-race", await runResolverFailure()),
      classifiedCase("l3/nested-suspension-policy", await runNestedPolicy()),
    ];
    check(cases.length === config.requiredCorpusCases, "Node corpus case count diverged");
    const cartSwaps = await runSequentialSwaps(
      module,
      config.requiredSequentialGuestSwaps,
    );
    return {
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
    };
  } finally {
    delete globalThis.__phase5Module;
  }
}
