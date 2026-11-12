import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startBenchmarkServer } from "../benchmark/server.mjs";
import {
  delay,
  evaluate,
  launchChrome,
  waitForDocumentStatus,
} from "./chrome-cdp.mjs";

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForCapture(cdp, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await evaluate(cdp, "document.body?.dataset?.status ?? 'loading'");
    const progress = await evaluate(cdp, "document.body?.dataset?.progress ?? ''");
    if (status === "error") {
      const detail = await evaluate(cdp, "document.querySelector('#result')?.textContent ?? ''");
      throw new Error(`${progress}: ${detail}`);
    }
    if (progress === "capture") return;
    if (Date.now() > deadline) throw new Error("Timed out waiting for cart B capture point");
    await delay(50);
  }
}

const server = await startBenchmarkServer({ availability: [] });
const chrome = await launchChrome({
  profilePrefix: "p8w-phase14a-",
  extraFlags: ["--autoplay-policy=no-user-gesture-required"],
});
const screenshotDirectory = await mkdtemp(join(tmpdir(), "p8w-phase14a-evidence-"));
const screenshotPath = join(screenshotDirectory, "cart-b-sequential-startup.png");

try {
  await chrome.cdp.command("Page.navigate", {
    url: `${server.origin}/tests/browser/phase-14a.html`,
  });
  await waitForCapture(chrome.cdp);
  const capture = await chrome.cdp.command("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  await writeFile(screenshotPath, Buffer.from(capture.data, "base64"));
  await evaluate(chrome.cdp, "window.__phase14Resume(); true");
  await waitForDocumentStatus(chrome.cdp, { timeoutMs: 60_000 });
  const result = JSON.parse(await evaluate(
    chrome.cdp,
    "document.querySelector('#result').textContent",
  ));
  check(result.apiVersion === 2, "Chrome used the wrong Embed API version");
  check(result.firstFrames >= 1 && result.secondFrames >= 1 && result.freshFrames >= 1,
    "a startup resolved without a presented frame");
  check(result.generations[1] > result.generations[0],
    "same-facade cart replacement retained a generation");
  check(new Set(Object.values(result.pixels).map(JSON.stringify)).size === 3,
    "sequential Canvas pixels were not isolated");
  check(result.workerCount === 2 && result.terminatedWorkers === 2,
    "fresh facade Worker lifecycle was not isolated");
  check(result.audioContextCount === 2 && result.closedAudioContexts === 2,
    "fresh facade AudioContext lifecycle was not isolated");
  check(result.activeAnimationFrames === 0, "dispose retained an animation frame");
  process.stdout.write(`${JSON.stringify({
    browser: chrome.version,
    screenshotPath,
    ...result,
  }, null, 2)}\n`);
} finally {
  await server.close();
  await chrome.close();
}
