#!/usr/bin/env node
import { parseArgs } from "node:util";
import { prepareRepresentativePlayability } from "./representative-playability-v1.mjs";

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
    index: { type: "string" }, plan: { type: "string" }, output: { type: "string" },
  } });
  if (!values.index || !values.plan || !values.output) {
    throw new Error("usage: prepare-representative-playability --index <expanded-index> --plan <external-plan> --output <new-external-directory>");
  }
  const result = await prepareRepresentativePlayability({
    expandedIndexPath: values.index, planPath: values.plan, outputRoot: values.output,
  });
  process.stdout.write(`${JSON.stringify({ output: result.outputRoot, selectionSha256: result.selectionSha256, cases: 10 })}\n`);
  return result;
}

if (process.argv[1] === new URL(import.meta.url).pathname) main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
