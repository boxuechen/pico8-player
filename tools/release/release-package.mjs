import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  releaseArtifactContract as CONTRACT,
  verifyReleaseArtifact,
} from "./release-artifact.mjs";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_RELEASE = join(PROJECT_ROOT, CONTRACT.outputRoot);
const DEFAULT_PACKAGE = join(PROJECT_ROOT, CONTRACT.packageOutputRoot);
const BLOCK_BYTES = 512;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function relativePath(root, path) {
  return relative(root, path).split(sep).join("/");
}

function assertSafeOutputDirectory(path) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  assert.notEqual(absolute, root, "package output cannot be a filesystem root");
  assert.notEqual(absolute, PROJECT_ROOT, "package output cannot be the repository root");
  assert.ok(relative(root, absolute).split(sep).filter(Boolean).length >= 3,
    "package output must be a narrow directory");
  return absolute;
}

async function walk(root, directory = root) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(root, path));
    else if (entry.isFile()) result.push(relativePath(root, path));
  }
  return result.sort();
}

function writeAscii(target, offset, length, value) {
  const bytes = Buffer.from(value, "ascii");
  assert.ok(bytes.length <= length, `tar field is too long: ${value}`);
  bytes.copy(target, offset);
}

function writeOctal(target, offset, length, value) {
  assert.ok(Number.isSafeInteger(value) && value >= 0);
  const digits = value.toString(8);
  assert.ok(digits.length <= length - 1, `tar octal field overflow: ${value}`);
  writeAscii(target, offset, length, `${digits.padStart(length - 1, "0")}\0`);
}

