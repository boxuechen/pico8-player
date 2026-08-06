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
const chrome = await launchChrome({ profilePrefix: "p8w-phase3c-" });

try {
  await chrome.cdp.command("Page.navigate", {
    url: `${server.origin}/tests/browser/phase-3c.html`,
  });
  try {
    await waitForDocumentStatus(chrome.cdp, { timeoutMs: 90_000 });
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
  check(result.phase === "3C", "Chrome reported the wrong phase");
  check(result.touchControlCount === 6, "Chrome shell did not expose six touch controls");
  check(result.simultaneous.every((x) => x >= 12), "Chrome cart missed an input source");
  check(result.partialEnd[0] === result.partialStart[0], "touch cancel was not stable");
  check(result.partialEnd[1] > result.partialStart[1], "multitouch source did not remain independent");
  check(result.partialEnd[2] === result.partialStart[2], "keyboard release was not stable");
  check(result.partialEnd[3] === result.partialStart[3], "Gamepad disconnect was not stable");
  check(result.resetPositions.every((x) => x === 8), "reset retained cart/input state");
  check(result.generationAfterReset > result.generationBeforeReset,
    "Chrome reset did not advance generation");
  check(result.audioMode === "disabled", "3C gate unexpectedly opened an audio device");
  check(result.workerErrors.length === 0, "production Worker reported an error");
  check(result.finalState === "stopped", "production shell did not stop cleanly");
  process.stdout.write(`${JSON.stringify({ browser: chrome.version, ...result }, null, 2)}\n`);
} finally {
  await server.close();
  await chrome.close();
}
