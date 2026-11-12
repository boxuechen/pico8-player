import assert from "node:assert/strict";
import test, { before } from "node:test";

import createZ8LuaModule from "../../wasm/dist/z8lua-runtime-v1.mjs";
import { createPlayerWorkerController } from "../../apps/web-player/dist/worker/compose-runtime.js";
import {
  isPlayerHostToRuntime,
  isPlayerRuntimeToHost,
} from "../../apps/web-player/dist/transport/public.js";
import { Pico8WebPlayer } from "../../apps/web-player/dist/main/public.js";

const encoder = new TextEncoder();
let module;

before(async () => {
  module = await createZ8LuaModule();
});

function textCart(source) {
  return encoder.encode(
    `pico-8 cartridge // http://www.pico-8.com\nversion 42\n__lua__\n${source}\n`,
  );
}

function command(type, overrides = {}) {
  return {
    v: 1,
    type,
    requestId: 1,
    workerGeneration: 1,
    sessionGeneration: 1,
    ...overrides,
  };
}

function seed(value) {
  const bytes = new Uint8Array(256);
  new DataView(bytes.buffer).setInt32(0, value * 65_536, true);
  return bytes;
}

test("Worker hydrates host cartdata before ready and emits copy-owned commits", async () => {
  const indexedDbCalls = [];
  const persistence = {
    async hydrate() { indexedDbCalls.push("hydrate"); return []; },
    enqueue() { indexedDbCalls.push("enqueue"); },
    async flush() { indexedDbCalls.push("flush"); },
    takeDiagnostics() { return []; },
    async dispose() {},
  };
  const controller = createPlayerWorkerController(module, { persistence });
  const cart = textCart(`
function _init()
 cartdata("native_slot")
 dset(0,dget(0)+1)
end
function _draw() end`);
  const initial = seed(4);
  const loaded = await controller.handle(command("loadCart", {
    cartBytes: cart.slice().buffer,
    hostCartData: [{ id: "native_slot", bytes: initial.slice().buffer }],
  }));
  const commit = loaded.find(({ type }) => type === "cartdata-commit");
  assert.equal(loaded.at(-1).state, "ready");
  assert.equal(isPlayerRuntimeToHost(commit), true);
  assert.equal(new DataView(commit.bytes).getInt32(0, true), 5 * 65_536);
  assert.deepEqual(indexedDbCalls, ["flush"], "old default profile is flushed before switching");

  const flushed = await controller.handle(command("flushPersistence", { requestId: 2 }));
  assert.equal(flushed.at(-1).type, "persistence-flushed");
  assert.equal(isPlayerRuntimeToHost(flushed.at(-1)), true);
  assert.deepEqual(indexedDbCalls, ["flush"]);
  await controller.handle(command("dispose", { requestId: 3 }));
});

class FakeRuntime {
  sessionGeneration = 1;
  listeners = new Set();
  onEvent(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event) { for (const listener of this.listeners) listener(event); }
}

class FakeController {
  state = "idle";
  listeners = new Set();
  loads = [];
  pauses = 0;
  clears = 0;
  startHook;
  onStateChange(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async loadCart(_source, options) { this.loads.push(options); this.state = "ready"; }
  async start() { this.state = "running"; this.startHook?.(); }
  async pause() { this.pauses += 1; this.state = "paused"; }
  async resume() { this.state = "running"; }
  async reset() {}
  async stop() { this.state = "stopped"; }
  setInput() {}
  clearInput() { this.clears += 1; }
  async dispose() { this.state = "disposed"; }
}

test("public adapter serializes writes, awaits flush and backgrounds without resume", async () => {
  const calls = [];
  const adapter = {
    async hydrate(contentId) {
      calls.push(["hydrate", contentId]);
      return [{ id: "native_slot", bytes: seed(7) }];
    },
    async write(contentId, commit) {
      calls.push(["write", contentId, commit.id, commit.revision, commit.bytes.slice()]);
    },
    async flush(contentId) { calls.push(["flush", contentId]); },
  };
  const runtime = new FakeRuntime();
  const controller = new FakeController();
  const presenter = { sessionGeneration: 1, lastFrameId: -1 };
  controller.startHook = () => {
    presenter.lastFrameId = 0;
    runtime.emit({ type: "frame", sessionGeneration: 1, frameId: 0,
      targetFps: 60, cpuInstructions: 1, cpuFractionRaw: 0, slowFrame: false,
      packedScreen: new ArrayBuffer(0x2000), displayPalette: new ArrayBuffer(16) });
  };
  const composition = {
    runtime,
    presenter,
    flushes: 0,
    async flushPersistence() {
      this.flushes += 1;
      return { type: "persistence-flushed", durable: true };
    },
  };
  const mounted = {
    controller,
    composition,
    elements: { root: {}, canvas: {} },
  };
  const player = Reflect.construct(Pico8WebPlayer, [mounted, adapter]);
  const statuses = [];
  player.on("persistence", (event) => statuses.push(event.status));

  await player.loadCart(new Uint8Array([1]), {
    displayName: "native.p8",
    contentId: "sha256:abcd",
  });
  assert.equal(controller.loads[0].hostCartData[0].id, "native_slot");
  runtime.emit({
    v: 1,
    type: "cartdata-commit",
    requestId: 2,
    workerGeneration: 1,
    sessionGeneration: 1,
    id: "native_slot",
    revision: 2,
    bytes: seed(8).buffer,
  });
  const result = await player.flushPersistence("test");
  assert.equal(result.status, "written");
  assert.equal(result.durable, true);
  assert.deepEqual(calls.slice(0, 3).map(([name]) => name), ["hydrate", "write", "flush"]);
  assert.deepEqual(statuses, ["saving", "saved", "saved"]);

  await player.start();
  const background = await player.handleLifecycle("background");
  assert.equal(background.status, "unchanged");
  assert.equal(controller.clears, 1);
  assert.equal(controller.pauses, 1);
  assert.equal(controller.state, "paused");
  await player.handleLifecycle("active");
  assert.equal(controller.state, "paused", "active must not auto-resume");
  await player.dispose();
});

test("transport rejects malformed host records and requestless flush", () => {
  const base = command("loadCart", {
    cartBytes: new Uint8Array([1]).buffer,
    hostCartData: [],
  });
  assert.equal(isPlayerHostToRuntime(base), true);
  assert.equal(isPlayerHostToRuntime({
    ...base,
    hostCartData: [{ id: "Bad ID", bytes: new ArrayBuffer(256) }],
  }), false);
  assert.equal(isPlayerHostToRuntime(command("flushPersistence", { requestId: 0 })), false);
  assert.equal(isPlayerHostToRuntime(command("flushPersistence", { requestId: 3 })), true);
});
