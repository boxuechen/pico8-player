import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { before } from "node:test";

import { decodeCart } from "@pico8-player/cart-codec";
import {
  FrameSliceRuntime,
} from "@pico8-player/runtime-core";
import {
  createPicoApiHostRouter,
  Z8LuaFrameVm,
} from "@pico8-player/z8lua-bridge";
import {
  createPlayerWorkerController,
} from "../../apps/player/dist/worker/compose-runtime.js";
import createZ8LuaModule from "../../wasm/dist/z8lua-runtime-v1.mjs";

const encoder = new TextEncoder();
const projectRoot = new URL("../../", import.meta.url);
let module;

const ALL_DATA_ACCESS = Object.freeze({
  load: true,
  reloadData: true,
  cstoreData: true,
  include: false,
});

const SUSPENSION_SURFACES = Object.freeze([
  { name: "flip", statement: "flip()" },
  { name: "run", statement: "run(\"nested-run\")" },
  { name: "stop", statement: "stop(\"nested-stop\")" },
  {
    name: "load",
    statement: "load(\"chapter-b.p8\",\"nested\",\"nested\")",
  },
  {
    name: "reload",
    statement: "reload(0x5000,0,1,\"data-cart.p8\")",
  },
  {
    name: "cstore",
    statement: "cstore(0,0x5000,1,\"data-cart.p8\")",
  },
  {
    name: "diagnostic",
    statement: "__p8w_probe_host_request(\"nested-probe\")",
  },
]);

const EXECUTION_MODES = Object.freeze(["callback", "custom"]);
const NESTING_DEPTHS = Object.freeze(["single", "multi"]);

before(async () => {
  module = await createZ8LuaModule();
});

function cart(lua) {
  return encoder.encode(`pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
${lua}
`);
}

