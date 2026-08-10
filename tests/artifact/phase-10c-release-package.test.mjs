import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildReleaseArtifact,
  releaseArtifactContract,
  verifyReleaseArtifact,
} from "../../tools/release/release-artifact.mjs";
import {
  buildReleasePackage,
  verifyReleasePackage,
} from "../../tools/release/release-package.mjs";

const releaseRoot = "apps/web-player/dist/release";
const packageRoot = "apps/web-player/dist/package";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("Phase 10C emits versioned metadata, project license and complete notices", async () => {
  const { manifest } = await verifyReleaseArtifact({ outputDirectory: releaseRoot });
  assert.deepEqual({
    schemaVersion: manifest.schemaVersion,
    artifactId: manifest.artifactId,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    channel: manifest.channel,
    projectLicense: manifest.projectLicense,
  }, {
    schemaVersion: 2,
    artifactId: "pico8-web-player",
    version: "0.1.0-rc.1",
    apiVersion: 1,
    channel: "release-candidate",
    projectLicense: "UNLICENSED",
  });
  assert.equal(manifest.files.length, 15);
  assert.ok(manifest.files.some(({ path, provenance }) =>
    path === "LICENSE" && provenance === "project-license"));
  assert.ok(manifest.files.some(({ path }) => path === "RELEASE_NOTES.md"));
  const notices = await readFile(`${releaseRoot}/THIRD_PARTY_NOTICES.md`, "utf8");
  assert.match(notices, /RuntimeCore third-party notices/u);
  assert.match(notices, /Third-party notices: z8lua/u);
  assert.match(notices, /fake-08/u);
  assert.match(notices, /Emscripten/u);
});

test("Phase 10C package is self-verifying without repository-relative inputs", async () => {
  const verified = await verifyReleasePackage({ packageDirectory: packageRoot });
  assert.equal(verified.archivedFiles, 16);
  assert.equal(verified.manifest.version, "0.1.0-rc.1");
  assert.match(verified.archiveSha256, /^[a-f0-9]{64}$/u);
  const checksum = await readFile(`${packageRoot}/SHA256SUMS`, "utf8");
  assert.equal(
    checksum,
    `${verified.archiveSha256}  ${releaseArtifactContract.archive}\n`,
  );
});

test("Phase 10C release directory and compressed package are byte-reproducible", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "p8w-phase-10c-repro-"));
  try {
    const firstRelease = join(temporary, "first", "release");
    const secondRelease = join(temporary, "second", "release");
    const firstPackage = join(temporary, "first", "package");
    const secondPackage = join(temporary, "second", "package");
    await buildReleaseArtifact({ outputDirectory: firstRelease });
    await buildReleaseArtifact({ outputDirectory: secondRelease });
    await buildReleasePackage({ releaseDirectory: firstRelease, packageDirectory: firstPackage });
    await buildReleasePackage({ releaseDirectory: secondRelease, packageDirectory: secondPackage });
    const firstArchive = await readFile(join(firstPackage, releaseArtifactContract.archive));
    const secondArchive = await readFile(join(secondPackage, releaseArtifactContract.archive));
    assert.equal(digest(firstArchive), digest(secondArchive));
    assert.deepEqual(firstArchive, secondArchive);
    assert.equal(
      await readFile(join(firstPackage, releaseArtifactContract.checksums), "utf8"),
      await readFile(join(secondPackage, releaseArtifactContract.checksums), "utf8"),
    );
    await verifyReleasePackage({ packageDirectory: firstPackage, releaseDirectory: firstRelease });
    await verifyReleasePackage({ packageDirectory: secondPackage, releaseDirectory: secondRelease });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Phase 10C package verification fails closed on archive mutation", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "p8w-phase-10c-negative-"));
  try {
    const mutated = join(temporary, "mutated", "package");
    await cp(packageRoot, mutated, { recursive: true });
    const archivePath = join(mutated, releaseArtifactContract.archive);
    const archive = await readFile(archivePath);
    archive[archive.byteLength - 1] ^= 1;
    await writeFile(archivePath, archive);
    await assert.rejects(
      verifyReleasePackage({ packageDirectory: mutated }),
      /archive checksum mismatch/u,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
