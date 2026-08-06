import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { before } from "node:test";

import { decodeCart } from "@pico8-web/cart-codec";
import { CartSession, FrameSliceRuntime } from "@pico8-web/runtime-core";
import { createPicoApiHostRouter, Z8LuaFrameVm } from "@pico8-web/z8lua-bridge";
import createZ8LuaModule from "../../wasm/dist/z8lua-runtime-v1.mjs";

const projectRoot = new URL("../../", import.meta.url);
const manifestUrl = new URL("manifests/phase-4c-core-library.json", import.meta.url);
let module;
let manifest;

before(async () => {
  [module, manifest] = await Promise.all([
    createZ8LuaModule(),
    readFile(manifestUrl, "utf8").then(JSON.parse),
  ]);
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

async function loadCart(entry) {
  const source = new Uint8Array(await readFile(new URL(entry.source, projectRoot)));
  assert.equal(sha256(source), entry.sourceSha256, `${entry.id} source hash`);
  const cart = decodeCart(source);
  assert.equal(cart.identity.contentSha256, entry.cartSha256, `${entry.id} cart hash`);
  return { source, cart };
}

function createSession(instructionBudget) {
  return new CartSession({
    createRuntime() {
      const vm = new Z8LuaFrameVm(module, createPicoApiHostRouter(module));
      try {
        return new FrameSliceRuntime(vm, { instructionBudget });
      } catch (error) {
        vm.destroy();
        throw error;
      }
    },
  });
}

function assertOk(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}

function capture(session, expected) {
  const stepped = assertOk(session.step());
  assert.equal(stepped.kind, "frame");
  const ram = assertOk(session.copyRam(expected.address, expected.length));
  assert.equal(hex(ram), expected.hex);
  assert.equal(hex(stepped.frame.screen.subarray(0, expected.length)), expected.hex);
  assert.equal(sha256(stepped.frame.screen), expected.screenSha256);
  return {
    observationHex: hex(ram),
    screenSha256: sha256(stepped.frame.screen),
    completedSlices: stepped.frame.completedSlices,
  };
}

test("Phase 4C P8 Lua helpers execute in real WASM and reset exactly", async () => {
  const entry = manifest.cases.find(({ id }) => id === "phase-4/p8lua-core");
  const { cart } = await loadCart(entry);
  const session = createSession(entry.instructionBudget);
  const boot = assertOk(session.load(cart));
  assert.equal(boot.kind, "ready");
  assert.equal(boot.targetFps, 60);
  const initial = capture(session, entry.expected);
  assertOk(session.reset());
  const reset = capture(session, entry.expected);
  assert.deepEqual(reset, initial);
  assertOk(session.dispose());
});

test("Phase 4C nested coroutine cannot swallow the root instruction budget", async () => {
  const entry = manifest.faultCase;
  const { cart } = await loadCart(entry);
  const session = createSession(entry.instructionBudget);
  const result = session.load(cart);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, entry.expectedCode);
  assert.equal(result.error.phase, "init");
  assert.match(result.error.message, /instruction budget/u);
  assert.equal(session.state, "faulted");
  const reset = session.reset();
  assert.equal(reset.ok, false);
  assert.equal(reset.error.code, entry.expectedCode);
  assertOk(session.dispose());
});

test("Phase 4C closes its inventory and stays a pure VM change with host ABI unchanged", async () => {
  const [abi, generated, runtimeManifest, phase, inventory] = await Promise.all([
    readFile(new URL("spec/abi/pico-host-api-v1.json", projectRoot), "utf8").then(JSON.parse),
    readFile(new URL("spec/abi/generated-bindings.manifest.json", projectRoot), "utf8").then(JSON.parse),
    readFile(new URL("wasm/runtime-v1.manifest.lock.json", projectRoot), "utf8").then(JSON.parse),
    readFile(new URL("spec/phase-4-l2-mvp-contract.json", projectRoot), "utf8").then(JSON.parse),
    readFile(new URL("spec/pico-api-inventory.yaml", projectRoot), "utf8").then(JSON.parse),
  ]);
  assert.ok(abi.bindings.length >= 38);
  assert.deepEqual(
    abi.bindings.slice(0, 38).map(({ id }) => id),
    Array.from({ length: 38 }, (_, index) => index + 1),
  );
  assert.equal(generated.files.length, 2);
  assert.equal(phase.workUnits["4C"].result.runtimeAbiVersion, "0x00010002");
  assert.ok(runtimeManifest.abiVersion >= 0x0001_0002);
  assert.equal(runtimeManifest.compiledBridgeSources.includes(
    "wasm/bridge/p8w_pico8_compat.cpp",
  ), true);
  assert.equal(phase.workUnits["4C"].status, "complete");
  assert.equal(phase.workUnits["4C"].result.hostAbiBindings, 38);
  assert.ok(phase.completedWorkUnits.includes("4C"));
  const byName = new Map(inventory.apis.map((api) => [api.name, api]));
  for (const name of manifest.requiredApis) {
    assert.equal(byName.get(name)?.implementationStatus, "implemented", name);
    assert.equal(byName.get(name)?.conformanceStatus, "compatible", name);
  }
});
