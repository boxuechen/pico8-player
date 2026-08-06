import { startBenchmarkServer } from "../benchmark/server.mjs";
import { evaluate, launchChrome, waitForDocumentStatus } from "./chrome-cdp.mjs";

function check(condition, message) {
  if (!condition) throw new Error(message);
}

const server = await startBenchmarkServer({ availability: [] });
const chrome = await launchChrome({ profilePrefix: "p8w-phase4d-" });

try {
  await chrome.cdp.command("Page.navigate", {
    url: `${server.origin}/tests/browser/phase-4d.html`,
  });
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
  const result = await evaluate(chrome.cdp, "window.phase4dResult");
  check(result.phase === "4D", "Chrome reported the wrong phase");
  check(result.apiCount === 9, "Chrome did not cover all required Phase 4D APIs");
  check(result.initial.observationHex === result.reset.observationHex,
    "Chrome reset observation drifted");
  check(result.initial.screenSha256 === result.recovered.screenSha256,
    "Chrome fault recovery screen drifted");
  check(result.faultCode === "E_VM_INSTRUCTION_BUDGET",
    "Chrome did not contain instruction-budget exhaustion");
  check(result.workerErrors.length === 0, "production Worker reported an error");
  process.stdout.write(`${JSON.stringify({ browser: chrome.version, ...result }, null, 2)}\n`);
} finally {
  await server.close();
  await chrome.close();
}
