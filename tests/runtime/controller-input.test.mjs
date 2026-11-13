import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { before } from "node:test";
import { inputSnapshot } from "../helpers/input.mjs";

import {
  PICO_CONTROLLER_BUTTON_COUNT,
  PICO_CONTROLLER_BUTTON_MASK,
  PICO_CONTROLLER_COUNT,
} from "@pico8-player/contracts";
import {
  createPicoApiHost,
  FrameSliceRuntime,
  L1Input,
} from "@pico8-player/runtime-core";
import {
  createPicoApiHostRouter,
  Z8LuaFrameVm,
} from "@pico8-player/z8lua-bridge";
import createZ8LuaModule from "../../wasm/dist/z8lua-runtime-v1.mjs";
import { isPlayerHostToRuntime } from "../../apps/player/dist/transport/public.js";
import * as transport from "../../apps/player/dist/transport/public.js";
import {
  GamepadInputFrontend,
} from "../../apps/player/dist/main/gamepad-input.js";
import {
  KeyboardInputFrontend,
} from "../../apps/player/dist/main/input-frontend.js";
import {
  PlayerInputFrontend,
} from "../../apps/player/dist/main/player-input.js";
import {
  TouchInputFrontend,
} from "../../apps/player/dist/main/touch-input.js";
import {
  createPlayerWorkerController,
} from "../../apps/player/dist/worker/compose-runtime.js";

const encoder = new TextEncoder();
const ZERO = Object.freeze(new Array(8).fill(0));
let module;

before(async () => {
  module = await createZ8LuaModule();
});

function q16(value) {
  return value << 16;
}

function snapshot(...controllers) {
  return inputSnapshot([...controllers, ...ZERO].slice(0, 8));
}

function sourceCart(source) {
  return {
    rom: new Uint8Array(0x8000),
    code: encoder.encode(source),
  };
}

function textCart(source) {
  return encoder.encode(
    `pico-8 cartridge // http://www.pico-8.com\nversion 42\n__lua__\n${source}\n`,
  );
}

function createRuntime() {
  const vm = new Z8LuaFrameVm(module, createPicoApiHostRouter(module));
  return new FrameSliceRuntime(vm, {
    picoApiHost: createPicoApiHost(vm.memory, vm.logicalMemory),
  });
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

function eventWith(type, properties = {}) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [name, value] of Object.entries(properties)) {
    Object.defineProperty(event, name, { configurable: true, value });
  }
  return event;
}

class FakeDocument extends EventTarget {
  activeElement;
  visibilityState = "visible";
}

class FakeElement extends EventTarget {
  dataset = {};
  captured = [];
  children = [];

  querySelectorAll() {
    return this.children;
  }

  setPointerCapture(pointerId) {
    this.captured.push(pointerId);
  }
}

function gamepad({ index = 0, axes = [0, 0], pressed = [] } = {}) {
  return {
    index,
    connected: true,
    mapping: "standard",
    axes,
    buttons: Array.from({ length: 16 }, (_, button) => ({
      pressed: pressed.includes(button),
      touched: false,
      value: pressed.includes(button) ? 1 : 0,
    })),
  };
}

function buildGolden() {
  const ram = new Uint8Array(0x10000);
  const input = new L1Input(ram);
  const trace = [];
  for (let tick = 0; tick < 48; tick += 1) {
    const controllers = Array.from(
      { length: 8 },
      (_, player) => ((tick * 5 + player * 11) ^ (1 << ((tick + player) % 6))) & 0x3f,
    );
    input.beginTick(inputSnapshot(controllers), tick < 24 ? 30 : 60);
    const pressed = Array.from({ length: 8 }, (_, player) => {
      let mask = 0;
      for (let button = 0; button < 6; button += 1) {
        if (input.btnp(q16(button), q16(player))) mask |= 1 << button;
      }
      return mask;
    });
    trace.push({ controllers, pressed, both: input.btn() });
  }
  const serialized = JSON.stringify(trace);
  return {
    traceSha256: createHash("sha256").update(serialized).digest("hex"),
    finalRegistersHex: Buffer.from(ram.subarray(0x5f4c, 0x5f54)).toString("hex"),
    finalPressed: trace.at(-1).pressed,
  };
}

