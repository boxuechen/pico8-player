#!/usr/bin/env node
import { parseArgs } from "node:util";
import {
  buildRepresentativePlayabilityAggregate,
  writeRepresentativePlayabilityAggregate,
} from "./representative-playability-v1.mjs";

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
    selection: { type: "string" }, observations: { type: "string" }, review: { type: "string" },
    output: { type: "string" },
  } });
  if (!values.selection || !values.observations || !values.review || !values.output) {
    throw new Error("usage: aggregate-representative-playability --selection <external.json> --observations <external.json> --review <external.json> --output <external.json>");
  }
  const report = await buildRepresentativePlayabilityAggregate({
    selectionPath: values.selection, observationsPath: values.observations, reviewPath: values.review,
  });
  await writeRepresentativePlayabilityAggregate({ outputPath: values.output, report });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return report;
}

if (process.argv[1] === new URL(import.meta.url).pathname) main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
