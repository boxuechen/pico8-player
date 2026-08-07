import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import test from "node:test";

import {
  buildReleaseArtifact,
  releaseArtifactContract,
  verifyReleaseArtifact,
} from "../../tools/release/release-artifact.mjs";

const releaseRoot = "apps/web-player/dist/release";

async function treeHashes(root, directory = root) {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(result, await treeHashes(root, path));
    else if (entry.isFile()) {
      const key = relative(root, path).split(sep).join("/");
      result[key] = createHash("sha256").update(await readFile(path)).digest("hex");
    }
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

test("release manifest exposes six stable keys behind an exact fail-closed file set", async () => {
  const { manifest } = await verifyReleaseArtifact({ outputDirectory: releaseRoot });
  assert.deepEqual(Object.keys(manifest.artifacts), releaseArtifactContract.stableKeys);
  assert.equal(manifest.files.length, Object.keys(releaseArtifactContract.files).length);
  assert.equal(manifest.capabilities.networkCartAccess, false);
  assert.equal(manifest.capabilities.arbitraryUrlAccess, false);
  assert.equal(manifest.capabilities.crossOriginIsolationRequired, false);
  assert.equal(manifest.capabilities.publicationPerformed, false);
  assert.ok(manifest.files.every(({ sha256 }) => /^[0-9a-f]{64}$/u.test(sha256)));
  assert.ok(manifest.files.every(({ bytes }) => Number.isSafeInteger(bytes) && bytes > 0));
  assert.ok(manifest.files.some(({ provenance }) => provenance === "third-party-license"));
});

test("two fresh pinned-toolchain release builds are byte-identical", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "p8w-phase-7c-repro-"));
  try {
    const first = join(temporary, "first", "release");
    const second = join(temporary, "second", "release");
    await buildReleaseArtifact({ outputDirectory: first });
    await buildReleaseArtifact({ outputDirectory: second });
    await verifyReleaseArtifact({ outputDirectory: first });
    await verifyReleaseArtifact({ outputDirectory: second });
    assert.deepEqual(await treeHashes(first), await treeHashes(second));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("artifact verification rejects mutation and excluded output", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "p8w-phase-7c-negative-"));
  try {
    const mutated = join(temporary, "mutated", "release");
    await cp(releaseRoot, mutated, { recursive: true });
    const workerPath = join(mutated, releaseArtifactContract.artifacts.worker);
    await writeFile(workerPath, `${await readFile(workerPath, "utf8")}\n`);
    await assert.rejects(
      verifyReleaseArtifact({ outputDirectory: mutated }),
      /bytes|SHA-256/u,
    );

    const excluded = join(temporary, "excluded", "release");
    await cp(releaseRoot, excluded, { recursive: true });
    await writeFile(join(excluded, "local-corpus.p8"), "forbidden");
    await assert.rejects(
      verifyReleaseArtifact({ outputDirectory: excluded }),
      /allowlist drift/u,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
