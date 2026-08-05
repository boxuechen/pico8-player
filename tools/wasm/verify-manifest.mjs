import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BRIDGE_SOURCES,
  BUILD_FLAGS,
  Z8LUA_SOURCES,
  resolveEmxx,
} from "./config.mjs";
import { verifySourceInventory } from "./source-inventory.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function readJson(path) {
  return JSON.parse(await readFile(join(projectRoot, path), "utf8"));
}

async function digest(path) {
  return createHash("sha256")
    .update(await readFile(join(projectRoot, path)))
    .digest("hex");
}

await verifySourceInventory(projectRoot);
await resolveEmxx();

const manifest = await readJson("wasm/manifest.lock.json");
const sourceLock = await readJson("wasm/source.lock.json");
const patchManifest = await readJson("wasm/patches/manifest.json");
const toolchainLock = await readJson("wasm/toolchain.lock.json");

assert.equal(manifest.phase, "0B");
assert.equal(manifest.upstream.commit, sourceLock.upstream.commit);
assert.equal(manifest.upstream.tree, sourceLock.upstream.tree);
assert.equal(manifest.toolchain.emsdkManagerCommit, toolchainLock.emsdk.managerCommit);
assert.equal(manifest.toolchain.emscriptenVersion, toolchainLock.emsdk.version);
assert.equal(
  manifest.toolchain.emscriptenReleaseCommit,
  toolchainLock.emsdk.releaseCommit,
);
assert.equal(
  manifest.toolchain.emccVersionCommit,
  toolchainLock.emsdk.emccVersionCommit,
);
assert.deepEqual(manifest.buildFlags, BUILD_FLAGS);
assert.deepEqual(manifest.compiledBridgeSources, BRIDGE_SOURCES);
assert.deepEqual(manifest.compiledZ8luaSources, Z8LUA_SOURCES);
assert.ok(
  [...BRIDGE_SOURCES, ...Z8LUA_SOURCES].every((path) => !path.includes("ref/")),
  "production source list must not read ref/",
);
assert.equal(manifest.sharedPicoRam.bytesPerContext, 0x10000);
assert.equal(manifest.sharedPicoRam.alignmentBytes, 16);
assert.deepEqual(manifest.fixedMemory, {
  initialPages: 256,
  maximumPages: 256,
  bytes: 16_777_216,
  growth: false,
  defaultLuaHeapLimitBytes: 1_048_576,
  minimumTestedLuaHeapLimitBytes: 32_768,
  ordinaryOomStatus: "P8W_OUT_OF_MEMORY",
});
assert.equal(manifest.patchManifest.patches.length, patchManifest.patches.length);

for (const patch of manifest.patchManifest.patches) {
  assert.equal(await digest(patch.path), patch.sha256);
  const detail = patchManifest.patches.find(
    (candidate) => `wasm/patches/${candidate.file}` === patch.path,
  );
  assert.ok(detail, `${patch.path} must be described by patch manifest`);
  assert.equal(detail.sha256, patch.sha256);
  assert.ok(detail.tests.length > 0, `${patch.path} must name regression tests`);
}

for (const license of manifest.licenses) {
  assert.equal(await digest(license.path), license.sha256);
}

for (const artifact of manifest.artifact.files) {
  const path = join(manifest.artifact.outputDirectory, artifact.path);
  const metadata = await stat(join(projectRoot, path));
  assert.equal(metadata.size, artifact.bytes, `${path} byte length`);
  assert.equal(await digest(path), artifact.sha256, `${path} SHA-256`);
}

process.stdout.write(
  `Verified Phase 0B manifest and ${manifest.artifact.files.length} artifact files\n`,
);