test("real WASM btn/btnp exposes all eight players, the P0/P1 bitfield and RAM registers", () => {
  const runtime = createRuntime();
  const boot = runtime.boot(sourceCart(`
function _update60()
 poke2(0x4300,btn())
 for p=0,7 do
  for b=0,5 do
   if btn(b,p) then poke(0x4310+p*6+b,1) end
   if btnp(b,p) then poke(0x4350+p*6+b,1) end
  end
 end
 if btn(0,8) or btn(6,0) or btnp(0,8) then poke(0x4390,1) end
end
function _draw() end`));
  assert.equal(boot.ok, true, JSON.stringify(boot));
  const controllers = [1, 2, 4, 8, 16, 32, 3, 63];
  const stepped = runtime.step(inputSnapshot(controllers));
  assert.equal(stepped.ok, true, JSON.stringify(stepped));
  const ram = runtime.copyRam(0, 0x10000);
  assert.deepEqual([...ram.subarray(0x5f4c, 0x5f54)], controllers);
  assert.equal(ram[0x4300] | (ram[0x4301] << 8), 1 | (2 << 8));
  for (let player = 0; player < 8; player += 1) {
    for (let button = 0; button < 6; button += 1) {
      const expected = (controllers[player] & (1 << button)) === 0 ? 0 : 1;
      assert.equal(ram[0x4310 + player * 6 + button], expected);
      assert.equal(ram[0x4350 + player * 6 + button], expected);
    }
  }
  assert.equal(ram[0x4390], 0);
  runtime.dispose();
});

test("eight independent repeat latches honor 30/60 Hz registers and reset", () => {
  const ram = new Uint8Array(0x10000);
  const input = new L1Input(ram);
  const held = snapshot(1, 1, 1, 1, 1, 1, 1, 1);
  input.beginTick(held, 60);
  for (let player = 0; player < 8; player += 1) {
    assert.equal(input.btnp(q16(0), q16(player)), 1);
  }
  for (let tick = 0; tick < 29; tick += 1) input.beginTick(held, 60);
  for (let player = 0; player < 8; player += 1) {
    assert.equal(input.btnp(q16(0), q16(player)), 0);
  }
  input.beginTick(held, 60);
  for (let player = 0; player < 8; player += 1) {
    assert.equal(input.btnp(q16(0), q16(player)), 1);
  }
  ram[0x5f5c] = 255;
  input.beginTick(snapshot(0, 0, 0, 0, 0, 0, 0, 0), 30);
  input.beginTick(held, 30);
  for (let tick = 0; tick < 64; tick += 1) input.beginTick(held, 30);
  assert.equal(input.btnp(q16(0), q16(7)), 0);
  input.reset();
  assert.deepEqual([...ram.subarray(0x5f4c, 0x5f54)], [...ZERO]);
  assert.equal(input.btn(), 0);
});

test("fixed input DTO rejects malformed masks without advancing runtime state", () => {
  assert.deepEqual(
    [transport.PICO_CONTROLLER_COUNT, transport.PICO_CONTROLLER_BUTTON_COUNT, transport.PICO_CONTROLLER_BUTTON_MASK],
    [PICO_CONTROLLER_COUNT, PICO_CONTROLLER_BUTTON_COUNT, PICO_CONTROLLER_BUTTON_MASK],
  );
  const runtime = createRuntime();
  assert.equal(runtime.boot(sourceCart("function _draw() end")).ok, true);
  for (const input of [
    { ...inputSnapshot(), controllers: [0] },
    { ...inputSnapshot(), controllers: [0, 0, 0, 0, 0, 0, 0, 64] },
    { ...inputSnapshot(), controllers: new Uint8Array(8) },
  ]) {
    const result = runtime.step(input);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "E_INVALID_STATE");
  }
  const validEnvelope = command("input", {
    requestId: 0,
    sequence: 1,
    input: snapshot(1, 2, 4, 8, 16, 32, 3, 63),
  });
  assert.equal(isPlayerHostToRuntime(validEnvelope), true);
  assert.equal(isPlayerHostToRuntime({
    ...validEnvelope,
    input: inputSnapshot([0, 0, 0, 0, 0, 0, 0, 64]),
  }), false);
  runtime.dispose();
});

