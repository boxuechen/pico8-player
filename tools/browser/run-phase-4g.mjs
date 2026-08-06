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
const manifest = JSON.parse(await readFile(
  resolve("tests/conformance/manifests/phase-4g-resource-long-run.json"),
  "utf8",
));
const soakSeconds = evidence ? manifest.chrome.evidenceSeconds : manifest.chrome.smokeSeconds;

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
    if (Date.now() > deadline) throw new Error(message);
    const status = await evaluate(cdp, "document.body.dataset.status ?? 'loading'");
    if (status === "error") {
      const detail = await evaluate(cdp, "document.querySelector('#result').textContent");
      throw new Error(`${message}: ${detail}`);
    }
    await delay(50);
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

function validateAudio(profile) {
  const delta = profile.audioDelta;
  check(delta.steadyUnderruns <= manifest.chrome.maximumSteadyAudioUnderruns,
    `${profile.targetFps} Hz steady audio underrun gate failed`);
  check(delta.overruns <= manifest.chrome.maximumAudioOverruns,
    `${profile.targetFps} Hz audio overrun gate failed`);
  check(delta.droppedSourceFrames === 0,
    `${profile.targetFps} Hz dropped source audio frames`);
  check(delta.discontinuities <= manifest.chrome.maximumAudioDiscontinuities,
    `${profile.targetFps} Hz audio discontinuity gate failed`);
  check(delta.staleChunks === 0,
    `${profile.targetFps} Hz accepted stale PCM during soak`);
}

const server = await startBenchmarkServer({ availability: [] });
const chrome = await launchChrome({
  extraFlags: [
    "--autoplay-policy=user-gesture-required",
    "--enable-precise-memory-info",
    "--js-flags=--expose-gc",
  ],
  profilePrefix: "p8w-phase4g-",
});

