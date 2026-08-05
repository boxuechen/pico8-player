import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { cpus, platform, release, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const wasmPath = join(projectRoot, "wasm", "dist", "z8lua-phase-0c.wasm");

export async function artifactMetadata() {
  const bytes = await readFile(wasmPath);
  return {
    wasmBytes: bytes.length,
    wasmSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function sourceRevision() {
  const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" });
  if (revision.status !== 0) throw new Error(revision.stderr || "Unable to read Git revision");
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: projectRoot, encoding: "utf8" });
  return `${revision.stdout.trim()}${status.stdout.trim() ? "-dirty" : ""}`;
}

export function machineMetadata() {
  const cpuModel = cpus()[0]?.model ?? "unknown";
  const machineDescription = `${platform()}|${process.arch}|${cpuModel}|${totalmem()}`;
  return {
    machineId: createHash("sha256").update(machineDescription).digest("hex").slice(0, 16),
    os: `${platform()} ${release()}`,
    architecture: process.arch,
    cpuModel,
    logicalCpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
  };
}
