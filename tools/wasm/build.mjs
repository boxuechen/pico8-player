import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import {
  ARTIFACT_BASENAME,
  BRIDGE_SOURCES,
  BUILD_FLAGS,
  SOURCE_DATE_EPOCH,
  Z8LUA_SOURCES,
  resolveEmxx,
} from "./config.mjs";
import { verifySourceInventory } from "./source-inventory.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function optionValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function run(executable, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { ...options, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(
          new Error(
            `${executable} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`,
          ),
        );
      }
    });
  });
}

export async function build(outputDirectory) {
  await verifySourceInventory(projectRoot);
  const { emxx, versionLine } = await resolveEmxx();
  const absoluteOutputDirectory = resolve(projectRoot, outputDirectory);
  const artifactPath = join(absoluteOutputDirectory, `${ARTIFACT_BASENAME}.mjs`);

  await rm(absoluteOutputDirectory, { recursive: true, force: true });
  await mkdir(absoluteOutputDirectory, { recursive: true });

  const sources = Z8LUA_SOURCES.map((name) => join("wasm", "z8lua", name));
  const args = [
    ...BUILD_FLAGS,
    "-Iwasm/z8lua",
    "-Iwasm/bridge",
    ...BRIDGE_SOURCES,
    ...sources,
    "-o",
    artifactPath,
  ];
  await run(emxx, args, {
    cwd: projectRoot,
    env: { ...process.env, SOURCE_DATE_EPOCH },
  });
  const licenseOutputDirectory = join(absoluteOutputDirectory, "licenses");
  await mkdir(licenseOutputDirectory, { recursive: true });
  await copyFile(
    join(projectRoot, "wasm", "THIRD_PARTY_NOTICES.md"),
    join(absoluteOutputDirectory, "THIRD_PARTY_NOTICES.md"),
  );
  await copyFile(
    join(projectRoot, "wasm", "licenses", "Emscripten.txt"),
    join(licenseOutputDirectory, "Emscripten.txt"),
  );
  await copyFile(
    join(projectRoot, "wasm", "licenses", "Lua-5.2.txt"),
    join(licenseOutputDirectory, "Lua-5.2.txt"),
  );
  await copyFile(
    join(projectRoot, "wasm", "licenses", "WTFPL-2.txt"),
    join(licenseOutputDirectory, "WTFPL-2.txt"),
  );
  process.stdout.write(`Built ${artifactPath}\nToolchain: ${versionLine}\n`);
  return absoluteOutputDirectory;
}

const outputDirectory = optionValue("--output-dir", join("wasm", "dist"));
await build(outputDirectory);
