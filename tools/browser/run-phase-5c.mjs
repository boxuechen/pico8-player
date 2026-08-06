import { startBenchmarkServer } from "../benchmark/server.mjs";
import {
  evaluate,
  launchChrome,
  waitForDocumentStatus,
} from "./chrome-cdp.mjs";

const server = await startBenchmarkServer({ availability: [] });
const chrome = await launchChrome({ profilePrefix: "p8w-phase5c-" });

function check(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  await chrome.cdp.command("Page.navigate", {
    url: `${server.origin}/tests/browser/phase-5c.html`,
  });
  try {
    await waitForDocumentStatus(chrome.cdp, { timeoutMs: 60_000 });
  } catch (error) {
    const debug = await evaluate(chrome.cdp, "globalThis.__phase5cDebug ?? null");
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(debug)}`);
  }
  const result = JSON.parse(await evaluate(
    chrome.cdp,
    "document.querySelector('#result').textContent",
  ));
  check(result.waitingStates >= 2, "Chrome did not observe boot and step suspension");
  check(result.recoveredPackedByte === 0x34, "Chrome continuation committed wrong frame bytes");
  check(result.cancelled === true, "Chrome handler did not observe cancellation");
  check(result.staleRuntimeEvents === 0, "Chrome published a stale completion");
  check(result.workerErrors.length === 0, "Chrome Worker reported an error");
  process.stdout.write(`${JSON.stringify({ browser: chrome.version, phase: "5C", ...result }, null, 2)}\n`);
} finally {
  await server.close();
  await chrome.close();
}
