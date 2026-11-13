import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE_ROOT = dirname(fileURLToPath(import.meta.url));
const EXPECTED_VERSION = "0.2.0-alpha.3";
const EXPECTED_API_VERSION = 2;
const EXPECTED_LICENSE = "MIT";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function releasePath(path) {
  assert.ok(path && !path.startsWith("/") && !path.includes("\\"), `unsafe path: ${path}`);
  assert.equal(posix.normalize(path), path, `non-canonical path: ${path}`);
  assert.equal(path.split("/").includes(".."), false, `parent path is forbidden: ${path}`);
  const absolute = resolve(RELEASE_ROOT, path);
  assert.ok(absolute.startsWith(`${RELEASE_ROOT}${sep}`), `path escapes release root: ${path}`);
  return absolute;
}

async function walk(directory = RELEASE_ROOT) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(path));
    else if (entry.isFile()) result.push(relative(RELEASE_ROOT, path).split(sep).join("/"));
    else throw new Error(`unsupported release entry: ${path}`);
  }
  return result.sort();
}

const manifest = JSON.parse(await readFile(join(RELEASE_ROOT, "manifest.json"), "utf8"));
assert.equal(manifest.version, EXPECTED_VERSION, "release version mismatch");
assert.equal(manifest.apiVersion, EXPECTED_API_VERSION, "embed API version mismatch");
assert.equal(manifest.projectLicense, EXPECTED_LICENSE, "project license mismatch");
assert.equal(manifest.capabilities.publicationPerformed, false, "unexpected publication claim");
assert.equal(manifest.capabilities.hostedShell, true, "hosted shell capability is missing");
assert.equal(manifest.capabilities.externalInput, true, "external input capability is missing");
assert.equal(manifest.capabilities.hostPersistence, true, "host persistence capability is missing");
assert.equal(manifest.capabilities.awaitablePersistenceFlush, true,
  "awaitable persistence flush capability is missing");
const expected = ["manifest.json", ...manifest.files.map(({ path }) => path)].sort();
assert.deepEqual(await walk(), expected, "release file allowlist drift");
for (const entry of manifest.files) {
  assert.match(entry.sha256, /^[a-f0-9]{64}$/u, `${entry.path} SHA-256 shape`);
  const bytes = await readFile(releasePath(entry.path));
  assert.equal(bytes.byteLength, entry.bytes, `${entry.path} bytes`);
  assert.equal(sha256(bytes), entry.sha256, `${entry.path} SHA-256`);
}
process.stdout.write(`${JSON.stringify({
  verified: true,
  version: manifest.version,
  apiVersion: manifest.apiVersion,
  files: manifest.files.length + 1,
})}\n`);
