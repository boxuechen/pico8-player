import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { before } from "node:test";

import {
  createPicoApiHost,
  FrameSliceRuntime,
  L1Input,
} from "@pico8-web/runtime-core";
import {
  createPicoApiHostRouter,
  Z8LuaFrameVm,
} from "@pico8-web/z8lua-bridge";
import createZ8LuaModule from "../../wasm/dist/z8lua-runtime-v1.mjs";
import { DevkitInputFrontend } from "../../apps/web-player/dist/main/devkit-input.js";
import {
  isPlayerHostToRuntime,
  isPlayerRuntimeToHost,
} from "../../apps/web-player/dist/transport/public.js";
import { createPlayerWorkerController } from "../../apps/web-player/dist/worker/compose-runtime.js";
import { inputSnapshot } from "../helpers/input.mjs";

const encoder = new TextEncoder();
const Q16_ONE = 0x1_0000;
let module;

before(async () => {
  module = await createZ8LuaModule();
});

function q16(value) {
  return value * Q16_ONE;
}

function sourceCart(source) {
  return {
    rom: new Uint8Array(0x8000),
    code: encoder.encode(source),
  };
}

function textCart(source) {
  return encoder.encode(
    `pico-8 cartridge // http://www.pico-8.com\nversion 42\n__lua__\n${source}\n`,
  );
}

function createRuntime() {
  const vm = new Z8LuaFrameVm(module, createPicoApiHostRouter(module));
  return new FrameSliceRuntime(vm, {
    picoApiHost: createPicoApiHost(vm.memory, vm.logicalMemory),
  });
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

function eventWith(type, properties = {}) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [name, value] of Object.entries(properties)) {
    Object.defineProperty(event, name, { configurable: true, value });
  }
  return event;
}

class FakeDocument extends EventTarget {
  activeElement;
  visibilityState = "visible";
  pointerLockElement = null;
  exitCount = 0;

  exitPointerLock() {
    this.exitCount += 1;
    this.pointerLockElement = null;
    this.dispatchEvent(new Event("pointerlockchange"));
  }
}

class FakeCanvas extends EventTarget {
  requestCount = 0;

  getBoundingClientRect() {
    return { left: 10, top: 20, width: 256, height: 128 };
  }

  requestPointerLock() {
    this.requestCount += 1;
    return Promise.resolve();
  }

  focus() {}
}

function packedPixel(screen, x, y) {
  const byte = screen[y * 64 + (x >> 1)];
  return (x & 1) === 0 ? byte & 0x0f : byte >> 4;
}

function findPixel(screen, y, color = 7) {
  for (let x = 0; x < 128; x += 1) {
    if (packedPixel(screen, x, y) === color) return x;
  }
  return -1;
}

test("operation 33 returns the documented input-only mixed stat types through real WASM", () => {
  const runtime = createRuntime();
  const boot = runtime.boot(sourceCart(`
function _init() poke(0x5f2d,7) end
function _update60()
 poke(0x4400,stat(30) and 1 or 0)
 local c=stat(31)
 poke(0x4401,#c)
 poke(0x4402,c=="a" and 1 or c=="b" and 2 or 0)
 poke(0x4403,stat(30) and 1 or 0)
 poke4(0x4410,stat(32))
 poke4(0x4414,stat(33))
 poke4(0x4418,stat(36))
 poke4(0x441c,stat(38))
 poke4(0x4420,stat(39))
 poke(0x4430,stat(34))
 poke(0x4431,stat(99)==false and 1 or 0)
 poke(0x4432,btn(4) and 1 or 0)
 poke(0x4433,btn(5) and 1 or 0)
 poke(0x4434,btn(6) and 1 or 0)
 poke(0x4435,btnp(6) and 1 or 0)
 poke2(0x4436,btn())
end
function _draw() end`));
  assert.equal(boot.ok, true, JSON.stringify(boot));
  assert.equal(boot.value.devkitFlags, 7);

  const first = runtime.step(inputSnapshot(undefined, {
    mouseXRaw: q16(12),
    mouseYRaw: q16(34),
    mouseButtons: 7,
    wheelRaw: -Q16_ONE,
    movementXRaw: q16(5),
    movementYRaw: q16(-6),
    keypresses: [97, 98],
  }));
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.value.frame.devkitFlags, 7);
  let ram = runtime.copyRam(0, 0x10000);
  assert.deepEqual([...ram.subarray(0x4400, 0x4404)], [1, 1, 1, 1]);
  assert.deepEqual(
    [0x4410, 0x4414, 0x4418, 0x441c, 0x4420].map((offset) =>
      new DataView(ram.buffer, ram.byteOffset + offset, 4).getInt32(0, true)),
    [q16(12), q16(34), -Q16_ONE, q16(5), q16(-6)],
  );
  assert.deepEqual([...ram.subarray(0x4430, 0x4438)], [7, 1, 1, 1, 1, 1, 112, 0]);
  assert.equal(ram[0x5f4c], 112);

  assert.equal(runtime.step(inputSnapshot()).ok, true);
  ram = runtime.copyRam(0, 0x10000);
  assert.deepEqual([...ram.subarray(0x4400, 0x4404)], [1, 1, 2, 0]);
  assert.equal(new DataView(ram.buffer, ram.byteOffset + 0x4418, 4).getInt32(0, true), 0);
  assert.equal(runtime.step(inputSnapshot()).ok, true);
  ram = runtime.copyRam(0, 0x10000);
  assert.deepEqual([...ram.subarray(0x4400, 0x4404)], [0, 0, 0, 0]);
  runtime.dispose();
});

