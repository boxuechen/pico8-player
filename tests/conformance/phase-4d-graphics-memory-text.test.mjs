import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { before } from "node:test";

import { decodeCart } from "@pico8-web/cart-codec";
import { CartSession, FrameSliceRuntime } from "@pico8-web/runtime-core";
import { createPicoApiHostRouter, Z8LuaFrameVm } from "@pico8-web/z8lua-bridge";
import createZ8LuaModule from "../../wasm/dist/z8lua-runtime-v1.mjs";

const projectRoot = new URL("../../", import.meta.url);
const manifestUrl = new URL("manifests/phase-4d-graphics-memory-text.json", import.meta.url);
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

function takeP8String(bytes, cursor) {
  const length = bytes[cursor.offset++];
  const value = Buffer.from(bytes.subarray(cursor.offset, cursor.offset + length)).toString("latin1");
  cursor.offset += length;
  return value;
}

test("Phase 4D graphics, memory and text cart executes in real WASM and resets exactly", async () => {
  const entry = manifest.cases[0];
  const { cart } = await loadCart(entry);
  const session = createSession(entry.instructionBudget);
  const boot = assertOk(session.load(cart));
  assert.equal(boot.kind, "ready");
  assert.equal(boot.targetFps, 60);
  const initial = capture(session, entry.expected);

  const bytes = Buffer.from(entry.expected.hex, "hex");
  const cursor = { offset: 0 };
  assert.deepEqual([
    takeP8String(bytes, cursor),
    takeP8String(bytes, cursor),
    takeP8String(bytes, cursor),
    takeP8String(bytes, cursor),
    takeP8String(bytes, cursor),
  ], ["", "[nil]", "0x0011.0000", "1114112", "0x00110000"]);
  assert.notEqual(bytes.indexOf(Buffer.from([0xaa, 0xaa, 0xaa, 0xaa])), -1,
    "64 KiB wrap observation missing");
  assert.notEqual(bytes.indexOf(Buffer.from([1, 1, 2, 3, 4, 5, 1, 1, 2, 3, 4, 5])), -1,
    "overlapping memcpy observation missing");
  assert.notEqual(bytes.indexOf(Buffer.from([0x21, 0x43, 0x65, 0x87, 0x21, 0x43, 0x65, 0x87])), -1,
    "tline(13)/tline(16) source-coordinate equivalence missing");

  assertOk(session.reset());
  const reset = capture(session, entry.expected);
  assert.deepEqual(reset, initial);
  assertOk(session.dispose());
});

test("Phase 4D contains a structured VM fault and recovers with the valid cart", async () => {
  const validEntry = manifest.cases[0];
  const [{ cart: validCart }, { cart: faultCart }] = await Promise.all([
    loadCart(validEntry),
    loadCart(manifest.faultCase),
  ]);
  const session = createSession(validEntry.instructionBudget);
  const fault = session.load(faultCart);
  assert.equal(fault.ok, false);
  assert.equal(fault.error.code, manifest.faultCase.expectedCode);
  assert.equal(fault.error.phase, "init");
  assert.equal(session.state, "faulted");

  const recovered = assertOk(session.load(validCart));
  assert.equal(recovered.kind, "ready");
  capture(session, validEntry.expected);
  assertOk(session.dispose());
});

test("Phase 4D appends bindings 39 and 40 while strings stay inside the VM", async () => {
  const [abi, generated, phase, inventory] = await Promise.all([
    readFile(new URL("spec/abi/pico-host-api-v1.json", projectRoot), "utf8").then(JSON.parse),
    readFile(new URL("spec/abi/generated-bindings.manifest.json", projectRoot), "utf8").then(JSON.parse),
    readFile(new URL("spec/phase-4-l2-mvp-contract.json", projectRoot), "utf8").then(JSON.parse),
    readFile(new URL("spec/pico-api-inventory.yaml", projectRoot), "utf8").then(JSON.parse),
  ]);
  assert.equal(abi.bindings.length, 40);
  assert.deepEqual(abi.bindings.map(({ id }) => id), Array.from({ length: 40 }, (_, i) => i + 1));
  assert.deepEqual(abi.bindings.slice(38).map(({ guestName }) => guestName), ["rrect", "rrectfill"]);
  assert.equal(generated.files.length, 2);
  assert.equal(generated.prototypeSignatureCount, 12);
  assert.equal(phase.workUnits["4D"].status, "complete");
  assert.equal(phase.activeWorkUnit, "4E");
  assert.deepEqual(phase.completedWorkUnits, ["4A", "4B", "4C", "4D"]);

  const byName = new Map(inventory.apis.map((api) => [api.name, api]));
  for (const name of manifest.requiredApis) {
    assert.equal(byName.get(name)?.implementationStatus, "implemented", name);
    assert.equal(byName.get(name)?.conformanceStatus, "compatible", name);
  }
  for (const name of ["tostr", "tonum", "chr", "ord", "split", "type"]) {
    assert.notEqual(byName.get(name)?.surface, "host-binding", name);
    assert.equal(byName.get(name)?.hostBindingId, undefined, name);
  }
  assert.equal(manifest.scopeDecisions.timedP8sciiControls,
    "accepted-partial-known-difference");
  assert.equal(manifest.scopeDecisions.advancedScreenAndBitplaneModes,
    "unsupported-outside-mvp");
});
