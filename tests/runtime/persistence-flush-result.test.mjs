import { withControllerLifecycle } from "./support/controller-lifecycle.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import createZ8LuaModule from "../../wasm/dist/z8lua-runtime-v1.mjs";
import { createPlayerWorkerController } from "../../apps/web-player/dist/worker/compose-runtime.js";
import { Pico8WebPlayer } from "../../apps/web-player/dist/main/public.js";
import { isPlayerRuntimeToHost } from "../../apps/web-player/dist/transport/public.js";

test("Worker flush failure reaches the public result and a successful retry becomes durable", async () => {
  const module = await createZ8LuaModule();
  let fail = true;
  const persistence = {
    async hydrate() { return []; }, enqueue() {}, takeDiagnostics() { return []; },
    async flush() {
      if (fail) throw new Error("QuotaExceededError");
      return { durable: true };
    }, async dispose() {},
  };
  const worker = createPlayerWorkerController(module, { persistence });
  const replies = [];
  const player = Reflect.construct(Pico8WebPlayer, [{
    controller: withControllerLifecycle({ state: "idle", onStateChange() { return () => {}; },
      async stop() {}, async dispose() {} }),
    composition: {
      runtime: { onEvent() { return () => {}; } ,
      async flushPersistence() {
        const events = await worker.handle({ v: 1, type: "flushPersistence", requestId: 1,
          workerGeneration: 1, sessionGeneration: 1 });
        replies.push(...events);
        return events.at(-1);
      },
    } }, elements: {},
  }]);
  const failed = await player.flushPersistence("quota-test");
  assert.equal(failed.status, "failed");
  assert.equal(failed.durable, false);
  assert.match(failed.message, /QuotaExceededError/);
  assert.ok(replies.some(e => e.type === "diagnostic" && e.error.code === "E_PERSISTENCE_WRITE"));
  assert.equal(isPlayerRuntimeToHost(replies.at(-1)), true);
  fail = false;
  assert.deepEqual(await player.flushPersistence("retry"), {
    status: "flushed", reason: "retry", durable: true,
  });
  await player.dispose();
  await worker.dispose();
});

test("flush acknowledgements require an explicit boolean durability result", () => {
  const base = { v: 1, type: "persistence-flushed", requestId: 1,
    workerGeneration: 1, sessionGeneration: 1 };
  assert.equal(isPlayerRuntimeToHost(base), false);
  assert.equal(isPlayerRuntimeToHost({ ...base, durable: "true" }), false);
  assert.equal(isPlayerRuntimeToHost({ ...base, durable: false, message: "quota" }), true);
  assert.equal(isPlayerRuntimeToHost({ ...base, durable: true }), true);
  assert.equal(isPlayerRuntimeToHost({ ...base, durable: false, message: {} }), false);
});