test("RuntimeCore bounds the key FIFO, drops newest, gates flags and overlays mouse buttons", () => {
  const ram = new Uint8Array(0x10000);
  const input = new L1Input(ram);
  ram[0x5f2d] = 3;
  input.beginTick(inputSnapshot([0], {
    mouseButtons: 7,
    keypresses: Array.from({ length: 64 }, (_, index) => index),
  }), 60);
  input.beginTick(inputSnapshot([0], { mouseButtons: 7, keypresses: [200] }), 60);
  assert.equal(input.btn(q16(6)), 1);
  assert.equal(ram[0x5f4c], 112);
  assert.equal(input.stat(q16(30)), 1);
  assert.deepEqual(
    Array.from({ length: 64 }, () => input.stat(q16(31))),
    Array.from({ length: 64 }, (_, index) => index),
  );
  assert.equal(input.stat(q16(31)), -1);
  ram[0x5f2d] = 0;
  input.beginTick(inputSnapshot([0], { mouseButtons: 7, keypresses: [9] }), 60);
  assert.equal(input.btn(q16(6)), 0);
  assert.equal(input.stat(q16(30)), 0);
  assert.equal(ram[0x5f4c], 0);
});

test("Worker accumulates events once, retains latest state and rejects stale input", () => {
  const controller = createPlayerWorkerController(module);
  const cart = textCart(`
k=8 w=8 m=8
function _init() poke(0x5f2d,1) end
function _update60()
 if stat(30) then local c=stat(31) if c=="x" then k+=1 end end
 if stat(36)!=0 then w+=1 end
 if stat(32)==40 then m+=1 end
end
function _draw() cls(1) pset(k,0,7) pset(w,1,7) pset(m,2,7) end`);
  const ready = controller.handle(command("loadCart", { cartBytes: cart.slice().buffer }))[0];
  assert.equal(ready.devkitFlags, 1);
  assert.equal(isPlayerRuntimeToHost(ready), true);
  controller.handle(command("start", { requestId: 2 }));
  controller.handle(command("input", {
    requestId: 0,
    sequence: 1,
    input: inputSnapshot(undefined, {
      mouseXRaw: q16(10), wheelRaw: Q16_ONE, keypresses: [120],
    }),
  }));
  controller.handle(command("input", {
    requestId: 0,
    sequence: 2,
    input: inputSnapshot(undefined, { mouseXRaw: q16(40) }),
  }));
  controller.handle(command("input", {
    requestId: 0,
    sequence: 1,
    input: inputSnapshot(undefined, {
      mouseXRaw: q16(99), wheelRaw: Q16_ONE, keypresses: [121],
    }),
  }));
  assert.equal(controller.handle(command("vsync", {
    requestId: 3, sequence: 1, timestampMs: 0,
  })).at(-1).tickCount, 0);
  const catchUp = controller.handle(command("vsync", {
    requestId: 4, sequence: 2, timestampMs: 50,
  }));
  const frames = catchUp.filter(({ type }) => type === "frame");
  assert.equal(frames.length, 3);
  assert.equal(frames.every(({ devkitFlags }) => devkitFlags === 1), true);
  const screen = new Uint8Array(frames.at(-1).packedScreen);
  assert.deepEqual([findPixel(screen, 0), findPixel(screen, 1), findPixel(screen, 2)], [9, 9, 11]);

  assert.equal(isPlayerHostToRuntime(command("input", {
    requestId: 0,
    sequence: 3,
    input: { controllers: new Array(8).fill(0) },
  })), false);
  const reset = controller.handle(command("reset", { requestId: 5, sessionGeneration: 2 }))[0];
  assert.equal(reset.devkitFlags, 1);
  controller.dispose();
});

