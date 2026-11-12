import assert from "node:assert/strict";
import test from "node:test";
import { inputSnapshot } from "../helpers/input.mjs";

import createZ8LuaModule from "../../wasm/dist/z8lua-runtime-v1.mjs";
import { FrameScheduler } from "../../packages/runtime-core/dist/public.js";
import {
  isPlayerHostToRuntime,
  isPlayerRuntimeToHost,
} from "../../apps/web-player/dist/transport/public.js";
import {
  createPlayerWorkerController,
} from "../../apps/web-player/dist/worker/compose-runtime.js";
import {
  PlayerRuntimeClient,
} from "../../apps/web-player/dist/main/worker-client.js";
import { RuntimeClientError } from "../../apps/web-player/dist/transport/runtime-error.js";
import { makeP8Png } from "../fixtures/p8png/fixture-builder.mjs";

const encoder = new TextEncoder();

function textCart(lua) {
  return encoder.encode(
    `pico-8 cartridge // http://www.pico-8.com\nversion 42\n__lua__\n${lua}\n`,
  );
}

function command(type, overrides = {}) {
  return {
    v: 1,
    type,
    requestId: 1,
    workerGeneration: 1,
    sessionGeneration: 1,
    ...overrides,
  };
}

test("FrameScheduler deterministically paces 30/60Hz and drops oversized backlog", () => {
  const scheduler = new FrameScheduler();
  scheduler.configure(30);
  scheduler.start();
  assert.deepEqual(scheduler.pulse(0), {
    tickCount: 0,
    discontinuity: false,
    droppedTicks: 0,
  });
  assert.equal(scheduler.pulse(1000 / 60).tickCount, 0);
  assert.equal(scheduler.pulse(1000 / 30).tickCount, 1);
  const overflow = scheduler.pulse(1000);
  assert.equal(overflow.tickCount, 5);
  assert.equal(overflow.discontinuity, true);
  assert.ok(overflow.droppedTicks > 0);

  scheduler.pause();
  assert.equal(scheduler.pulse(10_000).tickCount, 0);
  scheduler.resume();
  assert.equal(scheduler.pulse(20_000).tickCount, 0, "resume must establish a new anchor");
  assert.equal(scheduler.pulse(20_000 + 1000 / 30).tickCount, 1);
  const backwards = scheduler.pulse(1);
  assert.equal(backwards.tickCount, 0);
  assert.equal(backwards.discontinuity, true);

  scheduler.configure(60);
  scheduler.start();
  scheduler.pulse(0);
  assert.equal(scheduler.pulse(1000 / 60).tickCount, 1);
});

test("protocol validators fail closed", () => {
  const load = command("loadCart", { cartBytes: new ArrayBuffer(8) });
  assert.equal(isPlayerHostToRuntime(load), true);
  assert.equal(isPlayerHostToRuntime({ ...load, v: 2 }), false);
  assert.equal(isPlayerHostToRuntime({ ...load, requestId: 0 }), false);
  assert.equal(isPlayerHostToRuntime(command("vsync", {
    sequence: 1,
    timestampMs: Number.NaN,
  })), false);
  assert.equal(isPlayerHostToRuntime(command("input", {
    requestId: 0,
    sequence: 1,
    input: inputSnapshot([0x40, 0, 0, 0, 0, 0, 0, 0]),
  })), false);

  const frame = {
    v: 1,
    type: "frame",
    requestId: 1,
    workerGeneration: 1,
    sessionGeneration: 1,
    frameId: 0,
    completedSlices: "2",
    timeRawBeforeStep: 3276,
    targetFps: 60,
    cpuInstructions: 42,
    cpuFractionRaw: 41,
    slowFrame: false,
    devkitFlags: 0,
    packedScreen: new ArrayBuffer(0x2000),
    displayPalette: new ArrayBuffer(16),
  };
  assert.equal(isPlayerRuntimeToHost(frame), true);
  assert.equal(isPlayerRuntimeToHost({ ...frame, packedScreen: new ArrayBuffer(1) }), false);
  assert.equal(isPlayerRuntimeToHost({ ...frame, displayPalette: new ArrayBuffer(15) }), false);
});

