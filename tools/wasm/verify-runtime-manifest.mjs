import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RUNTIME_ARTIFACT_BASENAME,
  RUNTIME_BUILD_FLAGS,
  RUNTIME_BRIDGE_SOURCES,
  RUNTIME_EXPORTED_FUNCTIONS,
  Z8LUA_SOURCES,
} from "./config.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(
  await readFile(join(projectRoot, "wasm/runtime-v1.manifest.lock.json"), "utf8"),
);

function readVarUint(bytes, cursor) {
  let value = 0;
  let shift = 0;
  for (;;) {
    const byte = bytes[cursor.offset++];
    assert.notEqual(byte, undefined, "truncated Wasm LEB128");
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return value >>> 0;
    shift += 7;
    assert.ok(shift < 35, "invalid Wasm u32 LEB128");
  }
}

function memoryLimits(bytes) {
  const cursor = { offset: 8 };
  while (cursor.offset < bytes.length) {
    const sectionId = bytes[cursor.offset++];
    const sectionLength = readVarUint(bytes, cursor);
    const sectionEnd = cursor.offset + sectionLength;
    if (sectionId === 5) {
      assert.equal(readVarUint(bytes, cursor), 1);
      const flags = readVarUint(bytes, cursor);
      const initial = readVarUint(bytes, cursor);
      const maximum = (flags & 1) === 0 ? undefined : readVarUint(bytes, cursor);
      return { flags, initial, maximum };
    }
    cursor.offset = sectionEnd;
  }
  throw new Error("Wasm memory section not found");
}
const abi = JSON.parse(
  await readFile(join(projectRoot, manifest.abiContract), "utf8"),
);
const generatedBindings = JSON.parse(
  await readFile(join(projectRoot, manifest.generatedBindingsManifest), "utf8"),
);

assert.equal(manifest.phase, "2B");
assert.equal(manifest.abiVersion, abi.abiVersion);
assert.equal(generatedBindings.source, manifest.hostApiContract);
assert.deepEqual(manifest.compiledBridgeSources, RUNTIME_BRIDGE_SOURCES);
assert.equal(
  createHash("sha256").update(JSON.stringify(Z8LUA_SOURCES)).digest("hex"),
  manifest.z8luaSourceInventorySha256,
);
assert.equal(
  createHash("sha256").update(JSON.stringify(RUNTIME_BUILD_FLAGS)).digest("hex"),
  manifest.buildFlagsSha256,
);
assert.equal(manifest.artifact.files[0].path, `${RUNTIME_ARTIFACT_BASENAME}.mjs`);
assert.deepEqual(
  abi.operations.map(({ name }) => `_${name}`),
  RUNTIME_EXPORTED_FUNCTIONS,
);

for (const artifact of manifest.artifact.files) {
  const path = join(projectRoot, manifest.artifact.outputDirectory, artifact.path);
  assert.equal((await stat(path)).size, artifact.bytes, `${artifact.path} byte length`);
  assert.equal(
    createHash("sha256").update(await readFile(path)).digest("hex"),
    artifact.sha256,
    `${artifact.path} SHA-256`,
  );
}

const wasmBytes = await readFile(
  join(projectRoot, manifest.artifact.outputDirectory, `${RUNTIME_ARTIFACT_BASENAME}.wasm`),
);
const wasmModule = new WebAssembly.Module(wasmBytes);
assert.deepEqual(memoryLimits(wasmBytes), { flags: 1, initial: 256, maximum: 256 });
const exports = WebAssembly.Module.exports(wasmModule).map(({ name }) => name);
for (const name of RUNTIME_EXPORTED_FUNCTIONS.map((entry) => entry.slice(1))) {
  assert.ok(exports.includes(name), `runtime artifact must export ${name}`);
}
for (const prefix of manifest.forbiddenExportPrefixes) {
  assert.ok(exports.every((name) => !name.startsWith(prefix)), `${prefix} must be absent`);
}
const memory = WebAssembly.Module.exports(wasmModule).find(({ name }) => name === "memory");
assert.ok(memory, "runtime artifact must export memory");

process.stdout.write(
  `Verified p8w v1 runtime manifest, ${abi.operations.length} operations, and benchmark isolation\n`,
);
