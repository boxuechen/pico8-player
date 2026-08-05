import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import createZ8LuaPhase0CModule from "../../wasm/dist/z8lua-phase-0c.mjs";
import { runInteropBenchmark } from "../../benchmarks/interop/runner.mjs";
import { assertValidInteropResult } from "../../benchmarks/interop/validate.mjs";
import { artifactMetadata, machineMetadata, projectRoot, sourceRevision } from "./common.mjs";

const full = process.argv.includes("--full");
const outputIndex = process.argv.indexOf("--output");
const outputPath = outputIndex === -1
  ? join(projectRoot, "benchmarks", "interop", "results", full ? "node-full.json" : "node-smoke.json")
  : resolve(projectRoot, process.argv[outputIndex + 1]);

const manifest = JSON.parse(await readFile(join(projectRoot, "benchmarks", "interop", "case-manifest.json"), "utf8"));
const module = await createZ8LuaPhase0CModule();
const machine = machineMetadata();
const protocolOverrides = full
  ? {}
  : {
      warmupFrames: 2,
      measuredSamples: 3,
      targetSampleDurationMs: 2,
      maximumCalibrationRepeats: 4096,
      callCounts: [1024],
      byteStringLengths: [0, 8, 1024],
    };

const result = await runInteropBenchmark({
  module,
  manifest,
  sourceRevision: sourceRevision(),
  artifact: await artifactMetadata(),
  environment: {
    runtime: `node ${process.version}`,
    userAgent: `Node.js/${process.versions.node}`,
    hardwareConcurrency: machine.logicalCpuCount,
    ...machine,
  },
  availability: [
    { engine: "node", status: "measured" },
    { engine: "chromium", status: "not-run", reason: "Node correctness/smoke run" },
    { engine: "firefox", status: "not-run", reason: "Node correctness/smoke run" },
    { engine: "webkit", status: "not-run", reason: "Node correctness/smoke run" },
  ],
  protocolOverrides,
  onProgress(progress) {
    process.stderr.write(`\r${progress.stage} ${progress.current}/${progress.total}: ${progress.caseId}       `);
  },
});
process.stderr.write("\n");
assertValidInteropResult(result);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${outputPath}\n`);
