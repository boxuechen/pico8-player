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
const soak = process.argv.includes("--soak");
const durationMs = soak ? 600_000 : 5_000;

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function sourceHashes(paths) {
  return Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [
        path,
        createHash("sha256").update(await readFile(resolve(path))).digest("hex"),
      ]),
    ),
  );
}

const server = await startBenchmarkServer({ availability: [] });
const chrome = await launchChrome({
  extraFlags: ["--autoplay-policy=user-gesture-required"],
  profilePrefix: "p8w-phase0f-audio-",
});

try {
  const { cdp } = chrome;
  await cdp.command("Emulation.setDeviceMetricsOverride", {
    width: 900,
    height: 700,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.command("Page.navigate", {
    url: `${server.origin}/tests/browser/phase-0f-audio.html?durationMs=${durationMs}`,
  });
  await waitForDocumentStatus(cdp, {
    accepted: ["awaiting-gesture"],
    timeoutMs: 30_000,
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
  await waitForDocumentStatus(cdp, {
    accepted: ["complete"],
    timeoutMs: durationMs + 120_000,
  });
  const browserResult = await evaluate(cdp, "window.phase0fAudioResult");
  const result = {
    schemaVersion: 1,
    phase: "0F-A",
    mode: soak ? "soak" : "smoke",
    sourceRevision: sourceRevision(),
    sourceSha256: await sourceHashes([
      "apps/web-player/src/transport/audio-protocol.ts",
      "apps/web-player/src/worker/audio-transport.ts",
      "apps/web-player/src/worklet/pcm-queue.ts",
      "apps/web-player/src/worklet/pico8-audio-processor.ts",
      "apps/web-player/src/main/audio-frontend.ts",
      "tests/browser/phase-0f-audio-worker.mjs",
      "tests/browser/phase-0f-audio.mjs",
    ]),
    browser: chrome.version,
    machine: machineMetadata(),
    ...browserResult,
  };

  const resultDirectory = resolve("benchmarks/phase-0f/results");
  await mkdir(resultDirectory, { recursive: true });
  const resultPath = evidence
    ? resolve(resultDirectory, "chromium-macos-arm64-audio.json")
    : resolve(resultDirectory, "chromium-audio-smoke.json");
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);

  check(result.gesture.eventIsTrusted === true, "audio start event was not trusted");
  check(
    result.gesture.userActivationIsActive === true,
    "Chrome user activation was not active during resume",
  );
  check(result.cases.length === 2, "44.1/48 kHz matrix was incomplete");
  for (const entry of result.cases) {
    check(entry.actualSampleRate === entry.requestedSampleRate, "requested device rate was not honored");
    check(entry.initialContextState === "suspended", "AudioContext was not gesture-gated");
    check(entry.stateAfterResume === "running", "AudioContext did not resume");
    check(entry.prebufferStats.startupUnderruns === 0, "prebuffer had startup underruns");
    check(entry.finalStats.startupUnderruns === 0, "steady run recorded startup underruns");
    check(entry.finalStats.steadyUnderruns === 0, "steady run underrun detected");
    check(entry.finalStats.overruns === 0, "bounded queue overrun detected");
    check(entry.finalStats.droppedSourceFrames === 0, "source frames were dropped");
    check(entry.finalStats.discontinuities === 0, "sample sequence discontinuity detected");
    check(
      entry.finalStats.queueHighWaterFrames <=
        entry.finalStats.configuredHighWaterFrames,
      "queue exceeded configured high water",
    );
  }
  check(result.raf.nominalIntervalMs <= 1000 / 29, "main-thread cadence fell below 29 Hz");
  check(result.raf.missedRatio <= 0.001, "main-thread missed-frame ratio exceeded 0.1%");
  check(result.actualDurationMs >= durationMs, "audio run ended before the requested duration");
  process.stdout.write(`${JSON.stringify({ ...result, resultPath }, null, 2)}\n`);
} finally {
  await server.close();
  await chrome.close();
}
