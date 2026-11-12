import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { before } from "node:test";

import {
  FrameSliceRuntime,
} from "@pico8-web/runtime-core";
import {
  createPicoApiHostRouter,
  Z8LuaFrameVm,
} from "@pico8-web/z8lua-bridge";
import {
  decodePackedPicoFrame,
  PICO_RGBA_FRAME_BYTES,
} from "../../apps/web-player/dist/runtime/pico-frame.js";
import {
  isPlayerRuntimeToHost,
} from "../../apps/web-player/dist/transport/public.js";
import {
  createPlayerWorkerController,
} from "../../apps/web-player/dist/worker/compose-runtime.js";
import createZ8LuaModule from "../../wasm/dist/z8lua-runtime-v1.mjs";

const encoder = new TextEncoder();
let module;

before(async () => {
  module = await createZ8LuaModule();
});

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

function createRuntime(source) {
  const vm = new Z8LuaFrameVm(module, createPicoApiHostRouter(module));
  const runtime = new FrameSliceRuntime(vm);
  const boot = runtime.boot(sourceCart(source));
  assert.equal(boot.ok, true, JSON.stringify(boot));
  return runtime;
}

function stepFrame(runtime) {
  const result = runtime.step();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.kind, "frame");
  return result.value.frame;
}

function pixel(screen, x, y) {
  return (screen[y * 64 + (x >> 1)] >> ((x & 1) << 2)) & 0x0f;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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

test("appends typed graphics bindings and resets RAM-backed draw state", async () => {
  const contract = JSON.parse(await readFile(
    new URL("../../spec/abi/pico-host-api-v1.json", import.meta.url),
    "utf8",
  ));
  assert.deepEqual(contract.bindings.slice(9, 18).map(({ id, guestName }) => [id, guestName]), [
    [10, "color"],
    [11, "camera"],
    [12, "clip"],
    [13, "pal"],
    [14, "palt"],
    [15, "fillp"],
    [16, "pget"],
    [17, "oval"],
    [18, "ovalfill"],
  ]);

  const defaults = createRuntime(`
function _init() end
function _update() end
function _draw() end`);
  assert.deepEqual([...defaults.copyRam(0x5f00, 16)], [
    0x10, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  ]);
  assert.deepEqual([...defaults.copyRam(0x5f10, 16)], [...Array(16).keys()]);
  assert.deepEqual([...defaults.copyRam(0x5f20, 4)], [0, 0, 128, 128]);
  assert.equal(defaults.copyRam(0x5f25, 1)[0], 6);
  assert.deepEqual([...defaults.copyRam(0x5f28, 4)], [0, 0, 0, 0]);
  assert.deepEqual([...defaults.copyRam(0x5f31, 3)], [0, 0, 0]);
  assert.deepEqual([...defaults.copyRam(0x5f60, 16)], [
    0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
    0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
  ]);
  defaults.dispose();

  const changed = createRuntime(`
function _init()
 poke(0x200,color(0x76))
 camera(-2,3)
 clip(4,5,6,7,true)
 poke(0x201,pal(6,9))
 poke(0x202,pal(3,0x8e,1))
 poke(0x203,pal(4,0xa7,2))
 poke(0x204,palt(6,true) and 1 or 0)
 poke2(0x205,palt())
 poke4(0x208,fillp(0x1234.a000))
 poke4(0x20c,fillp())
 fillp(0x1234.a000)
end
function _update() end
function _draw() end`);
  assert.deepEqual([...changed.copyRam(0x200, 16)], [
    6, 6, 3, 0x44, 0, 0x00, 0x82, 0, 0, 0, 0, 0,
    0x00, 0xa0, 0x34, 0x12,
  ]);
  assert.equal(changed.copyRam(0x5f25, 1)[0], 0x76);
  assert.deepEqual([...changed.copyRam(0x5f28, 4)], [0xfe, 0xff, 3, 0]);
  assert.deepEqual([...changed.copyRam(0x5f20, 4)], [4, 5, 10, 12]);
  assert.equal(changed.copyRam(0x5f06, 1)[0], 9);
  assert.equal(changed.copyRam(0x5f13, 1)[0], 0x8e);
  assert.equal(changed.copyRam(0x5f64, 1)[0], 0xa7);
  assert.deepEqual([...changed.copyRam(0x5f31, 3)], [0x34, 0x12, 5]);
  changed.dispose();

  const tablePalette = createRuntime(`
function _init()
 pal({[1]=2,[12]=9,[16]=4})
end
function _update() end
function _draw() end`);
  assert.equal(tablePalette.copyRam(0x5f00, 1)[0], 0x14);
  assert.equal(tablePalette.copyRam(0x5f01, 1)[0], 2);
  assert.equal(tablePalette.copyRam(0x5f0c, 1)[0], 9);
  tablePalette.dispose();
});

test("camera, clip, draw palette, fill pattern and pget share immediate RAM state", () => {
  const runtime = createRuntime(`
function _init()
 poke(0x5f28,2,0,0,0)
 poke(0x5f20,1,1,5,5)
 poke(0x5f06,9)
 fillp(0x5a5a)
 color(0x76)
end
function _update() end
function _draw()
 rectfill(3,1,6,4)
 poke(0x210,pget(3,1),pget(2,1),pget(7,1))
 pal(0,0x8e,1)
end`);
  const frame = stepFrame(runtime);
  assert.equal(pixel(frame.screen, 1, 1), 9);
  assert.equal(pixel(frame.screen, 2, 1), 7);
  assert.equal(pixel(frame.screen, 0, 1), 0);
  assert.equal(pixel(frame.screen, 5, 1), 0);
  assert.deepEqual([...runtime.copyRam(0x210, 3)], [9, 0, 0]);
  assert.equal(frame.displayPalette.byteLength, 16);
  assert.equal(frame.displayPalette[0], 0x8e);
  runtime.dispose();
});

test("secondary palette, transparent pattern pixels and inverted fills compose deterministically", () => {
  const runtime = createRuntime(`
function _init() end
function _update() end
function _draw()
 cls(2)
 pal(6,0x87,2)
 fillp(0xaaaa.2000)
 pset(0,0,6)
 pset(1,0,6)
 fillp(0xffff.8000)
 pset(2,0,6)
 poke(0x5f34,3)
 clip(8,0,4,4)
 rectfill(9,1,10,2,0x1806.0000)
end`);
  const frame = stepFrame(runtime);
  assert.deepEqual([pixel(frame.screen, 0, 0), pixel(frame.screen, 1, 0)], [8, 7]);
  assert.equal(pixel(frame.screen, 2, 0), 2);
  assert.equal(pixel(frame.screen, 8, 0), 6);
  assert.equal(pixel(frame.screen, 9, 1), 2);
  assert.equal(pixel(frame.screen, 10, 2), 2);
  assert.equal(pixel(frame.screen, 11, 3), 6);
  runtime.dispose();
});

test("existing primitives plus reversed and fractional ovals produce a fixed packed-RAM golden", () => {
  const source = `
function _init() end
function _update() end
function _draw()
 cls(1)
 camera(2,-1)
 clip(3,2,121,123)
 pal(6,12)
 fillp(0x33cc)
 line(-2.5,4.75,80.5,31.25,0x76)
 rect(8.5,8.5,31.5,25.5,0x96)
 rectfill(35.5,7.5,49.5,24.5,0xa6)
 circ(61.5,18.5,11.5,0xb6)
 circfill(82.5,18.5,9.5,0xc6)
 oval(118.5,30.5,96.5,8.5,0xd6)
 ovalfill(14.5,58.5,48.5,32.5,0xe6)
 oval(-20,70,20,100,0xf6)
end`;
  const first = createRuntime(source);
  const second = createRuntime(source);
  const firstFrame = stepFrame(first);
  const secondFrame = stepFrame(second);
  assert.equal(sha256(firstFrame.screen), sha256(secondFrame.screen));
  assert.equal(sha256(firstFrame.screen), "0f5af6e7bd5f26fd1f9c25fd864af6b8d987dc267d3e0cb418b0a7be9ad39dcc");
  assert.equal(pixel(firstFrame.screen, 3, 2) >= 0, true);
  first.dispose();
  second.dispose();
});

test("production Worker DTO and Canvas decoder carry display palette without exposing RAM", () => {
  const controller = createPlayerWorkerController(module);
  const cart = textCart(`
function _update() end
function _draw()
 cls(0)
 pset(0,0,1)
 pal(1,0x8e,1)
end`);
  const ready = controller.handle(command("loadCart", {
    cartBytes: cart.slice().buffer,
    instructionBudget: 100000,
  }));
  assert.equal(ready[0].type, "state");
  controller.handle(command("start"));
  controller.handle(command("vsync", { sequence: 1, timestampMs: 0 }));
  const tick = controller.handle(command("vsync", {
    requestId: 2,
    sequence: 2,
    timestampMs: 1000 / 30,
  }));
  const event = tick.find((candidate) => candidate.type === "frame");
  assert.ok(event);
  assert.equal(isPlayerRuntimeToHost(event), true);
  assert.equal(event.displayPalette.byteLength, 16);
  assert.equal(new Uint8Array(event.displayPalette)[1], 0x8e);
  assert.equal(isPlayerRuntimeToHost({ ...event, displayPalette: new ArrayBuffer(15) }), false);

  const rgba = new Uint8ClampedArray(PICO_RGBA_FRAME_BYTES);
  decodePackedPicoFrame(
    new Uint8Array(event.packedScreen),
    rgba,
    undefined,
    new Uint8Array(event.displayPalette),
  );
  assert.deepEqual([...rgba.subarray(0, 4)], [0xff, 0x6e, 0x59, 0xff]);
  controller.dispose();
});
