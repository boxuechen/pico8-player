import assert from "node:assert/strict";
import test, { before } from "node:test";

import createZ8LuaModule from "../../wasm/dist/z8lua-runtime-v1.mjs";
import { createPlayerWorkerController } from "../../apps/player/dist/worker/compose-runtime.js";
import {
  isPlayerHostToRuntime,
  isPlayerRuntimeToHost,
} from "../../apps/player/dist/transport/public.js";
import { PlayerRuntimeClient } from "../../apps/player/dist/main/worker-client.js";

const encoder = new TextEncoder();
let module;

before(async () => {
  module = await createZ8LuaModule();
});

function textCart(source, suffix = "") {
  return encoder.encode(
    `pico-8 cartridge // http://www.pico-8.com\nversion 42\n__lua__\n${source}\n--${suffix}\n`,
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

function q16At(bytes, index) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getInt32(index * 4, true);
}

function seed(id, firstValue) {
  const bytes = Uint8Array.from(
    { length: 256 },
    (_, index) => index < 8 ? 0 : (index * 17) & 0xff,
  );
  new DataView(bytes.buffer).setInt32(0, firstValue * 65_536, true);
  return { id, bytes };
}

class FakePersistence {
  calls = [];
  durable = new Map();
  pending = new Map();
  diagnostics = [];
  failReads = 0;
  failWrites = 0;
  disposed = false;

  constructor(seeds = []) {
    for (const record of seeds) this.durable.set(record.id, record.bytes.slice());
  }

  async hydrate() {
    this.calls.push("hydrate");
    if (this.failReads > 0) {
      this.failReads -= 1;
      this.diagnostics.push({
        code: "E_PERSISTENCE_READ",
        message: "injected read failure",
        phase: "none",
        recoverable: true,
      });
      return [];
    }
    return [...this.durable].map(([id, bytes]) => ({ id, bytes: bytes.slice() }));
  }

  enqueue(commit) {
    this.calls.push(`enqueue:${commit.id}:${commit.revision}`);
    this.pending.set(commit.id, commit.bytes.slice());
  }

  async flush() {
    this.calls.push("flush");
    if (this.failWrites > 0) {
      this.failWrites -= 1;
      this.diagnostics.push({
        code: "E_PERSISTENCE_WRITE",
        message: "injected write failure",
        phase: "none",
        recoverable: true,
      });
      return;
    }
    for (const [id, bytes] of this.pending) this.durable.set(id, bytes.slice());
    this.pending.clear();
  }

  takeDiagnostics() {
    return this.diagnostics.splice(0);
  }

  async dispose() {
    if (this.disposed) return;
    this.calls.push("dispose");
    await this.flush();
    this.disposed = true;
  }
}

const CART_SOURCE = `
function _init()
 loaded=cartdata("shared_slot")
 dset(0,dget(0)+1)
end
function _update60()
 dset(1,dget(1)+1)
end
function _draw() end`;

test("Worker persistence hydrates before boot and flushes generation boundaries", async () => {
  const persistence = new FakePersistence([seed("shared_slot", 4)]);
  const controller = createPlayerWorkerController(module, { persistence });
  const cart = textCart(CART_SOURCE, "generation-a");

  const loaded = await controller.handle(command("loadCart", {
    cartBytes: cart.slice().buffer,
  }));
  assert.equal(loaded.at(-1).state, "ready");
  assert.deepEqual(persistence.calls.slice(0, 3), [
    "flush", "hydrate", "enqueue:shared_slot:1",
  ]);
  assert.equal(q16At(persistence.pending.get("shared_slot"), 0), 5 * 65_536);

  await controller.handle(command("start", { requestId: 2 }));
  await controller.handle(command("vsync", {
    requestId: 3, sequence: 1, timestampMs: 0,
  }));
  await controller.handle(command("vsync", {
    requestId: 4, sequence: 2, timestampMs: 17,
  }));
  assert.equal(q16At(persistence.pending.get("shared_slot"), 1), 65_536);
  assert.equal(
    persistence.calls.filter((entry) => entry === "flush").length,
    1,
    "steady simulation must not await durable storage",
  );

  persistence.failWrites = 1;
  const paused = await controller.handle(command("pause", { requestId: 5 }));
  assert.equal(paused.some(({ type }) => type === "diagnostic"), true);
  assert.equal(paused.some(({ type }) => type === "fault"), false);
  assert.equal(paused.at(-1).state, "paused");
  assert.equal(persistence.pending.has("shared_slot"), true);

  const callsBeforeReset = persistence.calls.length;
  const reset = await controller.handle(command("reset", {
    requestId: 6,
    sessionGeneration: 2,
  }));
  assert.equal(reset.at(-1).state, "ready");
  assert.deepEqual(persistence.calls.slice(callsBeforeReset, callsBeforeReset + 3), [
    "flush", "hydrate", "enqueue:shared_slot:1",
  ]);
  assert.equal(q16At(persistence.pending.get("shared_slot"), 0), 6 * 65_536);
  assert.equal(q16At(persistence.pending.get("shared_slot"), 1), 65_536);

  const hydrateCount = persistence.calls.filter((entry) => entry === "hydrate").length;
  const stale = await controller.handle(command("loadCart", {
    requestId: 7,
    sessionGeneration: 2,
    cartBytes: cart.slice().buffer,
  }));
  assert.equal(stale.some(({ type }) => type === "fault"), true);
  assert.equal(
    persistence.calls.filter((entry) => entry === "hydrate").length,
    hydrateCount,
    "stale generations must not hydrate or start a guest",
  );

  const stopped = await controller.handle(command("stop", {
    requestId: 8,
    sessionGeneration: 2,
  }));
  assert.equal(stopped.at(-1).state, "stopped");
  assert.equal(q16At(persistence.durable.get("shared_slot"), 0), 6 * 65_536);
  const disposed = await controller.handle(command("dispose", {
    requestId: 9,
    sessionGeneration: 2,
  }));
  assert.equal(disposed.at(-1).state, "disposed");
  assert.equal(persistence.disposed, true);
});

test("persistence read failures remain recoverable and VM faults still flush commits", async () => {
  const readFailure = new FakePersistence([seed("shared_slot", 9)]);
  readFailure.failReads = 1;
  const valid = createPlayerWorkerController(module, { persistence: readFailure });
  const loaded = await valid.handle(command("loadCart", {
    cartBytes: textCart(CART_SOURCE, "read-fallback").buffer,
  }));
  assert.deepEqual(loaded.map(({ type }) => type), ["diagnostic", "state"]);
  assert.equal(loaded[0].error.code, "E_PERSISTENCE_READ");
  assert.equal(q16At(readFailure.pending.get("shared_slot"), 0), 65_536);
  await valid.handle(command("dispose", { requestId: 2 }));

  const faultPersistence = new FakePersistence();
  const faulting = createPlayerWorkerController(module, { persistence: faultPersistence });
  const faultCart = textCart(`
function _init() cartdata("fault_slot") dset(0,7) end
function _update60() assert(false,"expected vm fault") end
function _draw() end`);
  await faulting.handle(command("loadCart", { cartBytes: faultCart.buffer }));
  await faulting.handle(command("start", { requestId: 2 }));
  await faulting.handle(command("vsync", {
    requestId: 3, sequence: 1, timestampMs: 0,
  }));
  const fault = await faulting.handle(command("vsync", {
    requestId: 4, sequence: 2, timestampMs: 17,
  }));
  assert.equal(fault.some(({ type }) => type === "fault"), true);
  assert.equal(q16At(faultPersistence.durable.get("fault_slot"), 0), 7 * 65_536);
  await faulting.handle(command("dispose", { requestId: 5 }));
});

test("persistence flush uses a request and waits for Worker acknowledgement", async () => {
  const posted = [];
  let listener;
  const worker = {
    postMessage(message) {
      posted.push(message);
      if (message.requestId === 0) return;
      const response = message.type === "loadCart"
        ? {
            v: 1, type: "state", requestId: message.requestId,
            workerGeneration: message.workerGeneration,
            sessionGeneration: message.sessionGeneration,
            state: "ready", mode: "callback", targetFps: 60, devkitFlags: 0,
          }
        : message.type === "flushPersistence"
          ? {
              v: 1, type: "persistence-flushed", durable: true, requestId: message.requestId,
              workerGeneration: message.workerGeneration,
              sessionGeneration: message.sessionGeneration,
            }
          : {
              v: 1, type: "state", requestId: message.requestId,
              workerGeneration: message.workerGeneration,
              sessionGeneration: message.sessionGeneration,
              state: "disposed", mode: "none", targetFps: 0, devkitFlags: 0,
            };
      queueMicrotask(() => listener({ data: response }));
    },
    addEventListener(_type, next) { listener = next; },
    terminate() {},
  };
  const client = new PlayerRuntimeClient(() => worker);
  await client.loadCart(new Uint8Array([1]));
  const flushed = await client.flushPersistence();
  const command = posted.find(({ type }) => type === "flushPersistence");
  assert.equal(command.requestId > 0, true);
  assert.equal(isPlayerHostToRuntime(command), true);
  assert.equal(flushed.type, "persistence-flushed");
  assert.equal(isPlayerRuntimeToHost(flushed), true);
  assert.equal(isPlayerRuntimeToHost({
    v: 1,
    type: "diagnostic",
    requestId: 0,
    workerGeneration: 1,
    sessionGeneration: 0,
    error: {
      code: "E_PERSISTENCE_WRITE",
      message: "pagehide flush failed",
      phase: "none",
      recoverable: true,
    },
  }), true);
  await client.dispose();
});
