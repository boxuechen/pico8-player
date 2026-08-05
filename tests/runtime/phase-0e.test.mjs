import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { before } from "node:test";

import { decodeP8Png } from "@pico8-web/cart-codec";
import { FrameSliceRuntime, logicalTimeRaw } from "@pico8-web/runtime-core";
import { Z8LuaFrameVm } from "@pico8-web/z8lua-bridge";
import createZ8LuaModule from "../../wasm/dist/z8lua-runtime-v1.mjs";
import { createPhase0EWorkerController } from "../../apps/web-player/dist/worker/compose-runtime.js";
import {
  Phase0ERuntimeClient,
  RuntimeClientError,
} from "../../apps/web-player/dist/main/runtime-client.js";
import { installPhase0EAsyncRuntimeWorker } from "../../apps/web-player/dist/worker/runtime-worker.js";
import {
  isPhase0EHostToRuntime,
  isPhase0ERuntimeToHost,
} from "../../apps/web-player/dist/transport/validators.js";
import { makeP8Png } from "../fixtures/p8png/fixture-builder.mjs";

const encoder = new TextEncoder();
let module;

before(async () => {
  module = await createZ8LuaModule();
});

function syntheticP8Png(source) {
  const vector = {
    name: "phase-0e-project-owned",
    codeHex: Buffer.from(source, "utf8").toString("hex"),
    compression: "raw",
    cartVersion: 42,
    romPatternSeed: 17,
    filterMode: "cycle",
    zlibMode: "fixed",
    splitIdat: true,
  };
  return makeP8Png(vector).png;
}

function sourceCart(source) {
  return {
    rom: new Uint8Array(0x8000),
    luaSource: encoder.encode(source),
  };
}

