import { startBenchmarkServer } from "../benchmark/server.mjs";
import { evaluate, launchChrome, waitForDocumentStatus } from "./chrome-cdp.mjs";

const server = await startBenchmarkServer({ availability: [] });
const chrome = await launchChrome({
  profilePrefix: "p8w-phase15-",
  extraFlags: ["--autoplay-policy=no-user-gesture-required"],
});
try {
  await chrome.cdp.command("Page.navigate", {
    url: `${server.origin}/tests/browser/phase-15.html`,
  });
  await waitForDocumentStatus(chrome.cdp, { timeoutMs: 30_000 });
  const result = JSON.parse(await evaluate(chrome.cdp,
    "document.querySelector('#result').textContent"));
  process.stdout.write(`${JSON.stringify({ browser: chrome.version, ...result }, null, 2)}\n`);
} finally {
  await server.close();
  await chrome.close();
}
