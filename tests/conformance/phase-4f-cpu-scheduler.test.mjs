import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { before } from "node:test";

import { decodeCart } from "@pico8-web/cart-codec";
import {
  CartSession,
  FrameSliceRuntime,
  PICO_CPU_ONE_RAW,
  PICO_VM_INSTRUCTIONS_PER_SECOND,
  picoCpuSliceBudget,
  runtimeCpuCost,
} from "@pico8-web/runtime-core";
import { createPicoApiHostRouter, Z8LuaFrameVm } from "@pico8-web/z8lua-bridge";
import { inputSnapshot } from "../helpers/input.mjs";
import createZ8LuaModule from "../../wasm/dist/z8lua-runtime-v1.mjs";

const projectRoot = new URL("../../", import.meta.url);
const manifestUrl = new URL("manifests/phase-4f-cpu-scheduler.json", import.meta.url);
const encoder = new TextEncoder();
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

async function loadCart(entry) {
  const source = new Uint8Array(await readFile(new URL(entry.source, projectRoot)));
  assert.equal(sha256(source), entry.sourceSha256, `${entry.id} source hash`);
  const cart = decodeCart(source);
  assert.equal(cart.identity.contentSha256, entry.cartSha256, `${entry.id} cart hash`);
  return cart;
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

function sourceCart(source) {
  return { rom: new Uint8Array(0x8000), code: encoder.encode(source) };
}

function readInt32(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(offset, true);
}

test("Phase 4F locks the deterministic 4M instruction Q16.16 cost model", () => {
  assert.equal(PICO_VM_INSTRUCTIONS_PER_SECOND, manifest.referenceInstructionsPerSecond);
  assert.equal(PICO_CPU_ONE_RAW, manifest.accounting.slowFrameThresholdRawExclusive);
  assert.deepEqual(picoCpuSliceBudget(30), {
    floor: manifest.cadences["30"].budgetFloor,
    ceiling: manifest.cadences["30"].budgetCeiling,
  });
  assert.deepEqual(picoCpuSliceBudget(60), {
    floor: manifest.cadences["60"].budgetFloor,
    ceiling: manifest.cadences["60"].budgetCeiling,
  });

  for (const [fpsText, cadence] of Object.entries(manifest.cadences)) {
    if (fpsText === "custom") continue;
    const fps = Number(fpsText);
    const before = runtimeCpuCost(cadence.firstSlowInstruction - 1, fps);
    const firstSlow = runtimeCpuCost(cadence.firstSlowInstruction, fps);
    assert.equal(before.slowFrame, false, `${fps} Hz last non-slow instruction`);
    assert.equal(firstSlow.cpuFractionRaw, PICO_CPU_ONE_RAW + 1);
    assert.equal(firstSlow.slowFrame, true, `${fps} Hz first slow instruction`);
  }
});

test("30/60 Hz real-WASM carts classify below, at and above the soft budget exactly", async () => {
  for (const entry of manifest.cases.filter(({ mode }) => mode === "callback")) {
    const cart = await loadCart(entry);
    const session = createSession(entry.instructionBudget);
    try {
      const ready = assertOk(session.load(cart));
      assert.equal(ready.kind, "ready");
      assert.equal(ready.mode, entry.mode);
      assert.equal(ready.targetFps, entry.targetFps);
      assert.deepEqual(
        {
          cpuInstructions: ready.cpuInstructions,
          cpuFractionRaw: ready.cpuFractionRaw,
          slowFrame: ready.slowFrame,
        },
        {
          cpuInstructions: entry.boot.cpuInstructions,
          cpuFractionRaw: entry.boot.cpuFractionRaw,
          slowFrame: entry.boot.slowFrame,
        },
      );

      for (const expected of entry.frames) {
        const stepped = assertOk(session.step());
        assert.equal(stepped.kind, "frame");
        assert.deepEqual(
          {
            cpuInstructions: stepped.frame.cpuInstructions,
            cpuFractionRaw: stepped.frame.cpuFractionRaw,
            slowFrame: stepped.frame.slowFrame,
            targetFps: stepped.frame.targetFps,
            timeRawBeforeStep: stepped.frame.timeRawBeforeStep,
            completedSlices: stepped.frame.completedSlices,
          },
          {
            cpuInstructions: expected.cpuInstructions,
            cpuFractionRaw: expected.cpuFractionRaw,
            slowFrame: expected.slowFrame,
            targetFps: entry.targetFps,
            timeRawBeforeStep: expected.timeRaw,
            completedSlices: expected.completedSlices,
          },
        );
      }
      const observation = assertOk(session.copyRam(
        entry.observation.address,
        entry.observation.length,
      ));
      assert.equal(hex(observation), entry.observation.hex);
      entry.frames.forEach((expected, index) => {
        assert.equal(readInt32(observation, index * 12), expected.stat1Raw);
        assert.equal(readInt32(observation, index * 12 + 4), expected.stat7Raw);
        assert.equal(readInt32(observation, index * 12 + 8), expected.timeRaw);
      });
    } finally {
      assertOk(session.dispose());
    }
  }
});

test("custom flip boundaries use the 30 Hz logical CPU and stat profile", async () => {
  const entry = manifest.cases.find(({ mode }) => mode === "custom");
  const cart = await loadCart(entry);
  const session = createSession(entry.instructionBudget);
  try {
    const ready = assertOk(session.load(cart));
    assert.equal(ready.kind, "ready");
    assert.equal(ready.mode, "custom");
    assert.equal(ready.targetFps, 30);
    assert.equal(ready.cpuInstructions, entry.boot.cpuInstructions);
    assert.equal(ready.cpuFractionRaw, entry.boot.cpuFractionRaw);
    assert.equal(hex(assertOk(session.copyRam(0x5000, 12))), entry.bootObservationHex);

    for (const expected of entry.frames) {
      const stepped = assertOk(session.step());
      assert.equal(stepped.kind, "frame");
      assert.deepEqual(
        [
          stepped.frame.cpuInstructions,
          stepped.frame.cpuFractionRaw,
          stepped.frame.slowFrame,
          stepped.frame.timeRawBeforeStep,
          stepped.frame.completedSlices,
        ],
        [
          expected.cpuInstructions,
          expected.cpuFractionRaw,
          expected.slowFrame,
          expected.timeRaw,
          expected.completedSlices,
        ],
      );
    }
    assert.equal(
      hex(assertOk(session.copyRam(entry.observation.address, entry.observation.length))),
      entry.observation.hex,
    );
  } finally {
    assertOk(session.dispose());
  }
});

test("ordinary slow frames atomically commit input, audio, draw and cartdata", async () => {
  const entry = manifest.transactionCase;
  const cart = await loadCart(entry);
  const session = createSession(entry.instructionBudget);
  try {
    assert.equal(assertOk(session.load(cart)).kind, "ready");
    const stepped = assertOk(session.step(inputSnapshot([entry.inputButtons])));
    assert.equal(stepped.kind, "frame");
    const frame = stepped.frame;
    assert.deepEqual(
      {
        cpuInstructions: frame.cpuInstructions,
        cpuFractionRaw: frame.cpuFractionRaw,
        slowFrame: frame.slowFrame,
        completedSlices: frame.completedSlices,
        timeRaw: frame.timeRawBeforeStep,
      },
      {
        cpuInstructions: entry.expected.cpuInstructions,
        cpuFractionRaw: entry.expected.cpuFractionRaw,
        slowFrame: entry.expected.slowFrame,
        completedSlices: entry.expected.completedSlices,
        timeRaw: entry.expected.timeRaw,
      },
    );
    assert.equal(hex(assertOk(session.copyRam(0x5000, 16))), entry.expected.observationHex);
    assert.equal(sha256(frame.screen), entry.expected.screenSha256);
    assert.equal(sha256(frame.audio.pcm16le), entry.expected.audioSha256);
    assert.equal(frame.cartDataCommit?.id, "phase4f");
    assert.equal(sha256(frame.cartDataCommit.bytes), entry.expected.cartDataSha256);
  } finally {
    assertOk(session.dispose());
  }
});

test("CPU accounting remains cumulative across a host-request continuation", () => {
  const vm = new Z8LuaFrameVm(module, createPicoApiHostRouter(module));
  const runtime = new FrameSliceRuntime(vm, { instructionBudget: 1_000_000 });
  try {
    const ready = assertOk(runtime.boot(sourceCart(`
function spin()
 local x=0
 for i=1,1000 do x+=i end
 return x
end
function _update()
 spin()
 local response=__p8w_probe_host_request("phase4f")
 spin()
 poke(0x5004,#response)
end
function _draw()
 poke4(0x5000,stat(1))
end`)));
    assert.equal(ready.kind, "ready");
    const requested = assertOk(runtime.step());
    assert.equal(requested.kind, "host-request");
    const completed = assertOk(runtime.completeHostRequest(
      requested.request.id,
      Uint8Array.of(1, 2, 3, 4),
    ));
    assert.equal(completed.kind, "frame");
    assert.equal(completed.frame.cpuInstructions, 6033);
    assert.equal(completed.frame.cpuFractionRaw, 2965);
    assert.equal(readInt32(runtime.copyRam(0x5000, 8), 0), 2964);
    assert.equal(runtime.copyRam(0x5004, 1)[0], 4);
  } finally {
    runtime.dispose();
  }
});

test("the hard safety cap is a structured fault and a fresh cart recovers", async () => {
  const faultEntry = manifest.faultCase;
  const validEntry = manifest.cases.find(({ mode }) => mode === "custom");
  const [faultCart, validCart] = await Promise.all([
    loadCart(faultEntry),
    loadCart(validEntry),
  ]);
  const session = createSession(faultEntry.instructionBudget);
  try {
    assert.equal(assertOk(session.load(faultCart)).kind, "ready");
    const fault = session.step();
    assert.equal(fault.ok, false);
    assert.equal(fault.error.code, faultEntry.expectedCode);
    assert.equal(fault.error.phase, faultEntry.expectedPhase);
    assert.equal(session.state, "faulted");

    const recovered = assertOk(session.load(validCart));
    assert.equal(recovered.kind, "ready");
    const frame = assertOk(session.step());
    assert.equal(frame.kind, "frame");
    assert.equal(frame.frame.slowFrame, false);
  } finally {
    assertOk(session.dispose());
  }
});

test("Phase 4F machine contract and inventory expose the calibrated selectors", async () => {
  const [phase, inventory] = await Promise.all([
    readFile(new URL("spec/phase-4-l2-mvp-contract.json", projectRoot), "utf8").then(JSON.parse),
    readFile(new URL("spec/pico-api-inventory.yaml", projectRoot), "utf8").then(JSON.parse),
  ]);
  assert.equal(phase.workUnits["4F"].status, "complete");
  assert.ok(phase.completedWorkUnits.includes("4F"));
  const byName = new Map(inventory.apis.map((api) => [api.name, api]));
  assert.equal(byName.get("time")?.implementationStatus, "implemented");
  assert.equal(byName.get("time")?.conformanceStatus, "compatible");
  assert.match(byName.get("stat")?.note ?? "", /1,6,7/u);
});
