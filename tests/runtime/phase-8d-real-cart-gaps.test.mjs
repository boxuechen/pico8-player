import assert from "node:assert/strict";
import test, { before } from "node:test";

import {
  createPicoApiHost,
  DEFAULT_SAFETY_INSTRUCTION_LIMIT,
  FrameSliceRuntime,
} from "@pico8-web/runtime-core";
import {
  createPicoApiHostRouter,
  Z8LuaFrameVm,
} from "@pico8-web/z8lua-bridge";
import createZ8LuaModule from "../../wasm/dist/z8lua-runtime-v1.mjs";
import {
  createPlayerWorkerController,
} from "../../apps/web-player/dist/worker/compose-runtime.js";

const encoder = new TextEncoder();
let module;

before(async () => {
  module = await createZ8LuaModule();
});

function sourceCart(source) {
  return { rom: new Uint8Array(0x8000), code: encoder.encode(source) };
}

function boot(source, instructionBudget) {
  const vm = new Z8LuaFrameVm(module, createPicoApiHostRouter(module));
  const runtime = new FrameSliceRuntime(vm, {
    ...(instructionBudget === undefined ? {} : { instructionBudget }),
  });
  const result = runtime.boot(sourceCart(source));
  assert.equal(result.ok, true, JSON.stringify(result));
  return runtime;
}

function textCart(source) {
  return encoder.encode(
    `pico-8 cartridge // http://www.pico-8.com\nversion 43\n__lua__\n${source}\n`,
  );
}

test("short-if ignores newlines swallowed by a long comment", () => {
  const runtime = boot(`
function _init()
 local hit=0
 if (true) --[[
  project-authored ignored text
 ]] hit=7
 poke(0x5000,hit)
end
function _update() end
function _draw() end`);
  assert.equal(runtime.copyRam(0x5000, 1)[0], 7);
  runtime.dispose();
});

test("single-name local compound initialization reads the previous visible binding", () => {
  const runtime = boot(`
function _init()
 local value=4
 local value+=3
 poke(0x5000,value)
end
function _update() end
function _draw() end`);
  assert.equal(runtime.copyRam(0x5000, 1)[0], 7);
  runtime.dispose();
});

test("omitted function arguments become nil and nil-like print calls are printable", () => {
  const runtime = boot(`
function _init()
 local function capture(a,b,c) return a,b,c end
 local a,b,c=capture(,7,)
 pset(nil,nil,nil)
 spr(nil,nil,nil)
 print(nil)
 print()
 poke(0x5000,a==nil and b==7 and c==nil and 1 or 0)
end
function _update() end
function _draw() end`);
  assert.equal(runtime.copyRam(0x5000, 1)[0], 1);
  runtime.dispose();
});

test("a replaced _ENV falls back to the original cart environment for missing globals", () => {
  const runtime = boot(`
function _init()
 local original=_ENV
 _ENV={value=7}
 pset(0,0,value)
 poke(0x5000,value)
 _ENV=original
end
function _update() end
function _draw() end`);
  assert.equal(runtime.copyRam(0x5000, 1)[0], 7);
  runtime.dispose();
});

test("flip suspends and resumes init, update and draw callbacks at frame boundaries", () => {
  const runtime = boot(`
frame=0
function _init()
 poke(0x5000,1)
 flip()
 poke(0x5000,2)
end
function _update()
 frame+=1
 if frame==1 then flip() end
 poke(0x5001,frame)
end
function _draw()
 poke(0x5002,frame)
 if frame==2 then flip() end
 poke(0x5003,frame)
end`);
  assert.equal(runtime.copyRam(0x5000, 1)[0], 1);

  for (const expected of [2, 3, 4, 5, 6]) {
    const result = runtime.step();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.value.kind, "frame");
    assert.equal(runtime.completedSlices, BigInt(expected));
  }
  assert.deepEqual(
    runtime.copyRam(0x5000, 4),
    Uint8Array.of(2, 2, 2, 2),
  );
  runtime.dispose();
});

