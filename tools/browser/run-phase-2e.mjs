import { startBenchmarkServer } from "../benchmark/server.mjs";
import {
  evaluate,
  launchChrome,
  waitForDocumentStatus,
} from "./chrome-cdp.mjs";

const server = await startBenchmarkServer({ availability: [] });
const chrome = await launchChrome({ profilePrefix: "p8w-phase2e-" });

function check(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  await chrome.cdp.command("Page.navigate", {
    url: `${server.origin}/tests/browser/phase-2e.html`,
  });
  await waitForDocumentStatus(chrome.cdp, { timeoutMs: 60_000 });
  const result = JSON.parse(await evaluate(
    chrome.cdp,
    "document.querySelector('#result').textContent",
  ));
  check(result.packedBytes === 0x2000, "Chrome gate lost the packed screen");
  check(result.displayPaletteBytes === 16, "Chrome gate lost the display palette");
  check(result.builtin.join(",") === "41,173,255,255", "Chrome built-in text drifted");
  check(result.custom.join(",") === "255,0,77,255", "Chrome custom font drifted");
  check(result.oneOff.join(",") === "0,228,54,255", "Chrome one-off glyph drifted");
  check(!result.eventKeys.includes("text"), "Worker frame DTO leaked text state");
  check(!result.eventKeys.includes("font"), "Worker frame DTO leaked font state");
  check(!result.eventKeys.includes("glyphs"), "Worker frame DTO leaked glyph state");
  process.stdout.write(`${JSON.stringify({ browser: chrome.version, ...result }, null, 2)}\n`);
} finally {
  await server.close();
  await chrome.close();
}
