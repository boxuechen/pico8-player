import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { before } from "node:test";
import { inputSnapshot } from "../helpers/input.mjs";

import {
  createPicoApiHost,
  FrameSliceRuntime,
} from "@pico8-player/runtime-core";
import {
  createPicoApiHostRouter,
  Z8LuaFrameVm,
} from "@pico8-player/z8lua-bridge";
import createZ8LuaModule from "../../wasm/dist/z8lua-runtime-v1.mjs";
import {
  renderCpp,
  renderTypeScript,
  validateBindingContract,
} from "../../tools/wasm/generate-host-bindings.mjs";

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
  const router = createPicoApiHostRouter(module);
  return { router, vm: new Z8LuaFrameVm(module, router) };
}

function wrapHost(memory, logicalMemory, overrides = {}) {
  const base = createPicoApiHost(memory, logicalMemory);
  return {
    memoryLeaseId: base.memoryLeaseId,
    get devkitFlags() { return base.devkitFlags; },
    takeCartDataCommit: () => base.takeCartDataCommit(),
    reset: () => base.reset(),
    resetAudio: () => base.resetAudio(),
    beginTick: (input, targetFps) => base.beginTick(input, targetFps),
    renderAudioSlices: (sliceCount, targetFps) =>
      base.renderAudioSlices(sliceCount, targetFps),
    snapshotAudioChannels: () => base.snapshotAudioChannels(),
    snapshotAudioMusic: () => base.snapshotAudioMusic(),
    cls: (colorRaw) => base.cls(colorRaw),
    pset: (xRaw, yRaw, colorRaw) => base.pset(xRaw, yRaw, colorRaw),
    line: (x0Raw, y0Raw, x1OrColorRaw, y1Raw, colorRaw) =>
      base.line(x0Raw, y0Raw, x1OrColorRaw, y1Raw, colorRaw),
    rect: (x0Raw, y0Raw, x1Raw, y1Raw, colorRaw) =>
      base.rect(x0Raw, y0Raw, x1Raw, y1Raw, colorRaw),
    rectfill: (x0Raw, y0Raw, x1Raw, y1Raw, colorRaw) =>
      base.rectfill(x0Raw, y0Raw, x1Raw, y1Raw, colorRaw),
    circ: (xRaw, yRaw, radiusRaw, colorRaw) =>
      base.circ(xRaw, yRaw, radiusRaw, colorRaw),
    circfill: (xRaw, yRaw, radiusRaw, colorRaw) =>
      base.circfill(xRaw, yRaw, radiusRaw, colorRaw),
    btn: (buttonRaw, playerRaw) => base.btn(buttonRaw, playerRaw),
    btnp: (buttonRaw, playerRaw) => base.btnp(buttonRaw, playerRaw),
    sfx: (sfxRaw, channelRaw, offsetRaw, lengthRaw) =>
      base.sfx(sfxRaw, channelRaw, offsetRaw, lengthRaw),
    music: (patternRaw, fadeLengthRaw, channelMaskRaw) =>
      base.music(patternRaw, fadeLengthRaw, channelMaskRaw),
    ...overrides,
  };
}

