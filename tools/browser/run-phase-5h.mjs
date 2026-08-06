import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { machineMetadata, sourceRevision } from "../benchmark/common.mjs";
import { startBenchmarkServer } from "../benchmark/server.mjs";
import {
  delay,
  evaluate,
  launchChrome,
  waitForDocumentStatus,
} from "./chrome-cdp.mjs";

const evidence = process.argv.includes("--evidence");
const configPath = "tests/conformance/phase-5/exit-config.json";
const config = JSON.parse(await readFile(resolve(configPath), "utf8"));
const soakSeconds = evidence
  ? config.chrome.evidenceSeconds
  : config.chrome.smokeSeconds;

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sourceHashes(paths) {
  return Object.fromEntries(await Promise.all(paths.map(async (path) => [
    path,
    sha256(await readFile(resolve(path))),
  ])));
}

async function waitFor(cdp, expression, message, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!(await evaluate(cdp, expression))) {
    const status = await evaluate(cdp, "document.body.dataset.status ?? 'running'");
    if (status === "error") {
      const detail = await evaluate(cdp, "document.querySelector('#result').textContent");
      throw new Error(`${message}: ${detail}`);
    }
    if (Date.now() > deadline) throw new Error(message);
    await delay(100);
  }
}

async function retainedHeap(cdp) {
  await cdp.command("HeapProfiler.collectGarbage");
  await delay(100);
  const usage = await cdp.command("Runtime.getHeapUsage");
  return {
    usedBytes: usage.usedSize,
    totalBytes: usage.totalSize,
    embedderUsedBytes: usage.embedderHeapUsedSize,
    backingStorageBytes: usage.backingStorageSize,
  };
}

const server = await startBenchmarkServer({ availability: [] });
const chrome = await launchChrome({
  extraFlags: ["--enable-precise-memory-info", "--js-flags=--expose-gc"],
  profilePrefix: "p8w-phase5h-",
});

