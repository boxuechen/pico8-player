import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { machineMetadata, sourceRevision } from "../../../tools/benchmark/common.mjs";
import { createPhase4Baseline, RESULT_DIRECTORY } from "./runner-v1.mjs";

const evidence = process.argv.includes("--evidence");
const suites = [
  "tests/conformance/phase-1f-l1-exit.test.mjs",
  "tests/conformance/phase-2f-exit.test.mjs",
  "tests/conformance/phase-3h-exit.test.mjs",
];

await new Promise((resolvePromise, reject) => {
  const child = spawn(process.execPath, ["--test", ...suites], { stdio: "inherit" });
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (code === 0) resolvePromise();
    else reject(new Error(`Phase 4B Node oracle failed (${signal ?? code})`));
  });
});

const result = await createPhase4Baseline({
  target: "node-real-wasm",
  sourceRevision: sourceRevision(),
  environment: {
    runtime: "node",
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    wasm: "real z8lua Emscripten artifact",
    oracleSuites: suites,
  },
  machine: machineMetadata(),
});

await mkdir(RESULT_DIRECTORY, { recursive: true });
const resultPath = evidence
  ? resolve(RESULT_DIRECTORY, "node-macos-arm64-l2-baseline.json")
  : resolve(RESULT_DIRECTORY, "node-l2-baseline-smoke.json");
await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  target: result.target,
  runner: result.runner,
  summary: result.summary,
  playerBuildId: result.build.playerBuildId,
  resultPath,
}, null, 2)}\n`);
