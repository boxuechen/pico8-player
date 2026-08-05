import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

export async function calculateSourceInventory(projectRoot, lock) {
  const sourceDirectory = join(projectRoot, lock.snapshot.path);
  const excluded = new Set(lock.snapshot.inventoryExcludes);
  const files = (await walk(sourceDirectory))
    .filter((path) => !excluded.has(relative(sourceDirectory, path).split(sep).join("/")))
    .sort();

  const inventory = createHash("sha256");
  for (const path of files) {
    const bytes = await readFile(path);
    const fileHash = createHash("sha256").update(bytes).digest("hex");
    const projectPath = relative(projectRoot, path).split(sep).join("/");
    inventory.update(`${fileHash}  ${projectPath}\n`);
  }
  return inventory.digest("hex");
}

export async function verifySourceInventory(projectRoot) {
  const lock = JSON.parse(
    await readFile(join(projectRoot, "wasm", "source.lock.json"), "utf8"),
  );
  const actual = await calculateSourceInventory(projectRoot, lock);
  if (actual !== lock.snapshot.sha256Inventory) {
    throw new Error(
      `Vendored z8lua inventory mismatch: expected ${lock.snapshot.sha256Inventory}, got ${actual}`,
    );
  }
  return actual;
}