test("DevkitInputFrontend maps CSS coordinates, batches events and owns pointer-lock cleanup", async () => {
  const fakeWindow = new EventTarget();
  const document = new FakeDocument();
  const canvas = new FakeCanvas();
  document.activeElement = canvas;
  const frontend = new DevkitInputFrontend(canvas, { window: fakeWindow, document });
  frontend.setFlags(7);
  frontend.setEnabled(true);

  canvas.dispatchEvent(eventWith("pointerdown", { button: 0, buttons: 7 }));
  document.pointerLockElement = canvas;
  document.dispatchEvent(new Event("pointerlockchange"));
  canvas.dispatchEvent(eventWith("pointermove", {
    clientX: 50,
    clientY: 84,
    movementX: 2,
    movementY: -3,
  }));
  canvas.dispatchEvent(eventWith("wheel", { deltaY: -10 }));
  fakeWindow.dispatchEvent(eventWith("keydown", { key: "A", repeat: false }));
  fakeWindow.dispatchEvent(eventWith("keydown", { key: "Enter", repeat: false }));
  fakeWindow.dispatchEvent(eventWith("keydown", { key: "B", repeat: true }));
  await Promise.resolve();

  const batch = frontend.takeBatch();
  assert.deepEqual(batch, {
    mouseXRaw: q16(20),
    mouseYRaw: q16(64),
    mouseButtons: 7,
    wheelRaw: -Q16_ONE,
    movementXRaw: q16(2),
    movementYRaw: q16(-3),
    keypresses: [65, 13],
  });
  assert.equal(canvas.requestCount, 1);
  assert.deepEqual(frontend.takeBatch(), {
    ...batch,
    wheelRaw: 0,
    movementXRaw: 0,
    movementYRaw: 0,
    keypresses: [],
  });

  for (let index = 0; index < 70; index += 1) {
    fakeWindow.dispatchEvent(eventWith("keydown", { key: "C", repeat: false }));
  }
  assert.equal(frontend.takeBatch().keypresses.length, 64);
  document.pointerLockElement = canvas;
  frontend.setFlags(0);
  assert.equal(document.exitCount, 1);
  assert.equal(frontend.takeBatch().mouseButtons, 0);
  frontend.dispose();
});

test("deterministic devkit trace matches the project golden", async () => {
  const golden = JSON.parse(await readFile(
    new URL("../golden/devkit-input.json", import.meta.url),
    "utf8",
  ));
  const ram = new Uint8Array(0x10000);
  const input = new L1Input(ram);
  ram[0x5f2d] = 3;
  const trace = [];
  for (let tick = 0; tick < 16; tick += 1) {
    input.beginTick(inputSnapshot([tick & 0x3f], {
      mouseXRaw: q16(tick * 3),
      mouseYRaw: q16(127 - tick),
      mouseButtons: tick % 4,
      wheelRaw: q16((tick % 3) - 1),
      movementXRaw: q16(tick - 8),
      movementYRaw: q16(8 - tick),
      keypresses: [65 + tick],
    }), tick < 8 ? 30 : 60);
    trace.push({
      buttons: input.btn(),
      pressed6: input.btnp(q16(6)),
      key: input.stat(q16(31)),
      x: input.stat(q16(32)),
      y: input.stat(q16(33)),
      mouse: input.stat(q16(34)),
      wheel: input.stat(q16(36)),
      dx: input.stat(q16(38)),
      dy: input.stat(q16(39)),
    });
  }
  assert.deepEqual({ trace, registers: [...ram.subarray(0x5f2d, 0x5f54)] }, golden);
});
