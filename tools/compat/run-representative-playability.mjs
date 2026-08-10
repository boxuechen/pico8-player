#!/usr/bin/env node
import { parseArgs } from "node:util";
import { runChromeBaseline } from "./run-chrome-baseline.mjs";

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
    manifest: { type: "string" }, observations: { type: "string" }, screenshots: { type: "string" },
    audio: { type: "boolean" },
  } });
  if (!values.manifest || !values.observations || !values.screenshots) {
    throw new Error("usage: run-representative-playability --manifest <external.json> --observations <external.json> --screenshots <external-directory>");
  }
  return runChromeBaseline({
    manifestPath: values.manifest,
    observationsPath: values.observations,
    screenshotsDirectory: values.screenshots,
    expectedCaseCount: 10,
    minimumCaseCount: 10,
    enableAudio: values.audio === true,
    requireCleanPlayer: true,
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
