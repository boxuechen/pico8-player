import assert from "node:assert/strict";
import test, { before } from "node:test";

import {
  FrameSliceRuntime,
  PICO_VM_INSTRUCTIONS_PER_SECOND,
} from "@pico8-web/runtime-core";
import {
  createPicoApiHostRouter,
  Z8LuaFrameVm,
} from "@pico8-web/z8lua-bridge";
import createZ8LuaModule from "../../wasm/dist/z8lua-runtime-v1.mjs";

const encoder = new TextEncoder();
const IMPLICIT_FRAME_INSTRUCTIONS =
  Math.floor(PICO_VM_INSTRUCTIONS_PER_SECOND / 30);
let module;

before(async () => {
  module = await createZ8LuaModule();
});

function sourceCart(source) {
  return { rom: new Uint8Array(0x8000), code: encoder.encode(source) };
}

function createRuntime(instructionBudget = 1_000_000) {
  const vm = new Z8LuaFrameVm(module, createPicoApiHostRouter(module));
  try {
    return new FrameSliceRuntime(vm, { instructionBudget });
  } catch (error) {
    vm.destroy();
    throw error;
  }
}

function assertOk(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}

function readU16(runtime, address) {
  const bytes = runtime.copyRam(address, 2);
  return bytes[0] | (bytes[1] << 8);
}

test("top-level loop gets one deterministic implicit 30 Hz frame per call", () => {
  const runtime = createRuntime();
  const ready = assertOk(runtime.boot(sourceCart(`
n=0
while true do
 n+=1
 poke2(0x5000,n)
 pset(n&127,0,7)
end`)));
  assert.equal(ready.kind, "ready");
  assert.equal(ready.mode, "custom");
  assert.equal(ready.targetFps, 30);
  assert.equal(ready.cpuInstructions, IMPLICIT_FRAME_INSTRUCTIONS);
  assert.equal(ready.slowFrame, false);
  assert.equal(runtime.completedSlices, 1n);

  let previous = readU16(runtime, 0x5000);
  for (let index = 0; index < 6; index += 1) {
    const stepped = assertOk(runtime.step());
    assert.equal(stepped.kind, "frame");
    assert.equal(stepped.frame.cpuInstructions, IMPLICIT_FRAME_INSTRUCTIONS);
    assert.equal(stepped.frame.completedSlices, String(index + 2));
    assert.notEqual(readU16(runtime, 0x5000), previous);
    previous = readU16(runtime, 0x5000);
  }
  assert.equal(runtime.completedSlices, 7n);
  runtime.dispose();
});

test("hook-yield resumes through deep Lua stack, pcall and allocation churn", () => {
  const runtime = createRuntime();
  const ready = assertOk(runtime.boot(sourceCart(`
n=0
function work(depth)
 if depth>0 then return work(depth-1) end
 local ok,message=pcall(function()
  local values={}
  for i=1,64 do values[i]={n,i,"allocation"..i} end
  n+=1
  poke2(0x5000,n)
 end)
 if not ok then error(message) end
end
while true do work(8) end`)));
  assert.equal(ready.kind, "ready");

  let previous = readU16(runtime, 0x5000);
  for (let index = 0; index < 12; index += 1) {
    const frame = assertOk(runtime.step());
    assert.equal(frame.kind, "frame");
    assert.equal(frame.frame.cpuInstructions, IMPLICIT_FRAME_INSTRUCTIONS);
    const current = readU16(runtime, 0x5000);
    assert.notEqual(current, previous, `continuation ${index} made progress`);
    previous = current;
  }
  runtime.dispose();
});

test("nested coroutine work is counted and defers yield to the root safe point", () => {
  const runtime = createRuntime();
  const ready = assertOk(runtime.boot(sourceCart(`
n=0
while true do
 local child=cocreate(function()
  for i=1,20000 do n+=1 end
 end)
 local ok,message=coresume(child)
 if not ok then error(message) end
 poke2(0x5000,n)
end`)));
  assert.equal(ready.kind, "ready");
  assert.equal(ready.mode, "custom");
  assert.ok(
    ready.cpuInstructions >= IMPLICIT_FRAME_INSTRUCTIONS,
    "nested work counts toward the implicit boundary",
  );
  assert.ok(
    ready.cpuInstructions < 1_000_000,
    "root safe-point deferral stays below the hard cap",
  );
  const before = readU16(runtime, 0x5000);
  const frame = assertOk(runtime.step());
  assert.equal(frame.kind, "frame");
  assert.ok(frame.frame.cpuInstructions >= IMPLICIT_FRAME_INSTRUCTIONS);
  assert.notEqual(readU16(runtime, 0x5000), before);
  runtime.dispose();
});

