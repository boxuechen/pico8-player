import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { extractReleasePackage } from "../../tools/release/release-package.mjs";

const packageRoot = "apps/web-player/dist/package";

function runPortableVerifier(root) {
  return JSON.parse(execFileSync(process.execPath, [join(root, "verify.mjs")], {
    cwd: root,
    encoding: "utf8",
  }));
}

test("Phase 10E verifies an unpacked candidate at an unrelated local path", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "p8w-phase-10e-unpack-"));
  try {
    const first = join(temporary, "arbitrary", "nested", "candidate");
    const { releaseDirectory, files } = await extractReleasePackage({
      packageDirectory: packageRoot,
      outputDirectory: first,
    });
    assert.equal(files, 16);
    assert.deepEqual(runPortableVerifier(releaseDirectory), {
      verified: true,
      version: "0.1.0-rc.1",
      apiVersion: 1,
      files: 16,
    });
    const manifest = await readFile(join(releaseDirectory, "manifest.json"), "utf8");
    assert.doesNotMatch(manifest, /\/Users\/|[A-Za-z]:\\/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Phase 10E portable verifier fails closed after extracted-file mutation", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "p8w-phase-10e-negative-"));
  try {
    const extracted = join(temporary, "release");
    await extractReleasePackage({ packageDirectory: packageRoot, outputDirectory: extracted });
    const mutated = join(temporary, "mutated");
    await cp(extracted, mutated, { recursive: true });
    await writeFile(join(mutated, "player.css"), "mutated\n");
    assert.throws(
      () => runPortableVerifier(mutated),
      (error) => /player\.css bytes|player\.css SHA-256/u.test(String(error?.stderr ?? error)),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
