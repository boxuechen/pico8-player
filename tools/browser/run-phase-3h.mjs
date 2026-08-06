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

async function waitFor(cdp, expression, message, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await evaluate(cdp, expression))) {
    if (Date.now() > deadline) throw new Error(message);
    await delay(50);
  }
}

const server = await startBenchmarkServer({ availability: [] });
const chrome = await launchChrome({
  extraFlags: ["--autoplay-policy=user-gesture-required"],
  profilePrefix: "p8w-phase3h-",
});

try {
  const { cdp } = chrome;
  await cdp.command("Emulation.setDeviceMetricsOverride", {
    width: 1000,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.command("Page.navigate", {
    url: `${server.origin}/tests/browser/phase-3h.html`,
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
    type: "mousePressed", x: button.x, y: button.y, button: "left", clickCount: 1,
  });
  await cdp.command("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: button.x, y: button.y, button: "left", clickCount: 1,
  });
  await waitFor(cdp, "window.__phase3hInputReady === true",
    "Phase 3H did not reach the trusted input checkpoint", 30_000);
  const canvas = await evaluate(cdp, `(() => {
    const bounds = document.querySelector('canvas').getBoundingClientRect();
    document.querySelector('canvas').focus();
    return { x: bounds.x + bounds.width * 0.75, y: bounds.y + bounds.height * 0.25 };
  })()`);
  await cdp.command("Input.dispatchMouseEvent", {
    type: "mouseMoved", x: canvas.x, y: canvas.y, button: "none", buttons: 0,
  });
  await cdp.command("Input.dispatchMouseEvent", {
    type: "mouseWheel", x: canvas.x, y: canvas.y, button: "none", buttons: 0,
    deltaX: 0, deltaY: -100,
  });
  for (const key of [
    { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
    { key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 },
    { key: "q", code: "KeyQ", text: "q", windowsVirtualKeyCode: 81 },
  ]) {
    await cdp.command("Input.dispatchKeyEvent", { type: "keyDown", ...key });
  }
  await delay(250);
  for (const key of [
    { key: "q", code: "KeyQ", windowsVirtualKeyCode: 81 },
    { key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 },
    { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ]) {
    await cdp.command("Input.dispatchKeyEvent", { type: "keyUp", ...key });
  }
  await evaluate(cdp, "window.__phase3hInputDone = true");

  try {
    await waitForDocumentStatus(cdp, { timeoutMs: 180_000 });
  } catch (error) {
    const diagnostics = await evaluate(cdp, `({
      progress: document.body.dataset.progress,
      status: document.body.dataset.status,
      result: document.querySelector('#result').textContent,
    })`);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(diagnostics, null, 2)}`);
  }
  const browserResult = await evaluate(cdp, "window.phase3hResult");
  check(browserResult.phase === "3H", "Chrome reported the wrong phase");
  check(browserResult.deterministic.length === 2, "Chrome deterministic matrix was incomplete");
  check(browserResult.performance.cases.length === 2, "Chrome performance matrix was incomplete");
  check(browserResult.performance.cases.every(({ measuredTicks }) => measuredTicks === 120),
    "Chrome performance samples were incomplete");
  check(browserResult.performance.maxP95Ms <= 8, "Chrome Phase 3 p95 exceeded 8ms");
  check(browserResult.audio.gesture.eventIsTrusted === true, "audio start event was not trusted");
  check(browserResult.audio.gesture.userActivationIsActive === true,
    "Chrome user activation was not active during audio resume");
  check(browserResult.audio.actualSampleRate === 48_000, "48kHz AudioContext was not honored");
  check(browserResult.audio.soak.actualDurationMs >= 60_000, "bounded soak ended early");
  check(browserResult.audio.soak.runtimeFrames >= 3_000,
    "bounded soak produced too few production frames");
  check(browserResult.audio.soak.timeDiscontinuities === 0,
    "bounded soak reported a scheduler discontinuity");
  const stats = browserResult.audio.soak.audioStats;
  check(browserResult.audio.soak.startupUnderrunDelta === 0 &&
    browserResult.audio.soak.steadyUnderrunDelta === 0,
  `bounded soak reported a new audio underrun: ${JSON.stringify({
    baseline: browserResult.audio.soak.baselineAudioStats,
    final: stats,
  })}`);
  check(stats.steadyUnderruns === 0,
    `bounded soak entered steady underrun state: ${JSON.stringify(stats)}`);
  check(stats.overruns === 0 && stats.droppedSourceFrames === 0,
    "bounded soak overflowed the audio queue");
  check(stats.discontinuities === 0 && stats.staleChunks === 0,
    "bounded soak accepted discontinuous or stale audio");
  check(browserResult.audio.recovery.code === "E_HOST_API",
    "Chrome host fault was not structured");
  check(browserResult.audio.recovery.recoveryGeneration
    > browserResult.audio.recovery.faultGeneration,
  "Chrome recovery did not advance generation");
  check(browserResult.audio.recovery.faultResetStats.queuedSourceFrames === 0,
    "host fault did not clear the Worklet queue");
  check(browserResult.audio.audioStateAfterDispose === "closed",
    "AudioContext did not close on dispose");
  check(browserResult.persistence.generationAfterReset
    > browserResult.persistence.generationBeforeReset,
  "persistence reset did not advance generation");
  check(browserResult.persistence.initial[0] === 1 && browserResult.persistence.initial[1] === 21,
    "fresh persistence/overlay Canvas oracle drifted");
  check(browserResult.persistence.reset[0] === 2 && browserResult.persistence.reset[1] === 22,
    "reset persistence/overlay Canvas oracle drifted");
  check(browserResult.persistence.writeFailureDiagnostic === true,
    "IndexedDB write failure was not visible");
  check(browserResult.persistence.failureState === "paused",
    "IndexedDB write failure faulted valid simulation");
  check(browserResult.resources.workersCreated === browserResult.resources.workersTerminated,
    "disposed Phase 3H players retained Workers");
  check(browserResult.workerErrors.length === 0, "production Worker reported an error");

  const result = {
    ...browserResult,
    sourceRevision: sourceRevision(),
    sourceSha256: await sourceHashes([
      "apps/web-player/src/main/compose-player.ts",
      "apps/web-player/src/main/player-controller.ts",
      "apps/web-player/src/main/audio-frontend.ts",
      "apps/web-player/src/worker/compose-runtime.ts",
      "apps/web-player/src/worker/adapters/indexeddb-persistence-adapter.ts",
      "apps/web-player/src/worker/adapters/cart-repository-adapter.ts",
      "apps/web-player/src/worklet/pico8-audio-processor.ts",
      "packages/runtime-core/src/frame-runtime.ts",
      "tests/conformance/manifests/phase-3h-exit.json",
      "tests/conformance/carts/phase-3/audio-input.p8",
      "tests/conformance/carts/phase-3/persistence-overlay.p8",
      "tests/conformance/carts/phase-3/host-api-fault.p8",
      "tests/browser/phase-3h.mjs",
    ]),
    browser: chrome.version,
    machine: machineMetadata(),
  };
  const resultDirectory = resolve("benchmarks/phase-3/results");
  await mkdir(resultDirectory, { recursive: true });
  const resultPath = evidence
    ? resolve(resultDirectory, "chromium-macos-arm64-phase-3-exit.json")
    : resolve(resultDirectory, "chromium-phase-3-exit-smoke.json");
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ...result, resultPath }, null, 2)}\n`);
} finally {
  await server.close();
  await chrome.close();
}
