import { startBenchmarkServer } from "../benchmark/server.mjs";
import {
  evaluate,
  launchChrome,
  waitForDocumentStatus,
} from "./chrome-cdp.mjs";

const server = await startBenchmarkServer({ availability: [] });
const chrome = await launchChrome({ profilePrefix: "p8w-phase5f-" });

function check(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  await chrome.cdp.command("Page.navigate", {
    url: `${server.origin}/tests/browser/phase-5f.html`,
  });
  try {
    await waitForDocumentStatus(chrome.cdp, { timeoutMs: 60_000 });
  } catch (error) {
    const debug = await evaluate(chrome.cdp, "globalThis.__phase5fDebug ?? null");
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(debug)}`);
  }
  const result = JSON.parse(await evaluate(
    chrome.cdp,
    "document.querySelector('#result').textContent",
  ));
  check(result.decision === "accepted-root-only", "Chrome decision diverged");
  check(result.matrixCases === 28 && result.structuredFaults === 28,
    "Chrome suspension matrix is incomplete");
  check(result.waitingHostEvents === 0, "Chrome nested request reached a resolver");
  check(result.replacementHandshakes === 0, "Chrome nested request replaced a session");
  check(result.publishedFrames === 0, "Chrome nested request published a frame");
  check(result.runtimeControls === 0, "Chrome nested run/stop escaped the VM");
  check(result.corpusClassification === "C3" &&
    result.corpusFaultCode === "E_FEATURE_UNSUPPORTED",
  "Chrome corpus classification diverged");
  check(result.budgetFaultCode === "E_VM_INSTRUCTION_BUDGET",
    "Chrome nested budget containment diverged");
  check(result.recoveryFrames === 1, "Chrome fresh-session recovery diverged");
  check(result.workerErrors.length === 0, "Chrome Worker reported an error");
  process.stdout.write(`${JSON.stringify({ browser: chrome.version, phase: "5F", ...result }, null, 2)}\n`);
} finally {
  await server.close();
  await chrome.close();
}