test("root host suspension preserves the pending implicit-frame transaction", () => {
  const runtime = createRuntime();
  const request = assertOk(runtime.boot(sourceCart(`
n=0
while true do
 n+=1
 if n==100 then
  local response=__p8w_probe_host_request("slice")
  poke(0x5000,#response)
 end
 poke2(0x5002,n)
end`)));
  assert.equal(request.kind, "host-request");
  assert.equal(request.request.operation, "boot");
  assert.deepEqual([...request.request.bytes], [...encoder.encode("slice")]);

  const ready = assertOk(runtime.completeHostRequest(
    request.request.id,
    Uint8Array.of(1, 2, 3),
  ));
  assert.equal(ready.kind, "ready");
  assert.equal(ready.mode, "custom");
  assert.equal(ready.cpuInstructions, IMPLICIT_FRAME_INSTRUCTIONS);
  assert.equal(runtime.copyRam(0x5000, 1)[0], 3);
  runtime.dispose();
});

test("finite top-level code can cross implicit frames before selecting callbacks", () => {
  const runtime = createRuntime();
  const ready = assertOk(runtime.boot(sourceCart(`
local total=0
for outer=1,4 do
 for i=1,30000 do total+=i end
end
poke(0x5000,1)
function _init() poke(0x5001,1) end
function _update() poke(0x5002,peek(0x5002)+1) end
function _draw() cls(4) end`)));
  assert.equal(ready.kind, "ready");
  assert.equal(ready.mode, "custom");

  let frames = 0;
  while (runtime.mode === "custom" && frames < 8) {
    const result = assertOk(runtime.step());
    assert.equal(result.kind, "frame");
    frames += 1;
  }
  assert.equal(runtime.mode, "callback");
  assert.deepEqual([...runtime.copyRam(0x5000, 3)], [1, 1, 0]);
  const callbackFrame = assertOk(runtime.step());
  assert.equal(callbackFrame.kind, "frame");
  assert.equal(runtime.copyRam(0x5002, 1)[0], 1);
  runtime.dispose();
});

test("callback, explicit flip and hard-budget controls keep their boundaries", () => {
  const callback = createRuntime();
  assertOk(callback.boot(sourceCart(`
function _update()
 local total=0
 for outer=1,3 do
  for i=1,30000 do total+=i end
 end
 poke(0x5000,total)
end
function _draw() cls(2) end`)));
  const callbackFrame = assertOk(callback.step());
  assert.equal(callbackFrame.kind, "frame");
  assert.ok(callbackFrame.frame.cpuInstructions > IMPLICIT_FRAME_INSTRUCTIONS);
  assert.equal(callbackFrame.frame.slowFrame, true);
  callback.dispose();

  const explicit = createRuntime();
  const explicitReady = assertOk(explicit.boot(sourceCart(`
n=0
while true do
 n+=1
 poke(0x5000,n)
 flip()
end`)));
  assert.equal(explicitReady.mode, "custom");
  assert.ok(explicitReady.cpuInstructions < IMPLICIT_FRAME_INSTRUCTIONS);
  const explicitFrame = assertOk(explicit.step());
  assert.equal(explicitFrame.kind, "frame");
  assert.ok(explicitFrame.frame.cpuInstructions < IMPLICIT_FRAME_INSTRUCTIONS);
  explicit.dispose();

  const callbackFault = createRuntime(50_000);
  assertOk(callbackFault.boot(sourceCart(`
function _update() while true do end end
function _draw() end`)));
  const callbackResult = callbackFault.step();
  assert.equal(callbackResult.ok, false);
  assert.equal(callbackResult.error.code, "E_VM_INSTRUCTION_BUDGET");
  assert.equal(callbackFault.state, "faulted");
  callbackFault.dispose();

  const implicitFault = createRuntime(50_000);
  const implicitResult = implicitFault.boot(sourceCart("while true do end"));
  assert.equal(implicitResult.ok, false);
  assert.equal(implicitResult.error.code, "E_VM_INSTRUCTION_BUDGET");
  assert.equal(implicitFault.state, "faulted");
  implicitFault.dispose();

  const recovered = createRuntime();
  const recoveredReady = assertOk(recovered.boot(sourceCart("while true do end")));
  assert.equal(recoveredReady.kind, "ready");
  assert.equal(recoveredReady.mode, "custom");
  recovered.dispose();
  assert.equal(module._p8w_live_contexts(), 0);
});
