#!/usr/bin/env node
import { parseArgs } from "node:util";

import contract from "../../spec/phase-8-expanded-real-cart-qualification-contract.json" with { type: "json" };
import {
  checkoutRevision,
  prepareExpandedCorpus,
} from "./expanded-corpus-v1.mjs";

function usage() {
  return "usage: prepare-expanded-corpus --source <external-checkout> --output <new-external-directory>";
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      source: { type: "string" },
      output: { type: "string" },
    },
  });
  if (!values.source || !values.output) throw new Error(usage());
  const revision = checkoutRevision(values.source);
  if (revision !== contract.externalSource.revision) {
    throw new Error(`E_SOURCE_REVISION: expected ${contract.externalSource.revision}, received ${revision}`);
  }
  const result = await prepareExpandedCorpus({
    sourceRoot: values.source,
    outputRoot: values.output,
    source: {
      repository: contract.externalSource.repository,
      revision,
      label: "MiniMechMedia/pico8-games",
    },
    expectedInventory: {
      topLevelProjects: contract.externalSource.topLevelProjects,
      cartFiles: contract.externalSource.cartFiles,
      p8Files: contract.externalSource.p8Files,
      p8PngFiles: contract.externalSource.p8PngFiles,
      byteUniqueFiles: contract.externalSource.byteUniqueFiles,
      canonicalLogicalCarts: contract.externalSource.canonicalLogicalCarts,
      formatPairs: contract.externalSource.formatPairs,
    },
  });
  process.stdout.write(`${JSON.stringify({
    outputRoot: result.outputRoot,
    indexSha256: result.indexSha256,
    corpusFingerprint: result.index.corpusFingerprint,
    inventory: result.index.inventory,
    canonicalBatches: result.index.canonical.batches,
    formatPairBatches: result.index.formatPairs.batches,
  })}\n`);
  return result;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
