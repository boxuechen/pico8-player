import assert from "node:assert/strict";
import test, { before } from "node:test";

import createZ8LuaModule from "../../wasm/dist/z8lua-runtime-v1.mjs";
import {
  isPlayerHostToRuntime,
  isPlayerRuntimeToHost,
} from "../../apps/web-player/dist/transport/public.js";
import {
  createPlayerWorkerController,
} from "../../apps/web-player/dist/worker/compose-runtime.js";
import { PlayerRuntimeClient } from "../../apps/web-player/dist/main/worker-client.js";
import { RuntimeClientError } from "../../apps/web-player/dist/transport/runtime-error.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
let module;

before(async () => {
  module = await createZ8LuaModule();
});

function textCart(lua) {
  return encoder.encode(
    `pico-8 cartridge // http://www.pico-8.com\nversion 42\n__lua__\n${lua}\n`,
  );
}

function command(type, requestId, overrides = {}) {
  return {
    v: 1,
    type,
    requestId,
    workerGeneration: 1,
    sessionGeneration: 1,
    ...overrides,
  };
}

function menuLabels(event) {
  return event.items.map((item) => [item.slot, decoder.decode(item.label), item.filter]);
}

test("menu transport validators accept only bounded versioned operations and DTOs", () => {
  assert.equal(isPlayerHostToRuntime(command("openPauseMenu", 1)), true);
  assert.equal(isPlayerHostToRuntime(command("closePauseMenu", 2)), true);
  assert.equal(isPlayerHostToRuntime(command("invokeMenuItem", 3, { slot: 5, button: 4 })), true);
  assert.equal(isPlayerHostToRuntime(command("invokeMenuItem", 4, { slot: 0, button: 4 })), false);
  assert.equal(isPlayerHostToRuntime(command("invokeMenuItem", 5, { slot: 1, button: 3 })), false);
  const event = {
    ...command("pause-menu", 6),
    open: true,
    outcome: "opened",
    items: [{ slot: 1, label: encoder.encode("menu").buffer, filter: 0x300 }],
  };
  assert.equal(isPlayerRuntimeToHost(event), true);
  assert.equal(isPlayerRuntimeToHost({ ...event, items: [{ ...event.items[0], filter: 1 }] }), false);
  assert.equal(isPlayerRuntimeToHost({ ...event, items: [{ ...event.items[0], label: new ArrayBuffer(17) }] }), false);
});

test("Worker owns menu pause, filter, refresh, close and host-pause separation", () => {
  const controller = createPlayerWorkerController(module);
  const source = textCart(`
n=0
function keep(b)
 n=n+1
 menuitem(0x101,"count:"..n,keep)
 return true
end
function _init()
 menuitem(0x101,"count:0",keep)
 menuitem(2,"close",function(b) return false end)
 menuitem(3,"remove",function(b) menuitem(3) return true end)
end
function _update() end
function _draw() end`);
  assert.equal(controller.handle(command("loadCart", 1, {
    cartBytes: source.slice().buffer,
  }))[0].state, "ready");
  assert.equal(controller.handle(command("start", 2))[0].state, "running");

  const opened = controller.handle(command("openPauseMenu", 3))[0];
  assert.equal(opened.type, "pause-menu");
  assert.equal(opened.open, true);
  assert.deepEqual(menuLabels(opened), [
    [1, "count:0", 0x100],
    [2, "close", 0],
    [3, "remove", 0],
  ]);

  const filtered = controller.handle(command("invokeMenuItem", 4, { slot: 1, button: 1 }));
  assert.equal(filtered[0].type, "fault");
  assert.match(filtered[0].error.message, /filtered/u);
  const refreshed = controller.handle(command("invokeMenuItem", 5, { slot: 1, button: 2 }))[0];
  assert.equal(refreshed.outcome, "keep-open");
  assert.deepEqual(menuLabels(refreshed)[0], [1, "count:1", 0x100]);

  const closed = controller.handle(command("invokeMenuItem", 6, { slot: 2, button: 4 }));
  assert.deepEqual(closed.map(({ type }) => type), ["pause-menu", "state"]);
  assert.equal(closed[0].open, false);
  assert.equal(closed[1].state, "running");

  controller.handle(command("openPauseMenu", 7));
  const hostPaused = controller.handle(command("pause", 8));
  assert.deepEqual(hostPaused.map((event) => event.type === "state" ? event.state : event.type), [
    "pause-menu",
    "paused",
  ]);
  assert.equal(controller.handle(command("resume", 9))[0].state, "running");
  assert.equal(controller.handle(command("closePauseMenu", 10))[0].type, "fault",
    "host resume must not reopen the guest menu");

  controller.handle(command("openPauseMenu", 11));
  const removed = controller.handle(command("invokeMenuItem", 12, { slot: 3, button: 4 }));
  assert.equal(removed[0].outcome, "removed");
  assert.equal(removed[1].state, "running");
  controller.dispose();
  assert.equal(module._p8w_live_contexts(), 0);
});

