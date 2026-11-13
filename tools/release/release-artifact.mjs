import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONTRACT_PATH = join(PROJECT_ROOT, "spec/release-artifact-contract.json");
const CONTRACT = JSON.parse(await readFile(CONTRACT_PATH, "utf8"));
const DEFAULT_OUTPUT = join(PROJECT_ROOT, CONTRACT.outputRoot);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function relativePath(root, path) {
  return relative(root, path).split(sep).join("/");
}

function assertSafeOutputDirectory(path) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  assert.notEqual(absolute, root, "release output cannot be a filesystem root");
  assert.notEqual(absolute, PROJECT_ROOT, "release output cannot be the repository root");
  assert.ok(relative(root, absolute).split(sep).filter(Boolean).length >= 3,
    "release output must be a narrow directory");
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

function provenanceFor(path) {
  if (path.startsWith("wasm/")) return "z8lua-runtime-lock";
  if (path === "LICENSE") return "project-license";
  if (path === "THIRD_PARTY_NOTICES.md" || path.startsWith("licenses/")) {
    return "third-party-license";
  }
  return "project-source";
}

async function copy(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

async function inputHashes() {
  const result = {};
  for (const path of Object.values(CONTRACT.provenance).sort()) {
    result[path] = sha256(await readFile(join(PROJECT_ROOT, path)));
  }
  return result;
}

async function combinedThirdPartyNotices() {
  const [runtimeCore, wasm] = await Promise.all([
    readFile(join(PROJECT_ROOT, CONTRACT.provenance.runtimeCoreNotices), "utf8"),
    readFile(join(PROJECT_ROOT, CONTRACT.provenance.wasmNotices), "utf8"),
  ]);
  return [
    `# Third-party notices: PICO-8 Player ${CONTRACT.version}`,
    "",
    "This generated notice combines the two tracked provenance owners used by the release artifact.",
    "",
    runtimeCore.trim(),
    "",
    wasm.trim(),
    "",
  ].join("\n");
}

async function assertReleaseMetadata() {
  const workspace = JSON.parse(await readFile(
    join(PROJECT_ROOT, CONTRACT.provenance.workspaceManifest),
    "utf8",
  ));
  assert.equal(workspace.version, CONTRACT.version, "workspace/release version drift");
  assert.equal(workspace.license, CONTRACT.projectLicense, "workspace/release license drift");
}

export async function buildReleaseArtifact({ outputDirectory = DEFAULT_OUTPUT } = {}) {
  await assertReleaseMetadata();
  const output = assertSafeOutputDirectory(outputDirectory);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });

  await build({
    entryPoints: [join(PROJECT_ROOT, "apps/web-player/dist/main/public.js")],
    outfile: join(output, CONTRACT.artifacts.main),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["chrome120"],
    legalComments: "none",
    sourcemap: false,
    plugins: [{ name: "main-z8lua-runtime", setup(context) {
      context.onResolve({ filter: /z8lua-runtime-v1\.mjs$/ }, () => ({
        path: "../wasm/z8lua-runtime-v1.mjs", external: true,
      }));
    } }],
  });
  await build({
    entryPoints: [join(PROJECT_ROOT, "apps/web-player/src/worker/player-worker-entry.mjs")],
    outfile: join(output, CONTRACT.artifacts.worker),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["chrome120"],
    legalComments: "none",
    sourcemap: false,
    plugins: [{
      name: "release-z8lua-runtime",
      setup(buildContext) {
        buildContext.onResolve({ filter: /z8lua-runtime-v1\.mjs$/ }, () => ({
          path: "../wasm/z8lua-runtime-v1.mjs",
          external: true,
        }));
      },
    }],
  });
  await build({
    entryPoints: [join(
      PROJECT_ROOT,
      "apps/web-player/src/worklet/pico8-audio-processor.ts",
    )],
    outfile: join(output, CONTRACT.artifacts.worklet),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["chrome120"],
    legalComments: "none",
    sourcemap: false,
  });

  for (const [source, destination] of [
    ["wasm/dist/z8lua-runtime-v1.mjs", "wasm/z8lua-runtime-v1.mjs"],
    ["wasm/dist/z8lua-runtime-v1.wasm", CONTRACT.artifacts.wasm],
    ["apps/web-player/public/player.css", CONTRACT.artifacts.styles],
    ["apps/web-player/public/demo/index.html", CONTRACT.artifacts.demo],
    ["apps/web-player/public/demo/demo.mjs", "demo/demo.mjs"],
    ["tools/release/portable-verify.mjs", "verify.mjs"],
    ["LICENSE", "LICENSE"],
    ["CHANGELOG.md", "RELEASE_NOTES.md"],
    ["wasm/licenses/Emscripten.txt", "licenses/Emscripten.txt"],
    ["wasm/licenses/Lua-5.2.txt", "licenses/Lua-5.2.txt"],
    ["wasm/licenses/WTFPL-2.txt", "licenses/WTFPL-2.txt"],
  ]) {
    await copy(join(PROJECT_ROOT, source), join(output, destination));
  }
  await writeFile(
    join(output, "THIRD_PARTY_NOTICES.md"),
    await combinedThirdPartyNotices(),
  );

  const emittedPaths = (await walk(output)).filter((path) => path !== CONTRACT.manifest);
  const files = [];
  for (const path of emittedPaths) {
    const bytes = await readFile(join(output, path));
    files.push({
      path,
      mime: CONTRACT.files[path],
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
      provenance: provenanceFor(path),
    });
  }
  const fileByPath = new Map(files.map((entry) => [entry.path, entry]));
  const artifacts = {};
  for (const key of CONTRACT.stableKeys) {
    artifacts[key] = { ...fileByPath.get(CONTRACT.artifacts[key]) };
  }
  const manifest = {
    schemaVersion: CONTRACT.schemaVersion,
    artifactId: CONTRACT.artifactId,
    version: CONTRACT.version,
    apiVersion: CONTRACT.apiVersion,
    channel: CONTRACT.channel,
    projectLicense: CONTRACT.projectLicense,
    target: CONTRACT.target,
    base: "./",
    csp: CONTRACT.csp,
    capabilities: {
      cartAuthority: CONTRACT.policy.cartAuthority,
      networkCartAccess: CONTRACT.policy.networkCartAccess,
      arbitraryUrlAccess: CONTRACT.policy.arbitraryUrlAccess,
      crossOriginIsolationRequired: CONTRACT.policy.crossOriginIsolationRequired,
      publicationPerformed: CONTRACT.policy.publicationPerformed,
      hostedShell: CONTRACT.policy.hostedShell,
      externalInput: CONTRACT.policy.externalInput,
      hostPersistence: CONTRACT.policy.hostPersistence,
      awaitablePersistenceFlush: CONTRACT.policy.awaitablePersistenceFlush,
    },
    toolchain: CONTRACT.toolchain,
    inputs: await inputHashes(),
    artifacts,
    files,
  };
  await writeFile(
    join(output, CONTRACT.manifest),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return { outputDirectory: output, manifest };
}

