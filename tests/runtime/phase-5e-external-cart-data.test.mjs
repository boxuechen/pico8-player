import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { before } from "node:test";

import { decodeCart } from "@pico8-web/cart-codec";
import {
  decodeExternalCartDataRequest,
  FrameSliceRuntime,
} from "@pico8-web/runtime-core";
import {
  createPicoApiHostRouter,
  Z8LuaFrameVm,
} from "@pico8-web/z8lua-bridge";
import { CartRepositoryAdapter } from
  "../../apps/web-player/dist/worker/adapters/cart-repository-adapter.js";
import { createPlayerWorkerController } from
  "../../apps/web-player/dist/worker/compose-runtime.js";
import createZ8LuaModule from "../../wasm/dist/z8lua-runtime-v1.mjs";

const encoder = new TextEncoder();
let module;

const DATA_ACCESS = Object.freeze({
  load: false,
  reloadData: true,
  cstoreData: true,
  include: false,
});

before(async () => {
  module = await createZ8LuaModule();
});

function cart(lua, gfx = "") {
  return encoder.encode(`pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
${lua}
${gfx === "" ? "" : `__gfx__\n${gfx}\n`}`);
}

async function fixture(name) {
  return new Uint8Array(await readFile(
    new URL(`../conformance/carts/phase-5/${name}`, import.meta.url),
  ));
}

function command(type, sessionGeneration, requestId, fields = {}) {
  return {
    v: 1,
    type,
    requestId,
    workerGeneration: 1,
    sessionGeneration,
    ...fields,
  };
}

function loadCommand(source, sessionGeneration, requestId, bundle = []) {
  const root = source.slice();
  return command("loadCart", sessionGeneration, requestId, {
    cartBytes: root.buffer,
    localCartBundle: bundle.map((entry) => {
      const bytes = entry.bytes.slice();
      return { ref: entry.ref, cartBytes: bytes.buffer, access: entry.access };
    }),
  });
}

