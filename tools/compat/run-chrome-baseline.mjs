#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { startBenchmarkServer } from "../benchmark/server.mjs";
import {
  evaluate,
  launchChrome,
  waitForDocumentStatus,
} from "../browser/chrome-cdp.mjs";
import {
  assertSafeLocalObservationsPath,
  assertSafeLocalOutputPath,
  loadLocalCorpusManifest,
} from "./local-qualification-v1.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const runtimeWasmPath = resolve(projectRoot, "wasm/dist/z8lua-runtime-v1.wasm");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function playerCommit(requireCleanPlayer) {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: projectRoot,
    encoding: "utf8",
  }).trim();
  if (requireCleanPlayer) {
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: projectRoot,
      encoding: "utf8",
    }).trim();
    if (status.length > 0) {
      throw new Error("E_PLAYER_WORKTREE_DIRTY: expanded qualification requires a clean player commit");
    }
  }
  return commit;
}

function incompleteObservation(id) {
  return {
    id,
    completed: false,
    smokeOutcome: "not-run",
    classification: "CU",
    failureCluster: null,
    completedTicks: 0,
  };
}

export async function runChromeBaseline({
  manifestPath,
  observationsPath,
  screenshotsDirectory,
  expectedCaseCount = 12,
  minimumCaseCount = 12,
  enableAudio = false,
  realTimePacing = false,
  requireCleanPlayer = false,
}) {
  const startingPlayerCommit = playerCommit(requireCleanPlayer);
  const corpus = await loadLocalCorpusManifest({ manifestPath, projectRoot, minimumCases: minimumCaseCount });
  if (expectedCaseCount !== null && corpus.entries.length !== expectedCaseCount) {
    throw new Error(`E_PHASE6C_CASE_COUNT: Phase 6C requires exactly ${expectedCaseCount} cases`);
  }
  const safeObservations = assertSafeLocalObservationsPath(observationsPath, projectRoot);
  const screenshotProbe = assertSafeLocalOutputPath(
    join(resolve(screenshotsDirectory), "01.png"),
    projectRoot,
  );
  const screenshotRoot = dirname(screenshotProbe);
  await mkdir(screenshotRoot, { recursive: true });

  const runtimeWasmSha256 = sha256(await readFile(runtimeWasmPath));
  const server = await startBenchmarkServer({ availability: [] });
  let chrome;
  try {
    chrome = await launchChrome({
      profilePrefix: "p8w-phase6c-",
      extraFlags: ["--autoplay-policy=no-user-gesture-required"],
    });
  } catch (error) {
    await server.close();
    throw error;
  }
  const observations = [];
  let infrastructureError;
  try {
    if (enableAudio || realTimePacing) {
      await chrome.cdp.command("Page.addScriptToEvaluateOnNewDocument", {
        source: [
          enableAudio ? "globalThis.__phase6cEnableAudio=true;" : "",
          realTimePacing ? "globalThis.__phase6cRealTimePacing=true;" : "",
        ].join(""),
      });
    }
    await chrome.cdp.command("Page.navigate", {
      url: `${server.origin}/tools/compat/browser/phase-6c.html`,
    });
    await waitForDocumentStatus(chrome.cdp, {
      accepted: ["ready"],
      timeoutMs: 60_000,
    });

    for (const [index, entry] of corpus.entries.entries()) {
      try {
        const cartBase64 = (await readFile(entry.cartPath)).toString("base64");
        const localCartBundle = await Promise.all(entry.localCartBundle.map(async (bundleEntry) => ({
          ref: bundleEntry.ref,
          cartBase64: (await readFile(bundleEntry.cartPath)).toString("base64"),
          access: bundleEntry.access,
        })));
        const result = await evaluate(
          chrome.cdp,
          `globalThis.__phase6cRunCase(${JSON.stringify(cartBase64)}, ${JSON.stringify(entry.trace)}, ${JSON.stringify(localCartBundle)}, ${JSON.stringify(entry.expectedTermination)})`,
        );
        const screenshot = await chrome.cdp.command("Page.captureScreenshot", {
          format: "png",
          fromSurface: true,
          captureBeyondViewport: true,
        });
        const screenshotPath = join(
          screenshotRoot,
          `${String(index + 1).padStart(2, "0")}.png`,
        );
        await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"), { flag: "wx" });
        observations.push({ id: entry.id, ...result, screenshotCaptured: true });
        process.stdout.write(`${JSON.stringify({
          index: index + 1,
          id: entry.id,
          smokeOutcome: result.smokeOutcome,
          classification: result.classification,
          failureCluster: result.failureCluster,
          faultCode: result.faultCode ?? null,
          completedTicks: result.completedTicks,
          frameCount: result.frameCount,
        })}\n`);
      } catch (error) {
        infrastructureError = error;
        observations.push(incompleteObservation(entry.id));
        for (const remaining of corpus.entries.slice(index + 1)) {
          observations.push(incompleteObservation(remaining.id));
        }
        break;
      }
    }
    await evaluate(chrome.cdp, "globalThis.__phase6cDispose?.()").catch(() => undefined);
  } finally {
    await server.close();
    await chrome.close();
  }

  const document = {
    schemaVersion: 1,
    environment: {
      target: "chrome-production",
      playerCommit: startingPlayerCommit,
      runtimeWasmSha256,
      chromeVersion: chrome.version,
    },
    entries: observations,
  };
  if (requireCleanPlayer && playerCommit(true) !== startingPlayerCommit) {
    throw new Error("E_PLAYER_COMMIT_DRIFT: player commit changed during expanded qualification");
  }
  await writeFile(safeObservations, `${JSON.stringify(document, null, 2)}\n`, { flag: "wx" });
  if (infrastructureError !== undefined) throw infrastructureError;
  return document;
}

function usage() {
  return "usage: run-chrome-baseline --manifest <local.json> --observations <local.json> --screenshots <local-directory>";
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      manifest: { type: "string" },
      observations: { type: "string" },
      screenshots: { type: "string" },
    },
  });
  if (!values.manifest || !values.observations || !values.screenshots) {
    throw new Error(usage());
  }
  const result = await runChromeBaseline({
    manifestPath: values.manifest,
    observationsPath: values.observations,
    screenshotsDirectory: values.screenshots,
  });
  process.stdout.write(`${JSON.stringify({
    observations: resolve(values.observations),
    chromeVersion: result.environment.chromeVersion,
    complete: result.entries.every(({ completed }) => completed),
  })}\n`);
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
