import assert from "node:assert/strict";
import test from "node:test";
import { PlayerController } from "../../apps/web-player/dist/main/player-controller.js";
import { Pico8WebPlayer } from "../../apps/web-player/dist/main/public.js";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const calls = [];
  const window = new EventTarget();
  const document = new EventTarget();
  document.visibilityState = "visible";
  const elements = {};
  for (const name of ["canvas", "fileInput", "dropZone", "playButton", "pauseButton", "menuButton",
    "pauseMenuItems", "pauseMenu", "resetButton", "stopButton", "muteButton", "fullscreenButton", "touchControls"]) {
    const element = new EventTarget();
    element.tabIndex = 0;
    element.querySelectorAll = () => [];
    element.focus = () => { document.activeElement = element; };
    elements[name] = element;
  }
  const runtime = {
    listeners: new Set(), sessionGeneration: 0, hasRetainedCart: true,
    clearInput() {}, onEvent(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
    emit(event) { for (const fn of [...this.listeners]) fn(event); },
  };
  const presenter = { sessionGeneration: 0, lastFrameId: -1 };
  function present() {
    presenter.sessionGeneration = runtime.sessionGeneration;
    presenter.lastFrameId++;
    runtime.emit({ type: "frame", sessionGeneration: runtime.sessionGeneration,
      frameId: presenter.lastFrameId, targetFps: 60, devkitFlags: 0,
      packedScreen: new ArrayBuffer(8192), displayPalette: new ArrayBuffer(16) });
  }
  const composition = {
    runtime, presenter,
    autoPresent: true,
    async resumeAudio() { calls.push("audio-probe"); return true; },
    async suspendAudio() {},
    setMuted() {},
    async dispose() { calls.push("dispose"); },
  };
  Object.assign(runtime, {
    async loadCart(source) {
      calls.push(`load:${source[0]}:begin`);
      await composition.loadGate?.promise;
      runtime.sessionGeneration++;
      calls.push(`load:${source[0]}:end`);
      return { type: "state", state: "ready" };
    },
    async start() { calls.push("start"); if (composition.autoPresent) present(); },
    async reset() { calls.push("reset"); },
    async pause() { calls.push("pause"); },
    async resume() { calls.push("resume"); },
    async stop() { calls.push("stop"); },
    async flushPersistence() { calls.push("flush"); return { type: "persistence-flushed", durable: true }; },
  });
  const view = { elements, render() {}, hidePauseMenu() {}, clearDiagnostic() {},
    showDiagnostic() {}, dispose() {}, async exitFullscreen() {} };
  const controller = new PlayerController(composition, view, { window, document,
    gamepadSource: { getGamepads: () => [] }, animationFrames: { request() { return 1; }, cancel() {} } });
  const player = Reflect.construct(Pico8WebPlayer, [{ controller, composition, elements }]);
  return { player, controller, composition, runtime, window, document, elements, calls, present };
}

test("embed load, UI reset and public stop execute in one FIFO transaction queue", async () => {
  const f = fixture();
  f.composition.loadGate = deferred();
  const loading = f.player.loadCart(new Uint8Array([1]));
  await tick();
  f.elements.resetButton.dispatchEvent(new Event("click"));
  const stopping = f.player.stop();
  await tick();
  const duringLoad = [...f.calls];
  f.composition.loadGate.resolve();
  await Promise.all([loading, stopping]);
  assert.deepEqual(duringLoad, ["load:1:begin"]);
  assert.deepEqual(f.calls, ["load:1:begin", "load:1:end", "reset", "stop"]);
  await f.player.dispose();
});

test("UI reset waits for the embed first-frame transaction without blocking frame delivery", async () => {
  const f = fixture();
  await f.player.loadCart(new Uint8Array([1]));
  f.composition.autoPresent = false;
  const starting = f.player.start();
  await tick();
  f.elements.resetButton.dispatchEvent(new Event("click"));
  await tick();
  const resetBeforeFrame = f.calls.includes("reset");
  f.present();
  await starting;
  await tick();
  assert.equal(resetBeforeFrame, false);
  assert.ok(f.calls.includes("reset"));
  await f.player.dispose();
});

test("blur during an in-flight start is evaluated after start, then focus resumes in order", async () => {
  const f = fixture();
  await f.player.loadCart(new Uint8Array([1]));
  const audioGate = deferred();
  f.composition.resumeAudio = () => audioGate.promise;
  const starting = f.player.start();
  await tick();
  f.window.dispatchEvent(new Event("blur"));
  audioGate.resolve(true);
  await starting;
  await tick();
  assert.equal(f.controller.state, "paused");
  f.window.dispatchEvent(new Event("focus"));
  await tick();
  assert.deepEqual(f.calls.filter(x => ["start", "pause", "resume"].includes(x)),
    ["start", "pause", "resume"]);
  await f.player.dispose();
});

