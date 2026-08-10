import assert from "node:assert/strict";
import test, { before } from "node:test";

import {
  createPicoApiHost,
  FrameSliceRuntime,
} from "@pico8-web/runtime-core";
import {
  createPicoApiHostRouter,
  Z8LuaFrameVm,
} from "@pico8-web/z8lua-bridge";
import createZ8LuaModule from "../../wasm/dist/z8lua-runtime-v1.mjs";
import { inputSnapshot } from "../helpers/input.mjs";

const encoder = new TextEncoder();
const Q16_ONE = 65_536;
const SFX_BASE = 0x3200;
const SFX_BYTES = 68;
let module;

before(async () => {
  module = await createZ8LuaModule();
});

function q16(value) {
  return Math.trunc(value * Q16_ONE) | 0;
}

function writeSfx(rom, sfx, speed) {
  const metadata = SFX_BASE + sfx * SFX_BYTES + 64;
  rom[metadata + 1] = speed;
  for (let note = 0; note < 32; note += 1) {
    const address = SFX_BASE + sfx * SFX_BYTES + note * 2;
    rom[address] = 24 + note;
    rom[address + 1] = 0x0e;
  }
}

function sourceCart(source, rom) {
  return { rom, code: encoder.encode(source) };
}

function readRaw(runtime, address) {
  const bytes = runtime.copyRam(address, 4);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(0, true);
}

test("stat(20) exposes deterministic channel-0 note state through real WASM", () => {
  const rom = new Uint8Array(0x8000);
  writeSfx(rom, 0, 4);
  const vm = new Z8LuaFrameVm(module, createPicoApiHostRouter(module));
  const host = createPicoApiHost(vm.memory, vm.logicalMemory);
  const runtime = new FrameSliceRuntime(vm, { picoApiHost: host });
  const boot = runtime.boot(sourceCart(`
frame=0
function _init()
 poke4(0x5000,stat(20))
 sfx(0,0,0,16)
 poke4(0x5004,stat(20))
 poke(0x5040,type(stat(19))=="number" and type(stat(21))=="number" and stat(99)==false and 1 or 0)
 poke(0x5041,type(stat(20))=="number" and 1 or 0)
 poke(0x5042,type(stat(30))=="boolean" and 1 or 0)
 poke(0x5043,type(stat(32))=="number" and 1 or 0)
end
function _update()
 frame+=1
 poke4(0x5004+frame*4,stat(20))
 if frame==3 then
  sfx(-1,0)
  poke4(0x5020,stat(20))
 end
end
function _draw() end`, rom));

  assert.equal(boot.ok, true, JSON.stringify(boot));
  assert.equal(readRaw(runtime, 0x5000), q16(-1), "idle stat(20)");
  assert.equal(readRaw(runtime, 0x5004), q16(0), "active launch note");
  assert.deepEqual([...runtime.copyRam(0x5040, 4)], [1, 1, 1, 1]);
  assert.equal(host.stat(q16(20)), q16(1), "boot audio advances the authoritative synth");

  for (const expected of [1, 2, 3]) {
    const step = runtime.step(inputSnapshot());
    assert.equal(step.ok, true, JSON.stringify(step));
    assert.equal(readRaw(runtime, 0x5004 + expected * 4), q16(expected));
  }
  assert.equal(readRaw(runtime, 0x5020), q16(-1), "guest sfx stop is visible immediately");
  assert.equal(host.stat(q16(20)), q16(-1));

  host.sfx(q16(0), q16(0));
  assert.equal(host.stat(q16(20)), q16(0));
  host.resetAudio();
  assert.equal(host.stat(q16(20)), q16(-1), "session audio reset clears the selector");
  const afterReset = runtime.step(inputSnapshot());
  assert.equal(afterReset.ok, true, JSON.stringify(afterReset));
  assert.equal(readRaw(runtime, 0x5014), q16(-1), "WASM observes reset synth state");
  runtime.dispose();
});
