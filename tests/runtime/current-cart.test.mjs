import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { before } from "node:test";

import {
  CartSession,
  FrameSliceRuntime,
} from "@pico8-web/runtime-core";
import {
  createPicoApiHostRouter,
  Z8LuaFrameVm,
} from "@pico8-web/z8lua-bridge";
import {
  CartRepositoryAdapter,
  CURRENT_CART_REPOSITORY_MAX_CARTS,
} from "../../apps/web-player/dist/runtime/adapters/cart-repository-adapter.js";
import createZ8LuaModule from "../../wasm/dist/z8lua-runtime-v1.mjs";

const encoder = new TextEncoder();
let module;

before(async () => {
  module = await createZ8LuaModule();
});

function identity(character) {
  return Object.freeze({ contentSha256: character.repeat(64) });
}

function cart(source, character = "a", rom = new Uint8Array(0x8000)) {
  const code = encoder.encode(source);
  return {
    identity: identity(character),
    format: "p8",
    version: 42,
    rom,
    code,
    warnings: Object.freeze([]),
    sourceBytes: code.byteLength,
  };
}

function runtimeFor(parsed, repository = new CartRepositoryAdapter()) {
  repository.registerCart(parsed);
  const vm = new Z8LuaFrameVm(module, createPicoApiHostRouter(module));
  const runtime = new FrameSliceRuntime(vm, {
    currentCart: { identity: parsed.identity, repository },
  });
  return { repository, runtime, boot: () => runtime.boot(parsed) };
}

function assertFault(parsed, expectedCode, repository = new CartRepositoryAdapter()) {
  const fixture = runtimeFor(parsed, repository);
  const result = fixture.boot();
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, expectedCode);
  assert.equal(fixture.runtime.state, "faulted");
  fixture.runtime.dispose();
  return fixture.repository;
}

test("operations 37..38 are append-only optional void bindings", async () => {
  const contract = JSON.parse(await readFile(
    new URL("../../spec/abi/pico-host-api-v1.json", import.meta.url),
    "utf8",
  ));
  assert.deepEqual(contract.bindings.slice(36, 38), [
    {
      id: 37,
      guestName: "reload",
      hostMethod: "reload",
      parameters: [
        { name: "destinationRaw", type: "q16.16-raw-i32", optional: true },
        { name: "sourceRaw", type: "q16.16-raw-i32", optional: true },
        { name: "lengthRaw", type: "q16.16-raw-i32", optional: true },
        { name: "reference", type: "byte-string", optional: true },
      ],
      result: "void",
    },
    {
      id: 38,
      guestName: "cstore",
      hostMethod: "cstore",
      parameters: [
        { name: "destinationRaw", type: "q16.16-raw-i32", optional: true },
        { name: "sourceRaw", type: "q16.16-raw-i32", optional: true },
        { name: "lengthRaw", type: "q16.16-raw-i32", optional: true },
        { name: "reference", type: "byte-string", optional: true },
      ],
      result: "void",
    },
  ]);
});

test("real WASM observes default, explicit, Q16 and same-stack reload/cstore", () => {
  const rom = Uint8Array.from({ length: 0x8000 }, (_, index) => (index * 29 + 7) & 0xff);
  const parsed = cart(`
function _init()
 poke(0x100,0xa1) poke(0x101,0xb2) poke(0x102,0xc3)
 cstore(0x200.75,0x100.75,3.75)
 poke(0x300,0) poke(0x301,0) poke(0x302,0)
 reload(0x300.9,0x200.9,3.9)
 poke(0xffff,0x5a)
 cstore(0x210,0xffff,1)
 poke(0xffff,0)
 reload(0xffff,0x210,1)
 poke(0x5000,peek(0x300)) poke(0x5001,peek(0x301)) poke(0x5002,peek(0x302))
 poke(0x5003,peek(0xffff))
 cstore(0x4300,0x4300,0)
 reload(0x100,0x4300,0)
end
function _update() end
function _draw() end`, "a", rom);
  const { runtime, repository, boot } = runtimeFor(parsed);
  const result = boot();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(runtime.copyRam(0x5000, 4), Uint8Array.of(0xa1, 0xb2, 0xc3, 0x5a));
  assert.deepEqual(repository.readData(parsed.identity, 0x200, 3), Uint8Array.of(0xa1, 0xb2, 0xc3));
  assert.equal(repository.readData(parsed.identity, 0x210, 1)[0], 0x5a);
  assert.equal(repository.readData(parsed.identity, 0, 1)[0], rom[0]);
  runtime.dispose();
});

test("default cstore/reload copies the complete protected data-ROM range", () => {
  const parsed = cart(`
function _init()
 poke(0,0xee) poke(0x42ff,0xdd)
 cstore()
 poke(0,0) poke(0x42ff,0)
 reload()
 poke(0x5000,peek(0)) poke(0x5001,peek(0x42ff))
end
function _update() end
function _draw() end`, "9");
  const { runtime, repository, boot } = runtimeFor(parsed);
  const result = boot();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(runtime.copyRam(0x5000, 2), Uint8Array.of(0xee, 0xdd));
  assert.equal(repository.readData(parsed.identity, 0, 1)[0], 0xee);
  assert.equal(repository.readData(parsed.identity, 0x42ff, 1)[0], 0xdd);
  runtime.dispose();
});

