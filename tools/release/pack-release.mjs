import { buildReleasePackage } from "./release-package.mjs";

const packageIndex = process.argv.indexOf("--package-output");
const packageDirectory = packageIndex === -1 ? undefined : process.argv[packageIndex + 1];
const releaseIndex = process.argv.indexOf("--release");
const releaseDirectory = releaseIndex === -1 ? undefined : process.argv[releaseIndex + 1];
const result = await buildReleasePackage({
  ...(packageDirectory === undefined ? {} : { packageDirectory }),
  ...(releaseDirectory === undefined ? {} : { releaseDirectory }),
});
process.stdout.write(`Built deterministic release package at ${result.packageDirectory}\n`);