try {
  const { cdp } = chrome;
  await cdp.command("Emulation.setDeviceMetricsOverride", {
    width: 1200,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.command("Page.navigate", {
    url: `${server.origin}/tests/browser/phase-4g.html?soakSeconds=${soakSeconds}`,
  });
  await waitForDocumentStatus(cdp, {
    accepted: ["awaiting-gesture"],
    timeoutMs: 120_000,
  });
  const button = await evaluate(cdp, `(() => {
    const bounds = document.querySelector('#start').getBoundingClientRect();
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  })()`);
  await cdp.command("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: button.x,
    y: button.y,
    button: "left",
    clickCount: 1,
  });
  await cdp.command("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: button.x,
    y: button.y,
    button: "left",
    clickCount: 1,
  });

  const progressTimer = setInterval(() => {
    void evaluate(cdp, "document.body.dataset.progress ?? ''").then((progress) => {
      process.stdout.write(`[phase-4g] ${progress}\n`);
    }).catch(() => undefined);
  }, 30_000);
  try {
    await cdp.command("HeapProfiler.enable");
    await waitFor(
      cdp,
      "window.__phase4gMeasurementReady === true",
      "Phase 4G did not reach the retained-heap baseline",
      120_000,
    );
    const heapBefore = await retainedHeap(cdp);
    await evaluate(cdp, "window.__phase4gMeasurementStart = true");
    await waitFor(
      cdp,
      "window.__phase4gMeasurementDone === true",
      "Phase 4G did not complete the requested soak",
      (soakSeconds + 60) * 1_000,
    );
    const heapAfter = await retainedHeap(cdp);
    const cdpHeap = {
      status: "measured",
      before: heapBefore,
      after: heapAfter,
      deltaBytes: heapAfter.usedBytes - heapBefore.usedBytes,
    };
    await evaluate(cdp, `window.__phase4gCdpHeap = ${JSON.stringify(cdpHeap)};
      window.__phase4gMeasurementFinish = true`);
    await waitForDocumentStatus(cdp, {
      timeoutMs: (soakSeconds + 180) * 1_000,
    });
  } catch (error) {
    const diagnostics = await evaluate(cdp, `({
      progress: document.body.dataset.progress,
      status: document.body.dataset.status,
      result: document.querySelector('#result').textContent,
    })`);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${
      JSON.stringify(diagnostics, null, 2)
    }`);
  } finally {
    clearInterval(progressTimer);
  }

  const browserResult = await evaluate(cdp, "window.phase4gResult");
  check(browserResult.phase === "4G", "Chrome reported the wrong phase");
  check(browserResult.gesture.eventIsTrusted === true, "audio start event was not trusted");
  check(browserResult.gesture.userActivationIsActive === true,
    "Chrome user activation was not active during audio resume");
  check(browserResult.lifecycle.loads === manifest.lifecycle.requiredLoads,
    "Chrome did not complete all sequential cart loads");
  check(browserResult.lifecycle.staleInputProbes === browserResult.lifecycle.generations,
    "Chrome did not reject stale input for every lifecycle generation");
  check(browserResult.lifecycle.staleFrameProbes === browserResult.lifecycle.generations,
    "Chrome did not reject stale frames for every lifecycle generation");
  check(browserResult.lifecycle.stalePcmProbes === browserResult.lifecycle.generations,
    "Chrome did not reject stale PCM for every lifecycle generation");
  check(browserResult.lifecycle.actions.some(({ faultCode }) =>
    faultCode === "E_VM_INSTRUCTION_BUDGET"),
  "Chrome lifecycle did not contain and recover from its structured fault");
  check(browserResult.minimumHeap.oomCode === "E_VM_OOM",
    "Chrome minimum heap OOM was not structured");
  check(browserResult.minimumHeap.oomDetails.luaHeapLimit ===
    manifest.limits.luaHeap.minimumBytes,
  "Chrome OOM diagnostics reported the wrong heap limit");
  check(browserResult.minimumHeap.faultQueuedFrames === 0,
    "Chrome OOM committed partial PCM");
  check(browserResult.minimumHeap.audioStateAfterDispose === "closed",
    "minimum-heap AudioContext did not close");
  check(browserResult.soak.actualDurationMs >= soakSeconds * 1000,
    "Chrome long-run measurement ended early");
  check(browserResult.soak.profiles.length === 2 &&
    browserResult.soak.profiles.map(({ targetFps }) => targetFps).join(",") === "30,60",
  "Chrome long-run cadence matrix was incomplete");
  for (const profile of browserResult.soak.profiles) {
    check(profile.frames === profile.ticks,
      `${profile.targetFps} Hz published frame/tick count drifted`);
    check(profile.cadenceRatio >= manifest.chrome.minimumCadenceRatio,
      `${profile.targetFps} Hz cadence ratio ${profile.cadenceRatio} was too low`);
    check(profile.droppedTickRatio <= manifest.chrome.maximumDroppedTickRatio,
      `${profile.targetFps} Hz dropped tick ratio was too high`);
    check(profile.discontinuities === 0,
      `${profile.targetFps} Hz reported a scheduler discontinuity`);
    validateAudio(profile);
  }
  check(browserResult.soak.longTaskSupport === "measured",
    "Chrome long-task measurement was unavailable");
  check(browserResult.soak.longTasks.length <= manifest.chrome.maximumMainThreadLongTasks,
    "Chrome reported a runtime main-thread long task");
  check(browserResult.soak.heap.status === "measured",
    "Chrome JS heap measurement was unavailable");
  process.stdout.write(`[phase-4g] heap ${JSON.stringify(browserResult.soak.heap)}\n`);
  check(browserResult.soak.heap.cdp.status === "measured",
    "Chrome retained-heap CDP gate was unavailable");
  check(browserResult.soak.heap.cdp.deltaBytes <= manifest.chrome.maximumMeasuredHeapGrowthBytes,
    `Chrome retained heap grew by ${browserResult.soak.heap.cdp.deltaBytes} bytes`);
  check(browserResult.soak.releasedAudio.every(({ queuedSourceFrames, playing }) =>
    queuedSourceFrames === 0 && playing === false),
  "Chrome did not return audio queues to baseline");
  check(browserResult.resources.workersCreated === browserResult.resources.workersTerminated,
    "Chrome retained a production Worker");
  check(browserResult.resources.activeAnimationFrames === 0,
    "Chrome retained a requestAnimationFrame callback");
  check(browserResult.resources.activeDomListeners === 0,
    "Chrome retained DOM listeners");
  check(browserResult.resources.audioStates.every((state) => state === "closed"),
    "Chrome retained an AudioContext");
  check(browserResult.workerErrors.length <= manifest.chrome.maximumWorkerErrors,
    "production Worker reported an error");

  const runtimeManifest = JSON.parse(await readFile(
    resolve("wasm/runtime-v1.manifest.lock.json"),
    "utf8",
  ));
  const sourcePaths = [
    "apps/web-player/src/main/audio-frontend.ts",
    "apps/web-player/src/main/compose-player.ts",
    "apps/web-player/src/main/player-controller.ts",
    "apps/web-player/src/main/player-runtime-client.ts",
    "apps/web-player/src/worker/compose-runtime.ts",
    "apps/web-player/src/worker/player-worker-entry.mjs",
    "apps/web-player/src/worklet/pcm-queue.ts",
    "apps/web-player/src/worklet/pico8-audio-processor.ts",
    "packages/z8lua-bridge/src/public.ts",
    "wasm/bridge/p8w_frame_runtime.cpp",
    "wasm/runtime-v1.manifest.lock.json",
    "tests/conformance/manifests/phase-4g-resource-long-run.json",
    ...manifest.carts.map(({ source }) => source),
    "tests/browser/phase-4g.mjs",
  ];
  const result = {
    schemaVersion: 1,
    ...browserResult,
    configuration: { evidence, soakSeconds },
    browser: chrome.version,
    machine: machineMetadata(),
    sourceRevision: sourceRevision(),
    sourceSha256: await sourceHashes([...new Set(sourcePaths)]),
    runtimeArtifact: runtimeManifest.artifact,
    manifestSha256: sha256(await readFile(
      resolve("tests/conformance/manifests/phase-4g-resource-long-run.json"),
    )),
  };
  const resultDirectory = resolve("benchmarks/phase-4/results");
  await mkdir(resultDirectory, { recursive: true });
  const resultPath = evidence
    ? resolve(resultDirectory, "chromium-macos-arm64-phase-4g-long-run.json")
    : resolve(resultDirectory, "chromium-phase-4g-smoke.json");
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ...result, resultPath }, null, 2)}\n`);
} finally {
  await server.close();
  await chrome.close();
}