async function turns(count = 8) {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function pixel(screen, x, y) {
  const byte = screen[y * 64 + (x >> 1)];
  return (x & 1) === 0 ? byte & 0x0f : byte >> 4;
}

async function runCorpusCart(entryName, expectedColor, expectedY) {
  const events = [];
  const controller = createPlayerWorkerController(module);
  controller.setEventSink((batch) => events.push(...batch));
  const initial = controller.handle(loadCommand(
    await fixture(entryName),
    1,
    1,
    [{ ref: "data-cart.p8", bytes: await fixture("data-cart.p8"), access: DATA_ACCESS }],
  ));
  assert.equal(initial.at(-1)?.state, "waiting-host");
  const waiting = controller.handle(command("vsync", 1, 2, {
    sequence: 1,
    timestampMs: 34,
  }));
  assert.equal(waiting.at(-1)?.type, "heartbeat");
  assert.equal(waiting.at(-1)?.tickCount, 0);
  assert.equal(events.some((event) => event.type === "frame"), false);
  await turns();
  assert.equal(events.at(-1)?.state, "ready");
  assert.equal(events.at(-1)?.sessionGeneration, 1);
  assert.equal(events.some((event) => event.type === "session-replaced"), false);

  controller.handle(command("start", 1, 3));
  controller.handle(command("vsync", 1, 4, { sequence: 2, timestampMs: 0 }));
  const stepped = controller.handle(command("vsync", 1, 5, {
    sequence: 3,
    timestampMs: 34,
  }));
  const frame = stepped.find((event) => event.type === "frame");
  assert.ok(frame);
  const screen = new Uint8Array(frame.packedScreen);
  for (let index = 0; index < 16; index += 1) {
    assert.equal(pixel(screen, index, expectedY(index)), expectedColor);
  }
  controller.dispose();
  return frame;
}

test("z8lua emits a strict versioned external request while no-ref reload/cstore stay synchronous", async () => {
  const source = decodeCart(cart(`
function _init()
 reload(0x4300,0,16,"data-cart.p8")
 memcpy(0x5000,0x4300,16)
end
function _update() end
function _draw() end`));
  const external = new FrameSliceRuntime(
    new Z8LuaFrameVm(module, createPicoApiHostRouter(module)),
  );
  const boot = external.boot(source);
  assert.equal(boot.ok, true);
  assert.equal(boot.value.kind, "host-request");
  const decoded = decodeExternalCartDataRequest(boot.value.request.bytes);
  assert.deepEqual(decoded, {
    operation: "reload",
    ref: "data-cart.p8",
    destinationRaw: 0x4300_0000,
    sourceRaw: 0,
    lengthRaw: 0x0010_0000,
  });
  external.writeSuspendedLogicalRam(
    0x4300,
    Uint8Array.from({ length: 16 }, (_, index) => index),
  );
  const completed = external.completeHostRequest(
    boot.value.request.id,
    new Uint8Array(),
    false,
  );
  assert.equal(completed.ok, true);
  assert.equal(completed.value.kind, "ready");
  assert.deepEqual([...external.copyRam(0x5000, 16)], [...Array(16).keys()]);
  const malformed = boot.value.request.bytes.slice();
  malformed[7] = 1;
  assert.throws(() => decodeExternalCartDataRequest(malformed), /canonical/u);
  external.dispose();

  const currentSource = decodeCart(cart(`
function _init()
 reload(0x5000,0,16)
 poke(0x5000,0xaa)
 cstore(0,0x5000,16)
 memset(0x5000,0,16)
 reload(0x5000,0,16)
end
function _update() end
function _draw() end`, `0123456789abcdef${"0".repeat(112)}`));
  const repository = new CartRepositoryAdapter();
  repository.registerCart(currentSource);
  const current = new FrameSliceRuntime(
    new Z8LuaFrameVm(module, createPicoApiHostRouter(module)),
    { currentCart: { identity: currentSource.identity, repository } },
  );
  const currentBoot = current.boot(currentSource);
  assert.equal(currentBoot.ok, true);
  assert.equal(currentBoot.value.kind, "ready");
  assert.deepEqual(
    [...current.copyRam(0x5000, 16)],
    [0xaa, 50, 84, 118, 152, 186, 220, 254, 0, 0, 0, 0, 0, 0, 0, 0],
  );
  current.dispose();
  repository.dispose();
});

test("production Worker runs the external reload and cstore-overlay corpus without generation change", async () => {
  const reloadFrame = await runCorpusCart(
    "external-reload.p8",
    7,
    (index) => [16, 50, 84, 118, 24, 58, 92, 126, 0, 0, 0, 0, 0, 0, 0, 0][index],
  );
  assert.equal(reloadFrame.completedSlices, "2");
  const cstoreFrame = await runCorpusCart(
    "external-cstore.p8",
    10,
    (index) => index,
  );
  assert.equal(cstoreFrame.completedSlices, "2");
});

test("capability, range, nested and cancellation failures close without stale continuation", async () => {
  const data = await fixture("data-cart.p8");

  const deniedEvents = [];
  const denied = createPlayerWorkerController(module);
  denied.setEventSink((events) => deniedEvents.push(...events));
  denied.handle(loadCommand(await fixture("external-cstore.p8"), 1, 1, [{
    ref: "data-cart.p8",
    bytes: data,
    access: { ...DATA_ACCESS, cstoreData: false },
  }]));
  await turns();
  assert.equal(deniedEvents.find((event) => event.type === "fault")?.error.code,
    "E_HOST_REQUEST");
  const replacement = denied.handle(loadCommand(
    await fixture("external-reload.p8"),
    2,
    2,
    [{ ref: "data-cart.p8", bytes: data, access: DATA_ACCESS }],
  ));
  assert.equal(replacement.at(-1)?.state, "waiting-host");
  await turns();
  assert.equal(deniedEvents.at(-1)?.state, "ready",
    "denied cstore must not leave a partial target overlay");
  denied.handle(command("start", 2, 3));
  denied.handle(command("vsync", 2, 4, { sequence: 1, timestampMs: 0 }));
  const originalFrame = denied.handle(command("vsync", 2, 5, {
    sequence: 2,
    timestampMs: 34,
  })).find((event) => event.type === "frame");
  assert.ok(originalFrame);
  const originalScreen = new Uint8Array(originalFrame.packedScreen);
  const originalRows = [16, 50, 84, 118, 24, 58, 92, 126, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let index = 0; index < 16; index += 1) {
    assert.equal(pixel(originalScreen, index, originalRows[index]), 7);
  }
  denied.dispose();

  const rangeController = createPlayerWorkerController(module);
  rangeController.setEventSink(() => undefined);
  const ranged = rangeController.handle(loadCommand(cart(`
function _init() reload(0xffff,0,2,"data-cart.p8") end
function _update() end function _draw() end`), 1, 1, [{
    ref: "data-cart.p8", bytes: data, access: DATA_ACCESS,
  }]));
  assert.equal(ranged.find((event) => event.type === "fault")?.error.code,
    "E_HOST_REQUEST");
  rangeController.dispose();

  const nestedController = createPlayerWorkerController(module);
  nestedController.setEventSink(() => undefined);
  const nested = nestedController.handle(loadCommand(cart(`
local co=cocreate(function() reload(0,0,1,"data-cart.p8") end)
coresume(co)
function _update() end function _draw() end`), 1, 1, [{
    ref: "data-cart.p8", bytes: data, access: DATA_ACCESS,
  }]));
  assert.equal(nested.find((event) => event.type === "fault")?.error.code,
    "E_FEATURE_UNSUPPORTED");
  nestedController.dispose();

  const lateEvents = [];
  const cancelled = createPlayerWorkerController(module);
  cancelled.setEventSink((events) => lateEvents.push(...events));
  cancelled.handle(loadCommand(await fixture("external-reload.p8"), 1, 1, [{
    ref: "data-cart.p8", bytes: data, access: DATA_ACCESS,
  }]));
  const fresh = cancelled.handle(loadCommand(cart(`
function _update() end function _draw() cls(2) end`), 2, 2));
  assert.equal(fresh.at(-1)?.state, "ready");
  await turns();
  assert.equal(lateEvents.some((event) => event.sessionGeneration === 1), false);
  assert.equal(lateEvents.some((event) => event.type === "session-replaced"), false);
  cancelled.dispose();
});