async function fixture(name) {
  return new Uint8Array(await readFile(
    new URL(`../fixtures/multicart/${name}`, import.meta.url),
  ));
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

function createRuntime(source, instructionBudget) {
  const router = createPicoApiHostRouter(module);
  const vm = new Z8LuaFrameVm(module, router);
  const runtime = new FrameSliceRuntime(vm, {
    ...(instructionBudget === undefined ? {} : { instructionBudget }),
  });
  const boot = runtime.boot(decodeCart(source));
  return { runtime, boot };
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

function loadCommand(source, sessionGeneration, requestId, bundle = [], instructionBudget) {
  const bytes = source.slice();
  return command("loadCart", sessionGeneration, requestId, {
    cartBytes: bytes.buffer,
    localCartBundle: bundle.map((entry) => {
      const entryBytes = entry.bytes.slice();
      return {
        ref: entry.ref,
        cartBytes: entryBytes.buffer,
        access: entry.access,
      };
    }),
    ...(instructionBudget === undefined ? {} : { instructionBudget }),
  });
}

async function turns(count = 4) {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function findFault(events) {
  return events.find((event) => event.type === "fault");
}

test("plain nested yield proves direct-resumer ownership and continuation stack", () => {
  const { runtime, boot } = createRuntime(cart(`
function _init()
 local co=cocreate(function()
  local resumed=yield(0x2a)
  poke(0x5002,resumed)
  return 0x2b
 end)
 local ok,first=coresume(co)
 local ok2,second=coresume(co,0x2c)
 poke(0x5000,ok and first==0x2a and 1 or 2)
 poke(0x5001,ok2 and second==0x2b and 1 or 2)
end
function _update() end
function _draw() end`));
  assert.equal(boot.ok, true);
  assert.equal(boot.value.kind, "ready");
  assert.deepEqual([...runtime.copyRam(0x5000, 3)], [1, 1, 0x2c]);
  runtime.dispose();
});

test("all nested suspension surfaces fail uniformly across mode and depth", () => {
  const observed = [];
  for (const surface of SUSPENSION_SURFACES) {
    for (const mode of EXECUTION_MODES) {
      for (const depth of NESTING_DEPTHS) {
        const { runtime, boot } = createRuntime(nestedCart(surface, mode, depth));
        assert.equal(boot.ok, true, `${surface.name}/${mode}/${depth} boot`);
        assert.equal(boot.value.kind, "ready", `${surface.name}/${mode}/${depth} ready`);
        assert.equal(runtime.completedSlices, 1n);
        const result = runtime.step();
        assert.equal(result.ok, false, `${surface.name}/${mode}/${depth} must fault`);
        assert.equal(result.error.code, "E_FEATURE_UNSUPPORTED");
        assert.equal(result.error.details?.reason, "nested-host-suspend");
        assert.equal(runtime.state, "faulted");
        assert.equal(runtime.completedSlices, 1n, "fault must not advance logical time");
        assert.deepEqual(
          [...runtime.copyRam(0x5000, 5)],
          [0x5a, 0, 0, 0, 0],
          "pcall/coresume must not swallow the root fault or run post-yield effects",
        );
        observed.push(`${surface.name}/${mode}/${depth}`);
        runtime.dispose();
      }
    }
  }
  assert.equal(observed.length, 28);
  assert.equal(new Set(observed).size, 28);
});

test("production controller exposes zero nested host, swap, frame, audio or persistence effects", async () => {
  const chapter = cart("function _update() end function _draw() cls(2) end");
  const data = await fixture("data-cart.p8");
  const bundle = [
    { ref: "chapter-b.p8", bytes: chapter, access: ALL_DATA_ACCESS },
    { ref: "data-cart.p8", bytes: data, access: ALL_DATA_ACCESS },
  ];
  let cases = 0;

  for (const surface of SUSPENSION_SURFACES) {
    for (const mode of EXECUTION_MODES) {
      for (const depth of NESTING_DEPTHS) {
        let handlerCalls = 0;
        let audioSends = 0;
        let persistenceEnqueues = 0;
        let audioGeneration = -1;
        const background = [];
        const controller = createPlayerWorkerController(module, {
          hostRequestHandler: {
            async handle(request) {
              handlerCalls += 1;
              return {
                generation: request.generation,
                requestId: request.requestId,
                bytes: new Uint8Array(),
                isError: false,
              };
            },
          },
          audioTransport: {
            get sessionGeneration() { return audioGeneration; },
            beginGeneration(generation) { audioGeneration = generation; },
            reset() {},
            submit() { audioSends += 1; },
          },
          persistence: {
            async hydrate() { return []; },
            enqueue() { persistenceEnqueues += 1; },
            async flush() {},
            takeDiagnostics() { return []; },
            async dispose() {},
          },
        });
        controller.setEventSink((events) => background.push(...events));
        const loaded = await controller.handle(loadCommand(
          nestedCart(surface, mode, depth),
          1,
          1,
          bundle,
        ));
        assert.equal(loaded.at(-1)?.state, "ready");
        const sendsAfterBoot = audioSends;
        const started = await controller.handle(command("start", 1, 2));
        assert.equal(started.at(-1)?.state, "running");
        await controller.handle(command("vsync", 1, 3, {
          sequence: 1,
          timestampMs: 0,
        }));
        const stepped = await controller.handle(command("vsync", 1, 4, {
          sequence: 2,
          timestampMs: 34,
        }));
        const allEvents = [...loaded, ...started, ...stepped, ...background];
        const fault = findFault(allEvents);
        assert.equal(fault?.error.code, "E_FEATURE_UNSUPPORTED");
        assert.equal(fault?.error.details?.reason, "nested-host-suspend");
        assert.equal(handlerCalls, 0, `${surface.name}/${mode}/${depth} handler`);
        assert.equal(persistenceEnqueues, 0, `${surface.name}/${mode}/${depth} persistence`);
        assert.equal(audioSends, sendsAfterBoot, `${surface.name}/${mode}/${depth} audio`);
        assert.equal(allEvents.some((event) => event.type === "state" &&
          event.state === "waiting-host"), false);
        assert.equal(allEvents.some((event) => event.type === "session-replaced"), false);
        assert.equal(allEvents.some((event) => event.type === "frame"), false);
        assert.equal(allEvents.some((event) => event.type === "runtime-control"), false);
        await controller.dispose();
        cases += 1;
      }
    }
  }
  assert.equal(cases, 28);
});

test("nested cstore cannot mutate the target overlay before a later root reload", async () => {
  const data = await fixture("data-cart.p8");
  const bundle = [{ ref: "data-cart.p8", bytes: data, access: ALL_DATA_ACCESS }];
  const background = [];
  const controller = createPlayerWorkerController(module);
  controller.setEventSink((events) => background.push(...events));

  const nestedLoaded = await controller.handle(loadCommand(
    nestedCart({
      name: "cstore-overlay-probe",
      statement: "poke(0x5000,0xaa) cstore(0,0x5000,1,\"data-cart.p8\")",
    }, "callback", "multi"),
    1,
    1,
    bundle,
  ));
  assert.equal(nestedLoaded.at(-1)?.state, "ready");
  await controller.handle(command("start", 1, 2));
  await controller.handle(command("vsync", 1, 3, { sequence: 1, timestampMs: 0 }));
  const nestedFault = await controller.handle(command("vsync", 1, 4, {
    sequence: 2,
    timestampMs: 34,
  }));
  assert.equal(findFault(nestedFault)?.error.details?.reason, "nested-host-suspend");

  background.length = 0;
  const verifier = cart(`
function _init() reload(0x5000,0,1,"data-cart.p8") end
function _update() end
function _draw()
 cls(0)
 pset(0,0,peek(0x5000)==0x10 and 1 or 2)
end`);
  const waiting = await controller.handle(loadCommand(verifier, 2, 5, bundle));
  assert.equal(waiting.at(-1)?.state, "waiting-host");
  await turns();
  assert.equal(background.at(-1)?.state, "ready");
  await controller.handle(command("start", 2, 6));
  await controller.handle(command("vsync", 2, 7, { sequence: 1, timestampMs: 0 }));
  const rendered = await controller.handle(command("vsync", 2, 8, {
    sequence: 2,
    timestampMs: 34,
  }));
  const frame = rendered.find((event) => event.type === "frame");
  assert.equal(new Uint8Array(frame.packedScreen)[0] & 0x0f, 1);
  await controller.dispose();
});

test("nested coroutine budget remains uncatchable and a fresh session recovers", async () => {
  const budgetCart = cart(`
function _update()
 local co=cocreate(function() while true do end end)
 local ok,value=pcall(function() return coresume(co) end)
 poke(0x5000,1)
end
function _draw() end`);
  const { runtime, boot } = createRuntime(budgetCart, 2_000);
  assert.equal(boot.ok, true);
  const fault = runtime.step();
  assert.equal(fault.ok, false);
  assert.equal(fault.error.code, "E_VM_INSTRUCTION_BUDGET");
  assert.equal(runtime.completedSlices, 1n);
  assert.deepEqual([...runtime.copyRam(0x5000, 1)], [0]);
  assert.equal(runtime.step().error.code, "E_INVALID_STATE");
  runtime.dispose();

  const recovered = createRuntime(cart(`
function _update() end
function _draw() cls(1) end`));
  assert.equal(recovered.boot.ok, true);
  const frame = recovered.runtime.step();
  assert.equal(frame.ok, true);
  assert.equal(frame.value.kind, "frame");
  recovered.runtime.dispose();
});

test("root requests remain exact-once and the Phase 5 corpus lane is C3", async () => {
  for (const mode of EXECUTION_MODES) {
    const source = mode === "callback"
      ? cart(`
local requested=false
function _update()
 if not requested then
  requested=true
  poke(0x5000,#__p8w_probe_host_request("root-callback"))
 end
end
function _draw() end`)
      : cart(`
flip()
poke(0x5000,#__p8w_probe_host_request("root-custom"))
while true do flip() end`);
    const { runtime, boot } = createRuntime(source);
    assert.equal(boot.ok, true);
    assert.equal(boot.value.kind, "ready");
    const request = runtime.step();
    assert.equal(request.ok, true);
    assert.equal(request.value.kind, "host-request");
    const response = encoder.encode("once");
    const resumed = runtime.completeHostRequest(request.value.request.id, response);
    assert.equal(resumed.ok, true);
    assert.equal(resumed.value.kind, "frame");
    assert.equal(runtime.copyRam(0x5000, 1)[0], response.byteLength);
    const next = runtime.step();
    assert.equal(next.ok, true);
    assert.equal(next.value.kind, "frame");
    runtime.dispose();
  }

  const controller = createPlayerWorkerController(module);
  controller.setEventSink(() => undefined);
  const corpusResult = await controller.handle(loadCommand(
    await fixture("nested-load-policy.p8"),
    1,
    1,
    [{
      ref: "chapter-b.p8",
      bytes: cart("function _update() end function _draw() end"),
      access: ALL_DATA_ACCESS,
    }],
  ));
  const corpusFault = findFault(corpusResult);
  assert.equal(corpusFault?.error.code, "E_FEATURE_UNSUPPORTED");
  assert.equal(corpusFault?.error.details?.reason, "nested-host-suspend");
  await controller.dispose();
});
