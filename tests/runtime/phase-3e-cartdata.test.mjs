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

function q16(value) {
  return Math.trunc(value * 65_536) | 0;
}

function sourceCart(source) {
  return {
    rom: new Uint8Array(0x8000),
    code: encoder.encode(source),
  };
}

function parsedCart(source, digestCharacter = "e") {
  const code = encoder.encode(source);
  return {
    identity: Object.freeze({ contentSha256: digestCharacter.repeat(64) }),
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
  const vm = createVm();
  const runtime = new FrameSliceRuntime(vm, options);
  return { vm, runtime, boot: () => runtime.boot(sourceCart(source)) };
}

function identityMemory() {
  const buffer = new ArrayBuffer(0x10000);
  const memory = {
    buffer,
    byteOffset: 0,
    byteLength: 0x10000,
    leaseId: "phase-3e-memory",
  };
  const logicalMemory = {
    memoryLeaseId: memory.leaseId,
    mapAddress(address) {
      return address & 0xffff;
    },
  };
  return { memory, logicalMemory, bytes: new Uint8Array(buffer) };
}

function assertFault(source, expected = "E_HOST_API") {
  const vm = createVm();
  const base = createPicoApiHost(vm.memory, vm.logicalMemory);
  let commitChecks = 0;
  const host = new Proxy(base, {
    get(target, property) {
      if (property === "takeCartDataCommit") {
        return () => {
          commitChecks += 1;
          return target.takeCartDataCommit();
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const runtime = new FrameSliceRuntime(vm, { picoApiHost: host });
  const result = runtime.boot(sourceCart(source));
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, expected);
  assert.equal(commitChecks, 0, "faulted transactions must not inspect or publish commits");
  assert.equal(runtime.state, "faulted");
  runtime.dispose();
}

test("operations 34..36 return boolean and raw Q16 values through real WASM", async () => {
  const contract = JSON.parse(await readFile(
    new URL("../../spec/abi/pico-host-api-v1.json", import.meta.url),
    "utf8",
  ));
  assert.deepEqual(contract.bindings.filter(({ id }) => id >= 34 && id <= 36), [
    {
      id: 34,
      guestName: "cartdata",
      hostMethod: "cartdata",
      parameters: [{ name: "idBytes", type: "byte-string" }],
      result: "boolean",
    },
    {
      id: 35,
      guestName: "dget",
      hostMethod: "dget",
      parameters: [{ name: "indexRaw", type: "q16.16-raw-i32" }],
      result: "q16.16-raw-i32",
    },
    {
      id: 36,
      guestName: "dset",
      hostMethod: "dset",
      parameters: [
        { name: "indexRaw", type: "q16.16-raw-i32" },
        { name: "valueRaw", type: "q16.16-raw-i32" },
      ],
      result: "void",
    },
  ]);

  const seed = Uint8Array.from({ length: 256 }, (_, index) => 255 - index);
  const source = `
function _init()
 poke(0x5000,cartdata("save_1") and 1 or 0)
 for i=0,63 do
  dset(i,i-31.5)
 end
 poke4(0x5efc,-2.25)
 poke4(0x5100,dget(63))
end
function _update() end
function _draw() end`;
  const { runtime, boot } = createRuntime(source, {
    cartDataSeeds: [{ id: "save_1", bytes: seed }],
  });
  seed.fill(0xee);
  const result = boot();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.kind, "ready");
  assert.equal(runtime.copyRam(0x5000, 1)[0], 1);
  assert.equal(new DataView(runtime.copyRam(0x5100, 4).buffer).getInt32(0, true), q16(-2.25));
  const commit = result.value.cartDataCommit;
  assert.ok(commit);
  assert.equal(commit.id, "save_1");
  assert.equal(commit.revision, 1);
  const view = new DataView(commit.bytes.buffer, commit.bytes.byteOffset, commit.bytes.byteLength);
  for (let index = 0; index < 63; index += 1) {
    assert.equal(view.getInt32(index * 4, true), q16(index - 31.5));
  }
  assert.equal(view.getInt32(63 * 4, true), q16(-2.25));
  runtime.dispose();

  const miss = createRuntime(`
function _init()
 poke(0x5000,cartdata("absent") and 1 or 0)
end
function _update() end
function _draw() end`);
  const missed = miss.boot();
  assert.equal(missed.ok, true, JSON.stringify(missed));
  assert.equal(miss.runtime.copyRam(0x5000, 1)[0], 0);
  assert.deepEqual(miss.runtime.copyRam(0x5e00, 256), new Uint8Array(256));
  assert.equal(missed.value.cartDataCommit, undefined);
  miss.runtime.dispose();
});

test("cartdata policy faults fail closed while invalid slots are safe no-ops", () => {
  for (const id of ["", "UPPER", "not.valid", "a".repeat(65)]) {
    assertFault(`cartdata(${JSON.stringify(id)})`);
  }
  assertFault(`cartdata("once") cartdata("twice")`);
  assertFault(`x=dget(0)`);
  assertFault(`dset(0,1)`);
  assertFault(`cartdata("fault") dset(0,1) missing_function()`, "E_VM_RUNTIME");

  const { runtime, boot } = createRuntime(`
function _init()
 cartdata("range")
 poke(0x5000,dget(-1),dget(64))
 dset(-1,1)
 dset(64,1)
end
function _update() end
function _draw() end`);
  const result = boot();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(runtime.copyRam(0x5000, 2), Uint8Array.of(0, 0));
  assert.equal(result.value.cartDataCommit, undefined);
  runtime.dispose();
});

test("cartdata accepts the current lower-case hyphen identifier alphabet", () => {
  const { runtime, boot } = createRuntime(`
function _init()
 cartdata("project-save_1")
 dset(0,7)
end
function _update() end
function _draw() end`);
  const result = boot();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.cartDataCommit?.id, "project-save_1");
  runtime.dispose();
});

test("browser-neutral seed and commit snapshots are isolated, revisioned and resettable", () => {
  const firstMemory = identityMemory();
  const seed = Uint8Array.from({ length: 256 }, (_, index) => index);
  const core = createPicoApiHost(firstMemory.memory, firstMemory.logicalMemory, {
    cartDataSeeds: [{ id: "shared_slot", bytes: seed }],
  });
  seed.fill(0xff);
  core.reset();
  assert.equal(core.cartdata(encoder.encode("shared_slot")), 1);
  assert.deepEqual(firstMemory.bytes.slice(0x5e00, 0x5f00), Uint8Array.from(
    { length: 256 },
    (_, index) => index,
  ));
  assert.equal(core.takeCartDataCommit(), undefined);

  firstMemory.bytes[0x5e00] = 0xa5;
  const first = core.takeCartDataCommit();
  assert.ok(first);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(first.revision, 1);
  first.bytes[0] = 0;
  assert.equal(
    core.takeCartDataCommit(),
    undefined,
    "caller mutation cannot dirty the internal baseline",
  );

  core.dset(q16(1), q16(-7.25));
  assert.equal(core.dget(q16(1)), q16(-7.25));
  const second = core.takeCartDataCommit();
  assert.ok(second);
  assert.equal(second.revision, 2);
  assert.equal(new DataView(second.bytes.buffer).getInt32(4, true), q16(-7.25));

  core.reset();
  assert.throws(() => core.dget(0), /select a slot/u);
  assert.equal(core.cartdata(encoder.encode("shared_slot")), 1);
  assert.equal(firstMemory.bytes[0x5e00], 0);
  assert.equal(core.takeCartDataCommit(), undefined);

  const secondMemory = identityMemory();
  const isolated = createPicoApiHost(secondMemory.memory, secondMemory.logicalMemory, {
    cartDataSeeds: [{ id: "shared_slot", bytes: new Uint8Array(256).fill(0x44) }],
  });
  isolated.reset();
  isolated.cartdata(encoder.encode("shared_slot"));
  assert.equal(secondMemory.bytes[0x5e00], 0x44);
  assert.equal(firstMemory.bytes[0x5e00], 0);

  const validationMemory = identityMemory();
  assert.throws(
    () => createPicoApiHost(validationMemory.memory, validationMemory.logicalMemory, {
      cartDataSeeds: [{ id: "Bad", bytes: new Uint8Array(256) }],
    }),
    /seed id/u,
  );
  assert.throws(
    () => createPicoApiHost(validationMemory.memory, validationMemory.logicalMemory, {
      cartDataSeeds: [
        { id: "duplicate", bytes: new Uint8Array(256) },
        { id: "duplicate", bytes: new Uint8Array(256) },
      ],
    }),
    /duplicate/u,
  );
});

test("boot and frame dirty checks suppress no-change and observe direct RAM writes", () => {
  const source = `
n=0
function _init()
 cartdata("frame_slot")
end
function _update()
 n+=1
 if n==1 then poke(0x5e00,0x91) end
 if n==3 then dset(1,1.5) end
end
function _draw() end`;
  const { runtime, boot } = createRuntime(source, {
    cartDataSeeds: [{ id: "frame_slot", bytes: new Uint8Array(256) }],
  });
  const ready = boot();
  assert.equal(ready.ok, true, JSON.stringify(ready));
  assert.equal(ready.value.cartDataCommit, undefined);

  const first = runtime.step();
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.value.frame.cartDataCommit.revision, 1);
  assert.equal(first.value.frame.cartDataCommit.bytes[0], 0x91);

  const second = runtime.step();
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.value.frame.cartDataCommit, undefined);

  const third = runtime.step();
  assert.equal(third.ok, true, JSON.stringify(third));
  assert.equal(third.value.frame.cartDataCommit.revision, 2);
  assert.equal(
    new DataView(third.value.frame.cartDataCommit.bytes.buffer).getInt32(4, true),
    q16(1.5),
  );
  runtime.dispose();
});

test("CartSession reset rehydrates a fresh generation and sessions never share mirrors", () => {
  const source = `
function _init()
 cartdata("reset_slot")
 dset(0,dget(0)+1)
end
function _update() end
function _draw() end`;
  function createSession(seedRaw) {
    const seed = new Uint8Array(256);
    new DataView(seed.buffer).setInt32(0, seedRaw, true);
    return new CartSession({
      createRuntime() {
        const vm = createVm();
        return new FrameSliceRuntime(vm, {
          cartDataSeeds: [{ id: "reset_slot", bytes: seed }],
        });
      },
    });
  }

  const firstSession = createSession(q16(10));
  const first = firstSession.load(parsedCart(source));
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.value.generation, 1);
  assert.equal(first.value.cartDataCommit.revision, 1);
  assert.equal(new DataView(first.value.cartDataCommit.bytes.buffer).getInt32(0, true), q16(11));
  first.value.cartDataCommit.bytes[0] = 0;
  assert.equal(
    new DataView(firstSession.copyRam(0x5e00, 4).value.buffer).getInt32(0, true),
    q16(11),
  );

  const reset = firstSession.reset();
  assert.equal(reset.ok, true, JSON.stringify(reset));
  assert.equal(reset.value.generation, 2);
  assert.equal(reset.value.cartDataCommit.revision, 1);
  assert.equal(new DataView(reset.value.cartDataCommit.bytes.buffer).getInt32(0, true), q16(11));

  const secondSession = createSession(q16(-4));
  const isolated = secondSession.load(parsedCart(source, "f"));
  assert.equal(isolated.ok, true, JSON.stringify(isolated));
  assert.equal(
    new DataView(isolated.value.cartDataCommit.bytes.buffer).getInt32(0, true),
    q16(-3),
  );
  assert.equal(
    new DataView(firstSession.copyRam(0x5e00, 4).value.buffer).getInt32(0, true),
    q16(11),
  );
  assert.equal(firstSession.dispose().ok, true);
  assert.equal(secondSession.dispose().ok, true);
});

