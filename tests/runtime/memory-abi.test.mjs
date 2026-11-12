import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { before } from "node:test";

import {
  createPicoApiHost,
  FrameSliceRuntime,
} from "@pico8-web/runtime-core";
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
  return {
    rom: new Uint8Array(0x8000),
    code: encoder.encode(source),
  };
}

function createVm() {
  return new Z8LuaFrameVm(module, createPicoApiHostRouter(module));
}

function createRuntime(source, options = {}) {
  const vm = createVm();
  const runtime = new FrameSliceRuntime(vm, options);
  const boot = runtime.boot(sourceCart(source));
  assert.equal(boot.ok, true, JSON.stringify(boot));
  return { runtime, vm };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("production Base RAM APIs share canonical wrap, width and overlap semantics", () => {
  const { runtime } = createRuntime(`
function _init()
 poke(0x100,1,2,3,4)
 a,b,c,d=peek(0x100,4)
 poke(0x110,a,b,c,d)
 memcpy(0x102,0x100,4)
 poke2(0x7fff,0x1234)
 poke4(0xffff,0x1122.3344)
 poke(0x120,peek2(0x7fff) & 0xff,peek2(0x7fff) >> 8)
 poke4(0x124,peek4(0xffff))
 poke(-1.5,0x7a)
 poke(0x128,peek(-1.5))
 memset(0x130,0xc8,5)
 poke(0x5f55,0xe0)
 poke(0xe000,9,8,7,6)
 memcpy(0x200,0x6000,4)
end
function _update() end
function _draw() end`);

  assert.deepEqual([...runtime.copyRam(0x100, 6)], [1, 2, 1, 2, 3, 4]);
  assert.deepEqual([...runtime.copyRam(0x110, 4)], [1, 2, 3, 4]);
  assert.equal(runtime.copyRam(0x7fff, 1)[0], 0x34);
  assert.equal(runtime.copyRam(0x8000, 1)[0], 0x12);
  assert.deepEqual([...runtime.copyRam(0x120, 2)], [0x34, 0x12]);
  assert.deepEqual([...runtime.copyRam(0x124, 4)], [0x44, 0x33, 0x22, 0x11]);
  assert.equal(runtime.copyRam(0xfffe, 1)[0], 0x7a);
  assert.equal(runtime.copyRam(0xffff, 1)[0], 0x44);
  assert.equal(runtime.copyRam(0x128, 1)[0], 0x7a);
  assert.deepEqual([...runtime.copyRam(0x130, 5)], [0xc8, 0xc8, 0xc8, 0xc8, 0xc8]);
  assert.deepEqual([...runtime.copyRam(0x200, 4)], [9, 8, 7, 6]);
  runtime.dispose();
});

test("memory vector resource limits fail as structured VM errors", () => {
  const vm = createVm();
  const runtime = new FrameSliceRuntime(vm);
  const boot = runtime.boot(sourceCart(`
function _init() peek(0,8193) end
function _update() end
function _draw() end`));
  assert.equal(boot.ok, false);
  assert.equal(boot.error.code, "E_VM_RUNTIME");
  assert.match(boot.error.message, /peek result count exceeds 8192/u);
  runtime.dispose();
});

test("peek is bounded to 8192 results while poke accepts a larger vector", () => {
  const success = createRuntime(`
function _init()
 memset(0x1000,0xab,8192)
 poke(0x8000,1,peek(0x1000,8192))
end
function _update() end
function _draw() end`, { instructionBudget: 2_000_000 });
  const copied = success.runtime.copyRam(0x8001, 8192);
  assert.equal(copied.every((value) => value === 0xab), true);
  assert.equal(sha256(copied), sha256(new Uint8Array(8192).fill(0xab)));
  success.runtime.dispose();

  const vm = createVm();
  const runtime = new FrameSliceRuntime(vm, { instructionBudget: 2_000_000 });
  const boot = runtime.boot(sourceCart(`
function _init()
 memset(0x8000,0x5a,8192)
 poke(0x8000,peek(0x1000,8193))
end
function _update() end
function _draw() end`));
  assert.equal(boot.ok, false);
  assert.equal(boot.error.code, "E_VM_RUNTIME");
  assert.match(boot.error.message, /peek result count exceeds 8192/u);
  assert.equal(runtime.copyRam(0x8000, 8192).every((value) => value === 0x5a), true);
  runtime.dispose();
});

test("RuntimeCore graphics and frame snapshots follow the adapter-owned mapper", () => {
  const { runtime, vm } = createRuntime(`
function _init()
 poke(0x5f54,0xe0)
 poke(0,0x2a)
 poke(0x140,@0,peek(0))
 poke(0x5f55,0xc0)
 cls(3)
 pset(0,0,7)
end
function _update() end
function _draw() end`);

  assert.equal(vm.logicalMemory.mapAddress(0), 0xe000);
  assert.equal(vm.logicalMemory.mapAddress(0x6000), 0xc000);
  assert.equal(runtime.copyRam(0xe000, 1)[0], 0x2a);
  assert.deepEqual([...runtime.copyRam(0xe140, 2)], [0x2a, 0x2a]);
  assert.equal(runtime.copyRam(0xc000, 1)[0], 0x37);
  assert.equal(runtime.copyRam(0x6000, 1)[0], 0);

  const step = runtime.step();
  assert.equal(step.ok, true, JSON.stringify(step));
  assert.equal(step.value.frame.screen[0], 0x37);
  const logicalMemory = vm.logicalMemory;
  runtime.dispose();
  assert.throws(() => logicalMemory.mapAddress(0), /stale|destroyed|detached/u);
});

test("80-byte host call frame validates twelve scalar slots and bounded byte-string views", () => {
  const router = createPicoApiHostRouter(module);
  const vm = new Z8LuaFrameVm(module, router);
  const base = createPicoApiHost(vm.memory, vm.logicalMemory);
  vm.bindHost(base);

  const framePointer = module._p8w_alloc(80) >>> 0;
  const bytesPointer = module._p8w_alloc(3) >>> 0;
  const view = new DataView(module.HEAPU8.buffer);
  try {
    module.HEAPU8.set([0x41, 0x00, 0x42], bytesPointer);
    module.HEAPU8.fill(0, framePointer, framePointer + 80);
    view.setUint32(framePointer, 80, true);
    view.setUint32(framePointer + 4, 1, true);
    view.setUint32(framePointer + 8, 1, true);
    view.setUint32(framePointer + 16, 12, true);
    view.setInt32(framePointer + 20, 3 << 16, true);
    view.setUint32(framePointer + 68, bytesPointer, true);
    view.setUint32(framePointer + 72, 3, true);
    assert.equal(module.p8wHostCall(router.bindingId, framePointer), 0);
    assert.equal(vm.copyRam(0x6000, 1)[0], 0x33);

    view.setUint32(framePointer + 68, module.HEAPU8.byteLength - 1, true);
    view.setUint32(framePointer + 72, 3, true);
    assert.equal(module.p8wHostCall(router.bindingId, framePointer), 1);
  } finally {
    module._p8w_free(bytesPointer);
    module._p8w_free(framePointer);
    vm.destroy();
  }
});
