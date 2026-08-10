import { verifyReleaseArtifact } from "./release-artifact.mjs";
import { verifyReleasePackage } from "./release-package.mjs";

const outputIndex = process.argv.indexOf("--output");
const outputDirectory = outputIndex === -1 ? undefined : process.argv[outputIndex + 1];
const packageIndex = process.argv.indexOf("--package-output");
const packageDirectory = packageIndex === -1 ? undefined : process.argv[packageIndex + 1];
const result = await verifyReleaseArtifact({
  ...(outputDirectory === undefined ? {} : { outputDirectory }),
});
process.stdout.write(
  `Verified ${result.manifest.files.length} release files and ${
    Object.keys(result.manifest.artifacts).length
  } stable artifact keys\n`,
);
const packaged = await verifyReleasePackage({
  releaseDirectory: result.outputDirectory,
  ...(packageDirectory === undefined ? {} : { packageDirectory }),
});
process.stdout.write(
  `Verified deterministic package ${packaged.archiveSha256} with ${packaged.archivedFiles} files\n`,
);
