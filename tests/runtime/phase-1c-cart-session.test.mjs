import assert from "node:assert/strict";
import test, { before } from "node:test";
import { inputSnapshot } from "../helpers/input.mjs";

import {
  CartSession,
  FrameSliceRuntime,
} from "@pico8-web/runtime-core";
import {
  createPicoApiHostRouter,
  Z8LuaFrameVm,
} from "@pico8-web/z8lua-bridge";
import createZ8LuaModule from "../../wasm/dist/z8lua-runtime-v1.mjs";

const encoder = new TextEncoder();
let module;

before(async () => {
  module = await createZ8LuaModule();
});

function makeCart(source, options = {}) {
  const rom = options.rom?.slice() ?? new Uint8Array(0x8000);
  const code = encoder.encode(source);
  const digestCharacter = options.digestCharacter ?? "a";
  return {
    identity: Object.freeze({ contentSha256: digestCharacter.repeat(64) }),
    format: options.format ?? "p8",
    version: 42,
    rom,
    code,
    warnings: Object.freeze([]),
    sourceBytes: code.byteLength,
    cartVersion: 42,
    luaSource: code,
  };
}

function ready(mode = "callback", targetFps = 30) {
  return {
    ok: true,
    value: {
      kind: "ready",
      mode,
      targetFps,
      cpuInstructions: 0,
      cpuFractionRaw: 0,
      slowFrame: false,
      devkitFlags: 0,
      audio: silentAudio(targetFps === 60 ? 735 : 735),
    },
  };
}

function silentAudio(frameCount = 735, firstSample = "0") {
  return {
    firstSample,
    frameCount,
    pcm16le: new Uint8Array(frameCount * 2),
  };
}

function frame(frameId = 0) {
  return {
    ok: true,
    value: {
      kind: "frame",
      frame: {
        frameId,
        completedSlices: String(frameId + 2),
        timeRawBeforeStep: 0,
        targetFps: 30,
        cpuInstructions: 0,
        cpuFractionRaw: 0,
        slowFrame: false,
        devkitFlags: 0,
        screen: new Uint8Array(0x2000),
        displayPalette: Uint8Array.from({ length: 16 }, (_, index) => index),
        audio: silentAudio(735, String(frameId * 735)),
      },
    },
  };
}

class FakeRuntime {
  state = "empty";
  bootCalls = [];
  stepCalls = [];
  completionCalls = [];
  disposeCalls = 0;
  memory = new Uint8Array(0x10000);
  script;

  constructor(script = {}) {
    this.script = script;
  }

  boot(cart, input) {
    this.bootCalls.push({
      rom: cart.rom.slice(),
      code: cart.code.slice(),
      input: { ...input },
    });
    const result = this.script.boot?.(cart, input, this) ?? ready();
    this.state = result.ok
      ? result.value.kind === "host-request" ? "waiting-host" : "ready"
      : "faulted";
    return result;
  }

  step(input = inputSnapshot([0, 0, 0, 0, 0, 0, 0, 0])) {
    this.stepCalls.push({ ...input });
    const result = this.script.step?.(input, this) ?? frame(this.stepCalls.length - 1);
    this.state = result.ok
      ? result.value.kind === "host-request" ? "waiting-host" : "ready"
      : "faulted";
    return result;
  }

  completeHostRequest(requestId, response, isError = false) {
    this.completionCalls.push({ requestId, response: response.slice(), isError });
    const result = this.script.complete?.(requestId, response, isError, this) ?? frame(0);
    this.state = result.ok
      ? result.value.kind === "host-request" ? "waiting-host" : "ready"
      : "faulted";
    return result;
  }

  copyRam(offset, length) {
    return this.memory.slice(offset, offset + length);
  }

  dispose() {
    this.disposeCalls += 1;
    this.state = "disposed";
    if (this.script.disposeThrows) throw new Error("fake dispose failure");
  }
}

