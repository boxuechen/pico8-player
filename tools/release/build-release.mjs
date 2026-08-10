import { buildReleaseArtifact } from "./release-artifact.mjs";
import { buildReleasePackage } from "./release-package.mjs";

const outputIndex = process.argv.indexOf("--output");
const outputDirectory = outputIndex === -1 ? undefined : process.argv[outputIndex + 1];
const packageIndex = process.argv.indexOf("--package-output");
const packageDirectory = packageIndex === -1 ? undefined : process.argv[packageIndex + 1];
const result = await buildReleaseArtifact({
  ...(outputDirectory === undefined ? {} : { outputDirectory }),
});
process.stdout.write(`Built release artifact at ${result.outputDirectory}\n`);
const packaged = await buildReleasePackage({
  releaseDirectory: result.outputDirectory,
  ...(packageDirectory === undefined ? {} : { packageDirectory }),
});
process.stdout.write(`Built deterministic release package at ${packaged.packageDirectory}\n`);