test("the default hard transaction guard leaves headroom above one million instructions", () => {
  assert.equal(DEFAULT_SAFETY_INSTRUCTION_LIMIT, 2_000_000);
});

test("printh preserves value conversion without granting a cart filesystem sink", () => {
  const runtime = boot(`
function _init()
 printh()
 printh(7)
 printh({value=1},"cart-selected.txt",true,true)
 poke(0x5000,1)
end
function _update() end
function _draw() end`);
  assert.equal(runtime.copyRam(0x5000, 1)[0], 1);
  runtime.dispose();
});

test("cursor returns its previous position and the no-argument form resets it", () => {
  const runtime = boot(`
function _init()
 cursor(11,22,3)
 local x,y=cursor()
 poke(0x5000,x,y,peek(0x5f26),peek(0x5f27))
end
function _update() end
function _draw() end`);
  assert.deepEqual(runtime.copyRam(0x5000, 4), Uint8Array.of(11, 22, 0, 0));
  runtime.dispose();
});

test("contiguous screen clears use a bounded number of logical mapping calls", () => {
  const buffer = new ArrayBuffer(0x10000);
  const memory = {
    buffer,
    byteOffset: 0,
    byteLength: 0x10000,
    leaseId: "phase-8d-contiguous-fill",
  };
  let mappingCalls = 0;
  const logicalMemory = {
    memoryLeaseId: memory.leaseId,
    mapAddress(address) {
      mappingCalls += 1;
      const normalized = address & 0xffff;
      return normalized >= 0x6000 && normalized < 0x8000
        ? normalized + 0x6000
        : normalized;
    },
  };
  const api = createPicoApiHost(memory, logicalMemory);
  api.reset();
  mappingCalls = 0;
  api.cls(3 << 16);
  assert.equal(mappingCalls, 2);
  assert.equal(new Uint8Array(buffer, 0xc000, 0x2000)
    .every((value) => value === 0x33), true);
});

test("RAM reset restores a deterministic, live PRNG and srand accepts no argument", () => {
  const source = `
function _init()
 local first=rnd(128)
 local second=rnd(128)
 while second==first do second=rnd(128) end
 poke4(0x5000,first)
 poke4(0x5004,second)
 srand()
 poke4(0x5008,rnd(128))
end
function _update() end
function _draw() end`;
  const first = boot(source);
  const firstBytes = first.copyRam(0x5000, 12);
  first.dispose();
  const second = boot(source);
  const secondBytes = second.copyRam(0x5000, 12);
  second.dispose();
  assert.deepEqual(secondBytes, firstBytes);
  assert.notDeepEqual(firstBytes.slice(0, 4), new Uint8Array(4));
  assert.notDeepEqual(firstBytes.slice(0, 4), firstBytes.slice(4, 8));
  assert.deepEqual(firstBytes.slice(0, 4), firstBytes.slice(8, 12));
});

test("Worker expands only explicitly authorized local include bundle entries", () => {
  const root = textCart(`#include shared.lua
function _init() poke(0x5000,included_value) end
function _update() end
function _draw() end`);
  const include = encoder.encode("included_value=7\n");
  const load = (includeAllowed) => ({
    v: 1,
    type: "loadCart",
    requestId: 1,
    workerGeneration: 1,
    sessionGeneration: 1,
    cartBytes: root.slice().buffer,
    localCartBundle: [{
      ref: "shared.lua",
      cartBytes: include.slice().buffer,
      access: {
        load: false,
        reloadData: false,
        cstoreData: false,
        include: includeAllowed,
      },
    }],
  });

  const allowed = createPlayerWorkerController(module);
  const ready = allowed.handle(load(true));
  assert.equal(ready[0]?.type, "state");
  assert.equal(ready[0]?.state, "ready");
  allowed.dispose();

  const denied = createPlayerWorkerController(module);
  const fault = denied.handle(load(false));
  assert.equal(fault[0]?.type, "fault");
  assert.equal(fault[0]?.error.code, "E_CART_PARSE");
  assert.equal(fault[0]?.error.details.cartCodecCode, "E_CART_INCLUDE_UNRESOLVED");
  denied.dispose();
});