function createFakeSession(scriptFactory = () => ({})) {
  const runtimes = [];
  const contexts = [];
  const session = new CartSession({
    createRuntime(context) {
      contexts.push(context);
      const runtime = new FakeRuntime(scriptFactory(context, runtimes.length));
      runtimes.push(runtime);
      return runtime;
    },
  });
  return { session, runtimes, contexts };
}

function assertOk(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}

test("load/reset own cart bytes, use zero input, and replace the full runtime graph", () => {
  const { session, runtimes, contexts } = createFakeSession();
  const cart = makeCart("function _update() end function _draw() end");
  cart.rom[0] = 0x31;
  cart.code[0] = 0x66;

  const loaded = assertOk(session.load(cart));
  assert.deepEqual(loaded, {
    kind: "ready",
    generation: 1,
    mode: "callback",
    targetFps: 30,
    cpuInstructions: 0,
    cpuFractionRaw: 0,
    slowFrame: false,
    devkitFlags: 0,
    audio: silentAudio(),
  });
  assert.equal(session.state, "ready");
  assert.equal(Object.isFrozen(session.cart), true);
  assert.equal(Object.isFrozen(session.cart.identity), true);
  assert.equal(Object.isFrozen(contexts[0]), true);
  assert.equal(Object.isFrozen(contexts[0].cart), true);
  assert.deepEqual(runtimes[0].bootCalls[0].input, inputSnapshot([0, 0, 0, 0, 0, 0, 0, 0]));

  cart.rom[0] = 0xee;
  cart.code[0] = 0xee;
  const reset = assertOk(session.reset());
  assert.equal(reset.generation, 2);
  assert.notEqual(runtimes[0], runtimes[1]);
  assert.equal(runtimes[0].disposeCalls, 1);
  assert.equal(runtimes[1].bootCalls[0].rom[0], 0x31);
  assert.equal(runtimes[1].bootCalls[0].code[0], 0x66);
  assert.deepEqual(runtimes[1].bootCalls[0].input, inputSnapshot([0, 0, 0, 0, 0, 0, 0, 0]));
  assert.deepEqual(contexts.map(({ generation }) => generation), [1, 2]);

  const badCart = { ...cart, rom: new Uint8Array(4) };
  const rejected = session.load(badCart);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, "E_INVALID_STATE");
  assert.equal(session.state, "ready");
  assert.equal(session.generation, 2);
  assert.equal(runtimes[1].disposeCalls, 0);
  assert.equal(session.lastError, undefined);

  const replacement = makeCart(
    "function _update60() end function _draw() end",
    { digestCharacter: "b" },
  );
  replacement.rom[0] = 0x42;
  const swapped = assertOk(session.load(replacement));
  assert.equal(swapped.generation, 3);
  assert.equal(runtimes[1].disposeCalls, 1);
  assert.equal(runtimes[2].bootCalls[0].rom[0], 0x42);
  assert.equal(session.cart.identity.contentSha256, "b".repeat(64));
  assertOk(session.dispose());
});

test("generation and request id reject stale host completions without poisoning active state", () => {
  const hostRequest = {
    ok: true,
    value: {
      kind: "host-request",
      request: { id: 7, bytes: Uint8Array.of(1, 2, 3), operation: "step" },
    },
  };
  const { session, runtimes } = createFakeSession(() => ({
    step: () => hostRequest,
    complete: () => frame(0),
  }));
  const cart = makeCart("function _update() end function _draw() end");
  assertOk(session.load(cart));
  const firstRequest = assertOk(session.step());
  assert.equal(firstRequest.kind, "host-request");
  assert.equal(firstRequest.request.generation, 1);
  assert.equal(session.state, "waiting-host");

  assertOk(session.reset());
  const stale = session.completeHostRequest(1, 7, Uint8Array.of(9));
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, "E_INVALID_STATE");
  assert.equal(session.state, "ready");
  assert.equal(session.generation, 2);
  assert.equal(runtimes[1].completionCalls.length, 0);
  assert.equal(session.lastError, undefined);

  const currentRequest = assertOk(session.step());
  assert.equal(currentRequest.request.generation, 2);
  const wrongId = session.completeHostRequest(2, 8, new Uint8Array());
  assert.equal(wrongId.ok, false);
  assert.equal(session.state, "waiting-host");
  assert.equal(runtimes[1].completionCalls.length, 0);

  const completed = assertOk(session.completeHostRequest(2, 7, Uint8Array.of(4)));
  assert.equal(completed.kind, "frame");
  assert.equal(completed.generation, 2);
  assert.equal(session.state, "ready");
  assert.equal(runtimes[1].completionCalls.length, 1);
  assertOk(session.dispose());
});

