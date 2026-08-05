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
const server = await startBenchmarkServer({ availability: [] });
const chrome = await launchChrome({
  extraFlags: ["--autoplay-policy=user-gesture-required"],
  profilePrefix: "p8w-phase0f-integration-",
});

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

try {
  const { cdp } = chrome;
  await cdp.command("Emulation.setDeviceMetricsOverride", {
    width: 900,
    height: 700,
    deviceScaleFactor: 1.25,
    mobile: false,
  });
  await cdp.command("Page.navigate", {
    url: `${server.origin}/tests/browser/phase-0f-integration.html`,
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
  await waitForDocumentStatus(cdp, { accepted: ["complete"], timeoutMs: 30_000 });
  const browserResult = await evaluate(cdp, "window.phase0fIntegrationResult");
  const result = {
    schemaVersion: 1,
    phase: "0F-I",
    sourceRevision: sourceRevision(),
    sourceSha256: await sourceHashes([
      "apps/web-player/src/main/compose-player.ts",
      "apps/web-player/src/main/runtime-client.ts",
      "apps/web-player/src/main/audio-frontend.ts",
      "apps/web-player/src/worker/runtime-worker.ts",
      "tests/browser/phase-0f-integration-worker.mjs",
      "tests/browser/phase-0f-integration.mjs",
    ]),
    browser: chrome.version,
    machine: machineMetadata(),
    ...browserResult,
  };

  const resultDirectory = resolve("benchmarks/phase-0f/results");
  await mkdir(resultDirectory, { recursive: true });
  const resultPath = evidence
    ? resolve(resultDirectory, "chromium-macos-arm64-integration.json")
    : resolve(resultDirectory, "chromium-integration-smoke.json");
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);

  check(result.gesture.eventIsTrusted === true, "integration click was not trusted");
  check(result.gesture.userActivationIsActive === true, "integration lacked active user gesture");
  check(result.firstGeneration === 1 && result.secondGeneration === 2, "generation did not advance once");
  check(result.watchdogCode === "E_VM_WATCHDOG", "Worker hang did not trigger watchdog");
  check(result.recovered === true, "replacement Worker did not recover");
  check(result.firstRgbaSha256 === result.expectedRgbaSha256, "composed presenter pixel hash drifted");
  check(result.presenterGeneration === -1, "presenter did not dispose");
  check(result.finalStats.sessionGeneration === 2, "Worklet did not attach replacement generation");
  check(result.finalStats.steadyUnderruns === 0, "integration had steady audio underrun");
  check(result.finalStats.overruns === 0, "integration had audio overrun");
  check(result.audioStateAfterDispose === "closed", "AudioContext did not close");
  check(result.workerCount === 2 && result.terminateCount === 2, "Worker lifecycle leaked or over-terminated");
  process.stdout.write(`${JSON.stringify({ ...result, resultPath }, null, 2)}\n`);
} finally {
  await server.close();
  await chrome.close();
}
