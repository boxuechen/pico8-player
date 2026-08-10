import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { before } from "node:test";

import { decodeCart } from "@pico8-web/cart-codec";
import { FrameSliceRuntime } from "@pico8-web/runtime-core";
import {
  createPicoApiHostRouter,
  Z8LuaFrameVm,
} from "@pico8-web/z8lua-bridge";
import {
  createPlayerWorkerController,
} from "../../apps/web-player/dist/worker/compose-runtime.js";
import createZ8LuaModule from "../../wasm/dist/z8lua-runtime-v1.mjs";

const encoder = new TextEncoder();
const fixtureRoot = new URL("../fixtures/phase-9/", import.meta.url);
const DATA_ACCESS = Object.freeze({
  load: false,
  reloadData: true,
  cstoreData: true,
  include: false,
});
let module;

before(async () => {
  module = await createZ8LuaModule();
});

async function fixture(name) {
  return new Uint8Array(await readFile(new URL(`${name}.p8`, fixtureRoot)));
}

function cart(lua = "function _update() end function _draw() end") {
  return encoder.encode(`pico-8 cartridge // http://www.pico-8.com
version 43
__lua__
${lua}
`);
}

function command(type, requestId, fields = {}) {
  return {
    v: 1,
    type,
    requestId,
    workerGeneration: 1,
    sessionGeneration: 1,
    ...fields,
  };
}

function loadCommand(source, bundle = []) {
  const root = source.slice();
  return command("loadCart", 1, {
    cartBytes: root.buffer,
    localCartBundle: bundle.map((entry) => {
      const bytes = entry.bytes.slice();
      return { ref: entry.ref, cartBytes: bytes.buffer, access: entry.access };
    }),
  });
}

async function settle() {
  for (let turn = 0; turn < 8; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

test("an accepted local data target completes cstore then reload without host authority", async () => {
  const background = [];
  const controller = createPlayerWorkerController(module);
  controller.setEventSink((events) => background.push(...events));
  const loading = controller.handle(loadCommand(
    await fixture("host-external-cartdata-request"),
    [{ ref: "phase9-data.p8", bytes: cart(), access: DATA_ACCESS }],
  ));
  assert.equal(loading.at(-1)?.state, "waiting-host");
  await settle();
  assert.equal(background.some((event) => event.type === "fault"), false);
  assert.equal(background.at(-1)?.state, "ready");

  controller.handle(command("start", 2));
  controller.handle(command("vsync", 3, { sequence: 1, timestampMs: 0 }));
  const frameEvents = controller.handle(command("vsync", 4, {
    sequence: 2,
    timestampMs: 34,
  }));
  const frame = frameEvents.find((event) => event.type === "frame");
  assert.ok(frame);
  assert.equal(new Uint8Array(frame.packedScreen)[0] & 0x0f, 1);
  controller.dispose();
});

test("missing and unauthorized local data targets still fail closed", async () => {
  for (const bundle of [
    [],
    [{
      ref: "phase9-data.p8",
      bytes: cart(),
      access: { ...DATA_ACCESS, cstoreData: false },
    }],
  ]) {
    const background = [];
    const controller = createPlayerWorkerController(module);
    controller.setEventSink((events) => background.push(...events));
    controller.handle(loadCommand(await fixture("host-external-cartdata-request"), bundle));
    await settle();
    assert.equal(background.find((event) => event.type === "fault")?.error.code,
      "E_HOST_REQUEST");
    controller.dispose();
  }
});

test("load with an empty launch parameter is a synchronous no-op", async () => {
  const vm = new Z8LuaFrameVm(module, createPicoApiHostRouter(module));
  const runtime = new FrameSliceRuntime(vm);
  const boot = runtime.boot(decodeCart(await fixture("host-empty-load-noop")));
  assert.equal(boot.ok, true, JSON.stringify(boot));
  assert.equal(boot.value.kind, "ready");
  assert.equal(runtime.copyRam(0x5000, 1)[0], 1);
  runtime.dispose();
});
