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

const fixtureUrl = new URL(
  "../fixtures/lua-compat/language-menuitem-display-bound.p8",
  import.meta.url,
);
let module;

before(async () => {
  module = await createZ8LuaModule();
});

test("menuitem keeps a 16-character display snapshot without aborting on a longer label", async () => {
  const cart = decodeCart(new Uint8Array(await readFile(fixtureUrl)));
  const vm = new Z8LuaFrameVm(module, createPicoApiHostRouter(module));
  const runtime = new FrameSliceRuntime(vm);
  const result = runtime.boot(cart);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(runtime.copyRam(0x5000, 2), Uint8Array.of(1, 0));

  const snapshot = runtime.snapshotMenuItems();
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.value.items.length, 1);
  assert.equal(new TextDecoder().decode(snapshot.value.items[0].label), "1234567890123456");

  const invoked = runtime.invokeMenuItem(1, 4);
  assert.equal(invoked.ok, true);
  assert.equal(invoked.value.kind, "keep-open");
  assert.deepEqual(runtime.copyRam(0x5000, 2), Uint8Array.of(1, 1));
  runtime.dispose();
});
