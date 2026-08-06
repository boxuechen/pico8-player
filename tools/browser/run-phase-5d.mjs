import { startBenchmarkServer } from "../benchmark/server.mjs";
import {
  evaluate,
  launchChrome,
  waitForDocumentStatus,
} from "./chrome-cdp.mjs";

const server = await startBenchmarkServer({ availability: [] });
const chrome = await launchChrome({ profilePrefix: "p8w-phase5d-" });

function check(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  await chrome.cdp.command("Page.navigate", {
    url: `${server.origin}/tests/browser/phase-5d.html`,
  });
  try {
    await waitForDocumentStatus(chrome.cdp, { timeoutMs: 60_000 });
  } catch (error) {
    const debug = await evaluate(chrome.cdp, "globalThis.__phase5dDebug ?? null");
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(debug)}`);
  }
  const result = JSON.parse(await evaluate(
    chrome.cdp,
    "document.querySelector('#result').textContent",
  ));
  check(result.handshakeCount === 2, "Chrome did not observe both replacement handshakes");
  check(result.generations.join(",") === "1,2,3,4", "Chrome generation sequence diverged");
  check(result.callbackPixel === 1 && result.customPixel === 1,
    "Chrome stat(6) target observations diverged");
  check(result.staleFrames === 0, "Chrome published a stale launcher frame");
  check(result.workerErrors.length === 0, "Chrome Worker reported an error");
  process.stdout.write(`${JSON.stringify({ browser: chrome.version, phase: "5D", ...result }, null, 2)}\n`);
} finally {
  await server.close();
  await chrome.close();
}
