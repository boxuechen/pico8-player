import { startBenchmarkServer } from "../benchmark/server.mjs";
import { evaluate, launchChrome, waitForDocumentStatus } from "./chrome-cdp.mjs";

function check(condition, message) {
  if (!condition) throw new Error(message);
}

const server = await startBenchmarkServer({ availability: [] });
const chrome = await launchChrome({ profilePrefix: "p8w-phase7f-" });

try {
  await chrome.cdp.command("Page.navigate", { url: `${server.origin}/tests/browser/phase-7f.html` });
  try {
    await waitForDocumentStatus(chrome.cdp, { timeoutMs: 120_000 });
  } catch (error) {
    const diagnostics = await evaluate(chrome.cdp, `({
      progress: document.body.dataset.progress,
      status: document.body.dataset.status,
      result: document.querySelector('#result').textContent,
    })`);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(diagnostics, null, 2)}`);
  }
  const result = await evaluate(chrome.cdp, "window.phase7fResult");
  check(result.phase === "7F", "Chrome reported the wrong phase");
  check(result.apiCount === 28, "Chrome did not cover all formerly unknown required APIs");
  check(result.cases.length === 3, "Chrome did not execute all project carts");
  check(result.faultCode === "E_VM_RUNTIME", "Chrome did not contain the invalid select fault");
  check(result.workerErrors.length === 0, "production Worker reported an error");
  process.stdout.write(`${JSON.stringify({ browser: chrome.version, ...result }, null, 2)}\n`);
} finally {
  await server.close();
  await chrome.close();
}
