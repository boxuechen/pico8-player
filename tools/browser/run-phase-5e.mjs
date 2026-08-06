import { startBenchmarkServer } from "../benchmark/server.mjs";
import {
  evaluate,
  launchChrome,
  waitForDocumentStatus,
} from "./chrome-cdp.mjs";

const server = await startBenchmarkServer({ availability: [] });
const chrome = await launchChrome({ profilePrefix: "p8w-phase5e-" });

function check(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  await chrome.cdp.command("Page.navigate", {
    url: `${server.origin}/tests/browser/phase-5e.html`,
  });
  try {
    await waitForDocumentStatus(chrome.cdp, { timeoutMs: 60_000 });
  } catch (error) {
    const debug = await evaluate(chrome.cdp, "globalThis.__phase5eDebug ?? null");
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(debug)}`);
  }
  const result = JSON.parse(await evaluate(
    chrome.cdp,
    "document.querySelector('#result').textContent",
  ));
  check(result.handshakeCount === 0, "Chrome observed a cart replacement handshake");
  check(result.waitingCount >= 3, "Chrome missed an external suspension boundary");
  check(result.generations.join(",") === "1,2", "Chrome generation sequence diverged");
  check(result.reloadOracle === 16 && result.cstoreOracle === 16,
    "Chrome external data oracle diverged");
  check(result.reloadCompletedSlices === "2" && result.cstoreCompletedSlices === "2",
    "Chrome logical time advanced while waiting");
  check(result.workerErrors.length === 0, "Chrome Worker reported an error");
  process.stdout.write(`${JSON.stringify({ browser: chrome.version, phase: "5E", ...result }, null, 2)}\n`);
} finally {
  await server.close();
  await chrome.close();
}
