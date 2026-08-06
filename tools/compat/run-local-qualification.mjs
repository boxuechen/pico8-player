#!/usr/bin/env node
import { parseArgs } from "node:util";

import {
  buildLocalQualificationReport,
  writeLocalQualificationReport,
} from "./local-qualification-v1.mjs";

const projectRoot = new URL("../../", import.meta.url).pathname;

function usage() {
  return "usage: run-local-qualification --manifest <local.json> --observations <local.json> --output <local.json>";
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      manifest: { type: "string" },
      observations: { type: "string" },
      output: { type: "string" },
    },
  });
  if (!values.manifest || !values.observations || !values.output) throw new Error(usage());
  const report = await buildLocalQualificationReport({
    manifestPath: values.manifest,
    observationsPath: values.observations,
    projectRoot,
  });
  const outputPath = await writeLocalQualificationReport({
    outputPath: values.output,
    projectRoot,
    report,
  });
  process.stdout.write(`${JSON.stringify({
    outputPath,
    qualificationComplete: report.summary.qualificationComplete,
    completedCaseCount: report.summary.completedCaseCount,
    caseCount: report.corpus.caseCount,
  })}\n`);
  if (!report.summary.qualificationComplete) process.exitCode = 2;
  return report;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
