import assert from "node:assert/strict";
import test, { before } from "node:test";

import { FrameSliceRuntime } from "@pico8-player/runtime-core";
import { createPicoApiHostRouter, Z8LuaFrameVm } from "@pico8-player/z8lua-bridge";
import createZ8LuaModule from "../../wasm/dist/z8lua-runtime-v1.mjs";

const encoder = new TextEncoder();
let module;

before(async () => {
  module = await createZ8LuaModule();
});

function boot(source) {
  const vm = new Z8LuaFrameVm(module, createPicoApiHostRouter(module));
  const runtime = new FrameSliceRuntime(vm);
  const result = runtime.boot({
    rom: new Uint8Array(0x8000),
    code: encoder.encode(source),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return runtime;
}

test("pal(table) ignores non-numeric entries while dispatching numeric values", () => {
  const runtime = boot(`
function _init()
 pal(split(""))
 pal({[1]="",[2]="4",[3]=false,[4]=5})
 poke(0x200,0x5a)
end
function _update() end
function _draw() end`);

  assert.equal(runtime.copyRam(0x200, 1)[0], 0x5a, "boot continues past pal(split(empty))");
  assert.deepEqual(
    [...runtime.copyRam(0x5f01, 4)],
    [1, 4, 3, 5],
    "non-numeric entries are ignored and numeric strings retain Lua coercion",
  );
  runtime.dispose();
});
