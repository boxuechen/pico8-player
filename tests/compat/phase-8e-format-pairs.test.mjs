import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { prepareExpandedCorpus } from "../../tools/compat/expanded-corpus-v1.mjs";
import {
  ExpandedFormatPairError,
  buildExpandedFormatPairQualification,
  writeExpandedFormatPairLocalDetails,
} from "../../tools/compat/expanded-format-pairs-v1.mjs";
import { makeP8Bytes } from "../fixtures/p8/fixture-builder.mjs";
import { makeP8Png } from "../fixtures/p8png/fixture-builder.mjs";

const projectRoot = new URL("../../", import.meta.url).pathname;
const source = {
  repository: "https://example.invalid/project-owned-phase-8e-fixture.git",
  revision: "0123456789abcdef0123456789abcdef01234567",
  label: "project-owned generated Phase 8E fixture",
};
const environment = {
  target: "chrome-production",
  playerCommit: "fedcba9876543210fedcba9876543210fedcba98",
  runtimeWasmSha256: "a".repeat(64),
  chromeVersion: "Google Chrome 151.0.0.0",
};
const expectedInventory = {
  topLevelProjects: 100,
  cartFiles: 165,
  p8Files: 100,
  p8PngFiles: 65,
  byteUniqueFiles: 165,
  logicalIdentities: 100,
  canonicalLogicalCarts: 100,
  formatPairs: 65,
};

function codeLines(index) {
  const calls = ["cls(1)"];
  if (index % 2 === 0) calls.push("sfx(0)");
  if (index % 3 === 0) calls.push("btn(0)");
  if (index % 5 === 0) calls.push("dget(0)");
  if (index % 7 === 0) calls.push('load("next")');
  return [
    `-- project-owned pair ${index}`,
    "function _draw()",
    ` ${calls.join(" ")}`,
    "end",
  ];
}

