import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractReleasePackage } from "./release-package.mjs";

const temporary = await mkdtemp(join(tmpdir(), "p8w-local-rc-"));
try {
  const releaseDirectory = join(temporary, "unpacked", "release");
  const extracted = await extractReleasePackage({ outputDirectory: releaseDirectory });
  const output = execFileSync(
    process.execPath,
    [join(extracted.releaseDirectory, "verify.mjs")],
    { cwd: extracted.releaseDirectory, encoding: "utf8" },
  ).trim();
  process.stdout.write(`Verified unpacked local RC at an isolated path: ${output}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