function tarHeader(path, bytes) {
  assert.ok(Buffer.byteLength(path, "ascii") <= 100, `tar path is too long: ${path}`);
  assert.equal(Buffer.byteLength(path, "utf8"), path.length, `tar path must be ASCII: ${path}`);
  const header = Buffer.alloc(BLOCK_BYTES);
  writeAscii(header, 0, 100, path);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, bytes.byteLength);
  writeOctal(header, 136, 12, Number(CONTRACT.toolchain.sourceDateEpoch));
  header.fill(0x20, 148, 156);
  writeAscii(header, 156, 1, "0");
  writeAscii(header, 257, 6, "ustar\0");
  writeAscii(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeAscii(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function deterministicTar(entries) {
  const blocks = [];
  for (const { path, bytes } of entries) {
    blocks.push(tarHeader(path, bytes), bytes);
    const remainder = bytes.byteLength % BLOCK_BYTES;
    if (remainder !== 0) blocks.push(Buffer.alloc(BLOCK_BYTES - remainder));
  }
  blocks.push(Buffer.alloc(BLOCK_BYTES * 2));
  return Buffer.concat(blocks);
}

function parseOctal(header, offset, length) {
  const raw = header.subarray(offset, offset + length).toString("ascii")
    .replace(/[\0 ]+$/gu, "");
  assert.match(raw, /^[0-7]+$/u, "invalid tar octal field");
  return Number.parseInt(raw, 8);
}

function parseTar(bytes) {
  assert.equal(bytes.byteLength % BLOCK_BYTES, 0, "tar length must be block-aligned");
  const files = new Map();
  let offset = 0;
  let ended = false;
  while (offset < bytes.byteLength) {
    const header = bytes.subarray(offset, offset + BLOCK_BYTES);
    if (header.every((byte) => byte === 0)) {
      assert.ok(bytes.subarray(offset).every((byte) => byte === 0), "tar trailer must be zeroed");
      assert.ok(bytes.byteLength - offset >= BLOCK_BYTES * 2, "tar requires two trailer blocks");
      ended = true;
      break;
    }
    const storedChecksum = parseOctal(header, 148, 8);
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    assert.equal(
      checksumHeader.reduce((sum, byte) => sum + byte, 0),
      storedChecksum,
      "tar header checksum mismatch",
    );
    const nul = header.indexOf(0, 0);
    const name = header.subarray(0, nul === -1 ? 100 : Math.min(nul, 100)).toString("ascii");
    assert.ok(name && !name.startsWith("/") && !name.includes("..") && !name.includes("\\"),
      `unsafe tar path: ${name}`);
    assert.equal(header[156], "0".charCodeAt(0), `${name} must be a regular file`);
    assert.equal(files.has(name), false, `duplicate tar path: ${name}`);
    const size = parseOctal(header, 124, 12);
    const start = offset + BLOCK_BYTES;
    const end = start + size;
    assert.ok(end <= bytes.byteLength, `${name} exceeds tar bounds`);
    files.set(name, Buffer.from(bytes.subarray(start, end)));
    offset = start + Math.ceil(size / BLOCK_BYTES) * BLOCK_BYTES;
  }
  assert.equal(ended, true, "tar trailer is missing");
  return files;
}

function normalizeGzipHeader(bytes) {
  const result = Buffer.from(bytes);
  result.writeUInt32LE(0, 4);
  result[9] = 255;
  return result;
}

export async function buildReleasePackage({
  releaseDirectory = DEFAULT_RELEASE,
  packageDirectory = DEFAULT_PACKAGE,
} = {}) {
  const release = resolve(releaseDirectory);
  const output = assertSafeOutputDirectory(packageDirectory);
  await verifyReleaseArtifact({ outputDirectory: release });
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const entries = [];
  for (const path of await walk(release)) {
    entries.push({
      path: `${CONTRACT.archiveRoot}/${path}`,
      bytes: await readFile(join(release, path)),
    });
  }
  const tar = deterministicTar(entries);
  const archive = normalizeGzipHeader(gzipSync(tar, { level: 9 }));
  const archivePath = join(output, CONTRACT.archive);
  const checksumPath = join(output, CONTRACT.checksums);
  await writeFile(archivePath, archive);
  await writeFile(checksumPath, `${sha256(archive)}  ${CONTRACT.archive}\n`);
  return { packageDirectory: output, archivePath, checksumPath, archiveSha256: sha256(archive) };
}

export async function verifyReleasePackage({
  packageDirectory = DEFAULT_PACKAGE,
  releaseDirectory,
} = {}) {
  const output = assertSafeOutputDirectory(packageDirectory);
  const archive = await readFile(join(output, CONTRACT.archive));
  const checksum = await readFile(join(output, CONTRACT.checksums), "utf8");
  assert.equal(checksum, `${sha256(archive)}  ${CONTRACT.archive}\n`, "archive checksum mismatch");
  assert.equal(archive.readUInt32LE(4), 0, "gzip mtime must be zero");
  assert.equal(archive[9], 255, "gzip OS byte must be neutral");
  const files = parseTar(gunzipSync(archive));
  const manifestPath = `${CONTRACT.archiveRoot}/${CONTRACT.manifest}`;
  assert.ok(files.has(manifestPath), "archive manifest is missing");
  const manifest = JSON.parse(files.get(manifestPath).toString("utf8"));
  assert.equal(manifest.version, CONTRACT.version);
  assert.equal(manifest.apiVersion, CONTRACT.apiVersion);
  assert.equal(manifest.projectLicense, CONTRACT.projectLicense);
  const expectedPaths = [
    manifestPath,
    ...manifest.files.map(({ path }) => `${CONTRACT.archiveRoot}/${path}`),
  ].sort();
  assert.deepEqual([...files.keys()].sort(), expectedPaths, "archive file allowlist drift");
  for (const entry of manifest.files) {
    const bytes = files.get(`${CONTRACT.archiveRoot}/${entry.path}`);
    assert.equal(bytes.byteLength, entry.bytes, `${entry.path} bytes`);
    assert.equal(sha256(bytes), entry.sha256, `${entry.path} SHA-256`);
  }
  if (releaseDirectory !== undefined) {
    const release = resolve(releaseDirectory);
    assert.deepEqual(
      await walk(release),
      expectedPaths.map((path) => path.slice(CONTRACT.archiveRoot.length + 1)),
      "archive/release path drift",
    );
    for (const [path, bytes] of files) {
      const relative = path.slice(CONTRACT.archiveRoot.length + 1);
      assert.deepEqual(bytes, await readFile(join(release, relative)), relative);
    }
  }
  return {
    packageDirectory: output,
    archiveSha256: sha256(archive),
    archivedFiles: files.size,
    manifest,
  };
}

export async function extractReleasePackage({ packageDirectory = DEFAULT_PACKAGE, outputDirectory }) {
  assert.notEqual(outputDirectory, undefined, "an explicit extraction output is required");
  const output = assertSafeOutputDirectory(outputDirectory);
  await verifyReleasePackage({ packageDirectory });
  const archive = await readFile(join(resolve(packageDirectory), CONTRACT.archive));
  const files = parseTar(gunzipSync(archive));
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const prefix = `${CONTRACT.archiveRoot}/`;
  for (const [path, bytes] of files) {
    assert.ok(path.startsWith(prefix), `archive path is outside its root: ${path}`);
    const relative = path.slice(prefix.length);
    const destination = resolve(output, relative);
    assert.ok(destination.startsWith(`${output}${sep}`), `archive path escapes output: ${path}`);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
  return { releaseDirectory: output, files: files.size };
}

export { CONTRACT as releasePackageContract };
