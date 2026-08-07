import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import test, { before } from "node:test";

import { decodeCart } from "@pico8-web/cart-codec";
import { CartSession, FrameSliceRuntime } from "@pico8-web/runtime-core";
import { createPicoApiHostRouter, Z8LuaFrameVm } from "@pico8-web/z8lua-bridge";
import createZ8LuaModule from "../../wasm/dist/z8lua-runtime-v1.mjs";

const projectRoot = new URL("../../", import.meta.url);
const manifestUrl = new URL("manifests/phase-7f-required-api.json", import.meta.url);
const expectedApis = [
  "pairs",
  "max", "min", "mid", "flr", "ceil", "cos", "sin", "atan2", "sqrt", "abs", "sgn",
  "band", "bor", "bxor", "bnot", "shl", "shr", "lshr", "rotl", "rotr",
  "setmetatable", "getmetatable", "rawset", "rawget", "rawequal", "rawlen", "select",
];

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

function assertOk(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
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

async function loadCart(entry) {
  const source = new Uint8Array(await readFile(new URL(entry.source, projectRoot)));
  assert.equal(sha256(source), entry.sourceSha256, `${entry.id} source hash`);
  const cart = decodeCart(source);
  assert.equal(cart.identity.contentSha256, entry.cartSha256, `${entry.id} decoded cart hash`);
  return { source, cart };
}

function capture(session, expected) {
  const stepped = assertOk(session.step());
  assert.equal(stepped.kind, "frame");
  const observation = assertOk(session.copyRam(expected.address, expected.length));
  assert.equal(hex(observation), expected.hex);
  assert.equal(hex(stepped.frame.screen.subarray(0, expected.length)), expected.hex);
  assert.equal(sha256(stepped.frame.screen), expected.screenSha256);
  return {
    observationHex: hex(observation),
    screenSha256: sha256(stepped.frame.screen),
    completedSlices: stepped.frame.completedSlices,
  };
}

test("Phase 7F manifest covers every formerly unknown required API exactly once", async () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.manual, "https://www.lexaloffle.com/dl/docs/pico-8_manual.html");
  assert.deepEqual([...manifest.requiredApis].sort(), [...expectedApis].sort());
  assert.equal(new Set(manifest.requiredApis).size, 28);

  const caseApis = manifest.cases.flatMap((entry) => entry.apis);
  const vectorApis = manifest.cases.flatMap((entry) => entry.apiVectors.map(({ api }) => api));
  assert.deepEqual([...caseApis].sort(), [...expectedApis].sort());
  assert.deepEqual([...vectorApis].sort(), [...expectedApis].sort());
  assert.equal(new Set(caseApis).size, 28);
  assert.equal(new Set(vectorApis).size, 28);

  for (const entry of manifest.cases) {
    assert.match(entry.manualSection, /\S/u);
    assert.equal(entry.expected.hex.length, entry.expected.length * 2, entry.id);
    assert.equal(entry.apiVectors.every(({ offsets }) => offsets.length > 0), true, entry.id);
    await loadCart(entry);
  }
  await loadCart(manifest.faultCase);
});

test("Phase 7F real-WASM carts match byte/raw oracles and reset replay", async () => {
  for (const entry of manifest.cases) {
    const { cart } = await loadCart(entry);
    const session = createSession(entry.instructionBudget);
    const ready = assertOk(session.load(cart));
    assert.equal(ready.kind, "ready");
    assert.equal(ready.mode, entry.mode);
    assert.equal(ready.targetFps, entry.targetFps);
    const initial = capture(session, entry.expected);
    assertOk(session.reset());
    const reset = capture(session, entry.expected);
    assert.deepEqual(reset, initial, `${entry.id} reset replay drifted`);
    assertOk(session.dispose());
  }
});

test("Phase 7F invalid select faults structurally and a fresh generation recovers", async () => {
  const recoveryEntry = manifest.cases[0];
  const [{ cart: faultCart }, { cart: recoveryCart }] = await Promise.all([
    loadCart(manifest.faultCase),
    loadCart(recoveryEntry),
  ]);
  const session = createSession(manifest.faultCase.instructionBudget);
  const fault = session.load(faultCart);
  assert.equal(fault.ok, false);
  assert.equal(fault.error.code, manifest.faultCase.expectedCode);
  assert.match(fault.error.message, new RegExp(manifest.faultCase.expectedMessage, "u"));
  assert.equal(session.state, "faulted");

  const ready = assertOk(session.load(recoveryCart));
  assert.equal(ready.kind, "ready");
  capture(session, recoveryEntry.expected);
  assertOk(session.dispose());
});

test("Phase 7F inventory closes required unknowns and preserves explicit partial modes", async () => {
  const inventory = JSON.parse(await readFile(new URL("spec/pico-api-inventory.yaml", projectRoot), "utf8"));
  const byName = new Map(inventory.apis.map((api) => [api.name, api]));
  for (const name of expectedApis) {
    const api = byName.get(name);
    assert.equal(api?.mvpDisposition, "required", name);
    assert.equal(api?.implementationStatus, "implemented", name);
    assert.equal(api?.conformanceStatus, "compatible", name);
    assert.equal(api?.evidence, "tests/conformance/manifests/phase-7f-required-api.json", name);
  }
  assert.equal(
    inventory.apis.filter((api) => api.mvpDisposition === "required" && api.conformanceStatus === "unknown").length,
    0,
  );

  for (const name of ["flip", "stat", "print"]) {
    assert.equal(byName.get(name)?.conformanceStatus, "partial", name);
    assert.equal(byName.get(name)?.evidence, "tests/conformance/manifests/phase-7f-required-api.json", name);
    const modes = manifest.partialModes[name];
    assert.ok(modes.supported.length > 0, name);
    assert.ok(modes.knownDifferences.length > 0, name);
    for (const path of modes.evidence) await access(new URL(path, projectRoot));
  }
  assert.equal(byName.get("menuitem")?.conformanceStatus, "compatible");
  assert.deepEqual(manifest.partialModes.menuitem.knownDifferences, []);
  for (const path of manifest.partialModes.menuitem.evidence) await access(new URL(path, projectRoot));
});