try {
  const { cdp } = chrome;
  await cdp.command("Page.navigate", {
    url: `${server.origin}/tests/browser/phase-5h.html?soakSeconds=${soakSeconds}`,
  });
  const progressTimer = setInterval(() => {
    void evaluate(cdp, "document.body.dataset.progress ?? ''").then((progress) => {
      process.stdout.write(`[phase-5h] ${progress}\n`);
    }).catch(() => undefined);
  }, 30_000);
  try {
    await cdp.command("HeapProfiler.enable");
    await waitFor(
      cdp,
      "window.__phase5hMeasurementReady === true",
      "Phase 5H did not reach its retained-heap baseline",
      180_000,
    );
    const heapBefore = await retainedHeap(cdp);
    await evaluate(cdp, "window.__phase5hMeasurementStart = true");
    await waitFor(
      cdp,
      "window.__phase5hMeasurementDone === true",
      "Phase 5H did not complete the mixed soak",
      (soakSeconds + 300) * 1000,
    );
    const heapAfter = await retainedHeap(cdp);
    const cdpHeap = {
      status: "measured",
      before: heapBefore,
      after: heapAfter,
      deltaBytes: heapAfter.usedBytes - heapBefore.usedBytes,
    };
    await evaluate(cdp, `window.__phase5hCdpHeap = ${JSON.stringify(cdpHeap)};
      window.__phase5hMeasurementFinish = true`);
    await waitForDocumentStatus(cdp, { timeoutMs: 180_000 });
  } catch (error) {
    const diagnostics = await evaluate(cdp, `({
      progress: document.body.dataset.progress,
      status: document.body.dataset.status,
      result: document.querySelector('#result').textContent,
      debug: globalThis.__phase5hDebug ? {
        sessionGeneration: globalThis.__phase5hDebug.sessionGeneration,
        rawMessageCount: globalThis.__phase5hDebug.telemetry.rawMessageCount,
        rawMessages: globalThis.__phase5hDebug.telemetry.rawMessages.slice(-12),
      } : null,
    })`);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${
      JSON.stringify(diagnostics, null, 2)
    }`);
  } finally {
    clearInterval(progressTimer);
  }

  const browserResult = await evaluate(cdp, "window.phase5hResult");
  check(browserResult.runner.id === config.runner.id &&
    browserResult.runner.version === config.runner.version,
  "Chrome runner identity diverged");
  check(browserResult.summary.denominator === config.requiredCorpusCases &&
    browserResult.summary.counts.C3 === config.requiredCorpusCases &&
    browserResult.summary.counts.CU === 0 &&
    browserResult.summary.playableRate >= 0.95,
  "Chrome corpus summary diverged");
  check(browserResult.cases.every((entry) =>
    entry.classification === config.requiredClassification),
  "Chrome corpus contains a non-C3 case");
  check(browserResult.cartSwaps.completed === config.requiredSequentialGuestSwaps &&
    browserResult.cartSwaps.replacementHandshakes === config.requiredSequentialGuestSwaps &&
    browserResult.cartSwaps.exactGenerationSequence === true,
  "Chrome 100-swap gate diverged");
  check(browserResult.cartSwaps.liveContextsBeforeDispose === 1,
    "Chrome retained a superseded VM after sequential swaps");
  check(browserResult.cartSwaps.wasmBytes === config.resources.fixedWasmBytes,
    "Chrome WASM memory size diverged");
  check(browserResult.faultRecovery.stagedFaultCode === "E_VM_RUNTIME" &&
    browserResult.faultRecovery.recovered === true,
  "Chrome staged failure recovery diverged");
  check(browserResult.soak.actualDurationMs >= soakSeconds * 1000,
    "Chrome mixed soak ended early");
  check(browserResult.soak.measuredCycles > 0,
    "Chrome mixed soak completed no cycles");
  check(browserResult.soak.retainedHeap?.status === "measured",
    "Chrome retained heap was not measured");
  check(browserResult.soak.retainedHeap.deltaBytes <=
    config.chrome.maximumRetainedHeapGrowthBytes,
  `Chrome retained heap grew by ${browserResult.soak.retainedHeap.deltaBytes} bytes`);
  check(browserResult.staleCommits.total === config.chrome.maximumStaleCommits,
    "Chrome accepted a stale commit");
  check(browserResult.resources.pendingRequests === 0 &&
    browserResult.resources.workersCreated === browserResult.resources.workersTerminated &&
    browserResult.resources.audioPortReleased === true,
  "Chrome did not release all runtime resources");
  check(browserResult.workerErrors.length <= config.chrome.maximumWorkerErrors,
    "Chrome production Worker reported an error");

  const runtimeManifest = JSON.parse(await readFile(
    resolve("wasm/runtime-v1.manifest.lock.json"),
    "utf8",
  ));
  const sourcePaths = [
    "apps/web-player/src/main/player-runtime-client.ts",
    "apps/web-player/src/worker/audio-transport.ts",
    "apps/web-player/src/worker/compose-runtime.ts",
    "apps/web-player/src/worker/adapters/host-cart-resolver-adapter.ts",
    "apps/web-player/src/worker/adapters/indexeddb-persistence-adapter.ts",
    "packages/runtime-core/src/cart/cart-loader.ts",
    "packages/runtime-core/src/frame-runtime.ts",
    "packages/z8lua-bridge/src/public.ts",
    "wasm/bridge/p8w_frame_runtime.cpp",
    "wasm/runtime-v1.manifest.lock.json",
    "tests/conformance/manifests/phase-5-l3-corpus.json",
    configPath,
    "tests/browser/phase-5h.html",
    "tests/browser/phase-5h.mjs",
    "tests/browser/phase-5h-worker.mjs",
    "tools/browser/build-phase-5h-worker.mjs",
    "tools/browser/run-phase-5h.mjs",
  ];
  const result = {
    schemaVersion: 1,
    phase: "5H",
    target: "chrome-production",
    releaseClaim: config.releaseClaim,
    ...browserResult,
    configuration: { evidence, soakSeconds },
    browser: chrome.version,
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
    const resultPath = resolve(resultDirectory, "chromium-macos-arm64-l3-exit.json");
    await mkdir(resultDirectory, { recursive: true });
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ ...result, resultPath }, null, 2)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
} finally {
  await server.close();
  await chrome.close();
}
