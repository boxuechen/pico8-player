import { withControllerLifecycle } from "./support/controller-lifecycle.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import { Pico8Player } from "../../apps/player/dist/main/public.js";

class FakeRuntime {
  sessionGeneration = 1;
  listeners = new Set();

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of [...this.listeners]) listener(event);
  }
}

class FakeController {
  state = "ready";
  listeners = new Set();
  stopCount = 0;
  disposeCount = 0;

  onStateChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(state) {
    this.state = state;
    for (const listener of [...this.listeners]) listener({ state, message: state });
  }

  async start() { this.emit("running"); }
  async stop() { this.stopCount += 1; this.emit("stopped"); }
  async dispose() { this.disposeCount += 1; this.emit("disposed"); }
}

function frame(sessionGeneration, frameId) {
  return {
    v: 1,
    type: "frame",
    requestId: 0,
    workerGeneration: 1,
    sessionGeneration,
    frameId,
    completedSlices: "1",
    timeRawBeforeStep: 0,
    targetFps: 60,
    cpuInstructions: 1,
    cpuFractionRaw: 0,
    slowFrame: false,
    devkitFlags: 0,
    packedScreen: new ArrayBuffer(0x2000),
    displayPalette: new ArrayBuffer(16),
  };
}

function fixture(timeoutMs = 100) {
  const runtime = new FakeRuntime();
  const controller = withControllerLifecycle(new FakeController());
  const presenter = { sessionGeneration: 1, lastFrameId: -1 };
  runtime.flushPersistence = async () => {};
  const mounted = {
    controller,
    composition: {
      runtime,
      presenter,
    },
    elements: { root: {}, canvas: {} },
  };
  return {
    runtime,
    controller,
    presenter,
    player: Reflect.construct(Pico8Player, [mounted, undefined, timeoutMs]),
  };
}

async function stillPending(promise) {
  const marker = Symbol("pending");
  assert.equal(await Promise.race([
    promise.then(() => "resolved", () => "rejected"),
    new Promise((resolve) => setTimeout(() => resolve(marker), 5)),
  ]), marker);
}

test("start waits for a current-generation frame accepted by the presenter", async () => {
  const { player, runtime, presenter } = fixture();
  const starting = player.start();
  await stillPending(starting);

  runtime.emit(frame(0, 0));
  await stillPending(starting);
  runtime.emit(frame(1, 0));
  await stillPending(starting);

  presenter.lastFrameId = 1;
  runtime.emit(frame(1, 1));
  await starting;
  assert.equal(player.state, "running");
  await player.dispose();
});

test("a missing first frame fails closed and stops the acknowledged runtime", async () => {
  const { player, controller } = fixture(20);
  await assert.rejects(player.start(), (error) => {
    assert.equal(error.name, "RuntimeClientError");
    assert.equal(error.record.code, "E_VM_WATCHDOG");
    return true;
  });
  assert.equal(controller.stopCount, 1);
  assert.equal(player.state, "stopped");
  await player.dispose();
});

test("dispose rejects a pending first-frame barrier and remains idempotent", async () => {
  const { player, controller } = fixture(1000);
  const starting = player.start();
  await Promise.resolve();
  const firstDispose = player.dispose();
  assert.equal(firstDispose, player.dispose());
  await assert.rejects(starting, /disposed before its first frame/u);
  await firstDispose;
  assert.equal(controller.disposeCount, 1);
});

test("a failed start command observes the separately rejected first-frame gate", async () => {
  const { player, controller } = fixture();
  controller.start = async () => {
    controller.emit("faulted");
    throw new Error("start command failed");
  };
  await assert.rejects(player.start(), /start command failed/);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await player.dispose();
});

for (const cause of ["deadline", "dispose"]) {
  test(`${cause} while start acknowledgement is pending does not leak a rejection`, async () => {
    const { player, controller } = fixture(cause === "deadline" ? 5 : 1000);
    let acknowledge;
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    controller.start = async () => {
      entered();
      await new Promise((resolve) => { acknowledge = resolve; });
      controller.emit("running");
    };
    const starting = player.start();
    const rejected = assert.rejects(starting, cause === "deadline" ? /deadline/ : /disposed/);
    await started;
    const disposal = cause === "dispose" ? player.dispose() : undefined;
    await new Promise((resolve) => setTimeout(resolve, 20));
    acknowledge();
    await rejected;
    await (disposal ?? player.dispose());
  });
}