test("Worker copies the latest eight-player snapshot and rejects stale sequence/generation", () => {
  const controller = createPlayerWorkerController(module);
  const cart = textCart(`
x=0
function _update60() if btn(0,7) then x+=1 end end
function _draw() cls(1) pset(x,0,7) end`);
  assert.equal(controller.handle(command("loadCart", {
    cartBytes: cart.slice().buffer,
  }))[0].state, "ready");
  assert.equal(controller.handle(command("start", { requestId: 2 }))[0].state, "running");
  const controllers = [0, 0, 0, 0, 0, 0, 0, 1];
  controller.handle(command("input", {
    requestId: 0,
    sequence: 2,
    input: inputSnapshot(controllers),
  }));
  controllers[7] = 0;
  controller.handle(command("input", {
    requestId: 0,
    sequence: 1,
    input: snapshot(),
  }));
  controller.handle(command("vsync", { requestId: 3, sequence: 1, timestampMs: 0 }));
  const catchUp = controller.handle(command("vsync", {
    requestId: 4,
    sequence: 2,
    timestampMs: 50,
  }));
  assert.equal(catchUp.filter(({ type }) => type === "frame").length, 3);
  const finalFrame = catchUp.filter(({ type }) => type === "frame").at(-1);
  assert.equal(new Uint8Array(finalFrame.packedScreen)[1], 0x71);

  const reset = controller.handle(command("reset", { requestId: 5, sessionGeneration: 2 }));
  assert.equal(reset[0].state, "ready");
  controller.handle(command("start", { requestId: 6, sessionGeneration: 2 }));
  controller.handle(command("input", {
    requestId: 0,
    sessionGeneration: 1,
    sequence: 99,
    input: snapshot(0, 0, 0, 0, 0, 0, 0, 1),
  }));
  controller.handle(command("vsync", {
    requestId: 7,
    sessionGeneration: 2,
    sequence: 1,
    timestampMs: 100,
  }));
  const afterReset = controller.handle(command("vsync", {
    requestId: 8,
    sessionGeneration: 2,
    sequence: 2,
    timestampMs: 117,
  }));
  assert.equal(new Uint8Array(afterReset.find(({ type }) => type === "frame").packedScreen)[0], 0x17);
  controller.dispose();
});

test("keyboard maps documented player 0/1 aliases and releases aliases independently", () => {
  const fakeWindow = new EventTarget();
  const document = new FakeDocument();
  const focus = new FakeElement();
  document.activeElement = focus;
  const keyboard = new KeyboardInputFrontend(focus, {
    window: fakeWindow,
    document,
  });
  keyboard.setEnabled(true);
  fakeWindow.dispatchEvent(eventWith("keydown", { code: "ArrowRight" }));
  fakeWindow.dispatchEvent(eventWith("keydown", { code: "KeyZ" }));
  fakeWindow.dispatchEvent(eventWith("keydown", { code: "KeyC" }));
  fakeWindow.dispatchEvent(eventWith("keydown", { code: "KeyS" }));
  fakeWindow.dispatchEvent(eventWith("keydown", { code: "ShiftLeft" }));
  fakeWindow.dispatchEvent(eventWith("keydown", { code: "Tab" }));
  assert.deepEqual(keyboard.snapshot().controllers.slice(0, 2), [0x12, 0x31]);
  fakeWindow.dispatchEvent(eventWith("keyup", { code: "KeyZ" }));
  assert.equal(keyboard.snapshot().controllers[0], 0x12);
  fakeWindow.dispatchEvent(eventWith("keyup", { code: "KeyC" }));
  assert.equal(keyboard.snapshot().controllers[0], 0x02);
  fakeWindow.dispatchEvent(new Event("blur"));
  assert.deepEqual(keyboard.snapshot().controllers, [...ZERO]);
  fakeWindow.dispatchEvent(eventWith("keydown", { code: "KeyF" }));
  assert.equal(keyboard.snapshot().controllers[1], 0x02);
  document.visibilityState = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  assert.deepEqual(keyboard.snapshot().controllers, [...ZERO]);
  keyboard.dispose();
});

