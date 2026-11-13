import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { removePreviousBuilds } from "../../tools/release/pages-retention.mjs";

test("Pages cleanup removes only previous commit directories", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "player-pages-retention-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const current = "a".repeat(40);
  const previous = "b".repeat(40);
  for (const name of [current, previous, ".git", "assets"]) {
    await mkdir(join(root, name));
    await writeFile(join(root, name, "sentinel"), "retained unless old build");
  }
  await writeFile(join(root, "c".repeat(40)), "not a build directory");
  await assert.rejects(removePreviousBuilds(root, "main"), /full source commit/);
  assert.ok((await readdir(root)).includes(previous));
  assert.deepEqual(await removePreviousBuilds(root, current), [previous]);
  assert.deepEqual((await readdir(root)).sort(), [".git", "assets", current, "c".repeat(40)].sort());
  assert.deepEqual(await removePreviousBuilds(root, current), []);
});
