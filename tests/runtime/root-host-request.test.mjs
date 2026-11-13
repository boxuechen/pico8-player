import assert from "node:assert/strict";
import test, { before } from "node:test";

import { PICO_HOST_REQUEST_MAX_BYTES } from "@pico8-player/contracts";
import {
  createPlayerWorkerController,
} from "../../apps/player/dist/worker/compose-runtime.js";
import createZ8LuaModule from "../../wasm/dist/z8lua-runtime-v1.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
let module;

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

function loadCommand(source, sessionGeneration, requestId) {
  const bytes = source.slice();
  return command("loadCart", sessionGeneration, requestId, {
    cartBytes: bytes.buffer,
  });
}

async function turn() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function deferredHandler() {
  const pending = [];
  return {
    pending,
    port: {
      handle(request, cancellation) {
        return new Promise((resolve) => {
          pending.push({ request, cancellation, resolve });
        });
      },
    },
  };
}

test("production controller recovers root boot and step requests without advancing while waiting", async () => {
  assert.equal(PICO_HOST_REQUEST_MAX_BYTES, 4096);
  const handler = deferredHandler();
  const background = [];
  const controller = createPlayerWorkerController(module, {
    hostRequestHandler: handler.port,
  });
  controller.setEventSink((events) => background.push(...events));

  const source = cart(`
function _init()
 local response=__p8w_probe_host_request("boot")
 poke(0x5000,#response)
end
n=0
function _update()
 n+=1
 if n==1 then
  local response=__p8w_probe_host_request("step")
  poke(0x5001,#response)
 end
end
function _draw()
 cls(0)
 pset(0,0,peek(0x5000))
 pset(1,0,peek(0x5001))
end`);

  const loading = await controller.handle(loadCommand(source, 1, 1));
  assert.equal(loading.at(-1)?.type, "state");
  assert.equal(loading.at(-1)?.state, "waiting-host");
  await turn();
  assert.equal(handler.pending.length, 1);
  const boot = handler.pending.shift();
  assert.equal(decoder.decode(boot.request.bytes), "boot");
  assert.equal(boot.request.operation, "boot");
  assert.equal(boot.cancellation.cancelled, false);
  boot.resolve({
    generation: boot.request.generation,
    requestId: boot.request.requestId,
    bytes: encoder.encode("four"),
    isError: false,
  });
  await turn();
  assert.equal(background.at(-1)?.type, "state");
  assert.equal(background.at(-1)?.state, "ready");

  const started = await controller.handle(command("start", 1, 2));
  assert.equal(started.at(-1)?.state, "running");
  await controller.handle(command("vsync", 1, 3, { sequence: 1, timestampMs: 0 }));
  const waiting = await controller.handle(command("vsync", 1, 4, {
    sequence: 2,
    timestampMs: 34,
  }));
  assert.equal(waiting.at(-1)?.state, "waiting-host");
  await turn();
  const step = handler.pending.shift();
  assert.equal(decoder.decode(step.request.bytes), "step");
  assert.equal(step.request.operation, "step");

  const whileWaiting = await controller.handle(command("vsync", 1, 5, {
    sequence: 3,
    timestampMs: 68,
  }));
  assert.equal(whileWaiting.at(-1)?.type, "heartbeat");
  assert.equal(whileWaiting.at(-1)?.tickCount, 0);
  assert.equal(background.some((event) => event.type === "frame"), false);

  step.resolve({
    generation: step.request.generation,
    requestId: step.request.requestId,
    bytes: encoder.encode("tri"),
    isError: false,
  });
  await turn();
  const frame = background.find((event) => event.type === "frame");
  const heartbeat = background.find((event) =>
    event.type === "heartbeat" && event.requestId === 4);
  assert.ok(frame);
  assert.equal(new Uint8Array(frame.packedScreen)[0], 0x34);
  assert.equal(heartbeat?.tickCount, 1);
  assert.equal(frame.completedSlices, "2");
  controller.dispose();
});

test("new generation cancels a pending handler and discards its late completion", async () => {
  const handler = deferredHandler();
  const background = [];
  const controller = createPlayerWorkerController(module, {
    hostRequestHandler: handler.port,
  });
  controller.setEventSink((events) => background.push(...events));
  const waitingCart = cart(`
function _init() __p8w_probe_host_request("slow") end
function _update() end
function _draw() cls(1) end`);
  const replacement = cart(`
function _update() end
function _draw() cls(2) end`);

  const first = await controller.handle(loadCommand(waitingCart, 1, 1));
  assert.equal(first.at(-1)?.state, "waiting-host");
  await turn();
  const slow = handler.pending.shift();
  const second = await controller.handle(loadCommand(replacement, 2, 2));
  assert.equal(second.at(-1)?.state, "ready");
  assert.equal(slow.cancellation.cancelled, true);

  const eventsBeforeLate = background.length;
  slow.resolve({
    generation: slow.request.generation,
    requestId: slow.request.requestId,
    bytes: encoder.encode("late"),
    isError: false,
  });
  await turn();
  assert.equal(background.length, eventsBeforeLate);
  controller.dispose();
});

test("mismatched, oversized and rejected completions close as E_HOST_REQUEST", async () => {
  for (const completionOf of [
    (request) => ({
      generation: request.generation,
      requestId: request.requestId + 1,
      bytes: new Uint8Array(),
      isError: false,
    }),
    (request) => ({
      generation: request.generation,
      requestId: request.requestId,
      bytes: new Uint8Array(PICO_HOST_REQUEST_MAX_BYTES + 1),
      isError: false,
    }),
    (request) => ({
      generation: request.generation,
      requestId: request.requestId,
      bytes: encoder.encode("denied"),
      isError: true,
    }),
  ]) {
    const background = [];
    const controller = createPlayerWorkerController(module, {
      hostRequestHandler: {
        async handle(request) {
          return completionOf(request);
        },
      },
    });
    controller.setEventSink((events) => background.push(...events));
    const loading = await controller.handle(loadCommand(cart(`
function _init() __p8w_probe_host_request("fail") end
function _update() end
function _draw() end`), 1, 1));
    assert.equal(loading.at(-1)?.state, "waiting-host");
    await turn();
    const fault = background.find((event) => event.type === "fault");
    assert.equal(fault?.error.code, "E_HOST_REQUEST");
    controller.dispose();
  }
});

test("nested HostRequest remains fail-closed and never reaches the root handler", async () => {
  let handlerCalls = 0;
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
  });
  controller.setEventSink(() => undefined);
  const result = await controller.handle(loadCommand(cart(`
local inner=cocreate(function() __p8w_probe_host_request("nested") end)
coresume(inner)
function _update() end
function _draw() end`), 1, 1));
  const fault = result.find((event) => event.type === "fault");
  assert.equal(fault?.error.code, "E_FEATURE_UNSUPPORTED");
  assert.equal(fault?.error.details?.reason, "nested-host-suspend");
  assert.equal(handlerCalls, 0);
  controller.dispose();
});
