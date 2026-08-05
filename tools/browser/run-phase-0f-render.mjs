import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { machineMetadata, sourceRevision } from "../benchmark/common.mjs";
import { startBenchmarkServer } from "../benchmark/server.mjs";
import {
  delay,
  evaluate,
  launchChrome,
  waitForDocumentStatus,
} from "./chrome-cdp.mjs";

const evidence = process.argv.includes("--evidence");
const server = await startBenchmarkServer({ availability: [] });
const chrome = await launchChrome({
  extraFlags: ["--enable-precise-memory-info"],
  profilePrefix: "p8w-phase0f-render-",
});

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function sourceHashes(paths) {
  return Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [
        path,
        createHash("sha256").update(await readFile(resolve(path))).digest("hex"),
      ]),
    ),
  );
}

try {
  const { cdp } = chrome;
  await cdp.command("HeapProfiler.enable");
  await cdp.command("Emulation.setDeviceMetricsOverride", {
    width: 900,
    height: 700,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.command("Page.navigate", {
    url: `${server.origin}/tests/browser/phase-0f-render.html`,
  });
  await waitForDocumentStatus(cdp, { accepted: ["ready"] });
  const correctness = await evaluate(cdp, "window.phase0fRenderResult");

  await cdp.command("HeapProfiler.collectGarbage");
  const heapBefore = await evaluate(
    cdp,
    "performance.memory?.usedJSHeapSize ?? null",
  );
  const benchmark = await evaluate(cdp, "window.phase0fRunRenderBenchmark()");
  await cdp.command("HeapProfiler.collectGarbage");
  const heapAfter = await evaluate(
    cdp,
    "performance.memory?.usedJSHeapSize ?? null",
  );

  const dprCases = [];
  for (const deviceScaleFactor of [1, 2, 1.25]) {
    await cdp.command("Emulation.setDeviceMetricsOverride", {
      width: 900,
      height: 700,
      deviceScaleFactor,
      mobile: false,
    });
    await delay(100);
    dprCases.push(await evaluate(cdp, "window.phase0fCheckDpr()"));
  }

  const screenshot = await cdp.command("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const screenshotBytes = Buffer.from(screenshot.data, "base64");
  const screenshotSha256 = createHash("sha256").update(screenshotBytes).digest("hex");
  const heapDeltaBytes =
    typeof heapBefore === "number" && typeof heapAfter === "number"
      ? heapAfter - heapBefore
      : null;
  const result = {
    schemaVersion: 1,
    phase: "0F-R",
    sourceRevision: sourceRevision(),
    sourceSha256: await sourceHashes([
      "apps/web-player/src/main/render/pico-frame.ts",
      "apps/web-player/src/main/render/canvas2d-frame-presenter.ts",
      "tests/fixtures/phase-0f/frame-fixture.mjs",
      "tests/browser/phase-0f-render.mjs",
    ]),
    browser: chrome.version,
    machine: machineMetadata(),
    fixture: correctness,
    benchmark: { ...benchmark, heapBefore, heapAfter, heapDeltaBytes },
    dprCases,
    screenshotSha256,
  };

  check(benchmark.totalFrames === 10_000, "renderer benchmark did not present 10,000 frames");
  check(benchmark.p95Ms <= 4, `Canvas2D p95 ${benchmark.p95Ms}ms exceeded 4ms`);
  check(
    heapDeltaBytes === null || heapDeltaBytes <= 1024 * 1024,
    `renderer live heap grew by ${heapDeltaBytes} bytes`,
  );
  check(dprCases.length === 3, "DPR matrix was incomplete");
  for (const entry of dprCases) {
    check(entry.backingWidth === 128 && entry.backingHeight === 128, "canvas backing size drifted");
    check(entry.cssWidth === entry.cssHeight && entry.cssWidth === 300.25, "letterbox size drifted");
    check(entry.imageRendering === "pixelated", "CSS nearest-neighbor policy is missing");
    check(entry.imageSmoothingEnabled === false, "Canvas smoothing was enabled");
    check(entry.paletteOnly === true, "nearest-neighbor probe introduced blended colors");
    check(entry.rgbaSha256 === correctness.rgbaSha256, "resize changed source pixels");
  }

  const resultDirectory = resolve("benchmarks/phase-0f/results");
  await mkdir(resultDirectory, { recursive: true });
  const resultPath = evidence
    ? resolve(resultDirectory, "chromium-macos-arm64-render.json")
    : resolve(resultDirectory, "chromium-render-smoke.json");
  const screenshotPath = evidence
    ? resolve("docs/evidence/phase-0f-render-chrome.png")
    : resolve(resultDirectory, "chromium-render-smoke.png");
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(screenshotPath, screenshotBytes);
  process.stdout.write(`${JSON.stringify({ ...result, resultPath, screenshotPath }, null, 2)}\n`);
} finally {
  await server.close();
  await chrome.close();
}
