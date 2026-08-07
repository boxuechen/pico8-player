import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { startBenchmarkServer } from "../../benchmark/server.mjs";
import {
  delay,
  evaluate,
  launchChrome,
  waitForDocumentStatus,
} from "../chrome-cdp.mjs";

const diagnostic = process.argv.includes("--diagnostic");
const gateManifest = JSON.parse(await readFile(
  resolve("tests/conformance/manifests/phase-7g-chrome-hardening.json"),
  "utf8",
));
const resourceManifest = JSON.parse(await readFile(
  resolve("tests/conformance/manifests/phase-4g-resource-long-run.json"),
  "utf8",
));
const soakSeconds = diagnostic
  ? gateManifest.soak.diagnosticSeconds
  : gateManifest.soak.seconds;

function check(condition, message) {
  if (!condition) throw new Error(message);
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
  check(delta.steadyUnderruns <= gateManifest.soak.maximumSteadyAudioUnderruns,
    `${profile.targetFps} Hz steady audio underrun gate failed`);
  check(delta.overruns <= gateManifest.soak.maximumAudioOverruns,
    `${profile.targetFps} Hz audio overrun gate failed`);
  check(delta.droppedSourceFrames === 0,
    `${profile.targetFps} Hz dropped source audio frames`);
  check(delta.discontinuities <= gateManifest.soak.maximumAudioDiscontinuities,
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
  profilePrefix: "p8w-phase7g-soak-",
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
      process.stdout.write(`[phase-7g-soak] ${progress}\n`);
    }).catch(() => undefined);
  }, 30_000);
  try {
    await cdp.command("HeapProfiler.enable");
    await waitFor(
      cdp,
      "window.__phase4gMeasurementReady === true",
      "soak did not reach its retained-heap baseline",
      120_000,
    );
    const heapBefore = await retainedHeap(cdp);
    await evaluate(cdp, "window.__phase4gMeasurementStart = true");
    await waitFor(
      cdp,
      "window.__phase4gMeasurementDone === true",
      "soak did not complete its wall-clock interval",
      (soakSeconds + 60) * 1_000,
    );
    const heapAfter = await retainedHeap(cdp);
    await evaluate(cdp, `window.__phase4gCdpHeap = ${JSON.stringify({
      status: "measured",
      before: heapBefore,
      after: heapAfter,
      deltaBytes: heapAfter.usedBytes - heapBefore.usedBytes,
    })}; window.__phase4gMeasurementFinish = true`);
    await waitForDocumentStatus(cdp, {
      timeoutMs: (soakSeconds + 180) * 1_000,
    });
  } catch (error) {
    const detail = await evaluate(cdp, `({
      progress: document.body.dataset.progress,
      status: document.body.dataset.status,
      result: document.querySelector('#result').textContent,
    })`);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${
      JSON.stringify(detail, null, 2)
    }`);
  } finally {
    clearInterval(progressTimer);
  }

  const browserResult = await evaluate(cdp, "window.phase4gResult");
  check(browserResult.phase === "4G", "resource harness reported the wrong phase");
  check(browserResult.gesture.eventIsTrusted === true,
    "AudioContext unlock did not use a trusted event");
  check(browserResult.gesture.userActivationIsActive === true,
    "user activation was inactive during audio unlock");
  check(browserResult.lifecycle.loads === resourceManifest.lifecycle.requiredLoads,
    "resource harness did not complete all sequential loads");
  check(browserResult.lifecycle.staleInputProbes === browserResult.lifecycle.generations,
    "stale input rejection was incomplete");
  check(browserResult.lifecycle.staleFrameProbes === browserResult.lifecycle.generations,
    "stale frame rejection was incomplete");
  check(browserResult.lifecycle.stalePcmProbes === browserResult.lifecycle.generations,
    "stale PCM rejection was incomplete");
  check(browserResult.soak.actualDurationMs >= soakSeconds * 1_000,
    "wall-clock soak ended early");
  check(browserResult.soak.profiles.map(({ targetFps }) => targetFps).join(",") ===
    gateManifest.soak.profilesHz.join(","), "cadence profile matrix was incomplete");
  for (const profile of browserResult.soak.profiles) {
    check(profile.frames === profile.ticks,
      `${profile.targetFps} Hz frame and tick totals drifted`);
    check(profile.cadenceRatio >= gateManifest.soak.minimumCadenceRatio,
      `${profile.targetFps} Hz cadence ratio was below budget`);
    check(profile.droppedTickRatio <= gateManifest.soak.maximumDroppedTickRatio,
      `${profile.targetFps} Hz dropped tick ratio exceeded budget`);
    check(profile.discontinuities === 0,
      `${profile.targetFps} Hz scheduler discontinuity was observed`);
    validateAudio(profile);
  }
  check(browserResult.soak.longTaskSupport === "measured",
    "Long Tasks measurement was unavailable");
  check(browserResult.soak.longTasks.length <= gateManifest.soak.maximumMainThreadLongTasks,
    "main-thread long-task budget failed");
  check(browserResult.soak.heap.status === "measured" &&
    browserResult.soak.heap.cdp.status === "measured",
  "retained heap measurement was unavailable");
  check(browserResult.soak.heap.cdp.deltaBytes <=
    gateManifest.soak.maximumMeasuredHeapGrowthBytes,
  "retained heap growth exceeded budget");
  check(browserResult.soak.releasedAudio.every(({ queuedSourceFrames, playing }) =>
    queuedSourceFrames === 0 && playing === false),
  "audio queues did not return to baseline");
  check(browserResult.resources.workersCreated === browserResult.resources.workersTerminated,
    "soak retained a Worker");
  check(browserResult.resources.activeAnimationFrames === 0,
    "soak retained a requestAnimationFrame callback");
  check(browserResult.resources.activeDomListeners === 0,
    "soak retained DOM listeners");
  check(browserResult.resources.audioStates.every((state) => state === "closed"),
    "soak retained an AudioContext");
  check(browserResult.workerErrors.length <= gateManifest.soak.maximumWorkerErrors,
    "soak Worker error budget failed");

  const result = {
    schemaVersion: 1,
    phase: "7G-soak",
    diagnostic,
    browser: chrome.version,
    requestedSeconds: soakSeconds,
    actualDurationMs: browserResult.soak.actualDurationMs,
    profiles: browserResult.soak.profiles.map((profile) => ({
      targetFps: profile.targetFps,
      frames: profile.frames,
      ticks: profile.ticks,
      cadenceRatio: profile.cadenceRatio,
      droppedTickRatio: profile.droppedTickRatio,
      steadyAudioUnderruns: profile.audioDelta.steadyUnderruns,
      audioOverruns: profile.audioDelta.overruns,
      discontinuities: profile.discontinuities,
    })),
    longTasks: browserResult.soak.longTasks.length,
    retainedHeapDeltaBytes: browserResult.soak.heap.cdp.deltaBytes,
    resources: browserResult.resources,
    workerErrors: browserResult.workerErrors.length,
  };
  const resultPath = process.env.P8W_PHASE7G_SOAK_RESULT;
  if (resultPath) await writeFile(resolve(resultPath), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await server.close();
  await chrome.close();
}