test("standard Gamepad slots apply d-pad, O/X and axis hysteresis then clear disconnect", () => {
  let pads = [null, null, gamepad({ index: 2, axes: [-0.6, 0.7], pressed: [0, 15] })];
  const frontend = new GamepadInputFrontend({ source: { getGamepads: () => pads } });
  frontend.setEnabled(true);
  assert.equal(frontend.snapshot().controllers[2], 0x1b);
  pads = [null, null, gamepad({ index: 2, axes: [-0.4, 0], pressed: [] })];
  assert.equal(frontend.snapshot().controllers[2], 0x01, "axis remains latched above release threshold");
  pads = [null, null, gamepad({ index: 2, axes: [-0.3, 0], pressed: [1] })];
  assert.equal(frontend.snapshot().controllers[2], 0x20);
  pads = [null, null, null];
  assert.equal(frontend.snapshot().controllers[2], 0);
  frontend.dispose();
});

test("multitouch tracks multiple pointers and cancel does not clear another source", () => {
  const fakeWindow = new EventTarget();
  const document = new FakeDocument();
  const root = new FakeElement();
  const left = new FakeElement();
  left.dataset.picoPlayer = "0";
  left.dataset.picoButton = "0";
  const action = new FakeElement();
  action.dataset.picoPlayer = "0";
  action.dataset.picoButton = "4";
  root.children = [left, action];
  const touch = new TouchInputFrontend(root, { window: fakeWindow, document });
  touch.setEnabled(true);
  left.dispatchEvent(eventWith("pointerdown", { pointerId: 7 }));
  action.dispatchEvent(eventWith("pointerdown", { pointerId: 8 }));
  assert.equal(touch.snapshot().controllers[0], 0x11);
  left.dispatchEvent(eventWith("pointerup", { pointerId: 7 }));
  assert.equal(touch.snapshot().controllers[0], 0x10);
  action.dispatchEvent(eventWith("pointercancel", { pointerId: 8 }));
  assert.equal(touch.snapshot().controllers[0], 0);
  action.dispatchEvent(eventWith("pointerdown", { pointerId: 9 }));
  action.dispatchEvent(eventWith("lostpointercapture", { pointerId: 9 }));
  assert.equal(touch.snapshot().controllers[0], 0);
  action.dispatchEvent(eventWith("pointerdown", { pointerId: 10 }));
  document.visibilityState = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  assert.deepEqual(touch.snapshot().controllers, [...ZERO]);
  touch.dispose();
});

test("device source merge is bitwise and releasing keyboard preserves Gamepad/touch", () => {
  const fakeWindow = new EventTarget();
  const document = new FakeDocument();
  const focus = new FakeElement();
  document.activeElement = focus;
  const root = new FakeElement();
  const action = new FakeElement();
  action.dataset.picoButton = "4";
  root.children = [action];
  let pads = [gamepad({ axes: [0.7, 0] })];
  const input = new PlayerInputFrontend(focus, {
    window: fakeWindow,
    document,
    gamepadSource: { getGamepads: () => pads },
    touchRoot: root,
  });
  input.setEnabled(true);
  fakeWindow.dispatchEvent(eventWith("keydown", { code: "ArrowRight" }));
  action.dispatchEvent(eventWith("pointerdown", { pointerId: 1 }));
  assert.equal(input.snapshot().controllers[0], 0x12);
  fakeWindow.dispatchEvent(eventWith("keyup", { code: "ArrowRight" }));
  assert.equal(input.snapshot().controllers[0], 0x12, "Gamepad still holds right");
  pads = [];
  assert.equal(input.snapshot().controllers[0], 0x10, "touch still holds O");
  input.dispose();
});

test("eight-player deterministic input replay matches the project golden", async () => {
  const golden = JSON.parse(await readFile(
    new URL("../golden/input.json", import.meta.url),
    "utf8",
  ));
  assert.deepEqual(buildGolden(), golden);
  assert.deepEqual(buildGolden(), golden);
});
