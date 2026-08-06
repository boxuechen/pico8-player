import { PlayerRuntimeClient } from
  "../../apps/web-player/dist/main/player-runtime-client.js";

const encoder = new TextEncoder();
const resultNode = document.querySelector("#result");
const ALL_DATA_ACCESS = Object.freeze({
  load: true,
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
const SUSPENSION_SURFACES = Object.freeze([
  { name: "flip", statement: "flip()" },
  { name: "run", statement: "run(\"nested-run\")" },
  { name: "stop", statement: "stop(\"nested-stop\")" },
  { name: "load", statement: "load(\"chapter-b.p8\",\"nested\",\"nested\")" },
  { name: "reload", statement: "reload(0x5000,0,1,\"data-cart.p8\")" },
  { name: "cstore", statement: "cstore(0,0x5000,1,\"data-cart.p8\")" },
  { name: "diagnostic", statement: "__p8w_probe_host_request(\"nested-probe\")" },
]);
const EXECUTION_MODES = Object.freeze(["callback", "custom"]);
const NESTING_DEPTHS = Object.freeze(["single", "multi"]);

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

function nestedAttempt(statement, depth) {
  const resume = depth === "single"
    ? `local leaf=cocreate(function() ${statement} end)
 local ok,value=pcall(function()
  local resumed,result=coresume(leaf)
  poke(0x5001,resumed and 1 or 2)
 end)`
    : `local leaf=cocreate(function() ${statement} end)
 local middle=cocreate(function()
  local resumed,result=coresume(leaf)
  poke(0x5002,resumed and 1 or 2)
 end)
 local ok,value=pcall(function()
  local resumed,result=coresume(middle)
  poke(0x5001,resumed and 1 or 2)
 end)`;
  return `local function attempt_nested()
 poke(0x5000,0x5a)
 ${resume}
 poke(0x5003,ok and 1 or 2)
end`;
}

function nestedCart(surface, mode, depth) {
  const attempt = nestedAttempt(surface.statement, depth);
  if (mode === "callback") {
    return cart(`${attempt}
local attempted=false
function _update()
 if not attempted then
  attempted=true
  attempt_nested()
 end
end
function _draw() cls(0) pset(0,0,7) end`);
  }
  return cart(`${attempt}
flip()
attempt_nested()
poke(0x5004,1)
while true do flip() end`);
}

function errorRecord(error) {
  return error !== null && typeof error === "object" && "record" in error
    ? error.record
    : undefined;
}

async function expectNestedFault(runtime, rawMessages, source, bundle, label) {
  const ready = await runtime.loadCart(source, undefined, bundle);
  const generation = runtime.sessionGeneration;
  check(ready.type === "state" && ready.state === "ready", `${label} did not become ready`);
  await runtime.start();
  await runtime.pulse(0, ZERO_INPUT);
  let record;
  try {
    await runtime.pulse(34, ZERO_INPUT);
  } catch (error) {
    record = errorRecord(error);
  }
  check(record?.code === "E_FEATURE_UNSUPPORTED", `${label} did not fault unsupported`);
  check(record?.details?.reason === "nested-host-suspend", `${label} reason diverged`);
  const events = rawMessages.filter((event) => event.sessionGeneration === generation);
  check(events.filter((event) => event.type === "fault").length === 1,
    `${label} fault count diverged`);
  check(events.some((event) => event.type === "state" && event.state === "waiting-host") === false,
    `${label} reached a host resolver`);
  check(events.some((event) => event.type === "session-replaced") === false,
    `${label} replaced the session`);
  check(events.some((event) => event.type === "frame") === false,
    `${label} published a frame`);
  check(events.some((event) => event.type === "runtime-control") === false,
    `${label} published run/stop control`);
  return { label, generation };
}

async function run() {
  const rawMessages = [];
  const workerErrors = [];
  globalThis.__phase5fDebug = { rawMessages, workerErrors };
  const runtime = new PlayerRuntimeClient(() => {
    const worker = new Worker(
      "/apps/web-player/dist/browser/phase-5f-worker.mjs",
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

  const chapter = cart("function _update() end function _draw() cls(2) end");
  const data = await fixture("data-cart.p8");
  const bundle = [
    { ref: "chapter-b.p8", bytes: chapter, access: ALL_DATA_ACCESS },
    { ref: "data-cart.p8", bytes: data, access: ALL_DATA_ACCESS },
  ];
  const matrix = [];
  for (const surface of SUSPENSION_SURFACES) {
    for (const mode of EXECUTION_MODES) {
      for (const depth of NESTING_DEPTHS) {
        const label = `${surface.name}/${mode}/${depth}`;
        document.body.dataset.progress = label;
        matrix.push(await expectNestedFault(
          runtime,
          rawMessages,
          nestedCart(surface, mode, depth),
          bundle,
          label,
        ));
      }
    }
  }
  check(matrix.length === 28, "Chrome suspension matrix is incomplete");
  check(new Set(matrix.map(({ label }) => label)).size === 28,
    "Chrome suspension matrix contains duplicates");

  document.body.dataset.progress = "corpus lane";
  let corpusRecord;
  try {
    await runtime.loadCart(await fixture("nested-load-policy.p8"), undefined, bundle);
  } catch (error) {
    corpusRecord = errorRecord(error);
  }
  const corpusGeneration = runtime.sessionGeneration;
  check(corpusRecord?.code === "E_FEATURE_UNSUPPORTED", "corpus lane did not classify C3");
  check(corpusRecord?.details?.reason === "nested-host-suspend",
    "corpus lane reason diverged");
  const corpusEvents = rawMessages.filter((event) =>
    event.sessionGeneration === corpusGeneration);
  check(corpusEvents.some((event) => event.type === "session-replaced") === false,
    "corpus lane replaced the session");
  check(corpusEvents.some((event) => event.type === "state" &&
    event.state === "waiting-host") === false, "corpus lane reached a resolver");

  document.body.dataset.progress = "nested budget";
  const budgetSource = cart(`
function _update()
 local co=cocreate(function() while true do end end)
 local ok,value=pcall(function() return coresume(co) end)
 poke(0x5000,1)
end
function _draw() end`);
  const budgetReady = await runtime.loadCart(budgetSource, 2_000, bundle);
  check(budgetReady.type === "state" && budgetReady.state === "ready",
    "budget cart did not become ready");
  await runtime.start();
  await runtime.pulse(0, ZERO_INPUT);
  let budgetRecord;
  try {
    await runtime.pulse(34, ZERO_INPUT);
  } catch (error) {
    budgetRecord = errorRecord(error);
  }
  check(budgetRecord?.code === "E_VM_INSTRUCTION_BUDGET",
    "nested coroutine did not inherit the root budget");

  document.body.dataset.progress = "fresh recovery";
  const recoveryReady = await runtime.loadCart(cart(`
function _update() end
function _draw() cls(1) pset(0,0,1) end`));
  const recoveryGeneration = runtime.sessionGeneration;
  check(recoveryReady.type === "state" && recoveryReady.state === "ready",
    "fresh recovery cart did not become ready");
  await runtime.start();
  await runtime.pulse(0, ZERO_INPUT);
  await runtime.pulse(34, ZERO_INPUT);
  const recoveryFrames = rawMessages.filter((event) =>
    event.type === "frame" && event.sessionGeneration === recoveryGeneration);
  check(recoveryFrames.length === 1, "fresh recovery did not publish exactly one frame");
  check(workerErrors.length === 0, "Chrome Worker reported an error");

  const result = {
    decision: "accepted-root-only",
    surfaces: SUSPENSION_SURFACES.map(({ name }) => name),
    executionModes: EXECUTION_MODES,
    nestingDepths: NESTING_DEPTHS,
    matrixCases: matrix.length,
    structuredFaults: matrix.length,
    waitingHostEvents: matrix.reduce((count, entry) => count + rawMessages.filter((event) =>
      event.sessionGeneration === entry.generation && event.type === "state" &&
      event.state === "waiting-host").length, 0),
    replacementHandshakes: matrix.reduce((count, entry) => count + rawMessages.filter((event) =>
      event.sessionGeneration === entry.generation &&
      event.type === "session-replaced").length, 0),
    publishedFrames: matrix.reduce((count, entry) => count + rawMessages.filter((event) =>
      event.sessionGeneration === entry.generation && event.type === "frame").length, 0),
    runtimeControls: matrix.reduce((count, entry) => count + rawMessages.filter((event) =>
      event.sessionGeneration === entry.generation &&
      event.type === "runtime-control").length, 0),
    corpusClassification: "C3",
    corpusFaultCode: corpusRecord.code,
    budgetFaultCode: budgetRecord.code,
    recoveryFrames: recoveryFrames.length,
    finalSessionGeneration: runtime.sessionGeneration,
    workerErrors,
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