test("Phase 3E deterministic cartdata trace matches the project golden", async () => {
  const { runtime, boot } = createRuntime(`
n=0
function _init()
 cartdata("golden_slot")
 dset(0,-1.5)
end
function _update()
 n+=1
 if n==1 then
  poke(0x5e04,0x34)
  poke(0x5e05,0x12)
 end
end
function _draw() end`, {
    cartDataSeeds: [{ id: "golden_slot", bytes: new Uint8Array(256) }],
  });
  const ready = boot();
  assert.equal(ready.ok, true, JSON.stringify(ready));
  const first = runtime.step();
  const second = runtime.step();
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(second.ok, true, JSON.stringify(second));
  const describe = (commit) => commit === undefined ? null : {
    id: commit.id,
    revision: commit.revision,
    firstEightHex: Buffer.from(commit.bytes.slice(0, 8)).toString("hex"),
  };
  const trace = {
    boot: describe(ready.value.cartDataCommit),
    frames: [
      describe(first.value.frame.cartDataCommit),
      describe(second.value.frame.cartDataCommit),
    ],
  };
  const golden = JSON.parse(await readFile(
    new URL("../golden/phase-3e-cartdata.json", import.meta.url),
    "utf8",
  ));
  assert.deepEqual(trace, golden);
  runtime.dispose();
});
