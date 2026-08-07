#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { runChromeBaseline } from "./run-chrome-baseline.mjs";

function usage() {
  return "usage: run-expanded-chrome-baseline --manifest <local.json> --observations <local.json> --screenshots <local-directory>";
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
  if (!values.manifest || !values.observations || !values.screenshots) throw new Error(usage());
  const result = await runChromeBaseline({
    manifestPath: values.manifest,
    observationsPath: values.observations,
    screenshotsDirectory: values.screenshots,
    expectedCaseCount: null,
  });
  process.stdout.write(`${JSON.stringify({
    observations: resolve(values.observations),
    chromeVersion: result.environment.chromeVersion,
    cases: result.entries.length,
    complete: result.entries.every(({ completed }) => completed),
  })}\n`);
  return result;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
