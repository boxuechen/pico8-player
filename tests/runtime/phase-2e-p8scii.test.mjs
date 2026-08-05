import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
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

function q16(value) {
  return (value * 65_536) | 0;
}

function sourceCart(source) {
  return { rom: new Uint8Array(0x8000), code: encoder.encode(source) };
}

function createDirectHost() {
  const buffer = new ArrayBuffer(0x10000);
  const lease = {
    buffer,
    byteOffset: 0,
    byteLength: 0x10000,
    leaseId: "phase-2e-direct",
  };
  const mapper = {
    memoryLeaseId: lease.leaseId,
    mapAddress(address) {
      return address & 0xffff;
    },
  };
  const host = createPicoApiHost(lease, mapper);
  host.reset();
  return { host, ram: new Uint8Array(buffer) };
}

function pixel(ram, x, y) {
  const packed = ram[0x6000 + y * 64 + (x >> 1)];
  return (packed >>> ((x & 1) * 4)) & 0x0f;
}

function row(ram, y, x0, x1) {
  return Array.from({ length: x1 - x0 + 1 }, (_, index) =>
    pixel(ram, x0 + index, y));
}

function ascii(value) {
  return typeof value === "number" ? value : value.charCodeAt(0);
}

function bytes(...values) {
  return Uint8Array.from(values.map(ascii));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("Phase 2E appends print/cursor ids and activates the production byte-string slot", async () => {
  const contract = JSON.parse(await readFile(
    new URL("../../spec/abi/pico-host-api-v1.json", import.meta.url),
    "utf8",
  ));
  assert.equal(contract.dispatchAbi.callFrame.byteSize, 80);
  assert.deepEqual(contract.bindings.slice(28, 30).map(({ id, guestName }) => [id, guestName]), [
    [29, "print"],
    [30, "cursor"],
  ]);
  assert.equal(contract.bindings[28].parameters[0].type, "byte-string");

  const vm = new Z8LuaFrameVm(module, createPicoApiHostRouter(module));
  const base = createPicoApiHost(vm.memory, vm.logicalMemory);
  const calls = [];
  const host = new Proxy(base, {
    get(target, property) {
      if (property === "print") {
        return (view) => {
          calls.push({
            copy: view.slice(),
            isSynchronousWasmView: view.buffer === module.HEAPU8.buffer,
          });
          return view.byteLength;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const runtime = new FrameSliceRuntime(vm, {
    picoApiHost: host,
    instructionBudget: 2_000_000,
  });
  const boot = runtime.boot(sourceCart(`
function _init()
 print("")
 print("a\\0b")
 print(chr(255))
 local s="" for i=1,1024 do s=s.."x" end print(s)
end
function _update() end
function _draw() end`));
  assert.equal(boot.ok, true, JSON.stringify(boot));
  assert.deepEqual(calls.map(({ copy }) => copy.byteLength), [0, 3, 1, 1024]);
  assert.deepEqual([...calls[1].copy], [0x61, 0x00, 0x62]);
  assert.deepEqual([...calls[2].copy], [0xff]);
  assert.equal(calls[3].copy.every((value) => value === 0x78), true);
  assert.equal(calls.every(({ isSynchronousWasmView }) => isSynchronousWasmView), true);
  runtime.dispose();
});

test("production wrappers reject missing and malformed required arguments without stale dispatch", () => {
  for (const source of [
    `function _init() print() end`,
    `function _init() print({}) end`,
    `function _init() cursor(1) end`,
  ]) {
    const vm = new Z8LuaFrameVm(module, createPicoApiHostRouter(module));
    const runtime = new FrameSliceRuntime(vm);
    const boot = runtime.boot(sourceCart(`${source}
function _update() end
function _draw() end`));
    assert.equal(boot.ok, false);
    assert.equal(boot.error.code, "E_VM_RUNTIME");
    runtime.dispose();
  }
});

test("production host exceptions become structured host API faults", () => {
  const vm = new Z8LuaFrameVm(module, createPicoApiHostRouter(module));
  const base = createPicoApiHost(vm.memory, vm.logicalMemory);
  const host = new Proxy(base, {
    get(target, property) {
      if (property === "print") return () => { throw new Error("text host probe"); };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const runtime = new FrameSliceRuntime(vm, { picoApiHost: host });
  const boot = runtime.boot(sourceCart(`
function _init() print("x") end
function _update() end
function _draw() end`));
  assert.equal(boot.ok, false);
  assert.equal(boot.error.code, "E_HOST_API");
  runtime.dispose();
});

test("print overloads preserve cursor/home/pen, NUL termination and right-most x", () => {
  const { host, ram } = createDirectHost();
  host.cursor(q16(10), q16(20), q16(3));
  assert.deepEqual([...ram.slice(0x5f24, 0x5f28)], [10, 3, 10, 20]);

  assert.equal(host.print(bytes("a")), 14);
  assert.deepEqual([...ram.slice(0x5f24, 0x5f28)], [10, 3, 10, 26]);
  assert.equal(host.print(bytes("a"), q16(4)), 14);
  assert.deepEqual([...ram.slice(0x5f24, 0x5f28)], [10, 4, 10, 32]);

  assert.equal(host.print(bytes("a", 0, "b"), q16(1), q16(2), q16(7)), 5);
  assert.deepEqual([...ram.slice(0x5f24, 0x5f28)], [1, 7, 5, 2]);
  assert.equal(pixel(ram, 1, 2), 7);

  host.cursor(q16(0), q16(0));
  assert.equal(host.print(bytes(3, "t", "a", 3, "0", "b"), q16(6)), 17);
  assert.equal(ram[0x5f25], 6);
  assert.equal(ram[0x5f26], 0);
  assert.equal(ram[0x5f27], 6);
});

test("built-in ASCII/high glyph rows use LSB-left software raster and draw palette", () => {
  const { host, ram } = createDirectHost();
  host.pal(q16(7), q16(12));
  assert.equal(host.print(bytes("a"), q16(0), q16(0), q16(7)), 4);
  assert.deepEqual(row(ram, 0, 0, 3), [12, 12, 12, 0]);
  assert.deepEqual(row(ram, 1, 0, 3), [12, 0, 12, 0]);
  assert.deepEqual(row(ram, 2, 0, 3), [12, 12, 12, 0]);
  assert.deepEqual(row(ram, 4, 0, 3), [12, 0, 12, 0]);

  assert.equal(host.print(bytes(0x80), q16(8), q16(0), q16(5)), 16);
  assert.deepEqual(row(ram, 0, 8, 15), [5, 5, 5, 5, 5, 5, 5, 0]);
  assert.deepEqual(row(ram, 4, 8, 15), [5, 5, 5, 5, 5, 5, 5, 0]);
});

test("text shares camera, clip, foreground/background palette and deterministic framebuffer ordering", () => {
  const { host, ram } = createDirectHost();
  host.cls(q16(1));
  host.pal(q16(7), q16(12));
  host.pal(q16(3), q16(9));
  host.camera(q16(2), q16(1));
  host.clip(q16(0), q16(0), q16(12), q16(10));
  host.print(bytes(2, "3", "a"), q16(2), q16(1), q16(7));
  host.print(bytes(6, "w", 6, "=", "b"), q16(6), q16(1), q16(7));
  host.camera();
  host.clip();
  host.print(bytes(6, ":", ...encoder.encode("447cb67c3e7f0106")), q16(16), q16(2), q16(6));

  assert.deepEqual(row(ram, 0, 0, 3), [12, 12, 12, 9]);
  assert.equal(pixel(ram, 4, 0), 12);
  assert.equal(pixel(ram, 5, 0), 1);
  assert.equal(pixel(ram, 16, 2), 1);
  assert.equal(pixel(ram, 18, 2), 6);
  assert.equal(
    sha256(ram.subarray(0x6000, 0x8000)),
    "da6169dd3f2d02bf500de92892d6a1b0a28b3386016aedf14a121f5915e69f65",
  );
});

test("control opcodes cover repeat, shifts, tab/newline, decoration, foreground and font switches", () => {
  const { host, ram } = createDirectHost();
  assert.equal(host.print(bytes(1, "3", "a", 0, "b"), q16(0), q16(0), q16(7)), 12);
  assert.deepEqual(row(ram, 0, 0, 11), [7, 7, 7, 0, 7, 7, 7, 0, 7, 7, 7, 0]);

  host.cls();
  host.cursor(q16(1), q16(6), q16(6));
  assert.equal(host.print(bytes(3, "h", "a", 8, 9, "a", 13, "a", 10, "a", 11, "b", ",", 12, "c")), 20);
  assert.equal(ram[0x5f25], 12);
  assert.equal(pixel(ram, 3, 9), 6);
  assert.equal(ram[0x5f27] >= 12, true);

  ram[0x5600] = 1;
  ram[0x5602] = 1;
  ram[0x5600 + "a".charCodeAt(0) * 8] = 1;
  host.cls();
  assert.equal(host.print(bytes(14, "a", 15, "a"), q16(0), q16(0), q16(5)), 5);
  assert.equal(pixel(ram, 0, 0), 5);
  assert.equal(pixel(ram, 1, 0), 5);
});

test("visual special commands implement homes, dimensions, modes, one-offs, outlines and raw writes", () => {
  const { host, ram } = createDirectHost();

  assert.equal(host.print(bytes(3, "h", 6, "h", 3, "h", 6, "g", "a"), q16(0), q16(0), q16(7)), 5);
  assert.equal(host.print(bytes(6, "j", "2", "3", "a"), q16(0), q16(0), q16(7)), 12);
  assert.equal(pixel(ram, 8, 12), 7);

  host.cls();
  assert.equal(host.print(bytes(6, "w", "a", 6, "-", "w", "a"), q16(0), q16(0), q16(7)), 12);
  assert.deepEqual(row(ram, 0, 0, 7), [7, 7, 7, 7, 7, 7, 0, 0]);
  assert.equal(pixel(ram, 8, 0), 7);
  host.cls();
  host.print(bytes(6, "w", 6, "=", 6, "#", "a"), q16(0), q16(0), q16(7));
  assert.deepEqual(row(ram, 0, 0, 5), [7, 0, 7, 0, 7, 0]);

  host.cls();
  assert.equal(host.print(bytes(6, "x", "2", 6, "y", "3", 6, "u", "a"), q16(0), q16(0), q16(6)), 2);
  assert.deepEqual(row(ram, 2, 0, 1), [6, 6]);
  host.cursor(q16(1), q16(0));
  assert.equal(host.print(bytes(6, "s", "3", 9, "a", 0)), 7);

  host.cls();
  host.print(bytes(6, ".", 1, 0, 0, 0, 0, 0, 0, 0), q16(2), q16(2), q16(5));
  assert.equal(pixel(ram, 2, 2), 5);
  host.print(bytes(6, ";", ...encoder.encode("0100000000000000")), q16(12), q16(2), q16(6));
  assert.equal(pixel(ram, 12, 2), 6);

  host.cls();
  host.print(bytes(6, "o", "8", "0", "1", 6, ".", 1, 0, 0, 0, 0, 0, 0, 0), q16(2), q16(2), q16(7));
  assert.equal(pixel(ram, 1, 1), 8);
  assert.equal(pixel(ram, 2, 2), 7);
  host.cls();
  host.print(bytes(6, "o", "!", "f", "f", 6, ".", 1, 0, 0, 0, 0, 0, 0, 0), q16(4), q16(4), q16(7));
  assert.equal(pixel(ram, 4, 4), 0);
  assert.equal(pixel(ram, 3, 3), 7);

  host.print(bytes(6, "@", ...encoder.encode("43000003"), "x", 0, 0xff, "a"), q16(0), q16(20), q16(6));
  assert.deepEqual([...ram.slice(0x4300, 0x4303)], [0x78, 0x00, 0xff]);
  host.cursor(q16(9), q16(9));
  host.print(bytes(6, "!", ...encoder.encode("4310"), "a", "b", 0xff));
  assert.deepEqual([...ram.slice(0x4310, 0x4313)], [0x61, 0x62, 0xff]);
  assert.deepEqual([...ram.slice(0x5f26, 0x5f28)], [9, 9]);

  host.cls(q16(4));
  host.print(bytes(6, "c", "2", "a"), q16(10), q16(10), q16(7));
  assert.equal(pixel(ram, 127, 127), 2);
  assert.equal(pixel(ram, 0, 0), 7);
  host.print(bytes(6, "1", 6, "d", "3", 7, "c", " ", "a"), q16(20), q16(20), q16(5));
  assert.equal(pixel(ram, 20, 20), 5);
});

test("background, both-axis shifts, wrapping and every render-mode toggle have explicit raster effects", () => {
  const { host, ram } = createDirectHost();
  host.cls(q16(1));
  host.print(bytes(2, "3", "a"), q16(1), q16(1), q16(7));
  assert.equal(pixel(ram, 0, 0), 3);
  assert.equal(pixel(ram, 1, 1), 7);

  host.cls();
  assert.equal(host.print(bytes(3, "h", 4, "h", 5, "h", "h", "a"), q16(0), q16(0), q16(7)), 6);
  assert.equal(pixel(ram, 2, 2), 7);

  host.cls();
  assert.equal(host.print(bytes(6, "r", "2", "a", "a", "a"), q16(0), q16(0), q16(7)), 8);
  assert.equal(pixel(ram, 0, 6), 7);

  host.cls();
  assert.equal(host.print(bytes(6, "t", "a", 6, "-", "t", "a"), q16(0), q16(0), q16(7)), 8);
  assert.equal(pixel(ram, 0, 1), 7);
  assert.equal(pixel(ram, 0, 9), 7);
  assert.equal(pixel(ram, 4, 9), 0);

  host.cls();
  assert.equal(host.print(bytes(6, "p", "a", 6, "-", "p", "a"), q16(0), q16(0), q16(7)), 12);
  assert.equal(pixel(ram, 0, 0), 7);
  assert.equal(pixel(ram, 1, 0), 0);
  assert.equal(pixel(ram, 0, 1), 0);
  assert.equal(pixel(ram, 8, 0), 7);

  host.cls();
  host.print(bytes(6, "i", "a", 6, "-", "i", "a"), q16(0), q16(0), q16(6));
  assert.equal(pixel(ram, 0, 0), 0);
  assert.equal(pixel(ram, 3, 0), 6);
  assert.equal(pixel(ram, 4, 0), 6);

  host.cls(q16(5));
  host.print(bytes(6, "#", 6, "-", "b", "a"), q16(1), q16(1), q16(7));
  assert.equal(pixel(ram, 0, 0), 5);
  assert.equal(pixel(ram, 1, 1), 7);
  host.print(bytes(6, "b", 6, "#", "a"), q16(10), q16(1), q16(7));
  assert.equal(pixel(ram, 9, 0), 0);

  assert.equal(host.print(bytes(6, "w", "a"), q16(0), q16(20), q16(7)), 8);
  assert.equal(host.print(bytes("a"), q16(0), q16(30)), 4);
});

test("colon/comma one-offs, current-colour outlines and truncated sequences stay deterministic", () => {
  const { host, ram } = createDirectHost();
  host.print(bytes(6, ":", ...encoder.encode("0100000000000000")), q16(0), q16(0), q16(5));
  host.print(bytes(6, ",", 1, 0, 0, 0, 0, 0, 0, 0), q16(10), q16(0), q16(6));
  assert.equal(pixel(ram, 0, 0), 5);
  assert.equal(pixel(ram, 10, 0), 6);

  host.print(bytes(6, "o", "$", "0", "1", 6, ".", 1, 0, 0, 0, 0, 0, 0, 0), q16(4), q16(4), q16(9));
  assert.equal(pixel(ram, 3, 3), 9);
  assert.equal(pixel(ram, 4, 4), 9);

  const truncated = [
    bytes(1), bytes(1, "3"), bytes(2), bytes(3), bytes(4), bytes(5), bytes(5, "h"),
    bytes(6), bytes(6, "j"), bytes(6, "j", "1"), bytes(6, "o", "7"),
    bytes(6, ".", 1, 2), bytes(6, ":", "0", "1"), bytes(6, "@", "4", "3"),
    bytes(6, "!", "4", "3"), bytes(7), bytes(11), bytes(12),
  ];
  for (const sample of truncated) {
    assert.doesNotThrow(() => host.print(sample, q16(0), q16(40), q16(7)));
  }
});

test("custom font attributes, adjustments, tab and default registers are read from live Pico RAM", () => {
  const { host, ram } = createDirectHost();
  ram.set([3, 5, 2, 1, 1, 3, 3, 0], 0x5600);
  const glyphAddress = 0x5600 + "a".charCodeAt(0) * 8;
  ram[glyphAddress] = 1;
  ram[glyphAddress + 1] = 2;
  const adjustmentAddress = 0x5608 + (("a".charCodeAt(0) - 16) >> 1);
  ram[adjustmentAddress] = 0xa0;

  assert.equal(host.print(bytes(14, "a"), q16(0), q16(0), q16(7)), 5);
  assert.equal(pixel(ram, 1, 0), 7);
  assert.equal(pixel(ram, 2, 1), 7);

  host.cursor(q16(1), q16(10));
  assert.equal(host.print(bytes(14, 9, "a", 0)), 9);
  assert.equal(ram[0x5f26], 9);

  host.cls();
  ram[0x5f58] = 0x01 | 0x04 | 0x80;
  ram[0x5f59] = 0x21;
  ram[0x5f5a] = 0x24;
  ram[0x5f5b] = 0x11;
  assert.equal(host.print(bytes("a"), q16(0), q16(0), q16(6)), 6);
  assert.equal(pixel(ram, 2, 1), 6);
});

test("implicit output scrolls the mapped screen to y=122 and 0x5f36 bit 0x40 disables it", () => {
  const first = createDirectHost();
  for (let y = 0; y < 128; y += 1) {
    first.ram.fill(((y + 1) & 0x0f) * 0x11, 0x6000 + y * 64, 0x6000 + (y + 1) * 64);
  }
  first.host.cursor(q16(0), q16(122), q16(7));
  first.host.print(bytes("a"));
  assert.equal(first.ram[0x5f27], 122);
  assert.equal(pixel(first.ram, 0, 0), 7);
  assert.equal(pixel(first.ram, 127, 121), 0);

  const second = createDirectHost();
  second.ram.fill(0x55, 0x6000, 0x8000);
  second.ram[0x5f36] = 0x40;
  second.host.cursor(q16(0), q16(122), q16(7));
  second.host.print(bytes("a"));
  assert.equal(second.ram[0x5f27], 128);
  assert.equal(pixel(second.ram, 100, 0), 5);
});

test("mapped production screen receives text and scroll while the base screen remains untouched", () => {
  const vm = new Z8LuaFrameVm(module, createPicoApiHostRouter(module));
  const runtime = new FrameSliceRuntime(vm);
  const boot = runtime.boot(sourceCart(`
function _init()
 poke(0x5f55,0xe0)
 memset(0xe000,0x55,0x2000)
 cursor(0,122,7)
 print("a")
end
function _update() end
function _draw() end`));
  assert.equal(boot.ok, true, JSON.stringify(boot));
  assert.equal(runtime.copyRam(0x6000, 0x2000).every((value) => value === 0), true);
  assert.equal(runtime.copyRam(0xe000, 1)[0], 0x55);
  assert.equal(runtime.copyRam(0x5f27, 1)[0], 122);
  runtime.dispose();
});

test("10,000 deterministic arbitrary byte arrays are bounded and never access outside Pico RAM", () => {
  const { host, ram } = createDirectHost();
  let state = 0x2e5a_19c3;
  let boundedErrors = 0;
  for (let caseIndex = 0; caseIndex < 10_000; caseIndex += 1) {
    const length = caseIndex % 65;
    const sample = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      sample[index] = state & 0xff;
    }
    ram[0x5f58] = 0;
    ram[0x5600] = 4;
    ram[0x5601] = 8;
    ram[0x5602] = 6;
    try {
      host.print(sample, q16(0), q16(0), q16(6));
    } catch (error) {
      assert.match(String(error), /print (?:glyph|raster) work exceeds/u);
      boundedErrors += 1;
    }
  }
  assert.equal(boundedErrors < 100, true);
  assert.throws(
    () => host.print(new Uint8Array(65_537), q16(0), q16(0)),
    /exceeds 65536 bytes/u,
  );
  const nestedRepeat = new Uint8Array(518);
  for (let index = 0; index < nestedRepeat.byteLength - 2; index += 2) {
    nestedRepeat[index] = 1;
    nestedRepeat[index + 1] = "1".charCodeAt(0);
  }
  nestedRepeat[nestedRepeat.byteLength - 2] = "a".charCodeAt(0);
  nestedRepeat[nestedRepeat.byteLength - 1] = 0;
  assert.throws(
    () => host.print(nestedRepeat, q16(0), q16(0)),
    /control nesting exceeds 256/u,
  );
  assert.equal(ram.byteLength, 0x10000);
});

test("Canvas presenter and Worker transport contain no text or glyph API", async () => {
  const presenter = await readFile(new URL(
    "../../apps/web-player/src/main/render/canvas2d-frame-presenter.ts",
    import.meta.url,
  ), "utf8");
  const workerProtocol = await readFile(new URL(
    "../../apps/web-player/src/transport/worker-protocol.ts",
    import.meta.url,
  ), "utf8");
  assert.doesNotMatch(presenter, /fillText|measureText|glyph|p8scii/iu);
  assert.doesNotMatch(workerProtocol, /glyph|font|p8scii|textState/iu);
});
