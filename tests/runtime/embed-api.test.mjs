import { withControllerLifecycle } from "./support/controller-lifecycle.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createPico8WebPlayer,
  Pico8WebPlayer,
  PICO8_WEB_PLAYER_API_VERSION,
} from "../../apps/web-player/dist/main/public.js";

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class FakeRuntime {
  listeners = new Set();
  sessionGeneration = 1;

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of this.listeners) listener(event);
  }
}

class FakeController {
  state = "idle";
  listeners = new Set();
  operations = [];
  loadGate;
  disposeCount = 0;
  startHook;

  onStateChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(state, message = state) {
    this.state = state;
    for (const listener of this.listeners) listener({ state, message });
  }

  async loadCart(source, options) {
    this.operations.push({ type: "load:start", source, options });
    this.emit("loading", "Loading");
    await this.loadGate?.promise;
    this.operations.push({ type: "load:end" });
    this.emit("ready", "Ready");
  }

  async start() {
    this.operations.push({ type: "start" });
    this.emit("running", "Running");
    this.startHook?.();
  }

  async pause() { this.operations.push({ type: "pause" }); }
  async resume() { this.operations.push({ type: "resume" }); }
  async reset() { this.operations.push({ type: "reset" }); }
  async stop() { this.operations.push({ type: "stop" }); }
  setInput(snapshot) { this.operations.push({ type: "input", snapshot }); }

  async dispose() {
    this.disposeCount += 1;
    this.emit("disposed", "Disposed");
  }
}

function fakePlayer() {
  const runtime = new FakeRuntime();
  const controller = withControllerLifecycle(new FakeController());
  const presenter = { sessionGeneration: 1, lastFrameId: -1 };
  controller.startHook = () => {
    presenter.lastFrameId += 1;
    runtime.emit({
      v: 1,
      type: "frame",
      requestId: 0,
      workerGeneration: 1,
      sessionGeneration: 1,
      frameId: presenter.lastFrameId,
      completedSlices: "1",
      timeRawBeforeStep: 0,
      targetFps: 60,
      cpuInstructions: 1,
      cpuFractionRaw: 0,
      slowFrame: false,
      devkitFlags: 0,
      packedScreen: new ArrayBuffer(0x2000),
      displayPalette: new ArrayBuffer(16),
    });
  };
  runtime.flushPersistence = async () => ({ type: "persistence-flushed", durable: true });
  const mounted = {
    controller,
    composition: { runtime, presenter },
    elements: { root: { id: "root" }, canvas: { id: "canvas" } },
  };
  return {
    runtime,
    presenter,
    controller,
    player: Reflect.construct(Pico8WebPlayer, [mounted]),
  };
}

test("the versioned package root is bytes-first and has no URL/fetch cart authority", async () => {
  assert.equal(PICO8_WEB_PLAYER_API_VERSION, 2);
  assert.equal(typeof createPico8WebPlayer, "function");
  for (const method of [
    "create", "loadCart", "start", "pause", "resume", "reset", "stop", "setInput", "dispose",
  ]) {
    assert.equal(typeof Pico8WebPlayer[method] === "function" ||
      typeof Pico8WebPlayer.prototype[method] === "function", true, method);
  }
  const manifest = JSON.parse(await readFile("apps/web-player/package.json", "utf8"));
  assert.deepEqual(manifest.exports["."], {
    types: "./dist/main/public.d.ts",
    import: "./dist/main/public.js",
  });
  const declaration = await readFile("apps/web-player/dist/main/embed-player.d.ts", "utf8");
  assert.match(declaration, /source: Uint8Array/u);
  assert.doesNotMatch(declaration, /loadCart\([^)]*(?:URL|string)/u);
  const publicModule = await readFile("apps/web-player/dist/main/public.js", "utf8");
  assert.doesNotMatch(publicModule, /\bfetch\s*\(/u);
  const selfImport = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", "const m=await import('@pico8-web/web-player');process.stdout.write(String(m.PICO8_WEB_PLAYER_API_VERSION))"],
    { cwd: "apps/web-player", encoding: "utf8" },
  );
  assert.equal(selfImport.status, 0, selfImport.stderr);
  assert.equal(selfImport.stdout, "2");
});

test("public lifecycle operations are deterministic and serialized", async () => {
  const { player, controller } = fakePlayer();
  controller.loadGate = deferred();
  const cart = new Uint8Array([1, 2, 3]);
  const load = player.loadCart(cart, { displayName: "serial.p8" });
  const start = player.start();
  await Promise.resolve();
  assert.deepEqual(controller.operations.map(({ type }) => type), ["load:start"]);
  controller.loadGate.resolve();
  await Promise.all([load, start]);
  assert.deepEqual(controller.operations.map(({ type }) => type), [
    "load:start", "load:end", "start",
  ]);
  await player.pause();
  await player.resume();
  await player.reset();
  await player.stop();
  assert.deepEqual(controller.operations.slice(-4).map(({ type }) => type), [
    "pause", "resume", "reset", "stop",
  ]);
  await player.dispose();
});

test("dispose is an idempotent terminal barrier for in-flight work and output", async () => {
  const { player, controller, runtime } = fakePlayer();
  controller.loadGate = deferred();
  const observed = [];
  for (const type of ["state", "frame", "diagnostic", "fault"]) {
    player.on(type, (event) => observed.push(event.type));
  }
  const load = player.loadCart(new Uint8Array([1]));
  await Promise.resolve();
  const firstDispose = player.dispose();
  const secondDispose = player.dispose();
  assert.equal(firstDispose, secondDispose);
  const countAtBarrier = observed.length;
  controller.emit("ready");
  runtime.emit({
    v: 1,
    type: "diagnostic",
    requestId: 0,
    workerGeneration: 1,
    sessionGeneration: 1,
    error: { code: "E_INVARIANT", message: "stale", phase: "none", recoverable: true },
  });
  controller.loadGate.resolve();
  await assert.rejects(load, /disposed/u);
  await firstDispose;
  assert.equal(controller.disposeCount, 1);
  assert.equal(observed.length, countAtBarrier);
  await assert.rejects(player.start(), /disposed/u);
});

test("typed events are copied and two facades do not share listeners", async () => {
  const first = fakePlayer();
  const second = fakePlayer();
  const firstFrames = [];
  const secondStates = [];
  first.player.on("frame", (event) => firstFrames.push(event));
  second.player.on("state", (event) => secondStates.push(event.state));
  const packedScreen = new ArrayBuffer(0x2000);
  const displayPalette = new ArrayBuffer(16);
  first.runtime.emit({
    v: 1,
    type: "frame",
    requestId: 0,
    workerGeneration: 1,
    sessionGeneration: 1,
    frameId: 4,
    completedSlices: "1",
    timeRawBeforeStep: 0,
    targetFps: 60,
    cpuInstructions: 12,
    cpuFractionRaw: 1,
    slowFrame: false,
    devkitFlags: 0,
    packedScreen,
    displayPalette,
  });
  first.controller.emit("running");
  second.controller.emit("paused");
  assert.equal(firstFrames.length, 1);
  assert.notEqual(firstFrames[0].packedScreen.buffer, packedScreen);
  assert.notEqual(firstFrames[0].displayPalette.buffer, displayPalette);
  assert.deepEqual(secondStates, ["paused"]);
  await first.player.dispose();
  assert.equal(second.player.state, "paused");
  await second.player.dispose();
});
