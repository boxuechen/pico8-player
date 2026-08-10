#!/usr/bin/env node
import { parseArgs } from "node:util";

import {
  buildPhase9FailureFreeze,
  writePhase9FailureFreeze,
} from "./phase-9-failure-freeze-v1.mjs";

function usage() {
  return "usage: freeze-phase-9-failures --aggregate <external.json> --observations <external.json> (four times) [--output <external.json>]";
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      aggregate: { type: "string" },
      observations: { type: "string", multiple: true },
      output: { type: "string" },
    },
  });
  if (!values.aggregate || values.observations?.length !== 4) throw new Error(usage());
  const report = await buildPhase9FailureFreeze({
    aggregatePath: values.aggregate,
    observationsPaths: values.observations,
  });
  if (values.output) await writePhase9FailureFreeze({ outputPath: values.output, report });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return report;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
