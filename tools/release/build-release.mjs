import { buildReleaseArtifact } from "./release-artifact.mjs";

const outputIndex = process.argv.indexOf("--output");
const outputDirectory = outputIndex === -1 ? undefined : process.argv[outputIndex + 1];
const result = await buildReleaseArtifact({
  ...(outputDirectory === undefined ? {} : { outputDirectory }),
});
process.stdout.write(`Built release artifact at ${result.outputDirectory}\n`);
