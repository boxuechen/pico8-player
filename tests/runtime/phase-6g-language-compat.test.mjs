import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { before } from "node:test";

import { FrameSliceRuntime } from "@pico8-web/runtime-core";
import {
  createPicoApiHostRouter,
  Z8LuaFrameVm,
} from "@pico8-web/z8lua-bridge";
import createZ8LuaModule from "../../wasm/dist/z8lua-runtime-v1.mjs";

const encoder = new TextEncoder();
let module;

const P8SCII_GLOBALS = [
  [0x80, 0x00000000], [0x81, 0x5a5a8000],
  [0x82, 0x511f8000], [0x83, 0x00030000],
  [0x84, 0x7d7d8000], [0x85, 0xb81d8000],
  [0x86, 0xf99f8000], [0x87, 0x51bf8000],
  [0x88, 0xb5bf8000], [0x89, 0x999f8000],
  [0x8a, 0xb11f8000], [0x8b, 0x00000000],
  [0x8c, 0xa0e08000], [0x8d, 0x9b3f8000],
  [0x8e, 0x00040000], [0x8f, 0xb1bf8000],
  [0x90, 0xf5ff8000], [0x91, 0x00010000],
  [0x92, 0xb15f8000], [0x93, 0x1b1f8000],
  [0x94, 0x00020000], [0x95, 0xf5bf8000],
  [0x96, 0x7adf8000], [0x97, 0x00050000],
  [0x98, 0x0f0f8000], [0x99, 0x55558000],
];

before(async () => {
  module = await createZ8LuaModule();
});

function sourceCart(code) {
  return { rom: new Uint8Array(0x8000), code };
}

function concatBytes(chunks) {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function createRuntime() {
  const vm = new Z8LuaFrameVm(module, createPicoApiHostRouter(module));
  try {
    return { vm, runtime: new FrameSliceRuntime(vm, {
      instructionBudget: 1_000_000,
    }) };
  } catch (error) {
    vm.destroy();
    throw error;
  }
}

function boot(code) {
  const created = createRuntime();
  const result = created.runtime.boot(sourceCart(code));
  if (!result.ok) created.runtime.dispose();
  assert.equal(result.ok, true, JSON.stringify(result));
  return created.runtime;
}

test("living API inventory records the Phase 6 global unpack extension", () => {
  const inventory = JSON.parse(
    readFileSync(new URL("../../spec/pico-api-inventory.yaml", import.meta.url), "utf8"),
  );
  const entry = inventory.apis.find(({ name }) => name === "unpack");

  assert.deepEqual(
    {
      category: entry?.category,
      surface: entry?.surface,
      implementationStatus: entry?.implementationStatus,
      conformanceStatus: entry?.conformanceStatus,
      evidence: entry?.evidence,
    },
    {
      category: "table",
      surface: "vm-builtin",
      implementationStatus: "implemented",
      conformanceStatus: "compatible",
      evidence: "tests/runtime/phase-6g-language-compat.test.mjs",
    },
  );
});

test("global unpack preserves default, ranged, empty and nil-hole multi-return semantics", () => {
  const runtime = boot(encoder.encode(`
function _init()
 poke(0x5000,unpack==table.unpack and 1 or 0)
 local a,b,c=unpack({11,22,33})
 poke(0x5001,a,b,c)
 local d,e=unpack({44,55,66,77},2,3)
 poke(0x5004,d,e)
 poke(0x5006,select("#",unpack({1,2},2,1)))
 local f,g,h=unpack({[2]=88,[4]=99},2,4)
 poke(0x5007,f,g==nil and 1 or 0,h)
 poke(0x500a,select("#",unpack({[1]=1,[3]=3},1,3)))
end
function _update() end
function _draw() end`));

  assert.deepEqual(
    [...runtime.copyRam(0x5000, 11)],
    [1, 11, 22, 33, 55, 66, 0, 88, 1, 99, 3],
  );
  runtime.dispose();
});

test("all source-level P8SCII globals preserve one-byte names and Q16.16 raw values", () => {
  const chunks = [encoder.encode("function _init()\n")];
  for (let index = 0; index < P8SCII_GLOBALS.length; index += 1) {
    chunks.push(
      encoder.encode(`poke4(0x${(0x5000 + index * 4).toString(16)},`),
      Uint8Array.of(P8SCII_GLOBALS[index][0]),
      encoder.encode(")\n"),
    );
  }
  chunks.push(encoder.encode("end\nfunction _update() end\nfunction _draw() end"));
  const runtime = boot(concatBytes(chunks));
  const bytes = runtime.copyRam(0x5000, P8SCII_GLOBALS.length * 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.deepEqual(
    P8SCII_GLOBALS.map((_, index) => view.getUint32(index * 4, true)),
    P8SCII_GLOBALS.map(([, raw]) => raw),
  );
  runtime.dispose();
});

test("language compatibility globals are isolated to each fresh VM generation", () => {
  for (let generation = 0; generation < 12; generation += 1) {
    const runtime = boot(encoder.encode(`
function _init()
 local a,b=unpack({${generation},${generation + 1}})
 poke(0x5000,a,b)
end
function _update() end
function _draw() end`));
    assert.deepEqual([...runtime.copyRam(0x5000, 2)], [generation, generation + 1]);
    runtime.dispose();
    assert.equal(module._p8w_live_contexts(), 0);
  }
});