test("Worker controller composes decodeCart, CartSession and scheduler", async () => {
  const module = await createZ8LuaModule();
  const controller = createPlayerWorkerController(module);
  const cart = textCart(`
x=0
function _update60()
 if btn(1) then x=x+1 end
end
function _draw()
 cls(1)
 pset(x,0,7)
end`);
  const ready = controller.handle(command("loadCart", {
    cartBytes: cart.slice().buffer,
    instructionBudget: 100_000,
  }));
  assert.equal(ready.length, 1);
  assert.deepEqual(
    { type: ready[0].type, state: ready[0].state, targetFps: ready[0].targetFps },
    { type: "state", state: "ready", targetFps: 60 },
  );
  assert.equal(controller.handle(command("start"))[0].state, "running");
  assert.equal(controller.handle(command("input", {
    requestId: 0,
    sequence: 1,
    input: inputSnapshot([2, 0, 0, 0, 0, 0, 0, 0]),
  })).length, 0);
  const anchor = controller.handle(command("vsync", { sequence: 1, timestampMs: 0 }));
  assert.equal(anchor.at(-1).type, "heartbeat");
  assert.equal(anchor.at(-1).tickCount, 0);
  const tick = controller.handle(command("vsync", {
    requestId: 2,
    sequence: 2,
    timestampMs: 1000 / 60,
  }));
  const frame = tick.find((event) => event.type === "frame");
  assert.ok(frame);
  assert.equal(frame.frameId, 0);
  assert.equal(new Uint8Array(frame.packedScreen)[0], 0x71);
  assert.equal(tick.at(-1).type, "heartbeat");
  assert.equal(tick.at(-1).tickCount, 1);

  const reset = controller.handle(command("reset", {
    requestId: 3,
    sessionGeneration: 2,
  }));
  assert.equal(reset[0].state, "ready");
  controller.handle(command("start", { requestId: 4, sessionGeneration: 2 }));
  controller.handle(command("input", {
    requestId: 0,
    sessionGeneration: 1,
    sequence: 99,
    input: inputSnapshot([2, 0, 0, 0, 0, 0, 0, 0]),
  }));
  controller.handle(command("vsync", {
    requestId: 5,
    sessionGeneration: 2,
    sequence: 1,
    timestampMs: 100,
  }));
  const resetTick = controller.handle(command("vsync", {
    requestId: 6,
    sessionGeneration: 2,
    sequence: 2,
    timestampMs: 100 + 1000 / 60,
  }));
  const resetFrame = resetTick.find((event) => event.type === "frame");
  assert.equal(resetFrame.frameId, 0);
  assert.equal(new Uint8Array(resetFrame.packedScreen)[0], 0x17,
    "stale input must not move the reset cart");

  const png = makeP8Png({
    compression: "raw",
    codeHex: Buffer.from("function _draw() cls(2) end\n").toString("hex"),
    cartVersion: 42,
    romPatternSeed: 17,
    zlibMode: "stored",
    filterMode: "cycle",
    splitIdat: true,
  }).png;
  const pngReady = controller.handle(command("loadCart", {
    requestId: 7,
    sessionGeneration: 3,
    cartBytes: png.slice().buffer,
  }));
  assert.equal(pngReady[0].type, "state");
  assert.equal(pngReady[0].state, "ready");
  assert.equal(pngReady[0].targetFps, 30);

  const malformed = controller.handle(command("loadCart", {
    requestId: 8,
    sessionGeneration: 4,
    cartBytes: encoder.encode("not a cart").buffer,
  }));
  assert.equal(malformed[0].type, "fault");
  assert.equal(malformed[0].error.code, "E_CART_PARSE");
  controller.dispose();
});

class FakeWorker {
  constructor({ hangVsync = false } = {}) {
    this.listener = undefined;
    this.messages = [];
    this.hangVsync = hangVsync;
    this.terminated = false;
  }

  addEventListener(type, listener) {
    if (type === "message") this.listener = listener;
  }

  postMessage(message) {
    this.messages.push(message);
    if (message.type === "input" || message.type === "attachAudioPort") return;
    if (message.type === "vsync" && this.hangVsync) return;
    let response;
    if (message.type === "vsync") {
      response = {
        ...message,
        type: "heartbeat",
        vsyncSequence: message.sequence,
        tickCount: 0,
        droppedTicks: 0,
      };
      delete response.timestampMs;
      delete response.sequence;
    } else {
      const states = {
        loadCart: "ready",
        reset: "ready",
        start: "running",
        pause: "paused",
        resume: "running",
        stop: "stopped",
        dispose: "disposed",
      };
      const state = states[message.type];
      response = {
        v: 1,
        type: "state",
        requestId: message.requestId,
        workerGeneration: message.workerGeneration,
        sessionGeneration: message.sessionGeneration,
        state,
        mode: state === "disposed" ? "none" : "callback",
        targetFps: state === "disposed" ? 0 : 30,
        devkitFlags: 0,
      };
    }
    queueMicrotask(() => this.listener?.({ data: response }));
  }

  terminate() {
    this.terminated = true;
  }
}

test("main client watchdog separates Worker generation and retains cart for recovery", async () => {
  const workers = [];
  const client = new PlayerRuntimeClient(() => {
    const worker = new FakeWorker({ hangVsync: workers.length === 0 });
    workers.push(worker);
    return worker;
  }, { commandTimeoutMs: 20 });
  const source = textCart("function _draw() cls(2) end");
  await client.loadCart(source);
  assert.equal(client.sessionGeneration, 1);
  assert.equal(client.workerGeneration, 1);
  await client.start();
  await assert.rejects(
    client.pulse(0, inputSnapshot([0, 0, 0, 0, 0, 0, 0, 0])),
    (error) => error instanceof RuntimeClientError && error.record.code === "E_VM_WATCHDOG",
  );
  assert.equal(workers[0].terminated, true);
  assert.equal(client.workerGeneration, 2);
  assert.equal(client.sessionGeneration, 1);
  await client.reset();
  assert.equal(client.sessionGeneration, 2);
  const recovery = workers[1].messages.find((message) => message.type === "loadCart");
  assert.ok(recovery, "reset after Worker restart must reload retained bytes");
  assert.deepEqual(new Uint8Array(recovery.cartBytes), source);
  await client.dispose();
  assert.equal(workers[1].terminated, true);
});

test("new session cancels an in-flight vsync without tripping the Worker watchdog", async () => {
  const worker = new FakeWorker({ hangVsync: true });
  const client = new PlayerRuntimeClient(() => worker, { commandTimeoutMs: 20 });
  await client.loadCart(textCart("function _draw() cls(2) end"));
  await client.start();
  const pendingPulse = client.pulse(0, inputSnapshot([0, 0, 0, 0, 0, 0, 0, 0]));
  const reset = client.reset();
  await assert.rejects(
    pendingPulse,
    (error) => error instanceof RuntimeClientError &&
      error.record.code === "E_INVALID_STATE",
  );
  await reset;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(client.workerGeneration, 1);
  assert.equal(worker.terminated, false);
  await client.dispose();
});
