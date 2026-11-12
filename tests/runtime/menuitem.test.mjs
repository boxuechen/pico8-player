import assert from "node:assert/strict";
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
  return { rom: new Uint8Array(0x8000), code: encoder.encode(source) };
}

function createRuntime(options = {}) {
  const vm = new Z8LuaFrameVm(module, createPicoApiHostRouter(module), options);
  try {
    return { vm, runtime: new FrameSliceRuntime(vm, {
      instructionBudget: 5_000_000,
    }) };
  } catch (error) {
    vm.destroy();
    throw error;
  }
}

function assertBoots(source, options) {
  const created = createRuntime(options);
  const result = created.runtime.boot(sourceCart(source));
  if (!result.ok) created.runtime.dispose();
  assert.equal(result.ok, true, JSON.stringify(result));
  return created;
}

test("menuitem registers, replaces and removes five bounded VM-local slots", () => {
  const { vm, runtime } = assertBoots(`
function cb() return true end
function _init()
 menuitem(1,"one",cb)
 menuitem(2,"two",cb)
 menuitem(3,"three",cb)
 menuitem(4,"four",cb)
 menuitem(0xff05,"1234567890123456",cb)
 for i=1,2000 do
  menuitem(0x1201,"replacement",function() return i end)
 end
 menuitem(1)
 menuitem(2,nil,cb)
 menuitem(3,"three")
 poke(0x5000,1)
end
function _update() end
function _draw() end`, { luaHeapLimit: 262_144 });

  assert.deepEqual([...runtime.copyRam(0x5000, 1)], [1]);
  assert.ok(vm.liveLuaBytes < vm.luaHeapLimit, "replacement registry stays bounded");
  runtime.dispose();
  assert.equal(module._p8w_live_contexts(), 0);
});

test("menuitem registry retains the active callback and releases replaced entries", () => {
  const { runtime } = assertBoots(`
weak=setmetatable({}, {__mode="v"})
function burn()
 for outer=1,80 do
  local garbage={}
  for inner=1,128 do garbage[inner]={outer,inner} end
 end
end
function _init()
 local first=function() return 1 end
 weak[1]=first
 menuitem(0x1201,"first",first)
 first=nil
 burn()
 poke(0x5000,type(weak[1])=="function" and 1 or 0)

 local second=function() return 2 end
 weak[2]=second
 menuitem(0xff01,"second",second)
 second=nil
 burn()
 poke(0x5001,weak[1]==nil and 1 or 0)
 poke(0x5002,type(weak[2])=="function" and 1 or 0)

 menuitem(1)
 burn()
 poke(0x5003,weak[2]==nil and 1 or 0)
end
function _update() end
function _draw() end`);

  assert.deepEqual(
    [...runtime.copyRam(0x5000, 4)],
    [1, 1, 1, 1],
    "registry strong refs and replacement/removal GC lifetime",
  );
  runtime.dispose();
});

test("menuitem rejects invalid index and argument types", () => {
  const cases = [
    ["slot zero", "menuitem(0,\"x\",function() end)", /slot 1\.\.5/u],
    ["slot six", "menuitem(6,\"x\",function() end)", /slot 1\.\.5/u],
    ["fractional slot", "menuitem(1.5,\"x\",function() end)", /integer/u],
    ["non-string label", "menuitem(1,false,function() end)", /string/u],
    ["non-function callback", "menuitem(1,\"x\",42)", /function/u],
  ];

  for (const [label, call, message] of cases) {
    const { runtime } = createRuntime();
    const result = runtime.boot(sourceCart(`
function _init() ${call} end
function _update() end
function _draw() end`));
    assert.equal(result.ok, false, label);
    assert.equal(result.error.code, "E_VM_RUNTIME", label);
    assert.match(result.error.message, message, label);
    runtime.dispose();
  }
  assert.equal(module._p8w_live_contexts(), 0);
});

test("menuitem registry is destroyed with each fresh VM generation", () => {
  for (let generation = 0; generation < 20; generation += 1) {
    const { runtime } = assertBoots(`
function _init()
 for slot=1,5 do
  local generation=${generation}
  menuitem(slot,"generation",function() return generation end)
 end
end
function _update() end
function _draw() end`);
    assert.equal(module._p8w_live_contexts(), 1);
    runtime.dispose();
    assert.equal(module._p8w_live_contexts(), 0);
  }
});