function createRuntime(source, instructionBudget = 100_000) {
  const runtime = new FrameSliceRuntime(new Z8LuaFrameVm(module), {
    instructionBudget,
  });
  const boot = runtime.boot(sourceCart(source));
  assert.equal(boot.ok, true, JSON.stringify(boot));
  return { runtime, boot: boot.value };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("decoded .p8.png boots callback mode and 60 manual slices are exact", () => {
  const source = `
function _init()
 poke(0x100,1) poke(0x101,0) poke(0x102,0)
end
function _update60()
 poke(0x101,peek(0x101)+1)
 poke4(0x110,time())
 poke(0x114,btn(0) and 1 or 0)
end
function _draw()
 poke(0x102,peek(0x102)+1)
 cls(2) pset(peek(0x101)-1,0,7)
end`;
  const cart = decodeP8Png(syntheticP8Png(source));
  const runtime = new FrameSliceRuntime(new Z8LuaFrameVm(module), {
    instructionBudget: 100_000,
  });
  const boot = runtime.boot(cart);
  assert.deepEqual(boot, {
    ok: true,
    value: { kind: "ready", mode: "callback", targetFps: 60 },
  });

  let lastFrame;
  for (let index = 0; index < 60; index += 1) {
    const stepped = runtime.step({ buttons: index === 59 ? 1 : 0 });
    assert.equal(stepped.ok, true, JSON.stringify(stepped));
    assert.equal(stepped.value.kind, "frame");
    lastFrame = stepped.value.frame;
  }

  const counters = runtime.copyRam(0x100, 0x18);
  assert.deepEqual([...counters.subarray(0, 3)], [1, 60, 60]);
  assert.equal(new DataView(counters.buffer).getInt32(0x10, true), logicalTimeRaw(59n, 60));
  assert.equal(counters[0x14], 1);
  assert.equal(runtime.completedSlices, 60n);
  assert.equal(lastFrame.timeRawBeforeStep, logicalTimeRaw(59n, 60));
  assert.equal(lastFrame.completedSlices, "60");
  assert.equal(lastFrame.screen[29], 0x72);
  assert.equal(sha256(lastFrame.screen), "9627762b606887336f881c14c4e14c6384f699baece8e96f13c70ee1ba6915b6");
  runtime.dispose();
});

test("callback priority is _update60 over _update and 30 Hz stays exact", () => {
  const { runtime, boot } = createRuntime(`
function _init() poke(0x120,0) poke(0x121,0) end
function _update() poke(0x120,peek(0x120)+1) end
function _update60() poke(0x121,peek(0x121)+1) end
function _draw() end`);
  assert.equal(boot.targetFps, 60);
  for (let index = 0; index < 60; index += 1) assert.equal(runtime.step().ok, true);
  assert.deepEqual([...runtime.copyRam(0x120, 2)], [0, 60]);
  runtime.dispose();

  const thirty = createRuntime(`
function _init() poke(0x120,0) end
function _update() poke(0x120,peek(0x120)+1) end
function _draw() end`).runtime;
  for (let index = 0; index < 60; index += 1) assert.equal(thirty.step().ok, true);
  assert.equal(thirty.copyRam(0x120, 1)[0], 60);
  assert.equal(logicalTimeRaw(thirty.completedSlices, 30), 0x0002_0000);
  thirty.dispose();
});

test("custom loop startup flip is not a slice and every later step reaches one flip", () => {
  const { runtime, boot } = createRuntime(`
n=0
while true do
 poke(0x130,n) poke4(0x134,time())
 cls(n) pset(n,1,7)
 flip()
 n+=1
end`);
  assert.deepEqual(boot, { kind: "ready", mode: "custom", targetFps: 30 });
  assert.equal(runtime.completedSlices, 0n);
  assert.equal(runtime.copyRam(0x130, 1)[0], 0);
  for (let index = 0; index < 60; index += 1) {
    const stepped = runtime.step();
    assert.equal(stepped.ok, true);
    assert.equal(stepped.value.kind, "frame");
  }
  const state = runtime.copyRam(0x130, 8);
  assert.equal(state[0], 60);
  assert.equal(new DataView(state.buffer).getInt32(4, true), logicalTimeRaw(59n, 30));
  assert.equal(runtime.completedSlices, 60n);
  runtime.dispose();
});

test("instruction exhaustion poisons the VM and cannot be resumed", () => {
  const { runtime } = createRuntime(`
function _update() while true do end end
function _draw() end`, 200);
  const first = runtime.step();
  assert.equal(first.ok, false);
  assert.equal(first.error.code, "E_VM_INSTRUCTION_BUDGET");
  assert.equal(runtime.state, "faulted");
  const second = runtime.step();
  assert.equal(second.ok, false);
  assert.equal(second.error.code, "E_INVALID_STATE");
  runtime.dispose();
});

test("runtime errors expose stable phase, cart line, and sanitized trace", () => {
  const { runtime } = createRuntime(`function _update()
 local x=nil
 return x.missing
end
function _draw() end`);
  const stepped = runtime.step();
  assert.equal(stepped.ok, false);
  assert.equal(stepped.error.code, "E_VM_RUNTIME");
  assert.equal(stepped.error.phase, "update");
  assert.equal(stepped.error.line, 3);
  assert.match(stepped.error.trace, /cart\.p8:3/u);
  assert.doesNotMatch(stepped.error.trace, /Users|boxue/u);
  runtime.dispose();
});

test("root HostRequest resumes once with byte strings; nested suspension is explicit unsupported", () => {
  const root = createRuntime(`
function _update()
 local value=__p8w_probe_host_request("ask\\0bytes")
 poke(0x140,#value)
end
function _draw() pset(1,1,7) end`).runtime;
  const requested = root.step();
  assert.equal(requested.ok, true);
  assert.equal(requested.value.kind, "host-request");
  assert.deepEqual([...requested.value.request.bytes], [...encoder.encode("ask\0bytes")]);
  const completed = root.completeHostRequest(
    requested.value.request.id,
    Uint8Array.of(1, 0, 2, 3),
  );
  assert.equal(completed.ok, true);
  assert.equal(completed.value.kind, "frame");
  assert.equal(root.copyRam(0x140, 1)[0], 4);
  assert.equal(root.completedSlices, 1n);
  root.dispose();

  const nested = createRuntime(`
function _update()
 local outer=cocreate(function()
  local inner=cocreate(function() __p8w_probe_host_request("nested") end)
  coresume(inner)
  poke(0x141,8)
 end)
 coresume(outer)
 poke(0x141,9)
end
function _draw() end`).runtime;
  const rejected = nested.step();
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, "E_FEATURE_UNSUPPORTED");
  assert.deepEqual(rejected.error.details, { reason: "nested-host-suspend" });
  assert.equal(nested.copyRam(0x141, 1)[0], 0);
  nested.dispose();

  const nestedFlip = createRuntime(`
function _update()
 local c=cocreate(function() flip() end)
 coresume(c)
 poke(0x142,9)
end
function _draw() end`).runtime;
  const flipRejected = nestedFlip.step();
  assert.equal(flipRejected.ok, false);
  assert.equal(flipRejected.error.code, "E_FEATURE_UNSUPPORTED");
  assert.equal(nestedFlip.copyRam(0x142, 1)[0], 0);
  nestedFlip.dispose();
});

test("host error, OOM, stale handles, and stale request completion stay classified", () => {
  const hostError = createRuntime(`
function _update() __p8w_probe_host_request("fail") end
function _draw() end`).runtime;
  const requested = hostError.step();
  assert.equal(requested.ok, true);
  assert.equal(requested.value.kind, "host-request");
  const rejected = hostError.completeHostRequest(
    requested.value.request.id,
    encoder.encode("denied"),
    true,
  );
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, "E_HOST_REQUEST");
  assert.equal(rejected.error.phase, "host-call");
  hostError.dispose();

  const stale = createRuntime(`
function _update() __p8w_probe_host_request("stale") end
function _draw() end`).runtime;
  const staleRequest = stale.step();
  const staleResult = stale.completeHostRequest(
    staleRequest.value.request.id + 1,
    new Uint8Array(),
  );
  assert.equal(staleResult.ok, false);
  assert.equal(staleResult.error.code, "E_INVALID_STATE");
  stale.dispose();

  const lowMemoryVm = new Z8LuaFrameVm(module, { luaHeapLimit: 32 * 1024 });
  const lowMemory = new FrameSliceRuntime(lowMemoryVm, {
    instructionBudget: 100_000,
  });
  const oom = lowMemory.boot(sourceCart(`
function _init()
 local values={}
 for i=1,10000 do values[i]="012345678901234567890123456789" end
end
function _update() end
function _draw() end`));
  assert.equal(oom.ok, false);
  assert.equal(oom.error.code, "E_VM_OOM");
  lowMemory.dispose();

  const handle = module._p8w_create(0) >>> 0;
  assert.notEqual(handle, 0);
  assert.equal(module._p8w_destroy(handle), 0);
  assert.equal(module._p8w_step(handle, 100, 0, 0), 2);
});

