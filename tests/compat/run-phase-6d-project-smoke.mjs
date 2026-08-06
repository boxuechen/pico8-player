import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runChromeBaseline } from "../../tools/compat/run-chrome-baseline.mjs";

const fixture = await readFile(new URL("fixtures/stat20-project-cart.p8", import.meta.url));
const fixtureSha256 = createHash("sha256").update(fixture).digest("hex");
const directory = await mkdtemp(join(tmpdir(), "p8w-phase6d-project-"));

try {
  const cartPath = join(directory, "project.p8");
  const manifestPath = join(directory, "manifest.json");
  const observationsPath = join(directory, "observations.json");
  const screenshotsDirectory = join(directory, "screenshots");
  await writeFile(cartPath, fixture);
  const entries = Array.from({ length: 12 }, (_, index) => ({
    id: `project/stat20-${String(index + 1).padStart(2, "0")}`,
    label: `Project stat(20) smoke ${index + 1}`,
    file: "project.p8",
    sha256: fixtureSha256,
    pico8Version: "0.2.7",
    source: {
      label: "pico8-web-player project fixture",
      revision: "phase-6d-v1",
      permissionStatus: "author-provided",
      permissionBasis: "Project-authored stat(20) Chrome fixture",
    },
    trace: {
      mode: "fixed-ticks",
      ticks: 120,
      stepMilliseconds: 1000 / 30,
      inputs: [],
    },
  }));
  await writeFile(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    corpusId: "phase-6d/project-stat20-smoke",
    policy: "developer-supplied-local-only",
    entries,
  }, null, 2)}\n`);

  const observations = await runChromeBaseline({
    manifestPath,
    observationsPath,
    screenshotsDirectory,
  });
  assert.equal(observations.entries.length, 12);
  assert.ok(observations.entries.every(({ completed }) => completed));
  assert.ok(
    observations.entries.every(({ smokeOutcome }) => smokeOutcome === "boots"),
    JSON.stringify(observations.entries[0]),
  );
  assert.ok(observations.entries.every(({ classification }) => classification === "CU"));
  assert.ok(observations.entries.every(({ completedTicks }) => completedTicks === 120));
  assert.ok(observations.entries.every(({ frameCount }) => frameCount > 0));
  assert.ok(observations.entries.every(({ nonBlackPixels }) => nonBlackPixels === 128 * 128));
  process.stdout.write(`${JSON.stringify({
    chromeVersion: observations.environment.chromeVersion,
    cases: observations.entries.length,
    stat20Boots: observations.entries.filter(({ smokeOutcome }) => smokeOutcome === "boots").length,
  }, null, 2)}\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
