#!/usr/bin/env node
import { parseArgs } from "node:util";

import {
  buildSupplementalTop200Aggregate,
  writeSupplementalTop200Aggregate,
} from "./supplemental-top200-v1.mjs";

function usage() {
  return "usage: aggregate-supplemental-top200 --index <external.json> --observations <batch.json> (four times) --output <external.json>";
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      index: { type: "string" },
      observations: { type: "string", multiple: true },
      output: { type: "string" },
    },
  });
  if (!values.index || !values.output || values.observations?.length !== 4) throw new Error(usage());
  const report = await buildSupplementalTop200Aggregate({
    indexPath: values.index,
    observationsPaths: values.observations,
  });
  await writeSupplementalTop200Aggregate({ outputPath: values.output, report });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return report;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
