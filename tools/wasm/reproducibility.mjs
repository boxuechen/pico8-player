import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ARTIFACT_BASENAME } from "./config.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function runBuild(outputDirectory) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      ["tools/wasm/build.mjs", "--output-dir", outputDirectory],
      { cwd: projectRoot, env: process.env, stdio: "inherit" },
    );
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`reproducibility build failed with exit code ${code}`));
    });
  });
}

async function digest(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "p8w-phase-0c-repro-"));
try {
  const first = join(temporaryRoot, "first");
  const second = join(temporaryRoot, "second");
  await runBuild(first);
  await runBuild(second);

  const hashes = {};
  for (const filename of [
    `${ARTIFACT_BASENAME}.mjs`,
    `${ARTIFACT_BASENAME}.wasm`,
    "THIRD_PARTY_NOTICES.md",
    "licenses/Emscripten.txt",
    "licenses/Lua-5.2.txt",
    "licenses/WTFPL-2.txt",
  ]) {
    const firstHash = await digest(join(first, filename));
    const secondHash = await digest(join(second, filename));
    assert.equal(secondHash, firstHash, `${filename} must be byte-reproducible`);
    hashes[filename] = firstHash;
  }
  process.stdout.write(`${JSON.stringify(hashes, null, 2)}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
