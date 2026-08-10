#!/usr/bin/env node
import { parseArgs } from "node:util";

import { prepareSupplementalTop200 } from "./supplemental-top200-v1.mjs";

function usage() {
  return "usage: prepare-supplemental-top200 --source <external-snapshot> --output <new-external-directory>";
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: { source: { type: "string" }, output: { type: "string" } },
  });
  if (!values.source || !values.output) throw new Error(usage());
  const result = await prepareSupplementalTop200({ sourceRoot: values.source, outputRoot: values.output });
  process.stdout.write(`${JSON.stringify({
    output: result.outputRoot,
    indexSha256: result.indexSha256,
    corpusFingerprint: result.index.corpusFingerprint,
    cases: result.index.cases.length,
    batches: result.index.batches.map((batch) => batch.cases),
  })}\n`);
  return result;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