test("binding generator proves Phase 2 scalar and byte-string frames without exposing prototype APIs", async () => {
  const prototype = validateBindingContract(JSON.parse(await readFile(
    new URL("../fixtures/host-bindings/signatures.json", import.meta.url),
    "utf8",
  )), { runtimeExposed: false });
  assert.equal(prototype.bindings.length, 12);
  const production = validateBindingContract(JSON.parse(await readFile(
    new URL("../../spec/abi/pico-host-api-v1.json", import.meta.url),
    "utf8",
  )));
  assert.deepEqual(production.bindings.slice(0, 9).map(({ guestName }) => guestName), [
    "cls", "pset", "btn", "line", "rect", "rectfill", "circ", "circfill", "btnp",
  ]);
  assert.match(renderTypeScript(production), /argumentMask & 4/u);
  assert.match(renderTypeScript(prototype), /byteString!/u);
  assert.match(renderCpp(production), /P8W_HOST_RESULT_INTEGER_OR_BOOLEAN/u);
  assert.equal(renderCpp(prototype).includes("probe_six"), true);
  assert.equal(renderCpp(prototype).includes("probe_twelve"), true);
  assert.match(renderCpp(prototype), /probe_bytes", 1u, 2u, 1u, 0u/u);
  assert.match(renderCpp(prototype), /probe_boolean_argument", 1u, 1u, 0u, 1u/u);
  assert.match(renderCpp(prototype), /P8W_HOST_RESULT_Q16/u);
});

function writeScalarCallFrame(pointer, operationId, argumentMask, args) {
  module.HEAPU8.fill(0, pointer, pointer + 80);
  const view = new DataView(module.HEAPU8.buffer);
  view.setUint32(pointer, 80, true);
  view.setUint32(pointer + 4, operationId, true);
  view.setUint32(pointer + 8, argumentMask, true);
  view.setUint32(pointer + 16, args.length, true);
  args.forEach((value, index) => view.setInt32(pointer + 20 + index * 4, value, true));
}

test("WASM compile is gated by an exactly-once nonzero host binding", () => {
  const handle = module._p8w_create(0) >>> 0;
  assert.notEqual(handle, 0);
  const source = encoder.encode("function _update() end function _draw() end");
  const pointer = module._p8w_alloc(source.byteLength) >>> 0;
  module.HEAPU8.set(source, pointer);
  try {
    assert.equal(module._p8w_compile(handle, pointer, source.byteLength) >>> 0, 3);
    assert.equal(module._p8w_bind_host(handle, 0) >>> 0, 4);
    assert.equal(module._p8w_bind_host(handle, 91) >>> 0, 0);
    assert.equal(module._p8w_bind_host(handle, 92) >>> 0, 3);
    assert.equal(module._p8w_compile(handle, pointer, source.byteLength) >>> 0, 0);
  } finally {
    module._p8w_free(pointer);
    assert.equal(module._p8w_destroy(handle) >>> 0, 0);
  }
});

test("session routers reject double bind, rebind and stale dispatch without cross-routing", () => {
  const first = createVm();
  const second = createVm();
  assert.notEqual(first.router.bindingId, second.router.bindingId);
  const firstHost = createPicoApiHost(first.vm.memory, first.vm.logicalMemory);
  const secondHost = createPicoApiHost(second.vm.memory, second.vm.logicalMemory);
  first.vm.bindHost(firstHost);
  second.vm.bindHost(secondHost);
  assert.equal(first.vm.hostBindingState, "bound");
  assert.throws(() => first.vm.bindHost(firstHost), /cannot bind from bound/u);

  const callFramePointer = module._p8w_alloc(80) >>> 0;
  try {
    writeScalarCallFrame(callFramePointer, 1, 1, [0x0003_0000]);
    assert.equal(module.p8wHostCall(first.router.bindingId, callFramePointer), 0);
    assert.equal(first.vm.copyRam(0x6000, 1)[0], 0x33);
    assert.equal(second.vm.copyRam(0x6000, 1)[0], 0);
    first.vm.destroy();
    assert.equal(first.vm.hostBindingState, "released");
    writeScalarCallFrame(callFramePointer, 1, 0, []);
    assert.equal(module.p8wHostCall(first.router.bindingId, callFramePointer), 1);
    assert.throws(() => first.router.bind(firstHost), /cannot bind from released/u);
    writeScalarCallFrame(callFramePointer, 1, 1, [0x0004_0000]);
    assert.equal(module.p8wHostCall(second.router.bindingId, callFramePointer), 0);
    assert.equal(second.vm.copyRam(0x6000, 1)[0], 0x44);
  } finally {
    module._p8w_free(callFramePointer);
    second.vm.destroy();
  }
});

test("raw Q16.16 arguments, optional presence and btn results cross the synchronous ABI exactly", () => {
  const { vm } = createVm();
  const calls = [];
  const base = createPicoApiHost(vm.memory, vm.logicalMemory);
  const host = wrapHost(vm.memory, vm.logicalMemory, {
    reset: () => base.reset(),
    beginTick: (input, targetFps) => base.beginTick(input, targetFps),
    cls(colorRaw) {
      calls.push(["cls", colorRaw]);
      base.cls(colorRaw);
    },
    pset(xRaw, yRaw, colorRaw) {
      calls.push(["pset", xRaw, yRaw, colorRaw]);
      base.pset(xRaw, yRaw, colorRaw);
    },
    btn(buttonRaw, playerRaw) {
      calls.push(["btn", buttonRaw, playerRaw]);
      return base.btn(buttonRaw, playerRaw);
    },
  });
  const runtime = new FrameSliceRuntime(vm, { picoApiHost: host });
  const boot = runtime.boot(sourceCart(`
function _init()
 cls() cls(2.5)
 pset(-1.5,3.25) pset(4.5,5.75,7.5)
 poke(0x150,btn())
 poke(0x151,btn(0) and 1 or 0)
 poke(0x152,btn(5,0) and 1 or 0)
 poke(0x153,btn(5,1) and 1 or 0)
 btn(nil,1)
end
function _update() end
function _draw() end`), inputSnapshot([0b10_0001, 0, 0, 0, 0, 0, 0, 0]));
  assert.equal(boot.ok, true, JSON.stringify(boot));
  assert.deepEqual(calls.slice(0, 4), [
    ["cls", undefined],
    ["cls", 0x0002_8000],
    ["pset", -0x0001_8000, 0x0003_4000, undefined],
    ["pset", 0x0004_8000, 0x0005_c000, 0x0007_8000],
  ]);
  assert.deepEqual(runtime.copyRam(0x150, 4), Uint8Array.of(33, 1, 1, 0));
  assert.deepEqual(calls.at(-1), ["btn", undefined, 0x0001_0000]);
  runtime.dispose();
});

test("TypeScript host owns mapped cls/pset semantics while direct memory and flip remain in WASM", () => {
  const { vm } = createVm();
  const runtime = new FrameSliceRuntime(vm);
  const boot = runtime.boot(sourceCart(`
poke(0x5f55,0xe0)
cls(9) pset(1,0,2)
n=0
while true do
 poke(0x160,n)
 flip()
 n+=1
end`));
  assert.equal(boot.ok, true, JSON.stringify(boot));
  assert.equal(boot.value.kind, "ready");
  assert.equal(boot.value.mode, "custom");
  assert.equal(boot.value.targetFps, 30);
  assert.equal(boot.value.audio.frameCount, 735);
  assert.equal(boot.value.audio.pcm16le.every((value) => value === 0), true);
  assert.equal(runtime.copyRam(0xe000, 1)[0], 0x29);
  assert.equal(runtime.copyRam(0x6000, 1)[0], 0);
  assert.equal(runtime.copyRam(0x160, 1)[0], 0);
  assert.equal(runtime.step().ok, true);
  assert.equal(runtime.copyRam(0x160, 1)[0], 1);
  runtime.dispose();
});

test("host throws become a contained E_HOST_API fault and poison the VM", () => {
  const { vm } = createVm();
  const base = createPicoApiHost(vm.memory, vm.logicalMemory);
  const host = wrapHost(vm.memory, vm.logicalMemory, {
    pset() {
      throw new Error("phase-1a-test-host-failure");
    },
    cls: (colorRaw) => base.cls(colorRaw),
  });
  const runtime = new FrameSliceRuntime(vm, { picoApiHost: host });
  const boot = runtime.boot(sourceCart(`
function _init() pset(1,2,3) end
function _update() end
function _draw() end`));
  assert.equal(boot.ok, false);
  assert.equal(boot.error.code, "E_HOST_API");
  assert.equal(boot.error.phase, "host-call");
  assert.equal(boot.error.message, "phase-1a-test-host-failure");
  assert.equal(runtime.state, "faulted");
  assert.equal(runtime.step().error.code, "E_INVALID_STATE");
  runtime.dispose();
});

test("synchronous host calls keep the Lua stack balanced and stay within the Phase 1A budget", () => {
  const { vm } = createVm();
  let dispatchCount = 0;
  const base = createPicoApiHost(vm.memory, vm.logicalMemory);
  const host = wrapHost(vm.memory, vm.logicalMemory, {
    reset: () => base.reset(),
    beginTick: (input, targetFps) => base.beginTick(input, targetFps),
    cls(colorRaw) {
      dispatchCount += 1;
      base.cls(colorRaw);
    },
    pset(xRaw, yRaw, colorRaw) {
      dispatchCount += 1;
      base.pset(xRaw, yRaw, colorRaw);
    },
    btn(buttonRaw, playerRaw) {
      dispatchCount += 1;
      return base.btn(buttonRaw, playerRaw);
    },
  });
  const runtime = new FrameSliceRuntime(vm, {
    instructionBudget: 2_000_000,
    picoApiHost: host,
  });
  const started = performance.now();
  const boot = runtime.boot(sourceCart(`
function _init()
 local sum=0
 for i=1,10000 do
  pset(i%128,(i/128)%128,i%16)
  if btn(0) then sum+=1 end
 end
 poke(0x170,sum) cls(1) pset(0,0,7)
end
function _update() end
function _draw() end`), inputSnapshot([1, 0, 0, 0, 0, 0, 0, 0]));
  const elapsedMs = performance.now() - started;
  assert.equal(boot.ok, true, JSON.stringify(boot));
  assert.equal(dispatchCount, 20_002);
  assert.equal(runtime.copyRam(0x170, 1)[0], 0x10);
  assert.equal(runtime.copyRam(0x6000, 1)[0], 0x17);
  assert.ok(elapsedMs < 1_000, `host interop took ${elapsedMs.toFixed(1)}ms`);
  runtime.dispose();
});
