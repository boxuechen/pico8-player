import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { before } from "node:test";

import { decodeCart } from "@pico8-web/cart-codec";
import {
  decodeGuestCartLoadRequest,
  FrameSliceRuntime,
} from "@pico8-web/runtime-core";
import {
  createPicoApiHostRouter,
  Z8LuaFrameVm,
} from "@pico8-web/z8lua-bridge";
import {
  createPlayerWorkerController,
} from "../../apps/web-player/dist/worker/compose-runtime.js";
import createZ8LuaModule from "../../wasm/dist/z8lua-runtime-v1.mjs";

const encoder = new TextEncoder();
let module;

const LOAD_ONLY = Object.freeze({
  load: true,
  reloadData: false,
  cstoreData: false,
  include: false,
});

before(async () => {
  module = await createZ8LuaModule();
});

function cart(lua) {
  return encoder.encode(`pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
${lua}
`);
}

async function fixture(name) {
  return new Uint8Array(await readFile(
    new URL(`../fixtures/multicart/${name}`, import.meta.url),
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

function targetCart() {
  return cart(`
function _init()
 if stat(6)=="from-launcher" then poke(0x5000,1) end
end
function _update() end
function _draw()
 cls(0)
 pset(0,0,peek(0x5000))
end`);
}

async function turns(count = 3) {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

test("z8lua load emits the bounded versioned payload and the old continuation fails closed", async () => {
  const root = cart(`function _init()
 load("chapter-b.p8","crumb","param")
 poke(0x5000,0xff)
end`);
  const vm = new Z8LuaFrameVm(module, createPicoApiHostRouter(module));
  const runtime = new FrameSliceRuntime(vm);
  const boot = runtime.boot(decodeCart(root));
  assert.equal(boot.ok, true);
  assert.equal(boot.value.kind, "host-request");
  const decoded = decodeGuestCartLoadRequest(boot.value.request.bytes);
  assert.equal(decoded.ref, "chapter-b.p8");
  assert.equal(new TextDecoder().decode(decoded.breadcrumb), "crumb");
  assert.equal(new TextDecoder().decode(decoded.parameter), "param");
  const resumed = runtime.completeHostRequest(
    boot.value.request.id,
    new Uint8Array(),
    false,
  );
  assert.equal(resumed.ok, false);
  assert.equal(resumed.error.code, "E_VM_RUNTIME");
  assert.match(resumed.error.message, /replaced load execution resumed/u);
  assert.throws(() => decodeGuestCartLoadRequest(encoder.encode("plain")), /truncated|magic/u);
  runtime.dispose();
});

test("callback guest load stages a fresh session and atomically commits parameter and breadcrumb", async () => {
  const background = [];
  const controller = createPlayerWorkerController(module);
  controller.setEventSink((events) => background.push(...events));
  const launcher = await fixture("load-launcher.p8");
  const loading = controller.handle(loadCommand(launcher, 1, 1, [{
    ref: "chapter-b.p8",
    bytes: targetCart(),
    access: LOAD_ONLY,
  }]));
  assert.equal(loading.at(-1)?.state, "waiting-host");
  await turns();

  const handshake = background.find((event) => event.type === "session-replaced");
  assert.deepEqual(
    {
      previous: handshake?.previousSessionGeneration,
      next: handshake?.nextSessionGeneration,
      ref: handshake?.cartRef,
      breadcrumb: new TextDecoder().decode(handshake?.breadcrumb),
      depth: handshake?.breadcrumbDepth,
    },
    {
      previous: 1,
      next: 2,
      ref: "chapter-b.p8",
      breadcrumb: "back to launcher",
      depth: 1,
    },
  );
  assert.equal(background[0]?.type, "session-replaced");
  assert.equal(background.at(-1)?.state, "ready");
  assert.equal(background.at(-1)?.sessionGeneration, 2);

  assert.equal(controller.handle(command("start", 2, 2)).at(-1)?.state, "running");
  controller.handle(command("vsync", 2, 3, { sequence: 1, timestampMs: 0 }));
  const frameEvents = controller.handle(command("vsync", 2, 4, {
    sequence: 2,
    timestampMs: 34,
  }));
  const frame = frameEvents.find((event) => event.type === "frame");
  assert.equal(new Uint8Array(frame.packedScreen)[0] & 0x0f, 1,
    "stat(6) must reach the fresh target VM");
  assert.equal(frameEvents.every((event) => event.sessionGeneration === 2), true);
  controller.dispose();
});

test("custom-loop load auto-resumes the staged target in the exact next session", async () => {
  const background = [];
  const controller = createPlayerWorkerController(module);
  controller.setEventSink((events) => background.push(...events));
  const launcher = await fixture("custom-load-launcher.p8");
  const loaded = controller.handle(loadCommand(launcher, 1, 1, [{
    ref: "chapter-b.p8",
    bytes: targetCart(),
    access: LOAD_ONLY,
  }]));
  assert.equal(loaded.at(-1)?.mode, "custom");
  controller.handle(command("start", 1, 2));
  controller.handle(command("vsync", 1, 3, { sequence: 1, timestampMs: 0 }));
  const waiting = controller.handle(command("vsync", 1, 4, {
    sequence: 2,
    timestampMs: 34,
  }));
  assert.equal(waiting.at(-1)?.state, "waiting-host");
  await turns();
  assert.equal(background[0]?.type, "session-replaced");
  assert.equal(background[0]?.nextSessionGeneration, 2);
  assert.equal(background.at(-1)?.state, "running");
  assert.equal(background.at(-1)?.sessionGeneration, 2);
  controller.dispose();
});

test("missing, denied, nested and cancelled loads never publish a mixed-generation commit", async () => {
  for (const scenario of ["missing", "denied"]) {
    const background = [];
    const controller = createPlayerWorkerController(module);
    controller.setEventSink((events) => background.push(...events));
    const launcher = scenario === "missing"
      ? await fixture("resolver-failure.p8")
      : await fixture("load-launcher.p8");
    controller.handle(loadCommand(launcher, 1, 1, scenario === "denied" ? [{
      ref: "chapter-b.p8",
      bytes: targetCart(),
      access: { ...LOAD_ONLY, load: false },
    }] : []));
    await turns();
    const fault = background.find((event) => event.type === "fault");
    assert.equal(fault?.error.code, "E_HOST_REQUEST");
    assert.equal(background.some((event) => event.type === "session-replaced"), false);
    controller.dispose();
  }

  const nestedController = createPlayerWorkerController(module);
  nestedController.setEventSink(() => undefined);
  const nested = nestedController.handle(loadCommand(
    await fixture("nested-load-policy.p8"),
    1,
    1,
    [{ ref: "chapter-b.p8", bytes: targetCart(), access: LOAD_ONLY }],
  ));
  assert.equal(nested.find((event) => event.type === "fault")?.error.code,
    "E_FEATURE_UNSUPPORTED");
  nestedController.dispose();

  const background = [];
  const cancellationController = createPlayerWorkerController(module);
  cancellationController.setEventSink((events) => background.push(...events));
  cancellationController.handle(loadCommand(
    await fixture("load-launcher.p8"),
    1,
    1,
    [{ ref: "chapter-b.p8", bytes: targetCart(), access: LOAD_ONLY }],
  ));
  const replacement = cancellationController.handle(loadCommand(
    cart("function _update() end function _draw() cls(3) end"),
    2,
    2,
  ));
  assert.equal(replacement.at(-1)?.state, "ready");
  await turns();
  assert.equal(background.some((event) => event.type === "session-replaced"), false);
  assert.equal(background.some((event) => event.sessionGeneration === 1), false);
  cancellationController.dispose();
});
