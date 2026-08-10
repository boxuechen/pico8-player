#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  buildExpandedFormatPairQualification,
  writeExpandedFormatPairAggregate,
  writeExpandedFormatPairLocalDetails,
} from "./expanded-format-pairs-v1.mjs";

function usage() {
  return "usage: aggregate-expanded-format-pairs --index <local.json> --observations <batch-1.json> --observations <batch-2.json> --observations <batch-3.json> --output <aggregate.json> --local-details <external-local.json> [--review <external-local.json>]";
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
      "local-details": { type: "string" },
      review: { type: "string" },
    },
  });
  if (!values.index || !values.output || !values["local-details"]
    || values.observations?.length !== 3) throw new Error(usage());
  const result = await buildExpandedFormatPairQualification({
    indexPath: values.index,
    observationsPaths: values.observations,
    ...(values.review === undefined ? {} : { reviewPath: values.review }),
  });
  await Promise.all([
    writeExpandedFormatPairAggregate({ outputPath: values.output, report: result.aggregate }),
    writeExpandedFormatPairLocalDetails({
      outputPath: values["local-details"],
      report: result.localDetails,
    }),
  ]);
  process.stdout.write(`${JSON.stringify(result.aggregate)}\n`);
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
