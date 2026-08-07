import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { verifyReleaseArtifact } from "../../tools/release/release-artifact.mjs";

const releaseRoot = "apps/web-player/dist/release";
const exit = JSON.parse(await readFile(
  "tests/conformance/manifests/phase-7h-exit.json",
  "utf8",
));

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("Phase 7H binds the verified release tree to its aggregate exit manifest", async () => {
  const { manifest } = await verifyReleaseArtifact({ outputDirectory: releaseRoot });
  const manifestBytes = await readFile(`${releaseRoot}/manifest.json`);
  assert.equal(sha256(manifestBytes), exit.releaseArtifact.manifestSha256);
  assert.equal(manifest.files.length, exit.releaseArtifact.fileCount);
  assert.deepEqual(Object.keys(manifest.artifacts), exit.releaseArtifact.stableKeys);

  const fileHashes = Object.fromEntries(
    manifest.files.map(({ path, sha256: hash }) => [path, hash]),
  );
  assert.deepEqual(fileHashes, exit.releaseArtifact.fileSha256);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(manifest.artifacts).map(([key, artifact]) => [key, artifact.sha256]),
    ),
    exit.releaseArtifact.stableArtifactSha256,
  );
  assert.equal(
    manifest.inputs["spec/phase-7-web-player-release-candidate-contract.json"],
    exit.sourceLocks["spec/phase-7-web-player-release-candidate-contract.json"],
  );
  assert.equal(
    manifest.inputs["wasm/runtime-v1.manifest.lock.json"],
    exit.sourceLocks["wasm/runtime-v1.manifest.lock.json"],
  );
  assert.deepEqual(manifest.capabilities, {
    cartAuthority: "caller-provided Uint8Array or caller-authorized local bundle only",
    networkCartAccess: false,
    arbitraryUrlAccess: false,
    crossOriginIsolationRequired: false,
    publicationPerformed: false,
  });
});

test("Phase 7H local demo only fetches its release manifest and keeps carts caller-owned", async () => {
  const [sourceHtml, sourceDemo, releaseHtml, releaseDemo] = await Promise.all([
    readFile("apps/web-player/public/demo/index.html", "utf8"),
    readFile("apps/web-player/public/demo/demo.mjs", "utf8"),
    readFile(`${releaseRoot}/demo/index.html`, "utf8"),
    readFile(`${releaseRoot}/demo/demo.mjs`, "utf8"),
  ]);
  assert.equal(releaseHtml, sourceHtml);
  assert.equal(releaseDemo, sourceDemo);
  assert.match(sourceHtml, /Cart bytes stay in this browser/u);
  assert.match(sourceHtml, /not uploaded or resolved from a cart URL/u);
  assert.equal((sourceDemo.match(/\bfetch\s*\(/gu) ?? []).length, 1);
  assert.ok(sourceDemo.includes("fetch(manifestUrl)"));
  assert.ok(sourceDemo.includes("manifest.artifacts.styles.path"));
  assert.ok(sourceDemo.includes("manifest.artifacts.main.path"));
  assert.doesNotMatch(sourceDemo, /selectedFile|\.p8(?:\.png)?|cartUrl/u);
});

test("Phase 7H documents static-HTTP local use and stable-key embedding", async () => {
  const readme = await readFile("README.md", "utf8");
  assert.ok(readme.includes("python3 -m http.server 8000 --directory apps/web-player/dist/release"));
  assert.ok(readme.includes("http://127.0.0.1:8000/demo/"));
  assert.ok(readme.includes("`file://` does not provide"));
  assert.ok(readme.includes("manifest.artifacts.main.path"));
  assert.ok(readme.includes("selectedFile.arrayBuffer()"));
  assert.ok(readme.includes("pnpm run test:release"));
  assert.match(readme, /does not upload them or resolve a\s+cart URL/u);
  assert.match(readme, /No npm package,\s+website, GitHub Release/u);
});
