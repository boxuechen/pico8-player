import { withControllerLifecycle } from "./support/controller-lifecycle.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import { Pico8WebPlayer } from "../../apps/web-player/dist/main/public.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const writes = [];
  const operations = [];
  const runtime = {
    sessionGeneration: 0,
    listeners: new Set(),
    onEvent(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
    emit(event) { for (const fn of [...this.listeners]) fn(event); },
  };
  const adapter = {
    async hydrate() { return []; },
    async write(contentId, commit) { writes.push({ contentId, revision: commit.revision }); },
    async flush(contentId) { operations.push(`flush:${contentId}`); },
  };
  const controller = {
    state: "idle",
    listeners: new Set(),
    onStateChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
    async loadCart() { runtime.sessionGeneration++; this.state = "ready"; },
    async stop() { operations.push("stop"); this.state = "stopped"; },
    async dispose() { operations.push("dispose"); this.state = "disposed"; },
  };
  const composition = { runtime };
  runtime.flushPersistence = async () => {
    operations.push("worker-flush");
    return { type: "persistence-flushed", durable: true };
  };
  const player = Reflect.construct(Pico8WebPlayer, [
    { controller: withControllerLifecycle(controller), composition, elements: {} }, adapter,
  ]);
  function commit(revision) {
    runtime.emit({ type: "cartdata-commit", sessionGeneration: runtime.sessionGeneration,
      id: "slot", revision, bytes: new ArrayBuffer(256) });
  }
  return { player, runtime, adapter, controller, composition, writes, operations, commit };
}

test("cart switch drains the old producer before hydration and preserves its identity until activation", async () => {
  const f = fixture();
  await f.player.loadCart(new Uint8Array([1]), { contentId: "cart-a" });
  f.controller.state = "running";
  const entered = deferred();
  const hydration = deferred();
  f.adapter.hydrate = async () => { entered.resolve(); return hydration.promise; };
  const stop = f.controller.stop.bind(f.controller);
  f.controller.stop = async () => { f.commit(1); await stop(); };
  const switching = f.player.loadCart(new Uint8Array([2]), { contentId: "cart-b" });
  await entered.promise;
  const stateDuringHydration = f.controller.state;
  // Verify the binding independently of producer shutdown as well.
  f.commit(2);
  hydration.resolve([]);
  await switching;
  f.commit(3);
  await f.player.flushPersistence();
  assert.equal(stateDuringHydration, "stopped");
  assert.deepEqual(f.writes, [
    { contentId: "cart-a", revision: 1 },
    { contentId: "cart-a", revision: 2 },
    { contentId: "cart-b", revision: 3 },
  ]);
  await f.player.dispose();
});

for (const failure of ["rejected", "malformed"]) {
  test(`failed ${failure} hydration leaves the previous persistence binding intact`, async () => {
    const f = fixture();
    await f.player.loadCart(new Uint8Array([1]), { contentId: "cart-a" });
    f.adapter.hydrate = async () => {
      if (failure === "rejected") throw new Error("hydrate failed");
      return [{ id: "slot", bytes: new Uint8Array(1) }];
    };
    await assert.rejects(f.player.loadCart(new Uint8Array([2]), { contentId: "cart-b" }));
    f.commit(1);
    await f.player.flushPersistence();
    assert.deepEqual(f.writes, [{ contentId: "cart-a", revision: 1 }]);
    f.adapter.hydrate = async () => [];
    await f.player.loadCart(new Uint8Array([2]), { contentId: "cart-b" });
    f.commit(2);
    await f.player.flushPersistence();
    assert.deepEqual(f.writes.at(-1), { contentId: "cart-b", revision: 2 });
    await f.player.dispose();
  });
}

test("dispose drains commits through teardown and awaits the final host flush", async () => {
  const f = fixture();
  await f.player.loadCart(new Uint8Array([1]), { contentId: "cart-a" });
  const finalFlush = deferred();
  const flushEntered = deferred();
  f.controller.stop = async () => { f.commit(1); f.controller.state = "stopped"; };
  f.runtime.flushPersistence = async () => {
    f.commit(2);
    return { type: "persistence-flushed", durable: true };
  };
  f.controller.teardown = async () => { f.commit(3); f.controller.state = "disposed"; };
  f.adapter.flush = async () => { flushEntered.resolve(); await finalFlush.promise; };
  const events = [];
  f.player.on("persistence", (event) => events.push(event));
  let done = false;
  const disposal = f.player.dispose();
  assert.equal(disposal, f.player.dispose());
  disposal.then(() => { done = true; });
  await flushEntered.promise;
  assert.equal(done, false);
  finalFlush.resolve();
  await disposal;
  assert.deepEqual(f.writes, [1, 2, 3].map(revision => ({ contentId: "cart-a", revision })));
  assert.deepEqual(events, [], "public events stop immediately, internal commits keep draining");
  assert.equal(f.runtime.listeners.size, 0);
  assert.equal(f.controller.listeners.size, 0);
});

test("a failed host flush blocks replacement until a successful retry", async () => {
  const f = fixture();
  await f.player.loadCart(new Uint8Array([1]), { contentId: "cart-a" });
  let fail = true;
  let hydrations = 0;
  f.adapter.hydrate = async () => { hydrations++; return []; };
  f.adapter.flush = async () => { if (fail) throw new Error("storage unavailable"); };
  assert.deepEqual(await f.player.flushPersistence("explicit"), {
    status: "failed", durable: false, reason: "explicit", message: "storage unavailable",
  });
  await assert.rejects(f.player.loadCart(new Uint8Array([2]), { contentId: "cart-b" }),
    /storage unavailable/);
  assert.equal(hydrations, 0);
  fail = false;
  await f.player.loadCart(new Uint8Array([2]), { contentId: "cart-b" });
  assert.equal(hydrations, 1);
  await f.player.dispose();
});

test("failed Worker teardown still flushes accepted host commits and removes subscriptions", async () => {
  const f = fixture();
  await f.player.loadCart(new Uint8Array([1]), { contentId: "cart-a" });
  f.controller.stop = async () => { throw new Error("stop watchdog"); };
  f.controller.teardown = async () => { f.commit(1); throw new Error("dispose watchdog"); };
  await assert.rejects(f.player.dispose(), /dispose watchdog/);
  assert.deepEqual(f.writes, [{ contentId: "cart-a", revision: 1 }]);
  assert.equal(f.operations.at(-1), "flush:cart-a");
  assert.equal(f.runtime.listeners.size, 0);
});

test("dispose still drains in-flight load commits while rejecting its public completion", async () => {
  const f = fixture();
  const entered = deferred();
  const loaded = deferred();
  f.controller.loadCart = async () => {
    f.controller.state = "loading";
    entered.resolve();
    await loaded.promise;
    f.commit(1);
    f.controller.state = "ready";
  };
  const loading = f.player.loadCart(new Uint8Array([1]), { contentId: "cart-a" });
  const rejection = assert.rejects(loading, /disposed/);
  await entered.promise;
  const disposal = f.player.dispose();
  loaded.resolve();
  await Promise.all([rejection, disposal]);
  assert.deepEqual(f.writes, [{ contentId: "cart-a", revision: 1 }]);
});