test("Worker controller consumes .p8.png bytes and emits versioned frame DTOs", () => {
  const controller = createPhase0EWorkerController(module);
  const png = syntheticP8Png(`
function _update() end
function _draw() cls(3) pset(0,0,7) end`);
  const load = controller.handle({
    v: 1,
    type: "loadCart",
    requestId: 1,
    sessionGeneration: 4,
    p8PngBytes: png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
  });
  assert.deepEqual(load, {
    v: 1,
    type: "ready",
    requestId: 1,
    sessionGeneration: 4,
    mode: "callback",
    targetFps: 30,
  });
  const frame = controller.handle({
    v: 1,
    type: "step",
    requestId: 2,
    sessionGeneration: 4,
    input: { buttons: 0 },
  });
  assert.equal(frame.type, "frame");
  assert.equal(frame.packedScreen.byteLength, 0x2000);
  assert.equal(new Uint8Array(frame.packedScreen)[0], 0x37);
  controller.dispose();
});

test("Window watchdog terminates, recreates, and ignores stale generations", async () => {
  class FakeWorker {
    listener;
    terminated = false;
    respond;

    constructor(respond) {
      this.respond = respond;
    }

    addEventListener(_type, listener) {
      this.listener = listener;
    }

    postMessage(command) {
      this.respond?.(command, (data) => queueMicrotask(() => this.listener({ data })));
    }

    terminate() {
      this.terminated = true;
    }

    emit(data) {
      this.listener({ data });
    }
  }

  const workers = [];
  const client = new Phase0ERuntimeClient(
    () => {
      const worker = new FakeWorker(
        workers.length === 0
          ? undefined
          : (command, reply) =>
              reply({
                v: 1,
                type: command.type === "dispose" ? "disposed" : "ready",
                requestId: command.requestId,
                sessionGeneration: command.sessionGeneration,
                ...(command.type === "dispose"
                  ? {}
                  : { mode: "callback", targetFps: 30 }),
              }),
      );
      workers.push(worker);
      return worker;
    },
    { commandTimeoutMs: 10 },
  );

  await assert.rejects(
    client.step({ buttons: 0 }),
    (error) =>
      error instanceof RuntimeClientError &&
      error.record.code === "E_VM_WATCHDOG",
  );
  assert.equal(workers[0].terminated, true);
  assert.equal(client.sessionGeneration, 2);
  workers[0].emit({
    v: 1,
    type: "ready",
    requestId: 1,
    sessionGeneration: 1,
    mode: "callback",
    targetFps: 30,
  });
  const recovered = await client.loadCart(Uint8Array.of(1));
  assert.equal(recovered.type, "ready");
  assert.equal(recovered.sessionGeneration, 2);
  await client.dispose();
});

test("protocol validators reject malformed data and async Worker startup queues first load", async () => {
  assert.equal(isPhase0EHostToRuntime({ v: 1, type: "step" }), false);
  assert.equal(
    isPhase0EHostToRuntime({
      v: 1,
      type: "step",
      requestId: 1,
      sessionGeneration: 1,
      input: { buttons: 0 },
    }),
    true,
  );
  assert.equal(
    isPhase0ERuntimeToHost({
      v: 1,
      type: "frame",
      requestId: 1,
      sessionGeneration: 1,
      frameId: 0,
      completedSlices: "1",
      timeRawBeforeStep: 0,
      targetFps: 30,
      packedScreen: new ArrayBuffer(1),
    }),
    false,
  );

  let listener;
  let resolveResponse;
  const responsePromise = new Promise((resolve) => {
    resolveResponse = resolve;
  });
  let resolveController;
  const controllerPromise = new Promise((resolve) => {
    resolveController = resolve;
  });
  const scope = {
    addEventListener(_type, callback) {
      listener = callback;
    },
    postMessage(message) {
      resolveResponse(message);
    },
  };
  installPhase0EAsyncRuntimeWorker(scope, controllerPromise);
  const png = syntheticP8Png(`
function _update() end
function _draw() end`);
  listener({
    data: {
      v: 1,
      type: "loadCart",
      requestId: 1,
      sessionGeneration: 7,
      p8PngBytes: png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
    },
  });
  resolveController(createPhase0EWorkerController(module));
  const response = await responsePromise;
  assert.equal(response.type, "ready");
  assert.equal(response.sessionGeneration, 7);
});
