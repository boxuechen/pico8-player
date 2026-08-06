import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runChromeBaseline } from "../../tools/compat/run-chrome-baseline.mjs";
import { buildLocalQualificationReport } from "../../tools/compat/local-qualification-v1.mjs";

const fixture = await readFile(new URL("fixtures/minimal-project-cart.p8", import.meta.url));
const fixtureSha256 = createHash("sha256").update(fixture).digest("hex");
const directory = await mkdtemp(join(tmpdir(), "p8w-phase6c-project-"));

try {
  const cartPath = join(directory, "project.p8");
  const manifestPath = join(directory, "manifest.json");
  const observationsPath = join(directory, "observations.json");
  const screenshotsDirectory = join(directory, "screenshots");
  await writeFile(cartPath, fixture);
  const entries = Array.from({ length: 12 }, (_, index) => ({
    id: `project/smoke-${String(index + 1).padStart(2, "0")}`,
    label: `Project smoke ${index + 1}`,
    file: "project.p8",
    sha256: fixtureSha256,
    pico8Version: "0.2.7",
    source: {
      label: "pico8-web-player project fixture",
      revision: "phase-6c-v1",
      permissionStatus: "author-provided",
      permissionBasis: "Project-authored deterministic Chrome fixture",
    },
    trace: {
      mode: "fixed-ticks",
      ticks: 120,
      stepMilliseconds: 1000 / 60,
      inputs: [],
    },
  }));
  await writeFile(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    corpusId: "phase-6c/project-chrome-smoke",
    policy: "developer-supplied-local-only",
    entries,
  }, null, 2)}\n`);

  const observations = await runChromeBaseline({
    manifestPath,
    observationsPath,
    screenshotsDirectory,
  });
  assert.match(observations.environment.chromeVersion, /^(Google Chrome|Chromium) /u);
  assert.equal(observations.entries.length, 12);
  assert.ok(observations.entries.every(({ completed }) => completed));
  assert.ok(observations.entries.every(({ smokeOutcome }) => smokeOutcome === "boots"));
  assert.ok(observations.entries.every(({ classification }) => classification === "CU"));
  assert.ok(observations.entries.every(({ completedTicks }) => completedTicks === 120));
  assert.ok(observations.entries.every(({ frameCount }) => frameCount > 0));
  assert.ok(observations.entries.every(({ screenSha256 }) => /^[a-f0-9]{64}$/u.test(screenSha256)));
  assert.ok(observations.entries.every(({ distinctColors }) => distinctColors >= 2));
  assert.ok(observations.entries.every(({ screenshotCaptured }) => screenshotCaptured));
  assert.equal((await readdir(screenshotsDirectory)).filter((name) => name.endsWith(".png")).length, 12);

  const report = await buildLocalQualificationReport({
    manifestPath,
    observationsPath,
    projectRoot: new URL("../../", import.meta.url).pathname,
  });
  assert.equal(report.summary.qualificationComplete, true);
  assert.deepEqual(report.summary.counts, { C0: 0, C1: 0, C2: 0, C3: 0, CU: 12 });
  assert.ok(report.entries.every(({ screenshotCaptured }) => screenshotCaptured));
  process.stdout.write(`${JSON.stringify({
    chromeVersion: observations.environment.chromeVersion,
    cases: observations.entries.length,
    counts: report.summary.counts,
    screenshots: 12,
  }, null, 2)}\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
