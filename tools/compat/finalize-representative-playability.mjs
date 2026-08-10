#!/usr/bin/env node
import { parseArgs } from "node:util";
import { finalizeRepresentativePlayability } from "./representative-playability-v1.mjs";

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
    selection: { type: "string" }, raw: { type: "string" }, review: { type: "string" },
    "audio-observations": { type: "string" }, screenshots: { type: "string" }, output: { type: "string" },
  } });
  if (!values.selection || !values.raw || !values.review || !values["audio-observations"]
    || !values.screenshots || !values.output) {
    throw new Error("usage: finalize-representative-playability --selection <external.json> --raw <external.json> --review <external.json> --audio-observations <external.json> --screenshots <external-directory> --output <external.json>");
  }
  const result = await finalizeRepresentativePlayability({
    selectionPath: values.selection, rawObservationsPath: values.raw, reviewPath: values.review,
    audioObservationsPath: values["audio-observations"], screenshotsDirectory: values.screenshots,
    outputPath: values.output,
  });
  process.stdout.write(`${JSON.stringify({ output: result.outputPath, cases: result.observations.entries.length })}\n`);
  return result;
}

if (process.argv[1] === new URL(import.meta.url).pathname) main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