test("dispose skips queued UI and Controller work, drains the in-flight facade load and stays terminal", async () => {
  const f = fixture();
  f.composition.loadGate = deferred();
  const loading = f.player.loadCart(new Uint8Array([1]));
  const rejectedLoad = assert.rejects(loading, /disposed/);
  await tick();
  f.elements.resetButton.dispatchEvent(new Event("click"));
  const rejectedReset = assert.rejects(f.controller.reset(), /disposed/);
  const disposal = f.player.dispose();
  assert.equal(f.player.dispose(), disposal);
  f.elements.playButton.dispatchEvent(new Event("click"));
  await assert.rejects(f.controller.start(), /disposed/);
  f.composition.loadGate.resolve();
  await Promise.all([rejectedLoad, rejectedReset, disposal]);
  assert.deepEqual(f.calls, ["load:1:begin", "load:1:end", "stop", "flush", "dispose"]);
  assert.equal(f.controller.state, "disposed");
  await assert.rejects(f.player.loadCart(new Uint8Array([2])), /disposed/);
});

test("file selection reserves its FIFO position before asynchronous byte reading", async () => {
  const f = fixture();
  const bytes = deferred();
  f.elements.fileInput.files = [{ name: "owned.p8", size: 1, arrayBuffer: () => bytes.promise }];
  f.elements.fileInput.dispatchEvent(new Event("change"));
  const loading = f.player.loadCart(new Uint8Array([2]));
  await tick();
  const beforeBytes = [...f.calls];
  bytes.resolve(new Uint8Array([1]).buffer);
  await loading;
  assert.deepEqual(beforeBytes, []);
  assert.deepEqual(f.calls.filter(x => x !== "audio-probe"),
    ["load:1:begin", "load:1:end", "start", "load:2:begin", "load:2:end"]);
  await f.player.dispose();
});

test("pagehide persistence flush cannot overtake an admitted load", async () => {
  const f = fixture();
  f.composition.loadGate = deferred();
  const loading = f.player.loadCart(new Uint8Array([1]));
  await tick();
  f.window.dispatchEvent(new Event("pagehide"));
  await tick();
  const earlyFlush = f.calls.includes("flush");
  f.composition.loadGate.resolve();
  await loading;
  await f.controller.runLifecycle(async () => {});
  assert.equal(earlyFlush, false);
  assert.deepEqual(f.calls, ["load:1:begin", "load:1:end", "flush"]);
  await f.player.dispose();
});

test("a failed operation does not poison later loads from another producer", async () => {
  const f = fixture();
  const load = f.runtime.loadCart;
  f.runtime.loadCart = async source => {
    if (source[0] === 1) throw new Error("injected load failure");
    return load(source);
  };
  const failed = assert.rejects(f.player.loadCart(new Uint8Array([1])), /injected/);
  const recovery = f.controller.loadCart(new Uint8Array([2]));
  await Promise.all([failed, recovery]);
  await f.player.start();
  assert.equal(f.controller.state, "running");
  await f.player.dispose();
});

test("two players own independent queues", async () => {
  const first = fixture();
  const second = fixture();
  first.composition.loadGate = deferred();
  const loading = first.player.loadCart(new Uint8Array([1]));
  await second.player.loadCart(new Uint8Array([2]));
  await second.player.start();
  assert.equal(second.player.state, "running");
  assert.equal(first.player.state, "loading");
  first.composition.loadGate.resolve();
  await loading;
  await Promise.all([first.player.dispose(), second.player.dispose()]);
});

test("trusted play probes audio synchronously but queues the state mutation", async () => {
  const f = fixture();
  f.composition.loadGate = deferred();
  const loading = f.player.loadCart(new Uint8Array([1]));
  await tick();
  f.elements.playButton.dispatchEvent(new Event("click"));
  assert.deepEqual(f.calls, ["load:1:begin", "audio-probe"]);
  f.composition.loadGate.resolve();
  await loading;
  await f.controller.runLifecycle(async () => {});
  assert.equal(f.controller.state, "running");
  assert.deepEqual(f.calls, ["load:1:begin", "audio-probe", "load:1:end", "start"]);
  await f.player.dispose();
});
