import { startBenchmarkServer } from "../benchmark/server.mjs";
import {
  evaluate,
  launchChrome,
  waitForDocumentStatus,
} from "./chrome-cdp.mjs";

const server = await startBenchmarkServer({ availability: [] });
const chrome = await launchChrome({ profilePrefix: "p8w-phase1e-" });

function check(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  await chrome.cdp.command("Page.navigate", {
    url: `${server.origin}/tests/browser/phase-1e.html`,
  });
  try {
    await waitForDocumentStatus(chrome.cdp, { timeoutMs: 60_000 });
  } catch (error) {
    const resources = await evaluate(
      chrome.cdp,
      "performance.getEntriesByType('resource').map(({name}) => name)",
    );
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${resources.join("\n")}`);
  }
  const result = JSON.parse(await evaluate(
    chrome.cdp,
    "document.querySelector('#result').textContent",
  ));
  check(result.targetFps === 60, "Chrome gate did not run a 60Hz cart");
  check(result.movedX >= 14, "Chrome gate did not apply normalized keyboard input");
  check(result.resetX === 10, "Chrome gate did not cold-reset the cart");
  check(result.faultCode === "E_CART_PARSE", "Chrome gate did not contain parse fault");
  check(result.finalState === "faulted", "Chrome gate shell did not expose fault state");
  process.stdout.write(`${JSON.stringify({ browser: chrome.version, ...result }, null, 2)}\n`);
} finally {
  await server.close();
  await chrome.close();
}
