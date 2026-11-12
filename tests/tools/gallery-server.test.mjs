import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createCartCatalog,
  parseCliArgs,
  startLocalGallery,
} from "../../tools/local-gallery/server.mjs";

const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; worker-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "p8w-gallery-test-"));
  const carts = join(root, "caller-carts");
  const release = join(root, "release");
  await Promise.all([mkdir(join(carts, "nested"), { recursive: true }), mkdir(release)]);
  const textCart = Buffer.from("pico-8 cartridge // project fixture\nversion 42\n__lua__\nfunction _draw() cls(1) end\n");
  const pngCart = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await Promise.all([
    writeFile(join(carts, "002-blue-orbit.p8"), textCart),
    writeFile(join(carts, "nested", "001-pink-star.p8.png"), pngCart),
    writeFile(join(carts, "readme.txt"), "ignored"),
    writeFile(join(release, "manifest.json"), JSON.stringify({
      csp: CSP,
      files: [{ path: "player.css", mime: "text/css; charset=utf-8" }],
    })),
    writeFile(join(release, "player.css"), ":root{}"),
  ]);
  try {
    await symlink(join(root, "outside.p8"), join(carts, "escaping.p8"));
    await writeFile(join(root, "outside.p8"), textCart);
  } catch {}
  return { root, carts, release, textCart, pngCart };
}

test("catalog is bounded, opaque and excludes symlinks and unsupported files", async (t) => {
  const local = await fixture();
  t.after(() => rm(local.root, { recursive: true, force: true }));
  const catalog = await createCartCatalog(local.carts);
  assert.equal(catalog.entries.length, 2);
  assert.deepEqual(catalog.publicCarts.map(({ id, format, rank, title }) => ({ id, format, rank, title })), [
    { id: "cart-0001", format: "p8", rank: 2, title: "blue orbit" },
    { id: "cart-0002", format: "p8.png", rank: 1, title: "pink star" },
  ]);
  const publicBody = catalog.body.toString("utf8");
  assert.equal(publicBody.includes(local.root), false);
  assert.doesNotMatch(publicBody, /escaping|readme\.txt/u);
  await assert.rejects(createCartCatalog(local.carts, { maximumCartFiles: 1 }), /cart count exceeds 1/u);
});

test("loopback server serves only catalog IDs and manifest-listed release files", async (t) => {
  const local = await fixture();
  const gallery = await startLocalGallery({ cartRoot: local.carts, releaseRoot: local.release, port: 0 });
  t.after(async () => {
    await gallery.close();
    await rm(local.root, { recursive: true, force: true });
  });
  assert.equal(gallery.server.address().address, "127.0.0.1");

  const catalogResponse = await fetch(`${gallery.origin}/api/carts`);
  assert.equal(catalogResponse.status, 200);
  assert.equal(catalogResponse.headers.get("content-security-policy"), CSP);
  assert.equal(catalogResponse.headers.get("x-content-type-options"), "nosniff");
  const catalog = await catalogResponse.json();
  assert.equal(catalog.count, 2);

  const textResponse = await fetch(`${gallery.origin}/api/carts/cart-0001`);
  assert.equal(textResponse.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.deepEqual(Buffer.from(await textResponse.arrayBuffer()), local.textCart);
  assert.equal((await fetch(`${gallery.origin}/api/carts/cart-0001/thumbnail`)).status, 404);

  const pngResponse = await fetch(`${gallery.origin}/api/carts/cart-0002/thumbnail`);
  assert.equal(pngResponse.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await pngResponse.arrayBuffer()), local.pngCart);

  assert.equal((await fetch(`${gallery.origin}/release/manifest.json`)).status, 200);
  assert.equal((await fetch(`${gallery.origin}/release/player.css`)).status, 200);
  assert.equal((await fetch(`${gallery.origin}/release/not-listed.mjs`)).status, 404);
  assert.equal((await fetch(`${gallery.origin}/api/carts/../../server.mjs`)).status, 404);
  assert.equal((await fetch(`${gallery.origin}/api/carts`, { method: "POST" })).status, 405);
});

test("CLI accepts only explicit cart root, release root and bounded port", () => {
  assert.deepEqual(parseCliArgs([
    "--cart-root", "./carts",
    "--release-root", "./release",
    "--port", "4318",
  ]), {
    cartRoot: "./carts",
    releaseRoot: "./release",
    port: 4318,
  });
  assert.throws(() => parseCliArgs(["--host", "0.0.0.0"]), /unknown argument --host/u);
  assert.throws(() => parseCliArgs(["--cart-root"]), /requires a value/u);
});
