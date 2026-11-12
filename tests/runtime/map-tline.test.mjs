import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { before } from "node:test";

import { FrameSliceRuntime } from "@pico8-web/runtime-core";
import {
  createPicoApiHostRouter,
  Z8LuaFrameVm,
} from "@pico8-web/z8lua-bridge";
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

function createRuntime(source, options = {}) {
  const vm = new Z8LuaFrameVm(module, createPicoApiHostRouter(module));
  const runtime = new FrameSliceRuntime(vm, options);
  const boot = runtime.boot(sourceCart(source));
  assert.equal(boot.ok, true, JSON.stringify(boot));
  return { runtime, vm };
}

function stepFrame(runtime) {
  const step = runtime.step();
  assert.equal(step.ok, true, JSON.stringify(step));
  return step.value.frame;
}

function pixel(screen, x, y) {
  const packed = screen[y * 64 + (x >> 1)];
  return (packed >>> ((x & 1) * 4)) & 0x0f;
}

function pixels(screen, y, x0, x1) {
  return Array.from({ length: x1 - x0 + 1 }, (_, index) =>
    pixel(screen, x0 + index, y));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("appends map bindings without changing the 80-byte ABI", async () => {
  const contract = JSON.parse(await readFile(
    new URL("../../spec/abi/pico-host-api-v1.json", import.meta.url),
    "utf8",
  ));
  assert.equal(contract.dispatchAbi.callFrame.byteSize, 80);
  assert.deepEqual(contract.bindings.slice(22, 28).map(({ id, guestName }) => [id, guestName]), [
    [23, "mget"],
    [24, "mset"],
    [25, "fget"],
    [26, "fset"],
    [27, "map"],
    [28, "tline"],
  ]);
});

test("map resolver covers default shared RAM, aliases, upper RAM, width and custom bounds", () => {
  const { runtime } = createRuntime(`
function _init()
 poke(0x4310,peek(0x5f56),peek(0x5f57))
 mset(0,0,0x11)
 mset(127,31,0x12)
 mset(0,32,0x13)
 mset(127,63,0x14)
 mset(1.99,0.99,0x15)
 poke(0x4300,mget(0,0),mget(127,31),mget(0,32),mget(127,63),mget(1,0))
 poke(0x5f36,0x10)
 poke(0x5f5a,0x7b)
 poke(0x4305,mget(-0.01,0),mget(128,0),mget(0,64))

 poke(0x5f57,0)
 mset(255,31,0x21)
 poke(0x4308,mget(255,31),mget(0,32))

 poke(0x5f56,0x18)
 poke(0x5f57,4)
 mset(0,1,0x31)
 poke(0x430a,mget(0,1),peek(0x1804))
 poke(0x5f56,0x38)
 poke(0x430c,mget(0,1))

 poke(0x5f56,0xe0)
 poke(0x5f57,0)
 mset(255,31,0x41)
 poke(0x430d,mget(255,31),mget(0,32))

 poke(0x5f56,0x40)
 poke(0x5f57,128)
 mset(0,0,0x51)
 poke(0x430f,mget(0,0))
end
function _update() end
function _draw() end`);

  assert.deepEqual([...runtime.copyRam(0x4300, 16)], [
    0x11, 0x12, 0x13, 0x14, 0x15,
    0x7b, 0x7b, 0x7b,
    0x21, 0x7b,
    0x31, 0x31, 0x31,
    0x41, 0x7b,
    0x51,
  ]);
  assert.equal(runtime.copyRam(0x2000, 1)[0], 0x51);
  assert.equal(runtime.copyRam(0x2fff, 1)[0], 0x12);
  assert.equal(runtime.copyRam(0x1000, 1)[0], 0x13);
  assert.equal(runtime.copyRam(0x1fff, 1)[0], 0x21);
  assert.equal(runtime.copyRam(0x1804, 1)[0], 0x31);
  assert.equal(runtime.copyRam(0xffff, 1)[0], 0x41);
  assert.deepEqual([...runtime.copyRam(0x4310, 2)], [0x20, 0x80]);
  runtime.dispose();
});

test("flags preserve byte, bit, boolean and direct-poke semantics at 0x3000", () => {
  const { runtime } = createRuntime(`
function _init()
 fset(3,0xa5)
 poke(0x4300,fget(3),fget(3,0) and 1 or 0,fget(3,1) and 1 or 0)
 fset(3,1,true)
 fset(3,7,false)
 poke(0x4303,fget(3),peek(0x3003))
 poke(0x3004,0x81)
 poke(0x4305,fget(4),fget(4,7) and 1 or 0)
 fset(-1,0xff)
 fset(256,0xff)
 fset(4,-1,true)
 fset(4,8,true)
 poke(0x4307,peek(0x3004),fget(-1),fget(256),fget(4,-1) and 1 or 0,fget(4,8) and 1 or 0)
end
function _update() end
function _draw() end`);

  assert.deepEqual([...runtime.copyRam(0x4300, 12)], [
    0xa5, 1, 0,
    0x27, 0x27,
    0x81, 1,
    0x81, 0, 0, 0, 0,
  ]);
  runtime.dispose();
});

test("map reuses sprite raster state with defaults, layers, tile-zero override and bounded visible work", () => {
  const { runtime } = createRuntime(`
function solid(n,c)
 for y=0,7 do
  for x=0,7 do sset(n*8+x,y,c) end
 end
end
function _init()
 solid(0,4) solid(1,1) solid(2,2) solid(3,3)
 mset(0,0,0) mset(1,0,1) mset(2,0,2) mset(3,0,3)
 fset(1,0,true) fset(2,1,true) fset(3,3)
end
function _update() end
function _draw()
 cls()
 map(0,0,0,0,4,1)
 map(0,0,0,8,4,1,1)
 map(0,0,0,16,4,1,2)
 poke(0x5f36,peek(0x5f36)|0x08)
 map(0,0,0,24,4,1)
 camera(8,0) clip(0,32,16,8)
 map(1,0,8,32,3,1)
 camera() clip()
 poke(0x5f56,0xe0) poke(0x5f57,128)
 mset(0,0,2)
 map(0,0,0,40,1,1)
 poke(0x5f36,peek(0x5f36)&~0x08)
 camera(0,-48) map() camera()
 pal(2,12) map(0,0,0,56,1,1)
 palt(2,true) map(0,0,0,64,1,1)
 pal() palt()
 pal(2,3) pal(3,0x87,2) fillp(0xaaaa.4000)
 map(0,0,0,72,1,1)
 pal() fillp()
 map(0,0,-32700,-32700,32767,32767)
end`, { instructionBudget: 1_000_000 });
  const frame = stepFrame(runtime);

  assert.deepEqual(pixels(frame.screen, 0, 0, 31), [
    ...new Array(8).fill(0),
    ...new Array(8).fill(1),
    ...new Array(8).fill(2),
    ...new Array(8).fill(3),
  ]);
  assert.deepEqual(pixels(frame.screen, 8, 0, 31), [
    ...new Array(8).fill(0),
    ...new Array(8).fill(1),
    ...new Array(8).fill(0),
    ...new Array(8).fill(3),
  ]);
  assert.deepEqual(pixels(frame.screen, 16, 0, 31), [
    ...new Array(16).fill(0),
    ...new Array(8).fill(2),
    ...new Array(8).fill(3),
  ]);
  assert.deepEqual(pixels(frame.screen, 24, 0, 31), [
    ...new Array(8).fill(4),
    ...new Array(8).fill(1),
    ...new Array(8).fill(2),
    ...new Array(8).fill(3),
  ]);
  assert.deepEqual(pixels(frame.screen, 32, 0, 15), [
    ...new Array(8).fill(1),
    ...new Array(8).fill(2),
  ]);
  assert.deepEqual(pixels(frame.screen, 40, 0, 7), new Array(8).fill(2));
  assert.deepEqual(pixels(frame.screen, 48, 0, 7), new Array(8).fill(2));
  assert.deepEqual(pixels(frame.screen, 56, 0, 7), new Array(8).fill(12));
  assert.deepEqual(pixels(frame.screen, 64, 0, 7), new Array(8).fill(0));
  assert.deepEqual(pixels(frame.screen, 72, 0, 7), [8, 7, 8, 7, 8, 7, 8, 7]);
  assert.equal(runtime.copyRam(0xe000, 1)[0], 2);
  runtime.dispose();
});

test("tline samples signed Q16.16 coordinates with masks, offsets, layers and draw state", () => {
  const { runtime } = createRuntime(`
function _init()
  for y=0,7 do
  for x=0,7 do
   sset(8+x,y,x+1)
   sset(16+x,y,9+(x%7))
   sset(24+x,y,y+1)
  end
 end
 mset(0,0,1) mset(1,0,2) mset(0,1,3)
 fset(1,1) fset(2,2)
end
function _update() end
function _draw()
 cls()
 tline(0,0,15,0,0,0)
 tline(15,2,0,2,0,0)
 tline(0,4,7,11,0,0)
 tline(0,13,7,13,0,0,0,0)
 poke(0x5f38,1) poke(0x5f3a,1)
 tline(0,15,15,15,0,0)
 poke(0x5f38,0) poke(0x5f3a,0)
 tline(0,17,15,17,0,0,0.125,0,1)
 tline(0,19,15,19,0,0,0.125,0,2)
 camera(2,20) clip(0,26,6,1)
 tline(2,46,9,46,0,0)
 camera() clip()
 pal(1,12) palt(2,true)
 tline(0,22,3,22,0,0)
 pal() palt()
 pal(9,3) pal(3,0x87,2) fillp(0xaaaa.4000)
 tline(0,24,7,24,1,0,0,0)
 fillp() pal()
 tline(0,28,7,28,0.875,0,-0.125,0)
 tline(0,30,7,30,0,1,0,0.125)
end`);
  const frame = stepFrame(runtime);
  const sequence = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 9];

  assert.deepEqual(pixels(frame.screen, 0, 0, 15), sequence);
  assert.deepEqual(pixels(frame.screen, 2, 0, 15), [...sequence].reverse());
  for (let index = 0; index < 8; index += 1) {
    assert.equal(pixel(frame.screen, index, 4 + index), index + 1);
  }
  assert.deepEqual(pixels(frame.screen, 13, 0, 7), new Array(8).fill(1));
  assert.deepEqual(pixels(frame.screen, 15, 0, 15), [
    9, 10, 11, 12, 13, 14, 15, 9,
    9, 10, 11, 12, 13, 14, 15, 9,
  ]);
  assert.deepEqual(pixels(frame.screen, 17, 0, 15), [
    1, 2, 3, 4, 5, 6, 7, 8,
    0, 0, 0, 0, 0, 0, 0, 0,
  ]);
  assert.deepEqual(pixels(frame.screen, 19, 0, 15), [
    0, 0, 0, 0, 0, 0, 0, 0,
    9, 10, 11, 12, 13, 14, 15, 9,
  ]);
  assert.deepEqual(pixels(frame.screen, 26, 0, 7), [1, 2, 3, 4, 5, 6, 0, 0]);
  assert.deepEqual(pixels(frame.screen, 22, 0, 3), [12, 0, 3, 4]);
  assert.deepEqual(pixels(frame.screen, 24, 0, 7), [8, 7, 8, 7, 8, 7, 8, 7]);
  assert.deepEqual(pixels(frame.screen, 28, 0, 7), [8, 7, 6, 5, 4, 3, 2, 1]);
  assert.deepEqual(pixels(frame.screen, 30, 0, 7), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(sha256(frame.screen), "c99d9aaff66b4922a3926d691e169bff231976dde51292e9e8921f87ae024e60");
  runtime.dispose();
});

test("upper map wins conflicts while non-overlapping GFX and screen mappings remain active", () => {
  const conflict = createRuntime(`
function _init()
 poke(0x5f56,0xc0)
 poke(0x5f54,0xc0)
 poke(0x5f55,0xe0)
end
function _update() end
function _draw() end`);
  assert.equal(conflict.vm.logicalMemory.mapAddress(0), 0x0000);
  assert.equal(conflict.vm.logicalMemory.mapAddress(0x6000), 0x6000);
  conflict.runtime.dispose();

  const nonConflict = createRuntime(`
function _init()
 poke(0x5f56,0xe0)
 poke(0x5f54,0xc0)
 poke(0x5f55,0xa0)
end
function _update() end
function _draw() end`);
  assert.equal(nonConflict.vm.logicalMemory.mapAddress(0), 0xc000);
  assert.equal(nonConflict.vm.logicalMemory.mapAddress(0x6000), 0xa000);
  nonConflict.runtime.dispose();
});
