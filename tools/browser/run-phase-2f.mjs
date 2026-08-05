import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { machineMetadata, sourceRevision } from "../benchmark/common.mjs";
import { startBenchmarkServer } from "../benchmark/server.mjs";
import {
  evaluate,
  launchChrome,
  waitForDocumentStatus,
} from "./chrome-cdp.mjs";

const evidence = process.argv.includes("--evidence");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function sourceHashes(paths) {
  return Object.fromEntries(await Promise.all(paths.map(async (path) => [
    path,
    sha256(await readFile(resolve(path))),
  ])));
}

const server = await startBenchmarkServer({ availability: [] });
const chrome = await launchChrome({ profilePrefix: "p8w-phase2f-" });

try {
  const { cdp } = chrome;
  await cdp.command("Page.navigate", {
    url: `${server.origin}/tests/browser/phase-2f.html`,
  });
  try {
    await waitForDocumentStatus(cdp, { timeoutMs: 120_000 });
  } catch (error) {
    const resources = await evaluate(
      cdp,
      "performance.getEntriesByType('resource').map(({name}) => name)",
    );
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${resources.join("\n")}`);
  }

  const browserResult = JSON.parse(await evaluate(
    cdp,
    "document.querySelector('#result').textContent",
  ));
  check(browserResult.phase === "2F", "Chrome reported the wrong phase");
  check(browserResult.deterministic.length === 2,
    "Chrome deterministic matrix was incomplete");
  check(browserResult.canvas.length === 2, "Chrome Canvas matrix was incomplete");
  check(browserResult.performance.cases.length === 2,
    "Chrome performance matrix was incomplete");
  check(browserResult.performance.cases.every(({ measuredTicks }) => measuredTicks === 120),
    "Chrome performance samples were incomplete");
  check(browserResult.performance.maxP95Ms <= 8,
    "Chrome representative Phase 2 p95 exceeded 8ms");
  check(browserResult.faultRecovery.mainThreadResponsive === true,
    "Chrome UI was not responsive during guest fault");
  check(browserResult.faultRecovery.recoverySessionGeneration
    > browserResult.faultRecovery.faultSessionGeneration,
  "Chrome did not advance generation during recovery");
  check(browserResult.faultRecovery.recoveredFrames > 0,
    "Chrome did not render after fault recovery");
  check(browserResult.workerError === null, `Chrome Worker error: ${browserResult.workerError}`);

  const result = {
    ...browserResult,
    sourceRevision: sourceRevision(),
    sourceSha256: await sourceHashes([
      "apps/web-player/src/main/player-runtime-client.ts",
      "apps/web-player/src/main/player-controller.ts",
      "apps/web-player/src/main/render/pico-frame.ts",
      "apps/web-player/src/worker/compose-runtime.ts",
      "packages/runtime-core/src/frame-runtime.ts",
      "tests/conformance/manifests/phase-2f-exit.json",
      "tests/conformance/carts/phase-2/graphics-memory.p8",
      "tests/conformance/carts/phase-2/text-remap.p8",
      "tests/conformance/carts/phase-2/resource-limit-fault.p8",
      "tests/browser/phase-2f.mjs",
    ]),
    browser: chrome.version,
    machine: machineMetadata(),
  };
  const resultDirectory = resolve("benchmarks/phase-2/results");
  await mkdir(resultDirectory, { recursive: true });
  const resultPath = evidence
    ? resolve(resultDirectory, "chromium-macos-arm64-phase-2-exit.json")
    : resolve(resultDirectory, "chromium-phase-2-exit-smoke.json");
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ...result, resultPath }, null, 2)}\n`);
} finally {
  await server.close();
  await chrome.close();
}
