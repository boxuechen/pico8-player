import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { verifyReleaseArtifact } from "../../tools/release/release-artifact.mjs";

const releaseRoot = "apps/web-player/dist/release";
const exit = JSON.parse(await readFile(
  "tests/conformance/manifests/phase-7h-exit.json",
  "utf8",
));

test("the current release verifies and preserves the Phase 7H public shape", async () => {
  const { manifest } = await verifyReleaseArtifact({ outputDirectory: releaseRoot });
  assert.ok(manifest.files.length >= exit.releaseArtifact.fileCount);
  assert.deepEqual(Object.keys(manifest.artifacts), exit.releaseArtifact.stableKeys);
  assert.deepEqual(manifest.capabilities, {
    cartAuthority: "caller-provided Uint8Array or caller-authorized local bundle only",
    networkCartAccess: false,
    arbitraryUrlAccess: false,
    crossOriginIsolationRequired: false,
    publicationPerformed: false,
  });
});

test("Phase 7H retains internally consistent frozen artifact evidence", async () => {
  assert.match(exit.releaseArtifact.manifestSha256, /^[0-9a-f]{64}$/u);
  assert.equal(
    Object.keys(exit.releaseArtifact.fileSha256).length,
    exit.releaseArtifact.fileCount,
  );
  assert.deepEqual(
    Object.keys(exit.releaseArtifact.stableArtifactSha256),
    exit.releaseArtifact.stableKeys,
  );

  const currentManifest = JSON.parse(await readFile(`${releaseRoot}/manifest.json`, "utf8"));
  for (const key of exit.releaseArtifact.stableKeys) {
    const path = currentManifest.artifacts[key].path;
    assert.equal(
      exit.releaseArtifact.stableArtifactSha256[key],
      exit.releaseArtifact.fileSha256[path],
      key,
    );
  }
  for (const [path, hash] of Object.entries(exit.releaseArtifact.fileSha256)) {
    assert.match(hash, /^[0-9a-f]{64}$/u, path);
  }
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
  assert.ok(readme.includes("pnpm run verify:release"));
  assert.match(readme, /does not upload them or resolve a\s+cart URL/u);
  assert.match(readme, /No npm package,\s+website, GitHub Release/u);
});
