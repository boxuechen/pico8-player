import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

export async function removePreviousBuilds(directory, currentRevision) {
  if (!/^[a-f0-9]{40}$/.test(currentRevision)) {
    throw new Error("Expected a full source commit for Pages publication");
  }
  const removed = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && /^[a-f0-9]{40}$/.test(entry.name) && entry.name !== currentRevision) {
      await rm(join(directory, entry.name), { recursive: true });
      removed.push(entry.name);
    }
  }
  return removed.sort();
}
