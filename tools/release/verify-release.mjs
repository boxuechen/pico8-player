import { verifyReleaseArtifact } from "./release-artifact.mjs";

const outputIndex = process.argv.indexOf("--output");
const outputDirectory = outputIndex === -1 ? undefined : process.argv[outputIndex + 1];
const result = await verifyReleaseArtifact({
  ...(outputDirectory === undefined ? {} : { outputDirectory }),
});
process.stdout.write(
  `Verified ${result.manifest.files.length} release files and ${
    Object.keys(result.manifest.artifacts).length
  } stable artifact keys\n`,
);
