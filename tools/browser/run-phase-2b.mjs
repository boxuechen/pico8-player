import { startBenchmarkServer } from "../benchmark/server.mjs";
import {
  evaluate,
  launchChrome,
  waitForDocumentStatus,
} from "./chrome-cdp.mjs";

const server = await startBenchmarkServer({ availability: [] });
const chrome = await launchChrome({ profilePrefix: "p8w-phase2b-" });

function check(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  await chrome.cdp.command("Page.navigate", {
    url: `${server.origin}/tests/browser/phase-2b.html`,
  });
  await waitForDocumentStatus(chrome.cdp, { timeoutMs: 60_000 });
  const result = JSON.parse(await evaluate(
    chrome.cdp,
    "document.querySelector('#result').textContent",
  ));
  check(result.packedBytes === 0x2000, "Chrome gate lost the packed screen");
  check(result.displayPaletteBytes === 16, "Chrome gate lost the display palette");
  check(result.displayPaletteEntry1 === 0x8e, "Chrome gate palette snapshot drifted");
  check(result.background.join(",") === "255,110,89,255", "Chrome gate extended colour drifted");
  process.stdout.write(`${JSON.stringify({ browser: chrome.version, ...result }, null, 2)}\n`);
} finally {
  await server.close();
  await chrome.close();
}
