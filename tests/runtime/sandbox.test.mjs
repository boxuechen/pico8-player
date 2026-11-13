import assert from "node:assert/strict";
import test from "node:test";
import { FrameSliceRuntime } from "@pico8-player/runtime-core";
import { createPicoApiHostRouter, Z8LuaFrameVm } from "@pico8-player/z8lua-bridge";
import createZ8LuaModule from "../../wasm/dist/z8lua-runtime-v1.mjs";

test("production Lua exposes cart operations without dynamic code or host filesystem libraries", async () => {
  const module = await createZ8LuaModule();
  const runtime = new FrameSliceRuntime(new Z8LuaFrameVm(module, createPicoApiHostRouter(module)));
  const forbidden = ["debug", "eris", "io", "os", "package", "require", "dofile", "loadfile", "loadstring", "collectgarbage", "math", "bit32"];
  try {
    const source = `${forbidden.map(name => `assert(type(${name})=="nil","${name}")`).join("\n")}
assert(type(load)=="function")
assert(type(coroutine)=="table")
assert(type(table)=="table")
assert(type(string)=="table")
function _update() end
function _draw() cls(8) end`;
    const boot = runtime.boot({ rom: new Uint8Array(0x8000), code: new TextEncoder().encode(source) });
    assert.equal(boot.ok, true, JSON.stringify(boot));
    assert.equal(runtime.step().ok, true);
  } finally {
    runtime.dispose();
  }
  assert.equal(module._p8w_live_contexts(), 0);
});
