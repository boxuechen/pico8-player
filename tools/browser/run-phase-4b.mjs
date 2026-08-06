import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { machineMetadata, sourceRevision } from "../benchmark/common.mjs";
import {
  createPhase4Baseline,
  RESULT_DIRECTORY,
} from "../../tests/conformance/phase-4/runner-v1.mjs";

const evidence = process.argv.includes("--evidence");
const gates = [
  {
    script: "tools/browser/run-phase-1f.mjs",
    result: "benchmarks/phase-1/results/chromium-l1-exit-smoke.json",
    key: "phase1",
  },
  {
    script: "tools/browser/run-phase-2f.mjs",
    result: "benchmarks/phase-2/results/chromium-phase-2-exit-smoke.json",
    key: "phase2",
  },
  {
    script: "tools/browser/run-phase-3h.mjs",
    result: "benchmarks/phase-3/results/chromium-phase-3-exit-smoke.json",
    key: "phase3",
  },
];

async function runGate(script) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${script} failed (${signal ?? code})\n${output}`));
    });
  });
}

const legacyResults = {};
for (const gate of gates) {
  process.stdout.write(`Phase 4B Chrome oracle: ${gate.key}\n`);
  await runGate(gate.script);
  legacyResults[gate.key] = JSON.parse(await readFile(resolve(gate.result), "utf8"));
}

const chromeVersions = new Set(Object.values(legacyResults).map(({ browser }) => browser));
if (chromeVersions.size !== 1) {
  throw new Error(`Phase 4B Chrome gates used different browser builds: ${[...chromeVersions]}`);
}

const result = await createPhase4Baseline({
  target: "chrome-production",
  sourceRevision: sourceRevision(),
  environment: {
    runtime: "chrome",
    browserVersion: legacyResults.phase3.browser,
    userAgent: legacyResults.phase3.userAgent,
    browserScope: "Chrome/Chromium desktop only",
    paths: ["production Worker", "Canvas2D", "AudioWorklet", "IndexedDB"],
    fixedInput: "CDP and deterministic runtime pulse traces",
    legacyGateScripts: gates.map(({ script }) => script),
  },
  machine: machineMetadata(),
  legacyResults,
});

await mkdir(RESULT_DIRECTORY, { recursive: true });
const resultPath = evidence
  ? resolve(RESULT_DIRECTORY, "chromium-macos-arm64-l2-baseline.json")
  : resolve(RESULT_DIRECTORY, "chromium-l2-baseline-smoke.json");
await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  target: result.target,
  runner: result.runner,
  browserVersion: result.environment.browserVersion,
  summary: result.summary,
  playerBuildId: result.build.playerBuildId,
  resultPath,
}, null, 2)}\n`);
