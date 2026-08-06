import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { failureClusterForFault } from "../../tools/compat/failure-clusters-v1.mjs";

test("6C maps runtime failures to bounded compatibility clusters", () => {
  assert.equal(failureClusterForFault("E_CART_PARSE"), "parse");
  assert.equal(failureClusterForFault("E_VM_INSTRUCTION_BUDGET"), "timing");
  assert.equal(failureClusterForFault("E_VM_WATCHDOG"), "timing");
  assert.equal(failureClusterForFault("E_FEATURE_UNSUPPORTED"), "unsupported-host-feature");
  assert.equal(failureClusterForFault("E_FRAME_MISSING"), "graphics");
  assert.equal(failureClusterForFault("E_VM_RUNTIME"), "language");
});

test("6C browser harness uses the production worker and local-only evidence paths", async () => {
  const [browserHarness, nodeHarness, schema, gitignore] = await Promise.all([
    readFile(new URL("../../tools/compat/browser/phase-6c.mjs", import.meta.url), "utf8"),
    readFile(new URL("../../tools/compat/run-chrome-baseline.mjs", import.meta.url), "utf8"),
    readFile(new URL("../../spec/compat/local-observations-v1.schema.json", import.meta.url), "utf8"),
    readFile(new URL("../../.gitignore", import.meta.url), "utf8"),
  ]);
  assert.ok(browserHarness.includes("/apps/web-player/dist/browser/player-worker.mjs"));
  assert.ok(browserHarness.includes("PlayerController"));
  assert.ok(browserHarness.includes("crypto.subtle.digest"));
  assert.doesNotMatch(browserHarness, /ref\//u);
  assert.doesNotMatch(nodeHarness, /source\.url|sourceUrl/u);
  const observationProperties = JSON.parse(schema).$defs.observation.properties;
  assert.ok(observationProperties.screenSha256);
  assert.ok(observationProperties.screenshotCaptured);
  assert.ok(gitignore.includes("/tests/conformance/local-corpus-results/"));
});