test("boot and step faults dispose exactly once while stop retains the cart for reset", () => {
  const runtimeFault = {
    code: "E_VM_RUNTIME",
    message: "synthetic runtime fault",
    phase: "update",
    line: 3,
    recoverable: false,
  };
  const { session, runtimes } = createFakeSession((_context, index) => (
    index === 0
      ? { boot: () => ({ ok: false, error: runtimeFault }), disposeThrows: true }
      : index === 1
        ? { step: () => ({ ok: false, error: runtimeFault }) }
        : {}
  ));
  const cart = makeCart("function _update() end function _draw() end");

  const bootFault = session.load(cart);
  assert.equal(bootFault.ok, false);
  assert.equal(bootFault.error, runtimeFault);
  assert.equal(session.state, "faulted");
  assert.equal(session.lastError, runtimeFault);
  assert.equal(runtimes[0].disposeCalls, 1);

  assertOk(session.reset());
  const stepFault = session.step();
  assert.equal(stepFault.ok, false);
  assert.equal(session.state, "faulted");
  assert.equal(runtimes[1].disposeCalls, 1);

  assertOk(session.reset());
  const stopped = assertOk(session.stop());
  assert.deepEqual(stopped, { kind: "stopped", generation: 3 });
  assert.equal(runtimes[2].disposeCalls, 1);
  assertOk(session.stop());
  assert.equal(runtimes[2].disposeCalls, 1);

  assertOk(session.reset());
  assert.equal(session.generation, 4);
  assertOk(session.dispose());
  assert.equal(runtimes[3].disposeCalls, 1);
  assertOk(session.dispose());
  assert.equal(runtimes[3].disposeCalls, 1);
  assert.equal(session.state, "disposed");
  assert.equal(session.cart, undefined);
  assert.equal(session.reset().error.code, "E_INVALID_STATE");
});

test("runtime factory throws and cross-generation object reuse are contained invariants", () => {
  const cart = makeCart("function _update() end function _draw() end");
  let attempts = 0;
  const throwing = new CartSession({
    createRuntime() {
      attempts += 1;
      throw new Error("synthetic factory failure");
    },
  });
  const failed = throwing.load(cart);
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, "E_INVARIANT");
  assert.match(failed.error.message, /factory failure/u);
  assert.equal(throwing.state, "faulted");
  assert.equal(throwing.generation, 1);
  assert.equal(throwing.cart.identity.contentSha256, "a".repeat(64));
  assert.equal(throwing.reset().error.code, "E_INVARIANT");
  assert.equal(attempts, 2);
  assertOk(throwing.dispose());

  const shared = new FakeRuntime();
  const reused = new CartSession({ createRuntime: () => shared });
  assertOk(reused.load(cart));
  const reuseFailure = reused.reset();
  assert.equal(reuseFailure.ok, false);
  assert.equal(reuseFailure.error.code, "E_INVARIANT");
  assert.match(reuseFailure.error.message, /reused/u);
  assert.equal(reused.state, "faulted");
  assert.equal(shared.disposeCalls, 1);
  assertOk(reused.dispose());
  assert.equal(shared.disposeCalls, 1);
});

