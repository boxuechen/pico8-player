import { startBenchmarkServer } from "../benchmark/server.mjs";
import {
  evaluate,
  launchChrome,
  waitForDocumentStatus,
} from "./chrome-cdp.mjs";

const server = await startBenchmarkServer({ availability: [] });
const chrome = await launchChrome({
  profilePrefix: "p8w-phase7b-",
  extraFlags: ["--autoplay-policy=no-user-gesture-required"],
});

function check(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  await chrome.cdp.command("Page.navigate", {
    url: `${server.origin}/tests/browser/phase-7b.html`,
  });
  await waitForDocumentStatus(chrome.cdp, { timeoutMs: 60_000 });
  const result = JSON.parse(await evaluate(
    chrome.cdp,
    "document.querySelector('#result').textContent",
  ));
  check(result.apiVersion === 2, "Chrome used the wrong Embed API version");
  check(result.workerCount === 3 && result.terminatedWorkers === 3,
    "Chrome did not isolate Worker lifecycles");
  check(result.audioContextCount === 3, "Chrome did not isolate audio lifecycles");
  check(result.firstFrameCount >= 4 && result.secondFrameCount >= 7,
    "Chrome did not run two independent frame streams");
  check(result.loadRaceRejected === true, "Chrome did not reject the load/dispose race");
  process.stdout.write(`${JSON.stringify({ browser: chrome.version, ...result }, null, 2)}\n`);
} finally {
  await server.close();
  await chrome.close();
}
