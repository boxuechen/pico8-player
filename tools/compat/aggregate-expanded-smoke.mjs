#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  buildExpandedSmokeAggregate,
  writeExpandedSmokeAggregate,
} from "./expanded-smoke-v1.mjs";

function usage() {
  return "usage: aggregate-expanded-smoke --index <local.json> --observations <batch-1.json> --observations <batch-2.json> --output <local.json>";
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
  if (!values.index || !values.output || values.observations?.length !== 2) throw new Error(usage());
  const report = await buildExpandedSmokeAggregate({
    indexPath: values.index,
    observationsPaths: values.observations,
  });
  await writeExpandedSmokeAggregate({ outputPath: values.output, report });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
