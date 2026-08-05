import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { before } from "node:test";

import {
  CartSession,
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

function parsedCart(source) {
  const code = encoder.encode(source);
  return {
    identity: Object.freeze({ contentSha256: "d".repeat(64) }),
    format: "p8",
    version: 42,
    rom: new Uint8Array(0x8000),
    code,
    warnings: Object.freeze([]),
    sourceBytes: code.byteLength,
    cartVersion: 42,
    luaSource: code,
  };
}

function createVm() {
  return new Z8LuaFrameVm(module, createPicoApiHostRouter(module));
}

function createRuntime(source, options = {}) {
  const runtime = new FrameSliceRuntime(createVm(), options);
  const boot = runtime.boot(sourceCart(source), options.bootInput);
  assert.equal(boot.ok, true, JSON.stringify(boot));
  return runtime;
}

function assertOk(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}

function q16(value) {
  return Math.trunc(value * 65_536) | 0;
}

function pixelAt(bytes, x, y) {
  const packed = bytes[y * 64 + (x >> 1)];
  return (packed >> ((x & 1) << 2)) & 0x0f;
}

function delegateHost(memory, logicalMemory, calls) {
  const base = createPicoApiHost(memory, logicalMemory);
  return {
    memoryLeaseId: base.memoryLeaseId,
    reset: () => base.reset(),
    beginTick: (input, targetFps) => base.beginTick(input, targetFps),
    cls: (colorRaw) => base.cls(colorRaw),
    pset: (xRaw, yRaw, colorRaw) => base.pset(xRaw, yRaw, colorRaw),
    line(...args) {
      calls.push(["line", ...args]);
      base.line(...args);
    },
    rect(...args) {
      calls.push(["rect", ...args]);
      base.rect(...args);
    },
    rectfill(...args) {
      calls.push(["rectfill", ...args]);
      base.rectfill(...args);
    },
    circ(...args) {
      calls.push(["circ", ...args]);
      base.circ(...args);
    },
    circfill(...args) {
      calls.push(["circfill", ...args]);
      base.circfill(...args);
    },
    btn: (buttonRaw, playerRaw) => base.btn(buttonRaw, playerRaw),
    btnp(buttonRaw, playerRaw) {
      calls.push(["btnp", buttonRaw, playerRaw]);
      return base.btnp(buttonRaw, playerRaw);
    },
  };
}

test("Phase 1D appends stable generated host operations and preserves raw optional arguments", async () => {
  const contract = JSON.parse(await readFile(
    new URL("../../spec/abi/pico-host-api-v1.json", import.meta.url),
    "utf8",
  ));
  assert.deepEqual(contract.bindings.slice(0, 9).map(({ id, guestName }) => [id, guestName]), [
    [1, "cls"],
    [2, "pset"],
    [3, "btn"],
    [4, "line"],
    [5, "rect"],
    [6, "rectfill"],
    [7, "circ"],
    [8, "circfill"],
    [9, "btnp"],
  ]);

  const vm = createVm();
  const calls = [];
  const runtime = new FrameSliceRuntime(vm, {
    picoApiHost: delegateHost(vm.memory, vm.logicalMemory, calls),
  });
  const boot = runtime.boot(sourceCart(`
function _init()
 line()
 line(-1.5,2.25,7.5)
 rect(-1.5,2.25,3.5,4.75)
 rectfill(1.5,2.25,3.5,4.75,6.5)
 circ(8.5,9.25)
 circfill(10.5,11.25,3.5,4.25)
 poke(0x100,btnp(5.5,0.25) and 1 or 0)
end
function _update() end
function _draw() end`), { buttons: 0b10_0000 });
  assert.equal(boot.ok, true, JSON.stringify(boot));
  assert.deepEqual(calls, [
    ["line", undefined, undefined, undefined, undefined, undefined],
    ["line", q16(-1.5), q16(2.25), q16(7.5), undefined, undefined],
    ["rect", q16(-1.5), q16(2.25), q16(3.5), q16(4.75), undefined],
    ["rectfill", q16(1.5), q16(2.25), q16(3.5), q16(4.75), q16(6.5)],
    ["circ", q16(8.5), q16(9.25), undefined, undefined],
    ["circfill", q16(10.5), q16(11.25), q16(3.5), q16(4.25)],
    ["btnp", q16(5.5), q16(0.25)],
  ]);
  assert.equal(runtime.copyRam(0x100, 1)[0], 1);
  runtime.dispose();
});

test("RAM-backed L1 graphics draw mapped packed pixels and retain pen/polyline state", () => {
  const runtime = createRuntime(`
function _init()
 poke(0x5f55,0xe0)
 pset(127,127,11)
 cls(0)
 pset(127,127)
 pset(1,0,2)
 pset(2,0)
 line()
 line(1,2,3)
 line(3,2)
 line(5,4,7,4,4)
 line(0,10,4,12,11)
 rect(10,7,8,5,5)
 rectfill(14,7,12,5,6)
 circ(20,20,2,7)
 circfill(30,30,2,8)
 circ(50,50)
 rectfill(-3,-3,0,0,10)
 circ(40,40,-1,9)
 pset(0,1)
end
function _update() end
function _draw() end`);
  const screen = runtime.copyRam(0xe000, 0x2000);

  assert.equal(pixelAt(screen, 1, 0), 2);
  assert.equal(pixelAt(screen, 2, 0), 2, "explicit pset colour becomes the RAM pen");
  assert.equal(pixelAt(screen, 1, 2), 3);
  assert.equal(pixelAt(screen, 2, 2), 3);
  assert.equal(pixelAt(screen, 3, 2), 3);
  assert.equal(pixelAt(screen, 0, 2), 0);
  assert.equal(pixelAt(screen, 5, 4), 4);
  assert.equal(pixelAt(screen, 7, 4), 4);
  assert.deepEqual(
    [[0, 10], [1, 11], [2, 11], [3, 12], [4, 12]].map(([x, y]) => pixelAt(screen, x, y)),
    [11, 11, 11, 11, 11],
    "line uses deterministic integer tie rounding",
  );
  assert.equal(pixelAt(screen, 127, 127), 11, "cls does not change the RAM pen");

  assert.equal(pixelAt(screen, 8, 5), 5);
  assert.equal(pixelAt(screen, 10, 7), 5);
  assert.equal(pixelAt(screen, 9, 6), 0, "rect leaves its interior untouched");
  assert.equal(pixelAt(screen, 12, 5), 6);
  assert.equal(pixelAt(screen, 13, 6), 6);
  assert.equal(pixelAt(screen, 14, 7), 6);

  assert.equal(pixelAt(screen, 22, 20), 7);
  assert.equal(pixelAt(screen, 22, 21), 7);
  assert.equal(pixelAt(screen, 20, 20), 0, "circ is an outline");
  assert.equal(pixelAt(screen, 30, 28), 8);
  assert.equal(pixelAt(screen, 28, 29), 8);
  assert.equal(pixelAt(screen, 30, 30), 8);
  assert.equal(pixelAt(screen, 54, 50), 8, "omitted radius defaults to four");
  assert.equal(pixelAt(screen, 0, 0), 10, "off-screen fill is clipped to physical bounds");
  assert.equal(pixelAt(screen, 40, 40), 0, "negative radius draws no pixels");
  assert.equal(pixelAt(screen, 0, 1), 9, "negative-radius explicit colour still updates pen");

  assert.deepEqual([...runtime.copyRam(0x5f20, 4)], [0, 0, 128, 128]);
  assert.equal(runtime.copyRam(0x5f25, 1)[0] & 0x0f, 9);
  assert.equal(runtime.copyRam(0x5f35, 1)[0] & 1, 0);
  const endpoint = new DataView(runtime.copyRam(0x5f3c, 4).buffer);
  assert.equal(endpoint.getInt16(0, true), 4);
  assert.equal(endpoint.getInt16(2, true), 12);
  assert.equal(runtime.copyRam(0x6000, 1)[0], 0, "mapped drawing does not touch default screen");
  runtime.dispose();
});

test("btn/btnp latch held, edge and default 30 Hz repeat exactly once per tick", () => {
  const runtime = createRuntime(`
n=0
function _update()
 poke(0x100+n,btn(0) and 1 or 0)
 poke(0x140+n,btnp(0) and 1 or 0)
 poke(0x180+n,peek(0x5f4c))
 poke(0x1c0+n,(btn(6) or btn(0,1) or btnp(6) or btnp(0,1)) and 1 or 0)
 n+=1
end
function _draw() end`);

  assertOk(runtime.step({ buttons: 0 }));
  for (let tick = 0; tick < 20; tick += 1) assertOk(runtime.step({ buttons: 1 }));
  assertOk(runtime.step({ buttons: 0 }));
  assertOk(runtime.step({ buttons: 1 }));

  const held = runtime.copyRam(0x100, 23);
  const pressed = runtime.copyRam(0x140, 23);
  const registers = runtime.copyRam(0x180, 23);
  const invalid = runtime.copyRam(0x1c0, 23);
  assert.deepEqual([...held], [0, ...new Array(20).fill(1), 0, 1]);
  assert.deepEqual(
    [...pressed.entries()].filter(([, value]) => value !== 0).map(([index]) => index),
    [1, 16, 20, 22],
  );
  assert.deepEqual(registers, held);
  assert.deepEqual([...invalid], new Array(23).fill(0));
  assert.equal(runtime.copyRam(0x5f4c, 1)[0], 1);
  runtime.dispose();
});

test("btnp scales repeat at 60 Hz and snapshots custom hardware registers", () => {
  const sixty = createRuntime(`
n=0
function _update60() poke(0x100+n,btnp(0) and 1 or 0) n+=1 end
function _draw() end`);
  for (let tick = 0; tick < 32; tick += 1) assertOk(sixty.step({ buttons: 1 }));
  assert.deepEqual(
    [...sixty.copyRam(0x100, 32).entries()]
      .filter(([, value]) => value !== 0).map(([index]) => index),
    [0, 30],
  );
  sixty.dispose();

  const custom = createRuntime(`
n=0
function _init() poke(0x5f5c,2) poke(0x5f5d,3) end
function _update() poke(0x100+n,btnp(0) and 1 or 0) n+=1 end
function _draw() end`);
  for (let tick = 0; tick < 9; tick += 1) assertOk(custom.step({ buttons: 1 }));
  assert.deepEqual(
    [...custom.copyRam(0x100, 9).entries()]
      .filter(([, value]) => value !== 0).map(([index]) => index),
    [0, 2, 5, 8],
  );
  custom.dispose();

  const customSixty = createRuntime(`
n=0
function _init() poke(0x5f5c,2) poke(0x5f5d,3) end
function _update60() poke(0x100+n,btnp(0) and 1 or 0) n+=1 end
function _draw() end`);
  for (let tick = 0; tick < 12; tick += 1) assertOk(customSixty.step({ buttons: 1 }));
  assert.deepEqual(
    [...customSixty.copyRam(0x100, 12).entries()]
      .filter(([, value]) => value !== 0).map(([index]) => index),
    [0, 4, 10],
  );
  customSixty.dispose();

  const latched = createRuntime(`
n=0
function _update()
 if n==15 then poke(0x5f5c,255) end
 poke(0x100+n,btnp(0) and 1 or 0)
 n+=1
end
function _draw() end`);
  for (let tick = 0; tick < 20; tick += 1) assertOk(latched.step({ buttons: 1 }));
  assert.deepEqual(
    [...latched.copyRam(0x100, 20).entries()]
      .filter(([, value]) => value !== 0).map(([index]) => index),
    [0, 15],
    "a repeat-register poke cannot rewrite the already-latched current tick",
  );
  latched.dispose();

  const disabled = createRuntime(`
n=0
function _init() poke(0x5f5c,255) end
function _update() poke(0x100+n,btnp(0) and 1 or 0) n+=1 end
function _draw() end`);
  for (let tick = 0; tick < 20; tick += 1) assertOk(disabled.step({ buttons: 1 }));
  assert.deepEqual(
    [...disabled.copyRam(0x100, 20).entries()]
      .filter(([, value]) => value !== 0).map(([index]) => index),
    [0],
  );
  disabled.dispose();
});

test("invalid input and HostRequest completion never consume or double-advance btnp", () => {
  const runtime = createRuntime(`
n=0
function _update()
 local before=btnp(0) and 1 or 0
 if n==0 then __p8w_probe_host_request("phase-1d-input") end
 local after=btnp(0) and 1 or 0
 poke(0x100+n,before)
 poke(0x110+n,after)
 n+=1
end
function _draw() end`);

  const invalid = runtime.step({ buttons: 64 });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "E_INVALID_STATE");
  const requested = assertOk(runtime.step({ buttons: 1 }));
  assert.equal(requested.kind, "host-request");
  const completed = assertOk(runtime.completeHostRequest(
    requested.request.id,
    Uint8Array.of(1),
  ));
  assert.equal(completed.kind, "frame");
  assert.deepEqual([...runtime.copyRam(0x100, 1)], [1]);
  assert.deepEqual([...runtime.copyRam(0x110, 1)], [1]);
  assertOk(runtime.step({ buttons: 1 }));
  assert.equal(runtime.copyRam(0x101, 1)[0], 0);
  assert.equal(runtime.copyRam(0x111, 1)[0], 0);
  runtime.dispose();
});

test("CartSession generation reset restores input and RAM-backed draw defaults", () => {
  const session = new CartSession({
    createRuntime() {
      return new FrameSliceRuntime(createVm());
    },
  });
  const cart = parsedCart(`
function _init()
 poke(0x210,peek(0x5f25))
 poke(0x211,peek(0x5f35))
 poke(0x212,peek(0x5f4c))
 pset(0,0,12)
 line(1,1,2,2,13)
end
function _update() poke(0x213,btnp(0) and 1 or 0) end
function _draw() end`);

  assertOk(session.load(cart));
  assert.deepEqual([...assertOk(session.copyRam(0x210, 3))], [6, 1, 0]);
  assertOk(session.step({ buttons: 1 }));
  assert.equal(assertOk(session.copyRam(0x213, 1))[0], 1);
  assertOk(session.reset());
  assert.deepEqual([...assertOk(session.copyRam(0x210, 3))], [6, 1, 0]);
  assertOk(session.step({ buttons: 1 }));
  assert.equal(assertOk(session.copyRam(0x213, 1))[0], 1);
  assertOk(session.dispose());
});
