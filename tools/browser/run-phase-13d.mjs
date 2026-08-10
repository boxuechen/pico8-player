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
const chrome = await launchChrome({
  profilePrefix: "p8w-phase13d-",
  extraFlags: ["--autoplay-policy=no-user-gesture-required"],
});

try {
  await chrome.cdp.command("Page.navigate", {
    url: `${server.origin}/tests/browser/phase-13d.html`,
  });
  await waitForDocumentStatus(chrome.cdp, { timeoutMs: 60_000 });
  const result = JSON.parse(await evaluate(
    chrome.cdp,
    "document.querySelector('#result').textContent",
  ));
  check(result.apiVersion === 2, "Chrome used the wrong Embed API version");
  check(result.frames >= 4 && result.writes >= 2, "hosted frame or write flow was incomplete");
  check(result.adapterFlushes >= 1, "adapter flush was not awaited");
  check(result.finalValue > 3, "external input did not update cartdata");
  check(result.hostedToolbarHidden === true, "hosted shell leaked built-in controls");
  process.stdout.write(`${JSON.stringify({ browser: chrome.version, ...result }, null, 2)}\n`);
} finally {
  await server.close();
  await chrome.close();
}