test("reset/stale generation and callback faults fail closed without callback retry", () => {
  const controller = createPlayerWorkerController(module);
  const source = textCart(`
function _init() menuitem(1,"fault",function() error("callback once") end) end
function _update() end
function _draw() end`);
  controller.handle(command("loadCart", 1, { cartBytes: source.slice().buffer }));
  controller.handle(command("start", 2));
  controller.handle(command("openPauseMenu", 3));
  const reset = controller.handle(command("reset", 4, { sessionGeneration: 2 }));
  assert.equal(reset[0].state, "ready");
  const stale = controller.handle(command("invokeMenuItem", 5, {
    sessionGeneration: 1,
    slot: 1,
    button: 4,
  }));
  assert.equal(stale[0].type, "fault");
  controller.handle(command("start", 6, { sessionGeneration: 2 }));
  controller.handle(command("openPauseMenu", 7, { sessionGeneration: 2 }));
  const fault = controller.handle(command("invokeMenuItem", 8, {
    sessionGeneration: 2,
    slot: 1,
    button: 4,
  }));
  assert.equal(fault.length, 1);
  assert.equal(fault[0].type, "fault");
  assert.equal(fault[0].error.code, "E_VM_RUNTIME");
  assert.equal(fault[0].error.phase, "menuitem");
  assert.match(fault[0].error.message, /callback once/u);
  const retry = controller.handle(command("invokeMenuItem", 9, {
    sessionGeneration: 2,
    slot: 1,
    button: 4,
  }));
  assert.equal(retry[0].type, "fault");
  assert.match(retry[0].error.message, /active pause menu/u);
  controller.dispose();
});

class FakeMenuWorker {
  constructor({ hangMenu = false } = {}) {
    this.hangMenu = hangMenu;
    this.listener = undefined;
    this.messages = [];
    this.terminated = false;
  }

  addEventListener(type, listener) {
    if (type === "message") this.listener = listener;
  }

  postMessage(message) {
    this.messages.push(message);
    if (message.type === "input" || message.type === "attachAudioPort") return;
    if (message.type === "openPauseMenu" && this.hangMenu) return;
    let response;
    if (["openPauseMenu", "closePauseMenu", "invokeMenuItem"].includes(message.type)) {
      response = {
        ...message,
        type: "pause-menu",
        open: message.type === "openPauseMenu",
        outcome: message.type === "openPauseMenu" ? "opened" : "closed",
        items: [],
      };
      delete response.slot;
      delete response.button;
    } else {
      const states = {
        loadCart: "ready",
        reset: "ready",
        start: "running",
        dispose: "disposed",
      };
      const state = states[message.type];
      response = {
        v: 1,
        type: "state",
        requestId: message.requestId,
        workerGeneration: message.workerGeneration,
        sessionGeneration: message.sessionGeneration,
        state,
        mode: state === "disposed" ? "none" : "callback",
        targetFps: state === "disposed" ? 0 : 30,
        devkitFlags: 0,
      };
    }
    queueMicrotask(() => this.listener?.({ data: response }));
  }

  terminate() {
    this.terminated = true;
  }
}

test("menu command watchdog respawns the Worker and retained cart recovers", async () => {
  const workers = [];
  const client = new PlayerRuntimeClient(() => {
    const worker = new FakeMenuWorker({ hangMenu: workers.length === 0 });
    workers.push(worker);
    return worker;
  }, { commandTimeoutMs: 20 });
  const source = textCart("function _draw() cls(1) end");
  await client.loadCart(source);
  await client.start();
  await assert.rejects(
    client.openPauseMenu(),
    (error) => error instanceof RuntimeClientError &&
      error.record.code === "E_VM_WATCHDOG" && error.record.recoverable,
  );
  assert.equal(workers[0].terminated, true);
  assert.equal(client.workerGeneration, 2);
  assert.equal(client.sessionGeneration, 1);
  await client.reset();
  assert.equal(client.sessionGeneration, 2);
  const recovery = workers[1].messages.find((message) => message.type === "loadCart");
  assert.ok(recovery, "reset after a menu timeout must reload retained bytes");
  assert.deepEqual(new Uint8Array(recovery.cartBytes), source);
  const opened = await client.openPauseMenu();
  assert.equal(opened.type, "pause-menu");
  assert.equal(opened.open, true);
  await client.closePauseMenu();
  await client.dispose();
  assert.equal(workers[1].terminated, true);
  await assert.rejects(
    client.openPauseMenu(),
    (error) => error instanceof RuntimeClientError && error.record.code === "E_INVALID_STATE",
  );
});
