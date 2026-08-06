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
const chrome = await launchChrome({ profilePrefix: "p8w-phase3g-" });

try {
  await chrome.cdp.command("Page.navigate", {
    url: `${server.origin}/tests/browser/phase-3g.html`,
  });
  try {
    await waitForDocumentStatus(chrome.cdp, { timeoutMs: 120_000 });
  } catch (error) {
    const diagnostics = await evaluate(chrome.cdp, `({
      result: document.querySelector('#result').textContent,
      progress: document.body.dataset.progress,
      resources: performance.getEntriesByType('resource').map(({name}) => name),
    })`);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(diagnostics, null, 2)}`);
  }
  const result = JSON.parse(await evaluate(
    chrome.cdp,
    "document.querySelector('#result').textContent",
  ));
  check(result.phase === "3G", "Chrome reported the wrong phase");
  check(JSON.stringify(result.first) === JSON.stringify([21, 1]),
    "first current-cart/cartdata transaction was incorrect");
  check(JSON.stringify(result.reset) === JSON.stringify([22, 2]),
    "reset did not preserve overlay and hydrated cartdata");
  check(JSON.stringify(result.repeated) === JSON.stringify([23, 3]),
    "same-identity load did not preserve the Worker overlay");
  check(JSON.stringify(result.isolated) === JSON.stringify([41, 4]),
    "different identity leaked current-cart overlay state");
  check(result.finalState === "stopped", "production shell did not stop cleanly");
  check(result.workerErrors.length === 0, "production Worker reported an error");
  process.stdout.write(`${JSON.stringify({ browser: chrome.version, ...result }, null, 2)}\n`);
} finally {
  await server.close();
  await chrome.close();
}
