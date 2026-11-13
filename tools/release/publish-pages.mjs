// Publish already-built static files; no GitHub Release or package registry.
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyReleaseArtifact } from "./release-artifact.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const git = (args, cwd = root) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
if (git(["status", "--porcelain"])) throw new Error("Commit source changes before publishing Pages.");
await verifyReleaseArtifact();
const revision = git(["rev-parse", "HEAD"]);
const remote = git(["remote", "get-url", "origin"]);
const staging = await mkdtemp(join(tmpdir(), "pico8-player-pages-"));
try {
  git(["init", "--initial-branch=gh-pages"], staging);
  git(["remote", "add", "origin", remote], staging);
  if (git(["ls-remote", "--heads", "origin", "gh-pages"], staging)) {
    git(["fetch", "--depth=1", "origin", "gh-pages"], staging);
    git(["reset", "--hard", "FETCH_HEAD"], staging);
  }
  const source = join(root, "apps/web-player/dist/release");
  const destination = join(staging, revision);
  let previous;
  try { previous = await readFile(join(destination, "manifest.json")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (previous && !previous.equals(await readFile(join(source, "manifest.json")))) {
    throw new Error("This source revision already has different published files.");
  }
  await mkdir(destination, { recursive: true });
  await cp(source, destination, { recursive: true });
  await writeFile(join(staging, ".nojekyll"), "");
  await writeFile(join(staging, "index.html"), `<!doctype html><html lang="en"><meta charset="utf-8"><title>PICO-8 Player</title><h1>PICO-8 Player</h1><p><a href="${revision}/demo/">Open player demo</a></p><p>Static build: <code>${revision}</code></p><p><a href="${revision}/manifest.json">File manifest</a> · <a href="${revision}/THIRD_PARTY_NOTICES.md">Third-party notices</a></p></html>\n`);
  git(["add", "."], staging);
  if (git(["status", "--porcelain"], staging)) {
    git(["commit", "-m", `Publish static player ${revision}`], staging);
    git(["push", "origin", "HEAD:gh-pages"], staging);
  }
  console.log(`Published static player directory: ${revision}/`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