async function withFixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "p8w-phase8e-pairs-"));
  try {
    const sourceRoot = join(root, "source");
    const cartsRoot = join(sourceRoot, "carts");
    await mkdir(cartsRoot, { recursive: true });
    for (let index = 1; index <= 100; index += 1) {
      const name = `project-${String(index).padStart(3, "0")}`;
      const directory = join(cartsRoot, name);
      await mkdir(directory);
      const lines = codeLines(index);
      await writeFile(join(directory, `${name}.p8`), makeP8Bytes({
        version: 43,
        sections: [{ name: "lua", lines }],
      }));
      if (index <= 65) {
        const code = Buffer.from(lines.join("\n"));
        const vector = {
          compression: "raw",
          codeHex: code.toString("hex"),
          cartVersion: 43,
          romPatternSeed: index,
          zlibMode: index % 2 === 0 ? "fixed" : "stored",
          filterMode: index % 3 === 0 ? "paeth" : "cycle",
          splitIdat: index % 2 === 0,
        };
        await writeFile(join(directory, `${name}.p8.png`), makeP8Png(vector).png);
      }
    }
    const prepared = await prepareExpandedCorpus({
      sourceRoot,
      outputRoot: join(root, "qualification"),
      source,
      expectedInventory,
    });
    const observationPaths = [];
    let divergentSideAssigned = false;
    for (const [batchIndex, batch] of prepared.index.formatPairs.batches.entries()) {
      const manifest = JSON.parse(await readFile(join(prepared.outputRoot, batch.file), "utf8"));
      const entries = manifest.entries.map(({ id }) => {
        const divergent = !divergentSideAssigned && id.endsWith("/p8.png");
        if (divergent) divergentSideAssigned = true;
        return {
          id,
          completed: true,
          smokeOutcome: "boots",
          classification: "CU",
          failureCluster: null,
          completedTicks: 120,
          frameCount: 120,
          screenSha256: (divergent ? "c" : "b").repeat(64),
          nonBlackPixels: 1,
          distinctColors: 2,
          screenshotCaptured: true,
        };
      });
      const observationPath = join(root, `observations-${batchIndex + 1}.json`);
      await writeFile(observationPath, `${JSON.stringify({ schemaVersion: 1, environment, entries })}\n`);
      observationPaths.push(observationPath);
    }
    const reviewPath = join(root, "review.json");
    await writeFile(reviewPath, `${JSON.stringify({
      schemaVersion: 1,
      reviewedAt: "2026-08-10T08:00:00Z",
      reviewer: "project-owned automated fixture reviewer",
      evidenceSha256: "d".repeat(64),
      samples: { matchedBoot: 1, fault: 0, divergent: 1 },
      unavailable: { fault: true, divergent: false },
      findings: { P0: 0, P1: 0, P2: 0, P3: 0 },
    })}\n`);
    return await fn({ root, prepared, observationPaths, reviewPath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("Phase 8E qualifies exactly 65 local format pairs without publishing per-cart data", async () => {
  await withFixture(async ({ root, prepared, observationPaths, reviewPath }) => {
    const result = await buildExpandedFormatPairQualification({
      indexPath: join(prepared.outputRoot, "expanded-corpus-index.json"),
      observationsPaths: observationPaths,
      reviewPath,
    });
    assert.equal(result.aggregate.summary.pairCount, 65);
    assert.equal(result.aggregate.summary.caseCount, 130);
    assert.equal(result.aggregate.summary.completedPairCount, 65);
    assert.deepEqual(result.aggregate.summary.dispositions,
      { matched: 0, divergent: 65, notRun: 0 });
    assert.deepEqual(result.aggregate.summary.boot,
      { matched: 64, divergent: 1, notRun: 0 });
    assert.deepEqual(result.aggregate.summary.decode.normalizedCode,
      { matched: 65, divergent: 0, notApplicable: 0 });
    assert.deepEqual(result.aggregate.summary.decode.normalizedRom,
      { matched: 0, divergent: 65, notApplicable: 0 });
    assert.equal(result.aggregate.summary.decode.successfulSides, 130);
    assert.deepEqual(result.aggregate.summary.screenshots,
      { capturedSides: 130, missingSides: 0 });
    assert.deepEqual(result.aggregate.summary.review.findings,
      { P0: 0, P1: 0, P2: 0, P3: 0 });
    assert.equal(result.aggregate.summary.qualificationComplete, true);
    assert.equal(result.aggregate.summary.risks.graphics.signaledPairs, 65);
    assert.equal(result.aggregate.summary.risks.audio.signaledPairs, 32);
    assert.equal(result.aggregate.summary.risks.input.signaledPairs, 21);
    assert.equal(result.aggregate.summary.risks.persistence.signaledPairs, 13);
    assert.equal(result.aggregate.summary.risks.multicart.signaledPairs, 9);

    const serialized = JSON.stringify(result.aggregate);
    assert.doesNotMatch(serialized,
      /project-[0-9]|\.p8|identity|cartSha256|screenSha256|sourceHashes|normalizedRomSha256/u);
    assert.equal(Object.hasOwn(result.aggregate, "details"), false);
    assert.equal(result.localDetails.details.length, 65);
    assert.ok(result.localDetails.details[0].identity.includes("project-"));

    await assert.rejects(writeExpandedFormatPairLocalDetails({
      outputPath: new URL("../conformance/phase-8e-pair-details.json", import.meta.url).pathname,
      projectRoot,
      report: result.localDetails,
    }), (error) => error instanceof ExpandedFormatPairError
      && error.code === "E_PATH_REPOSITORY");
    await writeExpandedFormatPairLocalDetails({
      outputPath: join(root, "local-details.json"),
      projectRoot,
      report: result.localDetails,
    });
  });
});

test("Phase 8E rejects environment drift, incomplete coverage and unreviewed available states", async () => {
  await withFixture(async ({ prepared, observationPaths, reviewPath }) => {
    const indexPath = join(prepared.outputRoot, "expanded-corpus-index.json");
    const second = JSON.parse(await readFile(observationPaths[1], "utf8"));
    second.environment.chromeVersion = "Google Chrome 152.0.0.0";
    await writeFile(observationPaths[1], `${JSON.stringify(second)}\n`);
    await assert.rejects(buildExpandedFormatPairQualification({
      indexPath,
      observationsPaths: observationPaths,
      reviewPath,
    }), (error) => error instanceof ExpandedFormatPairError
      && error.code === "E_ENVIRONMENT_DRIFT");

    second.environment = environment;
    second.entries.pop();
    await writeFile(observationPaths[1], `${JSON.stringify(second)}\n`);
    await assert.rejects(buildExpandedFormatPairQualification({
      indexPath,
      observationsPaths: observationPaths,
      reviewPath,
    }), (error) => error instanceof ExpandedFormatPairError
      && error.code === "E_OBSERVATION_COVERAGE");
  });
});

test("Phase 8E aggregate schema and scripts remain aggregate-only and Chrome-routed", async () => {
  const [schema, packageJson, runner] = await Promise.all([
    readFile(new URL("../../spec/compat/expanded-format-pair-aggregate-v1.schema.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../../package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../../tools/compat/aggregate-expanded-format-pairs.mjs", import.meta.url), "utf8"),
  ]);
  assert.equal(schema.properties.runner.const, "phase-8-expanded-format-pairs-v1");
  assert.equal(schema.properties.summary.properties.pairCount.const, 65);
  assert.equal(schema.properties.summary.properties.caseCount.const, 130);
  assert.match(packageJson.scripts["qualification:phase-8:pairs"] ?? "",
    /aggregate-expanded-format-pairs\.mjs/u);
  assert.match(runner, /values\.observations\?\.length !== 3/u);
  assert.match(runner, /local-details/u);
  const expandedChrome = await readFile(
    new URL("../../tools/compat/run-expanded-chrome-baseline.mjs", import.meta.url),
    "utf8",
  );
  assert.match(expandedChrome, /requireCleanPlayer: true/u);
});
