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
  profilePrefix: "p8w-phase4e-",
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
    url: `${server.origin}/tests/browser/phase-4e.html`,
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

  try {
    await waitForDocumentStatus(cdp, { timeoutMs: 120_000 });
  } catch (error) {
    const diagnostics = await evaluate(cdp, `({
      progress: document.body.dataset.progress,
      status: document.body.dataset.status,
      result: document.querySelector('#result').textContent,
    })`);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${
      JSON.stringify(diagnostics, null, 2)
    }`);
  }
  const result = await evaluate(cdp, "window.phase4eResult");
  check(result.phase === "4E", "Chrome reported the wrong phase");
  check(result.apiCount === 7, "Chrome did not cover all required Phase 4E APIs");
  check(result.gesture.eventIsTrusted === true, "audio start event was not trusted");
  check(result.gesture.userActivationIsActive === true,
    "Chrome user activation was not active during audio resume");
  check(result.controls.some(({ control, payload }) => control === "run" && payload === "again"),
    "Chrome did not observe guest run");
  check(result.controls.some(({ control, payload }) => control === "stop" && payload === "done"),
    "Chrome did not observe guest stop");
  check(result.faultCode === "E_VM_RUNTIME", "Chrome assert fault was not structured");
  check(result.recoveredFrames >= 1, "Chrome did not recover after the fault");
  check(result.audio.actualSampleRate === 48_000, "48kHz AudioContext was not honored");
  check(result.audio.stats.receivedChunks > 0, "AudioWorklet received no canonical audio");
  check(result.audio.stateAfterDispose === "closed", "AudioContext did not close on dispose");
  check(result.resources.workersCreated === result.resources.workersTerminated,
    "disposed Phase 4E player retained a Worker");
  check(result.workerErrors.length === 0, "production Worker reported an error");
  process.stdout.write(`${JSON.stringify({ browser: chrome.version, ...result }, null, 2)}\n`);
} finally {
  await server.close();
  await chrome.close();
}
