import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { before } from "node:test";

import { decodeCart } from "@pico8-web/cart-codec";
import {
  DEFAULT_SAFETY_INSTRUCTION_LIMIT,
  FrameSliceRuntime,
} from "@pico8-web/runtime-core";
import {
  createPicoApiHostRouter,
  Z8LuaFrameVm,
} from "@pico8-web/z8lua-bridge";
import createZ8LuaModule from "../../wasm/dist/z8lua-runtime-v1.mjs";

const fixtureRoot = new URL("../fixtures/lua-compat/", import.meta.url);
let module;

before(async () => {
  module = await createZ8LuaModule();
});

async function fixture(name) {
  return decodeCart(new Uint8Array(await readFile(new URL(`${name}.p8`, fixtureRoot))));
}

function createRuntime() {
  const vm = new Z8LuaFrameVm(module, createPicoApiHostRouter(module));
  return new FrameSliceRuntime(vm);
}

test("the fixed transaction guard admits finite heavy work and terminates a Q16.16 boundary loop", async () => {
  assert.equal(DEFAULT_SAFETY_INSTRUCTION_LIMIT, 32_000_000);

  const runtime = createRuntime();
  const boot = runtime.boot(await fixture("timing-instruction-budget-boundary"));
  assert.equal(boot.ok, true, JSON.stringify(boot));
  assert.equal(boot.value.kind, "ready");
  assert.ok(boot.value.cpuInstructions > 2_000_000);
  assert.ok(boot.value.cpuInstructions < DEFAULT_SAFETY_INSTRUCTION_LIMIT);
  assert.equal(boot.value.slowFrame, true);
  assert.equal(runtime.copyRam(0x5000, 1)[0], 1);

  const step = runtime.step();
  assert.equal(step.ok, true, JSON.stringify(step));
  assert.equal(step.value.kind, "frame");
  assert.ok(step.value.frame.cpuInstructions > 2_000_000);
  assert.ok(step.value.frame.cpuInstructions < DEFAULT_SAFETY_INSTRUCTION_LIMIT);
  assert.equal(step.value.frame.slowFrame, true);
  assert.equal(new DataView(runtime.copyRam(0x5004, 4).buffer).getInt32(0, true), 2048 << 16);
  assert.equal(runtime.copyRam(0x5008, 1)[0], 1);
  assert.equal(runtime.completedSlices, 2n);
  runtime.dispose();
});

test("a non-yielding callback still faults deterministically at the fixed guard", async () => {
  const runtime = createRuntime();
  const boot = runtime.boot(await fixture("timing-runaway-control"));
  assert.equal(boot.ok, true, JSON.stringify(boot));

  const fault = runtime.step();
  assert.equal(fault.ok, false);
  assert.equal(fault.error.code, "E_VM_INSTRUCTION_BUDGET");
  assert.equal(fault.error.phase, "update");
  assert.equal(runtime.state, "faulted");
  assert.equal(runtime.completedSlices, 1n);
  runtime.dispose();

  const recovery = createRuntime();
  const recovered = recovery.boot(await fixture("timing-instruction-budget-boundary"));
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  recovery.dispose();
});
