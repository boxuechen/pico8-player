import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { before } from "node:test";

import { decodeCart } from "@pico8-player/cart-codec";
import { FrameSliceRuntime } from "@pico8-player/runtime-core";
import {
  createPicoApiHostRouter,
  Z8LuaFrameVm,
} from "@pico8-player/z8lua-bridge";
import createZ8LuaModule from "../../wasm/dist/z8lua-runtime-v1.mjs";

const fixtureRoot = new URL("../fixtures/lua-compat/", import.meta.url);
let module;

before(async () => {
  module = await createZ8LuaModule();
});

async function boot(name) {
  const cart = decodeCart(new Uint8Array(
    await readFile(new URL(`${name}.p8`, fixtureRoot)),
  ));
  const vm = new Z8LuaFrameVm(module, createPicoApiHostRouter(module));
  const runtime = new FrameSliceRuntime(vm);
  const result = runtime.boot(cart);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.kind, "ready");
  return runtime;
}

test("camera returns signed previous coordinates before set or reset", async () => {
  const runtime = await boot("language-camera-previous-state");
  assert.deepEqual(runtime.copyRam(0x5000, 6), Uint8Array.of(1, 1, 1, 1, 1, 1));
  runtime.dispose();
});

test("all treats an absent argument as the same empty iterator as nil", async () => {
  const runtime = await boot("language-all-absent-value");
  assert.deepEqual(runtime.copyRam(0x5000, 2), Uint8Array.of(1, 1));
  runtime.dispose();
});

test("chr preserves bounded large varargs returned by peek", async () => {
  const runtime = await boot("language-chr-large-varargs");
  assert.deepEqual(runtime.copyRam(0x5000, 4), Uint8Array.of(1, 1, 1, 1));
  runtime.dispose();
});
