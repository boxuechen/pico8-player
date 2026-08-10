import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { prepareExpandedCorpus } from "../../tools/compat/expanded-corpus-v1.mjs";
import {
  ExpandedSmokeError,
  buildExpandedSmokeAggregate,
} from "../../tools/compat/expanded-smoke-v1.mjs";

const projectRoot = new URL("../../", import.meta.url).pathname;
const source = {
  repository: "https://example.invalid/project-owned-phase-8c-fixture.git",
  revision: "0123456789abcdef0123456789abcdef01234567",
  label: "project-owned generated Phase 8C fixture",
};
const expectedInventory = {
  topLevelProjects: 100,
  cartFiles: 100,
  p8Files: 100,
  p8PngFiles: 0,
  byteUniqueFiles: 100,
  logicalIdentities: 100,
  canonicalLogicalCarts: 100,
  formatPairs: 0,
};
const environment = {
  target: "chrome-production",
  playerCommit: "fedcba9876543210fedcba9876543210fedcba98",
  runtimeWasmSha256: "a".repeat(64),
  chromeVersion: "Google Chrome 151.0.0.0",
};

async function withFixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "p8w-phase8c-"));
  try {
    const sourceRoot = join(root, "source");
    const cartsRoot = join(sourceRoot, "carts");
    await mkdir(cartsRoot, { recursive: true });
    for (let index = 1; index <= 100; index += 1) {
      const name = `project-${String(index).padStart(3, "0")}`;
      const directory = join(cartsRoot, name);
      await mkdir(directory);
      await writeFile(join(directory, `${name}.p8`),
        `pico-8 cartridge // http://www.pico-8.com\nversion 43\n__lua__\nfunction _draw() cls(${index % 16}) end\n-- ${index}\n`);
    }
    const prepared = await prepareExpandedCorpus({
      sourceRoot,
      outputRoot: join(root, "qualification"),
      source,
      expectedInventory,
    });
    const observationPaths = [];
    let caseIndex = 0;
    for (const [batchIndex, batch] of prepared.index.canonical.batches.entries()) {
      const manifest = JSON.parse(await readFile(join(prepared.outputRoot, batch.file), "utf8"));
      const entries = manifest.entries.map(({ id }) => {
        caseIndex += 1;
        const fails = caseIndex <= 48;
        const cluster = ["parse", "language", "timing"][(caseIndex - 1) % 3];
        return {
          id,
          completed: true,
          smokeOutcome: fails ? "fails" : "boots",
          classification: fails ? "C0" : "CU",
          failureCluster: fails ? cluster : null,
          completedTicks: fails ? 0 : 120,
          ...(fails ? { faultCode: "E_PROJECT_FIXTURE" } : {}),
          frameCount: fails ? 0 : 120,
          screenSha256: fails ? null : "b".repeat(64),
          nonBlackPixels: fails ? 0 : 1,
          distinctColors: fails ? 0 : 2,
          screenshotCaptured: true,
        };
      });
      const path = join(root, `observations-${batchIndex + 1}.json`);
      await writeFile(path, `${JSON.stringify({ schemaVersion: 1, environment, entries }, null, 2)}\n`);
      observationPaths.push(path);
    }
    return await fn({ root, prepared, observationPaths });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("Phase 8C aggregates exact 100-case coverage without emitting per-cart data", async () => {
  await withFixture(async ({ prepared, observationPaths }) => {
    const report = await buildExpandedSmokeAggregate({
      indexPath: join(prepared.outputRoot, "expanded-corpus-index.json"),
      observationsPaths: observationPaths,
    });
    assert.equal(report.summary.caseCount, 100);
    assert.equal(report.summary.completedCaseCount, 100);
    assert.deepEqual(report.summary.smokeOutcomes, { boots: 52, fails: 48, notRun: 0 });
    assert.equal(report.summary.counts.C0, 48);
    assert.equal(report.summary.counts.CU, 52);
    assert.equal(report.summary.failureClusters.parse, 16);
    assert.equal(report.summary.failureClusters.language, 16);
    assert.equal(report.summary.failureClusters.timing, 16);
    assert.equal(report.summary.failureClusters.multicart, 0);
    assert.deepEqual(report.summary.screenshots, { captured: 100, missing: 0 });
    assert.deepEqual(report.summary.resources, {
      completedBatchRuns: 2,
      infrastructureFailures: 0,
    });
    const serialized = JSON.stringify(report);
    assert.doesNotMatch(serialized, /project-[0-9]|\.p8|identity|cartSha256|screenSha256/u);
    assert.equal(Object.hasOwn(report, "entries"), false);
  });
});

test("Phase 8C rejects cross-batch environment drift and incomplete coverage", async () => {
  await withFixture(async ({ prepared, observationPaths }) => {
    const second = JSON.parse(await readFile(observationPaths[1], "utf8"));
    second.environment.chromeVersion = "Google Chrome 152.0.0.0";
    await writeFile(observationPaths[1], `${JSON.stringify(second, null, 2)}\n`);
    await assert.rejects(buildExpandedSmokeAggregate({
      indexPath: join(prepared.outputRoot, "expanded-corpus-index.json"),
      observationsPaths: observationPaths,
    }), (error) => error instanceof ExpandedSmokeError && error.code === "E_ENVIRONMENT_DRIFT");

    second.environment = environment;
    second.entries.pop();
    await writeFile(observationPaths[1], `${JSON.stringify(second, null, 2)}\n`);
    await assert.rejects(buildExpandedSmokeAggregate({
      indexPath: join(prepared.outputRoot, "expanded-corpus-index.json"),
      observationsPaths: observationPaths,
    }), (error) => error instanceof ExpandedSmokeError && error.code === "E_OBSERVATION_COVERAGE");
  });
});

test("Phase 8C remains closed with aggregate-only exit evidence", async () => {
  const [contract, packageJson, docsReadme, evidence, schema] = await Promise.all([
    readFile(new URL("../../spec/phase-8-expanded-real-cart-qualification-contract.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../../package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../../docs/README.md", import.meta.url), "utf8"),
    readFile(new URL("../../docs/evidence/phase-8/91-phase-8-expanded-real-cart-qualification-exit-evidence.md", import.meta.url), "utf8"),
    readFile(new URL("../../spec/compat/expanded-smoke-aggregate-v1.schema.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  assert.deepEqual(contract.completedWorkUnits.slice(0, 3), ["8A", "8B", "8C"]);
  assert.equal(contract.workUnits["8C"].status, "complete");
  assert.equal(contract.activeWorkUnit, null);
  assert.equal(contract.nextWorkUnit, null);
  assert.equal(contract.status, "complete");
  assert.deepEqual(contract.workUnits["8C"].result.smokeOutcomes,
    { boots: 52, fails: 48, notRun: 0 });
  assert.deepEqual(contract.workUnits["8C"].result.failureClusters,
    { parse: 34, language: 11, timing: 3 });
  const runnerHashes = contract.workUnits["8C"].result.projectOwnedRunnerSha256;
  assert.deepEqual(Object.keys(runnerHashes).sort(), [
    "aggregateCli",
    "aggregateValidator",
    "browserHarness",
    "chromeRunner",
    "expandedWrapper",
  ]);
  for (const hash of Object.values(runnerHashes)) assert.match(hash, /^[0-9a-f]{64}$/u);
  assert.equal(contract.workUnits["8C"].result.thirdPartyPerCartDataTracked, false);
  assert.equal(packageJson.scripts["test:phase-8c"],
    "node --test tests/compat/phase-8c-expanded-smoke.test.mjs");
  assert.match(packageJson.scripts["qualification:phase-8:aggregate"], /aggregate-expanded-smoke\.mjs/u);
  assert.match(packageJson.scripts.test, /test:phase-8c/u);
  assert.match(packageJson.scripts.verify, /test:phase-8c/u);
  assert.equal(schema.properties.runner.const, "phase-8-expanded-smoke-v1");
  assert.match(docsReadme, /Active work unit \| 无/u);
  assert.ok(evidence.includes("100-cart canonical corpus"));
});
