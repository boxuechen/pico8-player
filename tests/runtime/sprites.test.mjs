import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { before } from "node:test";

import { FrameSliceRuntime } from "@pico8-player/runtime-core";
import {
  createPicoApiHostRouter,
  Z8LuaFrameVm,
} from "@pico8-player/z8lua-bridge";
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

function pixels(screen, y, x0, x1) {
  return Array.from({ length: x1 - x0 + 1 }, (_, index) =>
    pixel(screen, x0 + index, y));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("appends sprite bindings and sget/sset obey nibble, palette and bounds rules", async () => {
  const contract = JSON.parse(await readFile(
    new URL("../../spec/abi/pico-host-api-v1.json", import.meta.url),
    "utf8",
  ));
  assert.deepEqual(contract.bindings.slice(18, 22).map(({ id, guestName }) => [id, guestName]), [
    [19, "sget"],
    [20, "sset"],
    [21, "spr"],
    [22, "sspr"],
  ]);

  const runtime = createRuntime(`
function _init()
 color(6)
 pal(6,9)
 sset(0.75,0.75)
 sset(1,0,7)
 sset(2,0,8)
 poke(0x4300,sget(0.99,0.99),sget(1,0),sget(-0.01,0),sget(128,0))
 poke(0x5f36,0x10)
 poke(0x5f59,13)
 poke(0x4304,sget(128,0))
 sset(128,0,4)
end
function _update() end
function _draw() end`);
  assert.deepEqual([...runtime.copyRam(0, 2)], [0x79, 0x08]);
  assert.deepEqual([...runtime.copyRam(0x4300, 5)], [9, 7, 0, 0, 13]);
  assert.equal(runtime.copyRam(0x5f25, 1)[0], 6, "sset must not mutate the pen");
  runtime.dispose();
});

test("sprite APIs and direct memory share GFX remap aliases without a duplicate sheet", () => {
  const runtime = createRuntime(`
function _init()
 poke(0x5f54,0x80)
 sset(2,3,11)
 poke(0x4300,sget(2,3),peek(0x00c1))
 poke(0x00c2,0xd0)
 poke(0x4302,sget(5,3))
 poke(0x5f54,0x60)
 sset(0,0,5)
end
function _update() end
function _draw() end`);
  assert.deepEqual([...runtime.copyRam(0x4300, 3)], [11, 11, 13]);
  assert.equal(runtime.copyRam(0x80c1, 1)[0] & 0x0f, 11);
  assert.equal(runtime.copyRam(0x80c2, 1)[0], 0xd0);
  const frame = stepFrame(runtime);
  assert.equal(pixel(frame.screen, 0, 0), 5);
  runtime.dispose();
});

test("spr handles fractional extents, row boundaries, camera, clip, flips and transparency", () => {
  const runtime = createRuntime(`
function _init()
 for x=120,127 do
  sset(x,0,x-119)
  sset(x,1,8-(x-120))
 end
end
function _update() end
function _draw()
 cls(2)
 camera(2,3)
 clip(8,7,20,12)
 spr(15,10,10,1.5,0.25,true,true)
 pal(8,9)
 palt(7,true)
 spr(15,10,14,1,0.125,false,false)
end`);
  const frame = stepFrame(runtime);
  assert.deepEqual(pixels(frame.screen, 7, 8, 19), [
    2, 2, 2, 2, 1, 2, 3, 4, 5, 6, 7, 8,
  ]);
  assert.deepEqual(pixels(frame.screen, 11, 8, 15), [1, 2, 3, 4, 5, 6, 2, 9]);
  assert.deepEqual(pixels(frame.screen, 7, 7, 20), [
    2, 2, 2, 2, 2, 1, 2, 3, 4, 5, 6, 7, 8, 2,
  ]);
  runtime.dispose();
});

test("sspr uses deterministic nearest sampling for up/down scale and negative destinations", () => {
  const runtime = createRuntime(`
function _init()
 for x=0,7 do sset(x,0,x+1) end
 sset(126,1,9)
 sset(127,1,10)
end
function _update() end
function _draw()
 cls(2)
 sspr(0,0,4,1,0,0,8,2)
 sspr(0,0,4,1,0,3,2,1)
 sspr(0,0,4,1,7,5,-4,1)
 sspr(0,0,4,1,7,7,-4,-1,true,true)
 sspr(126,1,4,1,10,9,4,1)
 clip(0,0,0,0)
 sspr(0,0,1,1,-32700,-32700,32767,32767)
end`);
  const frame = stepFrame(runtime);
  assert.deepEqual(pixels(frame.screen, 0, 0, 7), [1, 1, 2, 2, 3, 3, 4, 4]);
  assert.deepEqual(pixels(frame.screen, 1, 0, 7), [1, 1, 2, 2, 3, 3, 4, 4]);
  assert.deepEqual(pixels(frame.screen, 3, 0, 1), [1, 3]);
  assert.deepEqual(pixels(frame.screen, 5, 4, 7), [4, 3, 2, 1]);
  assert.deepEqual(pixels(frame.screen, 7, 4, 7), [1, 2, 3, 4]);
  assert.deepEqual(pixels(frame.screen, 9, 10, 13), [9, 10, 2, 2]);
  assert.equal(sha256(frame.screen), "337c0b373ba82b7b1f6e8239ce0eb1da46b7a854e4066d994793520582707180");
  runtime.dispose();
});

test("fillp apply-to-sprites composes draw palette, secondary pairs and transparency", () => {
  const runtime = createRuntime(`
function _init()
 for y=0,7 do
  for x=0,7 do sset(x,y,12) end
 end
end
function _update() end
function _draw()
 cls(2)
 pal(12,3)
 pal(3,0x87,2)
 fillp(0xaaaa.4000)
 spr(0,0,0)
 fillp(0xaaaa.c000)
 spr(0,0,9)
 fillp(0xaaaa.2000)
 pset(18,0,3)
 spr(0,20,0,0.125,0.125)
end`);
  const frame = stepFrame(runtime);
  assert.deepEqual(pixels(frame.screen, 0, 0, 7), [8, 7, 8, 7, 8, 7, 8, 7]);
  assert.deepEqual(pixels(frame.screen, 9, 0, 7), [2, 7, 2, 7, 2, 7, 2, 7]);
  assert.equal(pixel(frame.screen, 18, 0), 8, "global secondary still applies to primitives");
  assert.equal(pixel(frame.screen, 20, 0), 3, "global-secondary alone must not pattern sprites");
  runtime.dispose();
});
