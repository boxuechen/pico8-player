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
const chrome = await launchChrome({ profilePrefix: "p8w-phase3f-" });

try {
  await chrome.cdp.command("Page.navigate", {
    url: `${server.origin}/tests/browser/phase-3f.html`,
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
  check(result.phase === "3F", "Chrome reported the wrong phase");
  check(result.firstHit === 5, "fresh cartdata incorrectly reported a hit");
  check(result.freshSchema === 1 && result.freshBytes === 256,
    "fresh durable record did not use the exact schema/payload");
  check(result.restartHit === 10 && result.resetHit === 10,
    "restart/reset did not hydrate before guest boot");
  check(result.restartLastByte === 37, "pagehide did not preserve the latest byte");
  check(result.legacyHit === 10 && result.legacyFirstByte === 23,
    "legacy schema did not hydrate exactly");
  check(result.migratedSchema === 1, "legacy schema was not lazily rewritten");
  check(result.migrationReadDiagnostics >= 2,
    "future/corrupt records did not produce read diagnostics");
  check(result.boundedHit === 5 && result.boundReadDiagnostic,
    "4096-record hydration bound was not enforced");
  check(result.writeFailureDiagnostic, "durable write failure was not visible");
  check(result.failureState === "paused", "write failure faulted the valid cart");
  check(result.workerErrors.length === 0, "production Worker reported an error");
  process.stdout.write(`${JSON.stringify({ browser: chrome.version, ...result }, null, 2)}\n`);
} finally {
  await server.close();
  await chrome.close();
}
