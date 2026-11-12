import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { before } from "node:test";

import { decodeCart } from "@pico8-web/cart-codec";
import {
  CartSession,
  FrameSliceRuntime,
} from "@pico8-web/runtime-core";
import {
  createPicoApiHostRouter,
  Z8LuaFrameVm,
} from "@pico8-web/z8lua-bridge";
import { PcmOutput } from "../../apps/web-player/dist/runtime/audio-transport.js";
import { CartRepositoryAdapter } from "../../apps/web-player/dist/runtime/adapters/cart-repository-adapter.js";
import { createPlayerWorkerController } from "../../apps/web-player/dist/worker/compose-runtime.js";
import { inputSnapshot } from "../helpers/input.mjs";
import createZ8LuaModule from "../../wasm/dist/z8lua-runtime-v1.mjs";

const cartUrl = new URL("../fixtures/integration/system-integration.p8", import.meta.url);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let module;
let cartBytes;
let cart;

before(async () => {
  [module, cartBytes] = await Promise.all([
    createZ8LuaModule(),
    readFile(cartUrl).then((bytes) => new Uint8Array(bytes)),
  ]);
  cart = decodeCart(cartBytes);
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

function assertOk(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}

function sourceCart(source) {
  return { rom: new Uint8Array(0x8000), code: encoder.encode(source) };
}

function textCartBytes(source) {
  return encoder.encode(
    `pico-8 cartridge // http://www.pico-8.com\nversion 42\n__lua__\n${source}\n`,
  );
}

function createRuntime(source, options = {}) {
  const vm = new Z8LuaFrameVm(module, createPicoApiHostRouter(module));
  const runtime = new FrameSliceRuntime(vm, options);
  const boot = runtime.boot(sourceCart(source));
  return { runtime, boot };
}

function mergeSeed(seeds, commit) {
  if (commit === undefined) return;
  seeds.current = [
    ...seeds.current.filter((seed) => seed.id !== commit.id),
    { id: commit.id, bytes: commit.bytes.slice() },
  ];
}

function createSession(repository, seeds) {
  repository.registerCart(cart);
  return new CartSession({
    createRuntime(context) {
      const vm = new Z8LuaFrameVm(module, createPicoApiHostRouter(module));
      try {
        return new FrameSliceRuntime(vm, {
          instructionBudget: 2_000_000,
          cartDataSeeds: seeds.current,
          currentCart: { identity: context.cart.identity, repository },
          runParameter: context.runParameter,
        });
      } catch (error) {
        vm.destroy();
        throw error;
      }
    },
  });
}

test("appends reset without changing the preceding host ABI", async () => {
  const abi = JSON.parse(await readFile(
    new URL("../../spec/abi/pico-host-api-v1.json", import.meta.url),
    "utf8",
  ));
  assert.equal(abi.bindings.length, 41);
  assert.deepEqual(
    abi.bindings.slice(38).map(({ id, guestName, hostMethod }) => [id, guestName, hostMethod]),
    [
      [39, "rrect", "rrect"],
      [40, "rrectfill", "rrectfill"],
      [41, "reset", "resetSystem"],
    ],
  );
  assert.ok(module._p8w_abi_version() >= 0x0001_0003);
});

test("reset restores only system defaults and assert remains a structured VM fault", () => {
  const resetCase = createRuntime(`
function _init()
 poke(0x4400,0x6d)
 camera(7,9) clip(1,2,3,4) pal(1,8) fillp(0x1234)
 reset()
 poke(0x4410,peek(0x5f00),peek(0x5f01),peek(0x5f10),peek(0x5f20))
 poke(0x4414,peek(0x5f22),peek(0x5f25),peek(0x5f28),peek(0x5f31))
end
function _update() end
function _draw() end`);
  try {
    assert.equal(assertOk(resetCase.boot).kind, "ready");
    assert.equal(resetCase.runtime.copyRam(0x4400, 1)[0], 0x6d);
    assert.deepEqual([...resetCase.runtime.copyRam(0x4410, 8)], [
      0x10, 1, 0, 0, 128, 6, 0, 0,
    ]);
  } finally {
    resetCase.runtime.dispose();
  }

  const assertion = createRuntime(`
function _update() assert(false,"phase4e assertion") end
function _draw() end`);
  try {
    assert.equal(assertOk(assertion.boot).kind, "ready");
    const fault = assertion.runtime.step();
    assert.equal(fault.ok, false);
    assert.equal(fault.error.code, "E_VM_RUNTIME");
    assert.equal(fault.error.phase, "update");
    assert.match(fault.error.message, /phase4e assertion/u);
  } finally {
    assertion.runtime.dispose();
  }
});

test("nested flip stays bounded while external references transfer to the Phase 5 root pipeline", () => {
  const nested = createRuntime(`
co=cocreate(function() flip() end)
function _update() coresume(co) end
function _draw() end`);
  try {
    assert.equal(assertOk(nested.boot).kind, "ready");
    const fault = nested.runtime.step();
    assert.equal(fault.ok, false);
    assert.equal(fault.error.code, "E_FEATURE_UNSUPPORTED");
    assert.equal(fault.error.details?.reason, "nested-host-suspend");
  } finally {
    nested.runtime.dispose();
  }

  const repository = new CartRepositoryAdapter();
  const seeds = { current: [] };
  const session = createSession(repository, seeds);
  try {
    const externalCart = {
      ...cart,
      code: encoder.encode(`
function _update() reload(0,0,1,"other") end
function _draw() end`),
    };
    assert.equal(assertOk(session.load(externalCart)).kind, "ready");
    const transfer = assertOk(session.step());
    assert.equal(transfer.kind, "host-request");
    assert.equal(transfer.request.operation, "step");
    assert.equal(transfer.request.generation, session.generation);
    assert.equal(repository.readData(cart.identity, 0, 1)[0], cart.rom[0]);
  } finally {
    session.dispose();
    repository.dispose();
  }
});

test("real WASM combined flow preserves audio, input, cartdata and current-cart state across run/stop", () => {
  const repository = new CartRepositoryAdapter();
  const seeds = { current: [] };
  const session = createSession(repository, seeds);
  try {
    const ready = assertOk(session.load(cart));
    assert.equal(ready.kind, "ready");
    mergeSeed(seeds, ready.cartDataCommit);

    const first = assertOk(session.step(inputSnapshot([16])));
    assert.equal(first.kind, "frame");
    mergeSeed(seeds, first.frame.cartDataCommit);
    assert.equal(hex(session.copyRam(0x5000, 8).value), "000001010101015a");
    assert.deepEqual([...session.copyRam(0x5020, 12).value], [
      0x10, 1, 0, 0, 128, 6, 0, 0, 0, 0, 0, 0,
    ]);
    assert.equal(first.frame.timeRawBeforeStep, 4369);
    assert.equal(sha256(first.frame.audio.pcm16le),
      "4031623795db82a594c88db8ac94fd4b1cd9e72fc1fc8db533a8a66195b56514");
    assert.equal(sha256(first.frame.screen),
      "99d598ca6fa57a75dc4de3b4ef57ece7168b48acd3e2d3d31e0b9117575a5af9");

    const run = assertOk(session.step(inputSnapshot()));
    assert.equal(run.kind, "restart");
    assert.equal(decoder.decode(run.parameter), "again");
    mergeSeed(seeds, run.cartDataCommit);

    const restarted = assertOk(session.restart(run.parameter));
    assert.equal(restarted.kind, "ready");
    mergeSeed(seeds, restarted.cartDataCommit);
    assert.equal(hex(session.copyRam(0x5000, 9).value), "05610201000000005a");

    const afterRun = assertOk(session.step(inputSnapshot([16])));
    assert.equal(afterRun.kind, "frame");
    mergeSeed(seeds, afterRun.frame.cartDataCommit);
    assert.equal(sha256(afterRun.frame.screen),
      "0f6cba94d7a5b5020d588ba0de35305889133df861c881d6c585d8065289e393");
    const second = assertOk(session.step(inputSnapshot()));
    assert.equal(second.kind, "frame");
    mergeSeed(seeds, second.frame.cartDataCommit);
    assert.equal(sha256(second.frame.screen),
      "23c4dcfc453cefc396aec4b772d86c05b5faf81e59901c86d6caf8fde3483668");

    const stopped = assertOk(session.step(inputSnapshot()));
    assert.equal(stopped.kind, "stopped");
    assert.equal(decoder.decode(stopped.message), "done");
    mergeSeed(seeds, stopped.cartDataCommit);
    assert.equal(sha256(seeds.current[0].bytes),
      "2692e9c03cab0b0b29228a6f42380edd3010159b1005c0f04f23cb5bb2a1990a");
    assert.equal(repository.readData(cart.identity, 0x100, 1)[0], 0x5a);
    assert.equal(session.state, "stopped");
  } finally {
    session.dispose();
    repository.dispose();
  }
});

class MemoryPersistence {
  durable = new Map();
  pending = new Map();
  flushes = 0;

  async hydrate() {
    return [...this.durable].map(([id, bytes]) => ({ id, bytes: bytes.slice() }));
  }

  enqueue(commit) {
    this.pending.set(commit.id, commit.bytes.slice());
  }

  async flush() {
    this.flushes += 1;
    for (const [id, bytes] of this.pending) this.durable.set(id, bytes.slice());
    this.pending.clear();
  }

  takeDiagnostics() {
    return [];
  }

  async dispose() {
    await this.flush();
  }
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

test("production Worker state machine emits guest controls and resets audio/persistence ownership", async () => {
  const audioMessages = [];
  const audio = new PcmOutput();
  audio.attach({
    postMessage(message) {
      audioMessages.push(message);
    },
    close() {},
  }, 1);
  const persistence = new MemoryPersistence();
  const controller = createPlayerWorkerController(module, {
    audioTransport: audio,
    persistence,
  });
  const events = [];
  async function send(value) {
    const result = await controller.handle(value);
    events.push(...result);
    return result;
  }
  async function input(sequence, snapshot) {
    await send({
      ...command("input", 0),
      sequence,
      input: snapshot,
    });
  }
  try {
    let result = await send(command("loadCart", 1, {
      cartBytes: cartBytes.slice().buffer,
      instructionBudget: 2_000_000,
    }));
    assert.equal(result.at(-1).type, "state");
    assert.equal(result.at(-1).state, "ready");
    await send(command("start", 2));
    await send(command("vsync", 3, { sequence: 1, timestampMs: 1_000 }));

    await input(1, inputSnapshot([16]));
    result = await send(command("vsync", 4, {
      sequence: 2,
      timestampMs: 1_000 + 1_000 / 30,
    }));
    assert.equal(result.filter((event) => event.type === "frame").length, 1);

    await input(2, inputSnapshot());
    result = await send(command("vsync", 5, {
      sequence: 3,
      timestampMs: 1_000 + 2_000 / 30,
    }));
    const runEvent = result.find((event) => event.type === "runtime-control");
    assert.equal(runEvent?.control, "run");
    assert.equal(decoder.decode(runEvent.payload), "again");
    assert.equal(result.find((event) => event.type === "state")?.state, "running");
    assert.ok(persistence.flushes >= 1, "guest run must flush its persistence boundary");

    await send(command("vsync", 6, { sequence: 4, timestampMs: 2_000 }));
    for (let index = 0; index < 3; index += 1) {
      await input(3 + index, index === 0 ? inputSnapshot([16]) : inputSnapshot());
      result = await send(command("vsync", 7 + index, {
        sequence: 5 + index,
        timestampMs: 2_000 + (index + 1) * 1_000 / 30,
      }));
    }
    const stopEvent = result.find((event) => event.type === "runtime-control");
    assert.equal(stopEvent?.control, "stop");
    assert.equal(decoder.decode(stopEvent.payload), "done");
    assert.equal(result.find((event) => event.type === "state")?.state, "stopped");
    assert.ok(persistence.flushes >= 2, "guest stop must flush its persistence boundary");
    assert.equal(sha256(persistence.durable.get("phase4e")),
      "2692e9c03cab0b0b29228a6f42380edd3010159b1005c0f04f23cb5bb2a1990a");

    const zeroTimelineResets = audioMessages.filter((message) =>
      message.type === "audioReset" && message.nextSequence === 0 && message.firstSample === "0"
    );
    assert.ok(zeroTimelineResets.length >= 2, "guest run must reset the same-generation audio timeline");
    assert.ok(audioMessages.some((message) => message.type === "audioChunk"));

    const stale = await send(command("start", 20, { sessionGeneration: 0 }));
    assert.equal(stale[0].type, "fault");
    assert.equal(stale[0].error.code, "E_INVALID_STATE");
  } finally {
    await controller.dispose();
    audio.dispose();
  }
});

test("production Worker publishes guest controls reached during boot", async () => {
  const controller = createPlayerWorkerController(module);
  try {
    const result = await controller.handle(command("loadCart", 1, {
      cartBytes: textCartBytes('stop("boot-stop")').buffer,
      instructionBudget: 2_000_000,
    }));
    assert.deepEqual(result.map((event) => event.type), ["runtime-control", "state"]);
    assert.equal(result[0].control, "stop");
    assert.equal(decoder.decode(result[0].payload), "boot-stop");
    assert.equal(result[1].state, "stopped");
  } finally {
    await controller.dispose();
  }
});