test("real z8lua cold reset restores RAM defaults, zero input, and frame clock", () => {
  const rom = new Uint8Array(0x8000);
  rom[0] = 0x31;
  rom[0x42ff] = 0xa2;
  rom[0x4300] = 0xcc;
  const cart = makeCart(`
function _init()
 poke(0x5000,peek(0))
 poke(0x5001,peek(0x42ff))
 poke(0x5002,peek(0x4300))
 poke(0x5003,peek(0x5e00))
 poke(0x5004,peek(0x5f54))
 poke(0x5005,peek(0x5f55))
 poke(0x5006,btn())
 poke(0x5007,peek(0x9000))
end
function _update() poke(0x9000,0x7b) end
function _draw() end`, { rom });
  const runtimes = [];
  const session = new CartSession({
    createRuntime() {
      const runtime = new FrameSliceRuntime(new Z8LuaFrameVm(
        module,
        createPicoApiHostRouter(module),
      ));
      runtimes.push(runtime);
      return runtime;
    },
  });

  assertOk(session.load(cart));
  assert.deepEqual(
    [...assertOk(session.copyRam(0x5000, 8))],
    [0x31, 0xa2, 0, 0, 0, 0x60, 0, 0],
  );
  assert.deepEqual([...assertOk(session.copyRam(0x5f54, 2))], [0, 0x60]);
  const firstFrame = assertOk(session.step());
  assert.equal(firstFrame.kind, "frame");
  assert.equal(firstFrame.generation, 1);
  assert.equal(firstFrame.frame.frameId, 0);
  assert.equal(firstFrame.frame.completedSlices, "2");
  assert.equal(assertOk(session.copyRam(0x9000, 1))[0], 0x7b);

  assertOk(session.reset());
  assert.equal(runtimes[0].state, "disposed");
  assert.equal(runtimes[1].state, "ready");
  assert.deepEqual(
    [...assertOk(session.copyRam(0x5000, 8))],
    [0x31, 0xa2, 0, 0, 0, 0x60, 0, 0],
  );
  assert.equal(assertOk(session.copyRam(0x9000, 1))[0], 0);
  const resetFrame = assertOk(session.step());
  assert.equal(resetFrame.generation, 2);
  assert.equal(resetFrame.frame.frameId, 0);
  assert.equal(resetFrame.frame.completedSlices, "2");
  assertOk(session.dispose());
});

test("real z8lua boot HostRequest is generation-tagged and resumes only as boot", () => {
  const cart = makeCart(`
local value=__p8w_probe_host_request("phase-1c-boot")
poke(0x5010,#value)
function _update() end
function _draw() end`);
  const session = new CartSession({
    createRuntime() {
      return new FrameSliceRuntime(new Z8LuaFrameVm(
        module,
        createPicoApiHostRouter(module),
      ));
    },
  });

  const requested = assertOk(session.load(cart));
  assert.equal(requested.kind, "host-request");
  assert.equal(requested.request.generation, 1);
  assert.equal(requested.request.operation, "boot");
  assert.deepEqual(
    requested.request.bytes,
    encoder.encode("phase-1c-boot"),
  );
  const completed = assertOk(session.completeHostRequest(
    1,
    requested.request.id,
    Uint8Array.of(1, 2, 3, 4),
  ));
  assert.deepEqual(completed, {
    kind: "ready",
    generation: 1,
    mode: "callback",
    targetFps: 30,
    cpuInstructions: 12,
    cpuFractionRaw: 5,
    slowFrame: false,
    devkitFlags: 0,
    audio: silentAudio(),
  });
  assert.equal(assertOk(session.copyRam(0x5010, 1))[0], 4);
  assertOk(session.dispose());
});

test("real z8lua compile faults destroy each failed generation and remain resettable", () => {
  const session = new CartSession({
    createRuntime() {
      return new FrameSliceRuntime(new Z8LuaFrameVm(
        module,
        createPicoApiHostRouter(module),
      ));
    },
  });
  const cart = makeCart("function _update( this is not valid");
  const first = session.load(cart);
  assert.equal(first.ok, false);
  assert.equal(first.error.code, "E_VM_SYNTAX");
  assert.equal(session.state, "faulted");
  assert.equal(session.generation, 1);
  assert.equal(session.copyRam(0, 1).error.code, "E_INVALID_STATE");

  const second = session.reset();
  assert.equal(second.ok, false);
  assert.equal(second.error.code, "E_VM_SYNTAX");
  assert.equal(session.generation, 2);
  assertOk(session.dispose());
});
