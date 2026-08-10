import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const readJson = async (path) => JSON.parse(await read(path));
const packages = [
  "package.json",
  "apps/web-player/package.json",
  "packages/cart-codec/package.json",
  "packages/contracts/package.json",
  "packages/runtime-core/package.json",
  "packages/z8lua-bridge/package.json",
];

test("Phase 10B aligns private workspace metadata to the local RC", async () => {
  const manifests = await Promise.all(packages.map(readJson));
  for (const manifest of manifests) {
    assert.equal(manifest.version, "0.1.0-rc.1", manifest.name);
    assert.equal(manifest.private, true, manifest.name);
    assert.equal(manifest.license, "UNLICENSED", manifest.name);
  }
});

test("Phase 10B publishes the current compatibility and distribution boundary", async () => {
  const [readme, changelog, license, contract] = await Promise.all([
    read("README.md"),
    read("CHANGELOG.md"),
    read("LICENSE"),
    readJson("spec/phase-10-release-readiness-contract.json"),
  ]);
  assert.match(readme, /0\.1\.0-rc\.1/u);
  assert.match(readme, /101 compatible, 5 partial/u);
  assert.match(readme, /7 unsupported/u);
  assert.doesNotMatch(readme, /3 explicitly partial|9 unsupported/u);
  assert.match(readme, /#1-当前发布口径/u);
  assert.match(changelog, /101 compatible, 5 partial and 7 unsupported/u);
  assert.match(changelog, /no npm, remote, tag, website or public release/u);
  assert.match(license, /^UNLICENSED/u);
  assert.match(license, /No license is granted/u);
  assert.equal(contract.release.projectLicense, "UNLICENSED");
});

test("Phase 10B retains the complete RuntimeCore notice sources", async () => {
  const notice = await read("packages/runtime-core/THIRD_PARTY_NOTICES.md");
  assert.match(notice, /fake-08/u);
  assert.match(notice, /tac08/u);
  assert.match(notice, /zepto8/u);
  assert.match(notice, /MIT licensed/u);
  assert.match(notice, /Do\s+What The Fuck You Want To Public License/u);
});
