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

function cart(source) {
  return { rom: new Uint8Array(0x8000), code: encoder.encode(source) };
}

function boot(source, instructionBudget = 1_000_000) {
  const vm = new Z8LuaFrameVm(module, createPicoApiHostRouter(module));
  const runtime = new FrameSliceRuntime(vm, { instructionBudget });
  const result = runtime.boot(cart(source));
  if (!result.ok) runtime.dispose();
  assert.equal(result.ok, true, JSON.stringify(result));
  return runtime;
}

test("real WASM snapshots ordered copy-owned slots and applies button filters", () => {
  const runtime = boot(`
function _init()
 menuitem(0x301,"filtered",function(b) poke(0x5000,b) return true end)
 menuitem(5,"1234567890123456",function() end)
end
function _update() end
function _draw() end`);

  const first = runtime.snapshotMenuItems();
  assert.equal(first.ok, true);
  assert.deepEqual(first.value.items.map(({slot,filter}) => [slot, filter]), [[1, 0x300], [5, 0]]);
  assert.equal(new TextDecoder().decode(first.value.items[1].label), "1234567890123456");
  first.value.items[0].label[0] = 0;
  const second = runtime.snapshotMenuItems();
  assert.equal(new TextDecoder().decode(second.value.items[0].label), "filtered");

  const filtered = runtime.invokeMenuItem(1, 1);
  assert.equal(filtered.ok, false);
  assert.equal(filtered.error.code, "E_INVALID_STATE");
  assert.deepEqual([...runtime.copyRam(0x5000, 1)], [0]);
  const invoked = runtime.invokeMenuItem(1, 4);
  assert.equal(invoked.ok, true);
  assert.equal(invoked.value.kind, "keep-open");
  assert.deepEqual([...runtime.copyRam(0x5000, 1)], [4]);
  runtime.dispose();
});

test("callback return, replacement and removal produce structured outcomes", () => {
  const runtime = boot(`
function _init()
 menuitem(1,"replace",function(b)
  poke(0x5000,b)
  menuitem(1,"replaced",function() return false end)
  return true
 end)
 menuitem(2,"remove",function() menuitem(2) return true end)
end
function _update() end
function _draw() end`);

  const replaced = runtime.invokeMenuItem(1, 2);
  assert.equal(replaced.ok, true);
  assert.equal(replaced.value.kind, "keep-open");
  assert.equal(new TextDecoder().decode(replaced.value.snapshot.items[0].label), "replaced");
  assert.deepEqual([...runtime.copyRam(0x5000, 1)], [2]);
  const closed = runtime.invokeMenuItem(1, 4);
  assert.equal(closed.ok, true);
  assert.equal(closed.value.kind, "close");
  const removed = runtime.invokeMenuItem(2, 4);
  assert.equal(removed.ok, true);
  assert.equal(removed.value.kind, "removed");
  assert.deepEqual(removed.value.snapshot.items.map(({slot}) => slot), [1]);
  runtime.dispose();
});

test("only boolean true keeps the menu open", () => {
  const runtime = boot(`
function _init()
 menuitem(1,"nil",function() end)
 menuitem(2,"number",function() return 1 end)
 menuitem(3,"string",function() return "true" end)
 menuitem(4,"true",function() return true end)
end
function _update() end
function _draw() end`);
  for (const slot of [1, 2, 3]) {
    const result = runtime.invokeMenuItem(slot, 4);
    assert.equal(result.ok, true);
    assert.equal(result.value.kind, "close");
  }
  const kept = runtime.invokeMenuItem(4, 4);
  assert.equal(kept.ok, true);
  assert.equal(kept.value.kind, "keep-open");
  runtime.dispose();
});

test("callback instruction budget fails closed at the menuitem phase", () => {
  const runtime = boot(`
function _init() menuitem(1,"spin",function() while true do end end) end
function _update() end
function _draw() end`, 200);
  const result = runtime.invokeMenuItem(1, 4);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "E_VM_INSTRUCTION_BUDGET");
  assert.equal(result.error.phase, "menuitem");
  assert.equal(runtime.state, "faulted");
  runtime.dispose();
});

test("twenty menu generations release every WASM context", () => {
  for (let generation = 1; generation <= 20; generation += 1) {
    const runtime = boot(`
function _init() menuitem(1,"generation:${generation}",function() return true end) end
function _update() end
function _draw() end`);
    const snapshot = runtime.snapshotMenuItems();
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.value.items.length, 1);
    const invoked = runtime.invokeMenuItem(1, 4);
    assert.equal(invoked.ok, true);
    assert.equal(invoked.value.kind, "keep-open");
    runtime.dispose();
    assert.equal(module._p8w_live_contexts(), 0, `generation ${generation} leaked`);
  }
});

test("callback fault is contained and custom-loop frame boundaries are invokable", () => {
  const faulting = boot(`
function _init() menuitem(1,"fault",function() error("menu boom") end) end
function _update() end
function _draw() end`);
  const fault = faulting.invokeMenuItem(1, 4);
  assert.equal(fault.ok, false);
  assert.equal(fault.error.code, "E_VM_RUNTIME");
  assert.equal(fault.error.phase, "menuitem");
  assert.match(fault.error.message, /menu boom/u);
  assert.equal(faulting.state, "faulted");
  faulting.dispose();

  const custom = boot(`
menuitem(1,"custom",function(b) poke(0x5000,b) return true end)
while true do flip() end`);
  const result = custom.invokeMenuItem(1, 1);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.kind, "keep-open");
  assert.deepEqual([...custom.copyRam(0x5000, 1)], [1]);
  custom.dispose();
  assert.equal(module._p8w_live_contexts(), 0);
});
