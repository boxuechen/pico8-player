import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import createZ8LuaModule from "../../../wasm/dist/z8lua-runtime-v1.mjs";
import { machineMetadata, sourceRevision } from "../../../tools/benchmark/common.mjs";
import { runNodePhase5Exit } from "./runner-v1.mjs";

const evidence = process.argv.includes("--evidence");
const configPath = "tests/conformance/phase-5/exit-config.json";
const config = JSON.parse(await readFile(resolve(configPath), "utf8"));

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sourceHashes(paths) {
  return Object.fromEntries(await Promise.all(paths.map(async (path) => [
    path,
    sha256(await readFile(resolve(path))),
  ])));
}

const module = await createZ8LuaModule();
const suite = await runNodePhase5Exit(module, config);
const runtimeManifest = JSON.parse(await readFile(
  resolve("wasm/runtime-v1.manifest.lock.json"),
  "utf8",
));
const sourcePaths = [
  "apps/web-player/src/main/player-runtime-client.ts",
  "apps/web-player/src/worker/compose-runtime.ts",
  "apps/web-player/src/worker/adapters/host-cart-resolver-adapter.ts",
  "packages/runtime-core/src/cart/cart-loader.ts",
  "packages/runtime-core/src/frame-runtime.ts",
  "packages/z8lua-bridge/src/public.ts",
  "wasm/bridge/p8w_frame_runtime.cpp",
  "wasm/runtime-v1.manifest.lock.json",
  "tests/conformance/manifests/phase-5-l3-corpus.json",
  configPath,
  "tests/conformance/phase-5/runner-v1.mjs",
  "tests/conformance/phase-5/run-node-exit.mjs",
];
const result = {
  schemaVersion: 1,
  phase: "5H",
  target: "node-real-wasm",
  releaseClaim: config.releaseClaim,
  ...suite,
  environment: {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
  },
  machine: machineMetadata(),
  sourceRevision: sourceRevision(),
  sourceSha256: await sourceHashes(sourcePaths),
  runtimeArtifact: runtimeManifest.artifact,
  externalCorpus: {
    networkAccess: false,
    thirdPartyOrBbsContent: false,
    publishedDenominatorContribution: 0,
  },
};

if (evidence) {
  const resultDirectory = resolve("benchmarks/phase-5/results");
  const resultPath = resolve(resultDirectory, "node-macos-arm64-l3-exit.json");
  await mkdir(resultDirectory, { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ...result, resultPath }, null, 2)}\n`);
} else {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
