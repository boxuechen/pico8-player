import { startBenchmarkServer } from "../benchmark/server.mjs";
import {
  evaluate,
  launchChrome,
  waitForDocumentStatus,
} from "./chrome-cdp.mjs";

function check(condition, message) {
  if (!condition) throw new Error(message);
}

const server = await startBenchmarkServer({ availability: [] });
const chrome = await launchChrome({
  extraFlags: ["--autoplay-policy=user-gesture-required"],
  profilePrefix: "p8w-phase3b-",
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
    url: `${server.origin}/tests/browser/phase-3b.html`,
  });
  await waitForDocumentStatus(cdp, {
    accepted: ["awaiting-gesture"],
    timeoutMs: 60_000,
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
    timeoutMs: 90_000,
  });
  const result = await evaluate(cdp, "window.phase3bResult");
  check(result.gesture.eventIsTrusted === true, "audio start event was not trusted");
  check(
    result.gesture.userActivationIsActive === true,
    "Chrome user activation was not active during resume",
  );
  check(result.workerErrors.length === 0, "production Worker reported an error");
  check(result.cases.length === 2, "44.1/48 kHz matrix was incomplete");
  check(
    result.actualDurationMs >= result.manifest.durationMs,
    "production audio run ended before the requested duration",
  );
  check(result.pulseCount > 30, "production runtime did not receive enough rAF pulses");
  for (const entry of result.cases) {
    check(
      entry.actualSampleRate === entry.requestedSampleRate,
      `${entry.requestedSampleRate} Hz AudioContext was not honored`,
    );
    check(entry.initialContextState === "suspended", "AudioContext was not gesture-gated");
    check(entry.stateAfterResume === "running", "AudioContext did not resume");
    check(
      entry.prebufferStats.queuedSourceFrames >= result.manifest.prebufferSourceFrames,
      "production PCM did not reach the Worklet prebuffer",
    );
    check(
      entry.finalStats.receivedChunks > entry.prebufferStats.receivedChunks,
      "production Worker stopped sending frame PCM",
    );
    check(entry.finalStats.playing === true, "Worklet never entered playback");
    check(entry.finalStats.startupUnderruns === 0, "startup underrun detected");
    check(entry.finalStats.steadyUnderruns === 0, "steady underrun detected");
    check(entry.finalStats.overruns === 0, "bounded queue overrun detected");
    check(entry.finalStats.droppedSourceFrames === 0, "source PCM frames were dropped");
    check(entry.finalStats.discontinuities === 0, "PCM sequence discontinuity detected");
    check(entry.finalStats.staleChunks === 0, "stale generation PCM was accepted");
    check(
      entry.finalStats.queueHighWaterFrames <= entry.finalStats.configuredHighWaterFrames,
      "queue exceeded its configured high water",
    );
  }
  for (const stats of result.resetStats) {
    check(stats.receivedChunks === 0, "stop did not reset Worklet chunk counters");
    check(stats.queuedSourceFrames === 0, "stop did not clear the Worklet queue");
  }
  process.stdout.write(`${JSON.stringify({ browser: chrome.version, ...result }, null, 2)}\n`);
} finally {
  await server.close();
  await chrome.close();
}
