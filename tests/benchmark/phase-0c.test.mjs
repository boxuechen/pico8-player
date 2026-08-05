import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { before } from "node:test";

import createZ8LuaPhase0CModule from "../../wasm/dist/z8lua-phase-0c.mjs";
import { compareInteropResults } from "../../benchmarks/interop/compare.mjs";
import { runInteropBenchmark } from "../../benchmarks/interop/runner.mjs";
import { assertValidInteropResult, validateInteropResult } from "../../benchmarks/interop/validate.mjs";

let module;
let manifest;
let smokeResult;

before(async () => {
  [module, manifest] = await Promise.all([
    createZ8LuaPhase0CModule(),
    readFile(new URL("../../benchmarks/interop/case-manifest.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
});

test("Phase 0C benchmark ABI stays bounded and rejects invalid RAM handles", () => {
  assert.equal(module._p8w0c_bench_abi_version(), 0x00030000);
  assert.equal(module._p8w0c_bench_export_pset(0, 1, 2, 3) >>> 0, 0xffffffff);
  assert.equal(module._p8w0c_bench_export_peek_poke(0, 0, 1) >>> 0, 0xffffffff);
  assert.equal(module._p8w0c_bench_export_spr(0, 0, 0, 0) >>> 0, 0xffffffff);
  assert.equal(module._p8w0c_bench_import_pset(0, 1, manifest.seed) >>> 0, 0xffffffff);
  assert.equal(module._p8w0c_bench_control_spr(0, 1, manifest.seed) >>> 0, 0xffffffff);
});

test("all four paths produce equal checksums and RAM hashes before timing", async () => {
  smokeResult = await runInteropBenchmark({
    module,
    manifest,
    sourceRevision: "test-revision",
    artifact: { wasmBytes: 1, wasmSha256: "0".repeat(64) },
    environment: {
      runtime: `node ${process.version}`,
      userAgent: "node-test",
      hardwareConcurrency: 1,
      machineId: "phase-0c-test",
    },
    availability: [
      { engine: "node", status: "measured" },
      { engine: "chromium", status: "not-run", reason: "unit test" },
      { engine: "firefox", status: "not-run", reason: "unit test" },
      { engine: "webkit", status: "not-run", reason: "unit test" },
    ],
    protocolOverrides: {
      warmupFrames: 1,
      measuredSamples: 3,
      targetSampleDurationMs: 1,
      maximumCalibrationRepeats: 2048,
      callCounts: [1024],
      byteStringLengths: [0, 8, 1024],
    },
  });
  assertValidInteropResult(smokeResult);
  assert.equal(smokeResult.cases.length, 32);
  assert.ok(smokeResult.cases.every(({ correctness }) => correctness.passed));
  assert.ok(smokeResult.cases.every(({ samplesMsPerFrame }) => samplesMsPerFrame.length === 3));
  assert.ok(smokeResult.cases.every(({ memory }) => memory.wasmBufferStable));
});

test("result validator rejects forged correctness and memory growth", () => {
  assert.ok(smokeResult);
  const forged = structuredClone(smokeResult);
  forged.cases[0].correctness.passed = false;
  forged.cases[1].memory.wasmBytesAfter += 65_536;
  assert.deepEqual(validateInteropResult(forged).some((error) => error.includes("correctness must pass")), true);
  assert.deepEqual(validateInteropResult(forged).some((error) => error.includes("memory size changed")), true);
});

test("same-machine comparison requires a repeat before a >10% regression fails", () => {
  assert.ok(smokeResult);
  const candidate = structuredClone(smokeResult);
  candidate.cases[0].summary.p50Ms *= 1.2;
  assert.equal(compareInteropResults(smokeResult, candidate).status, "repeat-required");
  assert.equal(
    compareInteropResults(smokeResult, candidate, { confirmedRepeat: true }).status,
    "fail",
  );
  candidate.environment.machineId = "different-machine";
  assert.equal(compareInteropResults(smokeResult, candidate).status, "informational");
});
