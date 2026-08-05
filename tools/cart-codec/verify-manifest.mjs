import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function readJson(path) {
  return JSON.parse(await readFile(join(projectRoot, path), "utf8"));
}

async function digest(path) {
  return createHash("sha256").update(await readFile(join(projectRoot, path))).digest("hex");
}

const manifest = await readJson("packages/cart-codec/manifest.lock.json");
const contract = await readJson(manifest.contract.path);
const fixtures = await readJson(manifest.fixtures.manifest);
const packageManifest = await readJson("packages/cart-codec/package.json");

assert.equal(manifest.phase, "0D");
assert.equal(manifest.target.pico8Version, contract.target.pico8Version);
assert.equal(manifest.target.maximumCartVersion, contract.target.maximumCartVersion);
assert.equal(await digest(manifest.contract.path), manifest.contract.sha256);
assert.equal(await digest(manifest.fixtures.manifest), manifest.fixtures.manifestSha256);
assert.equal(fixtures.ownership, manifest.fixtures.ownership);
assert.equal(manifest.thirdPartyCodeIncorporated, false);
assert.deepEqual(Object.keys(packageManifest.dependencies ?? {}).sort(), manifest.runtimeDependencies);

const actualSources = (await readdir(join(projectRoot, "packages/cart-codec/src")))
  .filter((name) => name.endsWith(".ts"))
  .map((name) => `packages/cart-codec/src/${name}`)
  .sort();
assert.deepEqual(actualSources, manifest.productionSources.map(({ path }) => path).sort());
for (const source of manifest.productionSources) {
  assert.equal(await digest(source.path), source.sha256, `${source.path} SHA-256`);
  assert.equal(source.path.includes("ref/"), false, `${source.path} must not resolve through ref/`);
}
assert.ok(manifest.normativeSources.every((source) => source.startsWith("https://")));
assert.ok(manifest.referenceCrossChecks.every(({ use }) => use.includes("no source copied or imported")));

process.stdout.write(
  `Verified Phase 0D cart-codec manifest and ${manifest.productionSources.length} production sources\n`,
);