export async function verifyReleaseArtifact({ outputDirectory = DEFAULT_OUTPUT } = {}) {
  await assertReleaseMetadata();
  const output = assertSafeOutputDirectory(outputDirectory);
  const manifest = JSON.parse(await readFile(join(output, CONTRACT.manifest), "utf8"));
  assert.equal(manifest.schemaVersion, CONTRACT.schemaVersion);
  assert.equal(manifest.artifactId, CONTRACT.artifactId);
  assert.equal(manifest.version, CONTRACT.version);
  assert.equal(manifest.apiVersion, CONTRACT.apiVersion);
  assert.equal(manifest.channel, CONTRACT.channel);
  assert.equal(manifest.projectLicense, CONTRACT.projectLicense);
  assert.equal(manifest.target, CONTRACT.target);
  assert.equal(manifest.base, "./");
  assert.equal(manifest.csp, CONTRACT.csp);
  assert.deepEqual(manifest.toolchain, CONTRACT.toolchain);
  assert.deepEqual(manifest.inputs, await inputHashes());
  assert.deepEqual(Object.keys(manifest.artifacts), CONTRACT.stableKeys);
  assert.deepEqual(manifest.capabilities, {
    cartAuthority: CONTRACT.policy.cartAuthority,
    networkCartAccess: false,
    arbitraryUrlAccess: false,
    crossOriginIsolationRequired: false,
    publicationPerformed: false,
    hostedShell: true,
    externalInput: true,
    hostPersistence: true,
    awaitablePersistenceFlush: true,
  });

  const emittedPaths = await walk(output);
  const expectedPaths = [...Object.keys(CONTRACT.files), CONTRACT.manifest].sort();
  assert.deepEqual(emittedPaths, expectedPaths, "release file allowlist drift");
  assert.deepEqual(
    manifest.files.map(({ path }) => path),
    Object.keys(CONTRACT.files).sort(),
    "manifest file order or membership drift",
  );

  const fileByPath = new Map();
  for (const entry of manifest.files) {
    assert.equal(entry.mime, CONTRACT.files[entry.path], `${entry.path} MIME`);
    assert.equal(entry.provenance, provenanceFor(entry.path), `${entry.path} provenance`);
    assert.ok(!entry.path.startsWith("/") && !entry.path.includes("..") &&
      !entry.path.includes("\\"), `${entry.path} must be relative and canonical`);
    for (const fragment of CONTRACT.policy.forbiddenPathFragments) {
      assert.equal(entry.path.toLowerCase().includes(fragment.toLowerCase()), false,
        `${entry.path} contains excluded path fragment ${fragment}`);
    }
    const bytes = await readFile(join(output, entry.path));
    assert.equal((await stat(join(output, entry.path))).size, entry.bytes, `${entry.path} bytes`);
    assert.equal(sha256(bytes), entry.sha256, `${entry.path} SHA-256`);
    fileByPath.set(entry.path, entry);
    if (/\.(?:m?js)$/u.test(entry.path)) {
      const source = bytes.toString("utf8");
      for (const pattern of CONTRACT.policy.forbiddenJavaScriptPatterns) {
        assert.equal(source.includes(pattern), false, `${entry.path} contains ${pattern}`);
      }
    }
  }
  for (const key of CONTRACT.stableKeys) {
    const expectedPath = CONTRACT.artifacts[key];
    assert.deepEqual(manifest.artifacts[key], fileByPath.get(expectedPath), key);
  }

  const main = await readFile(join(output, CONTRACT.artifacts.main), "utf8");
  assert.ok(main.includes("../browser/player-worker.mjs"));
  assert.ok(main.includes("../worklet/pico8-audio-processor.js"));
  assert.equal(main.includes("fetch("), false, "public main must not fetch cart or assets");
  const worker = await readFile(join(output, CONTRACT.artifacts.worker), "utf8");
  assert.ok(worker.includes("../wasm/z8lua-runtime-v1.mjs"));
  assert.equal(worker.includes("../../../../wasm/dist"), false);
  const loader = await readFile(join(output, CONTRACT.runtime.loader), "utf8");
  assert.ok(loader.includes(CONTRACT.runtime.streaming));
  assert.ok(loader.includes(CONTRACT.runtime.fallback));
  const demo = await readFile(join(output, "demo/demo.mjs"), "utf8");
  assert.equal((demo.match(/\bfetch\s*\(/gu) ?? []).length, 1);
  assert.ok(demo.includes("fetch(manifestUrl)"));
  const html = await readFile(join(output, CONTRACT.artifacts.demo), "utf8");
  assert.ok(html.includes(CONTRACT.csp));
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/iu.test(html), false, "inline script is forbidden");
  assert.equal(
    await readFile(join(output, "LICENSE"), "utf8"),
    await readFile(join(PROJECT_ROOT, CONTRACT.provenance.projectLicense), "utf8"),
  );
  assert.equal(
    await readFile(join(output, "RELEASE_NOTES.md"), "utf8"),
    await readFile(join(PROJECT_ROOT, CONTRACT.provenance.releaseNotes), "utf8"),
  );
  assert.equal(
    await readFile(join(output, "THIRD_PARTY_NOTICES.md"), "utf8"),
    await combinedThirdPartyNotices(),
  );

  const runtimeManifest = JSON.parse(await readFile(
    join(PROJECT_ROOT, CONTRACT.runtime.manifest),
    "utf8",
  ));
  const lockedWasm = runtimeManifest.artifact.files.find(
    ({ path }) => path === "z8lua-runtime-v1.wasm",
  );
  assert.equal(fileByPath.get(CONTRACT.artifacts.wasm).sha256, lockedWasm.sha256);
  assert.equal(fileByPath.get(CONTRACT.artifacts.wasm).bytes, lockedWasm.bytes);
  return { outputDirectory: output, manifest };
}

export { CONTRACT as releaseArtifactContract };