test("invalid current-cart calls fail before repository mutation", () => {
  const rom = new Uint8Array(0x8000);
  rom[0] = 0x19;
  rom[0x42ff] = 0x2a;

  for (const source of [
    `poke(0,0x71) cstore(0x4300,0,1)`,
    `poke(0,0x72) cstore(-1,0,1)`,
    `poke(0xffff,0x73) cstore(0,0xffff,2)`,
    `poke(0,0x74) reload(0,0x42ff,2)`,
    `poke(0xffff,0x75) reload(0xffff,0,2)`,
    `poke(0,0x76) reload(0,0,-1)`,
  ]) {
    const parsed = cart(`${source}\nfunction _update() end function _draw() end`, "b", rom);
    const repository = assertFault(parsed, "E_HOST_API");
    assert.equal(repository.readData(parsed.identity, 0, 1)[0], 0x19);
    assert.equal(repository.readData(parsed.identity, 0x42ff, 1)[0], 0x2a);
  }

});

test("external-reference calls leave the current repository untouched while transferring", () => {
  const rom = new Uint8Array(0x8000);
  rom[0] = 0x19;
  const parsed = cart(
    `poke(0,0x81) cstore(0,0,1,"other.p8")\n` +
      `function _update() end function _draw() end`,
    "c",
    rom,
  );
  const { runtime, repository, boot } = runtimeFor(parsed);
  const result = boot();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.kind, "host-request");
  assert.equal(repository.readData(parsed.identity, 0, 1)[0], 0x19);
  runtime.dispose();
});

test("Worker repository owns copies, isolates identities and enforces lifetime bounds", () => {
  const repository = new CartRepositoryAdapter();
  const firstRom = new Uint8Array(0x8000);
  firstRom[12] = 0x31;
  const first = cart("", "d", firstRom);
  const secondRom = new Uint8Array(0x8000);
  secondRom[12] = 0x42;
  const second = cart("", "e", secondRom);
  repository.registerCart(first);
  repository.registerCart(second);

  firstRom[12] = 0xff;
  const returned = repository.readData(first.identity, 12, 1);
  assert.equal(returned[0], 0x31);
  returned[0] = 0;
  assert.equal(repository.readData(first.identity, 12, 1)[0], 0x31);

  const input = Uint8Array.of(0x91, 0x92);
  repository.writeDataOverlay(first.identity, 12, input);
  input.fill(0);
  assert.deepEqual(repository.readData(first.identity, 12, 2), Uint8Array.of(0x91, 0x92));
  assert.equal(repository.readData(second.identity, 12, 1)[0], 0x42);

  for (let index = 2; index < CURRENT_CART_REPOSITORY_MAX_CARTS; index += 1) {
    repository.registerCart({
      identity: { contentSha256: index.toString(16).padStart(64, "0") },
      rom: new Uint8Array(0x8000),
    });
  }
  assert.throws(() => repository.registerCart({
    identity: { contentSha256: "f".repeat(64) },
    rom: new Uint8Array(0x8000),
  }), /64-cart/u);
  repository.dispose();
  assert.throws(() => repository.readData(first.identity, 0, 1), /disposed/u);
});

test("CartSession reset and repeated identity preserve overlay while another identity is isolated", () => {
  const repository = new CartRepositoryAdapter();
  const source = `
function _init()
 reload(0x100,0x100,1)
 poke(0x100,peek(0x100)+1)
 cstore(0x100,0x100,1)
end
function _update() end
function _draw() end`;
  const firstRom = new Uint8Array(0x8000);
  firstRom[0x100] = 5;
  const first = cart(source, "7", firstRom);
  const secondRom = new Uint8Array(0x8000);
  secondRom[0x100] = 100;
  const second = cart(source, "8", secondRom);
  repository.registerCart(first);
  repository.registerCart(second);

  const session = new CartSession({
    createRuntime(context) {
      const vm = new Z8LuaFrameVm(module, createPicoApiHostRouter(module));
      return new FrameSliceRuntime(vm, {
        currentCart: { identity: context.cart.identity, repository },
      });
    },
  });
  const loaded = session.load(first);
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  assert.equal(session.copyRam(0x100, 1).value[0], 6);
  const reset = session.reset();
  assert.equal(reset.ok, true, JSON.stringify(reset));
  assert.equal(session.copyRam(0x100, 1).value[0], 7);
  const repeated = session.load(first);
  assert.equal(repeated.ok, true, JSON.stringify(repeated));
  assert.equal(session.copyRam(0x100, 1).value[0], 8);
  const isolated = session.load(second);
  assert.equal(isolated.ok, true, JSON.stringify(isolated));
  assert.equal(session.copyRam(0x100, 1).value[0], 101);
  assert.equal(repository.readData(first.identity, 0x100, 1)[0], 8);
  assert.equal(session.dispose().ok, true);
  repository.dispose();
});
