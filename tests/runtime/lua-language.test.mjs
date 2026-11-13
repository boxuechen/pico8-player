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

async function fixture(name) {
  return decodeCart(new Uint8Array(await readFile(new URL(`${name}.p8`, fixtureRoot))));
}

async function boot(name, { input, luaHeapLimit } = {}) {
  const vm = new Z8LuaFrameVm(
    module,
    createPicoApiHostRouter(module),
    luaHeapLimit === undefined ? {} : { luaHeapLimit },
  );
  const runtime = new FrameSliceRuntime(vm);
  let result;
  try {
    result = runtime.boot(await fixture(name), input);
  } catch (error) {
    runtime.dispose();
    throw error;
  }
  return { vm, runtime, result };
}

function input(buttons = 0) {
  return {
    controllers: [buttons, 0, 0, 0, 0, 0, 0, 0],
    devkit: {
      mouseXRaw: 0,
      mouseYRaw: 0,
      mouseButtons: 0,
      wheelRaw: 0,
      movementXRaw: 0,
      movementYRaw: 0,
      keypresses: [],
    },
  };
}

function assertReady(created) {
  assert.equal(created.result.ok, true, JSON.stringify(created.result));
  assert.equal(created.result.value.kind, "ready");
}

test("language-boolean-value-semantics: omitted btnp and typed stat values remain usable", async () => {
  const created = await boot("language-boolean-value-semantics", { input: input(1) });
  assertReady(created);
  assert.deepEqual(created.runtime.copyRam(0x5000, 4), Uint8Array.of(1, 1, 1, 1));
  created.runtime.dispose();
});

test("language-poke-varargs-semantics: absent, nil and finite expanded values are bounded", async () => {
  const created = await boot("language-poke-varargs-semantics");
  assertReady(created);
  assert.deepEqual(created.runtime.copyRam(0x5000, 4), Uint8Array.of(0, 7, 1, 40));
  created.runtime.dispose();
});

test("language-extcmd-library-surface: command strings terminate in the no-authority sink", async () => {
  const created = await boot("language-extcmd-library-surface");
  assertReady(created);
  assert.deepEqual(created.runtime.copyRam(0x5000, 2), Uint8Array.of(1, 1));
  created.runtime.dispose();
});

test("language-cartdata-index-boundary: out-of-range slots read zero and ignore writes", async () => {
  const created = await boot("language-cartdata-index-boundary");
  assertReady(created);
  assert.deepEqual(created.runtime.copyRam(0x5000, 3), Uint8Array.of(7, 0, 0));
  created.runtime.dispose();
});

test("language-cls-color-coercion: numeric and empty strings use API numeric coercion", async () => {
  const created = await boot("language-cls-color-coercion");
  assertReady(created);
  assert.deepEqual(created.runtime.copyRam(0x5000, 2), Uint8Array.of(3, 3));
  created.runtime.dispose();
});

test("language-missing-global-library-surface: private aliases and local _ENV fallback exist", async () => {
  const created = await boot("language-missing-global-library-surface");
  assertReady(created);
  assert.deepEqual(
    created.runtime.copyRam(0x5000, 6),
    Uint8Array.of(2, 4, 3, 16, 1, 1),
  );
  created.runtime.dispose();
});

test("language-parser-if-do-shorthand: conditional do/end forms preserve flow", async () => {
  const created = await boot("language-parser-if-do-shorthand");
  assertReady(created);
  assert.equal(created.runtime.copyRam(0x5000, 1)[0], 8);
  created.runtime.dispose();
});

test("language-vm-memory-pressure: the fixed two-MiB profile accepts a finite workload", async () => {
  const created = await boot("language-vm-memory-pressure");
  assert.equal(created.vm.luaHeapLimit, 2 * 1024 * 1024);
  assertReady(created);
  assert.equal(created.runtime.copyRam(0x5000, 1)[0], 1);
  created.runtime.dispose();
});

test("language-nil-arithmetic-flow: lowered assignments keep numeric values", async () => {
  const created = await boot("language-nil-arithmetic-flow");
  assertReady(created);
  assert.equal(created.runtime.copyRam(0x5000, 1)[0], 1);
  created.runtime.dispose();
});

test("language-parser-question-print-shorthand: return-question form returns print result", async () => {
  const created = await boot("language-parser-question-print-shorthand");
  assertReady(created);
  assert.equal(created.runtime.copyRam(0x5000, 1)[0], 1);
  created.runtime.dispose();
});

test("language-all-iteration-semantics: strings, tables, deletion and nil iterate safely", async () => {
  const created = await boot("language-all-iteration-semantics");
  assertReady(created);
  assert.deepEqual(created.runtime.copyRam(0x5000, 2), Uint8Array.of(1, 6));
  created.runtime.dispose();
});

test("language-runtime-bootstrap-invariant: low-memory bootstrap is typed instead of trapping", async () => {
  const constrained = await boot("language-runtime-bootstrap-invariant", {
    luaHeapLimit: 64 * 1024,
  });
  assert.equal(constrained.result.ok, false);
  assert.equal(constrained.result.error.code, "E_VM_OOM");
  constrained.runtime.dispose();

  const production = await boot("language-runtime-bootstrap-invariant");
  assertReady(production);
  assert.equal(production.runtime.copyRam(0x5000, 1)[0], 1);
  production.runtime.dispose();
});

test("language-rnd-string-semantics: PICO hexadecimal strings and tables are accepted", async () => {
  const created = await boot("language-rnd-string-semantics");
  assertReady(created);
  assert.deepEqual(created.runtime.copyRam(0x5000, 2), Uint8Array.of(1, 1));
  created.runtime.dispose();
});
