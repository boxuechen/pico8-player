import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { machineMetadata, sourceRevision } from "../benchmark/common.mjs";
import { startBenchmarkServer } from "../benchmark/server.mjs";
import {
  evaluate,
  launchChrome,
  waitForDocumentStatus,
} from "./chrome-cdp.mjs";
import { makeP8Png } from "../../tests/fixtures/p8png/fixture-builder.mjs";

const evidence = process.argv.includes("--evidence");
const manifestPath = resolve("tests/conformance/manifests/phase-1f-l1-exit.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const pngEntry = manifest.cases.find(({ format }) => format === "p8png-generated");
if (pngEntry === undefined) throw new Error("Phase 1F manifest has no generated .p8.png case");
const pngSource = await readFile(resolve(pngEntry.source), "utf8");
const marker = "__lua__\n";
const markerIndex = pngSource.indexOf(marker);
if (markerIndex < 0) throw new Error("generated .p8.png source is missing __lua__");
const generatedP8Png = makeP8Png({
  codeHex: Buffer.from(pngSource.slice(markerIndex + marker.length), "utf8").toString("hex"),
  compression: "raw",
  cartVersion: 42,
  romPatternSeed: 71,
  zlibMode: "fixed",
  filterMode: "cycle",
  splitIdat: true,
}).png;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function sourceHashes(paths) {
  return Object.fromEntries(await Promise.all(paths.map(async (path) => [
    path,
    sha256(await readFile(resolve(path))),
  ])));
}

check(sha256(generatedP8Png) === pngEntry.cartSha256,
  "generated .p8.png hash does not match the reviewed manifest");

const server = await startBenchmarkServer({ availability: [] });
const chrome = await launchChrome({ profilePrefix: "p8w-phase1f-" });

try {
  const { cdp } = chrome;
  await cdp.command("Page.addScriptToEvaluateOnNewDocument", {
    source: `globalThis.__phase1fP8PngBase64=${JSON.stringify(Buffer.from(generatedP8Png).toString("base64"))};`,
  });
  await cdp.command("Page.navigate", {
    url: `${server.origin}/tests/browser/phase-1f.html`,
  });
  try {
    await waitForDocumentStatus(cdp, { timeoutMs: 120_000 });
  } catch (error) {
    const resources = await evaluate(
      cdp,
      "performance.getEntriesByType('resource').map(({name}) => name)",
    );
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${resources.join("\n")}`);
  }
  const browserResult = JSON.parse(await evaluate(
    cdp,
    "document.querySelector('#result').textContent",
  ));
  check(browserResult.deterministic.length === 3, "Chrome deterministic matrix was incomplete");
  check(browserResult.raf.length === 3, "Chrome rAF matrix was incomplete");
  check(browserResult.performance.measuredTicks === 120, "Chrome performance sample was incomplete");
  check(browserResult.performance.p95Ms <= 8, "Chrome ordinary 60Hz p95 exceeded 8ms");
  check(browserResult.faultRecovery.mainThreadResponsive === true,
    "Chrome UI was not responsive during guest fault");
  check(browserResult.workerError === null, `Chrome Worker error: ${browserResult.workerError}`);

  const result = {
    ...browserResult,
    sourceRevision: sourceRevision(),
    sourceSha256: await sourceHashes([
      "apps/web-player/src/main/player-runtime-client.ts",
      "apps/web-player/src/main/player-controller.ts",
      "apps/web-player/src/worker/compose-runtime.ts",
      "packages/runtime-core/src/scheduler/frame-scheduler.ts",
      "tests/conformance/manifests/phase-1f-l1-exit.json",
      "tests/browser/phase-1f.mjs",
    ]),
    browser: chrome.version,
    machine: machineMetadata(),
    generatedP8Png: {
      source: pngEntry.source,
      sourceSha256: pngEntry.sourceSha256,
      cartSha256: sha256(generatedP8Png),
      byteLength: generatedP8Png.byteLength,
      compression: "raw-code/fixed-zlib/filter-cycle/split-idat",
    },
  };
  const resultDirectory = resolve("benchmarks/phase-1/results");
  await mkdir(resultDirectory, { recursive: true });
  const resultPath = evidence
    ? resolve(resultDirectory, "chromium-macos-arm64-l1-exit.json")
    : resolve(resultDirectory, "chromium-l1-exit-smoke.json");
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ...result, resultPath }, null, 2)}\n`);
} finally {
  await server.close();
  await chrome.close();
}
