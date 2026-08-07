import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CART_RESULTS,
  FAILURE_CLUSTERS,
  buildLocalQualificationReport,
  assertSafeLocalOutputPath,
} from "./local-qualification-v1.mjs";
import { EXPANDED_CORPUS_RUNNER } from "./expanded-corpus-v1.mjs";

export const EXPANDED_SMOKE_RUNNER = "phase-8-expanded-smoke-v1";
export const EXPECTED_CANONICAL_CASES = 100;
export const EXPECTED_CANONICAL_BATCHES = 2;
export const EXPANDED_FAILURE_CLUSTERS = Object.freeze([
  ...FAILURE_CLUSTERS.slice(0, -1),
  "multicart",
  FAILURE_CLUSTERS.at(-1),
]);

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ID_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,127}$/u;

export class ExpandedSmokeError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "ExpandedSmokeError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ExpandedSmokeError(code, message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, allowed, label) {
  if (!isRecord(value)) fail("E_SCHEMA", `${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail("E_SCHEMA", `${label}.${key} is not allowed`);
  }
}

function inside(parent, candidate) {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function readExternalJson(path, label, projectRoot) {
  if (String(path).includes("://")) fail("E_PATH_URL", `${label} must be a local path`);
  let actual;
  try {
    actual = await realpath(resolve(path));
  } catch (error) {
    fail("E_INPUT_READ", `${label} could not be resolved: ${error.code ?? error.message}`);
  }
  if (inside(resolve(projectRoot), actual)) {
    fail("E_PATH_REPOSITORY", `${label} must be outside the project repository`);
  }
  let bytes;
  try {
    bytes = await readFile(actual);
  } catch (error) {
    fail("E_INPUT_READ", `${label} could not be read: ${error.code ?? error.message}`);
  }
  try {
    return { path: actual, bytes, value: JSON.parse(bytes.toString("utf8")) };
  } catch {
    fail("E_JSON", `${label} is not valid JSON`);
  }
}

function assertString(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
    fail("E_SCHEMA", `${label} must be a non-empty string`);
  }
}

function assertSha256(value, label) {
  if (!SHA256_PATTERN.test(value ?? "")) fail("E_SCHEMA", `${label} must be SHA-256`);
}

function validateCanonicalIndex(index) {
  exactKeys(index, [
    "$schema",
    "schemaVersion",
    "runner",
    "targetRuntime",
    "corpusFingerprint",
    "source",
    "inventory",
    "canonical",
    "formatPairs",
  ], "index");
  if (index.schemaVersion !== 1 || index.runner !== EXPANDED_CORPUS_RUNNER) {
    fail("E_SCHEMA_VERSION", "index must use the expanded corpus v1 contract");
  }
  if (index.targetRuntime !== "PICO-8 v0.2.7") fail("E_TARGET_VERSION", "index target must be PICO-8 v0.2.7");
  assertSha256(index.corpusFingerprint, "index.corpusFingerprint");
  exactKeys(index.source, [
    "repository",
    "revision",
    "label",
    "root",
    "permissionStatus",
    "redistributionAuthorized",
  ], "index.source");
  for (const field of ["repository", "revision", "label", "root"]) {
    assertString(index.source[field], `index.source.${field}`);
  }
  if (index.source.permissionStatus !== "caller-authorized-local-research"
    || index.source.redistributionAuthorized !== false) {
    fail("E_PERMISSION", "index source must remain caller-authorized, local-only and non-redistributable");
  }
  exactKeys(index.inventory, [
    "topLevelProjects",
    "cartFiles",
    "p8Files",
    "p8PngFiles",
    "byteUniqueFiles",
    "logicalIdentities",
    "canonicalLogicalCarts",
    "formatPairs",
  ], "index.inventory");
  if (index.inventory.canonicalLogicalCarts !== EXPECTED_CANONICAL_CASES) {
    fail("E_CASE_COUNT", `index must contain exactly ${EXPECTED_CANONICAL_CASES} canonical carts`);
  }
  exactKeys(index.canonical, ["cases", "duplicateCanonical", "batches"], "index.canonical");
  if (!Array.isArray(index.canonical.cases)
    || index.canonical.cases.length !== EXPECTED_CANONICAL_CASES) {
    fail("E_CASE_COUNT", `index.canonical.cases must contain ${EXPECTED_CANONICAL_CASES} cases`);
  }
  if (!Array.isArray(index.canonical.batches)
    || index.canonical.batches.length !== EXPECTED_CANONICAL_BATCHES) {
    fail("E_BATCH_COUNT", `index.canonical.batches must contain ${EXPECTED_CANONICAL_BATCHES} batches`);
  }
  const ids = new Set();
  for (const [position, entry] of index.canonical.cases.entries()) {
    const label = `index.canonical.cases[${position}]`;
    exactKeys(entry, ["id", "identity", "format", "file", "sha256"], label);
    if (!ID_PATTERN.test(entry.id ?? "")) fail("E_SCHEMA", `${label}.id is invalid`);
    if (ids.has(entry.id)) fail("E_DUPLICATE_ID", `${entry.id} occurs more than once in the index`);
    ids.add(entry.id);
    assertString(entry.identity, `${label}.identity`);
    if (!["p8", "p8.png"].includes(entry.format)) fail("E_SCHEMA", `${label}.format is invalid`);
    assertString(entry.file, `${label}.file`);
    assertSha256(entry.sha256, `${label}.sha256`);
  }
  let batchCases = 0;
  for (const [position, batch] of index.canonical.batches.entries()) {
    const label = `index.canonical.batches[${position}]`;
    exactKeys(batch, ["file", "cases", "sha256"], label);
    assertString(batch.file, `${label}.file`);
    if (basename(batch.file) !== batch.file || !/^canonical-batch-[0-9]{2}\.json$/u.test(batch.file)) {
      fail("E_BATCH_PATH", `${label}.file must be a local canonical batch basename`);
    }
    if (!Number.isInteger(batch.cases) || batch.cases < 12 || batch.cases > 64) {
      fail("E_BATCH_SIZE", `${label}.cases must be 12..64`);
    }
    assertSha256(batch.sha256, `${label}.sha256`);
    batchCases += batch.cases;
  }
  if (batchCases !== EXPECTED_CANONICAL_CASES) {
    fail("E_CASE_COUNT", "canonical batch counts must total 100");
  }
  return ids;
}

function sameEnvironment(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function buildExpandedSmokeAggregate({
  indexPath,
  observationsPaths,
  projectRoot = repositoryRoot,
}) {
  if (!Array.isArray(observationsPaths)
    || observationsPaths.length !== EXPECTED_CANONICAL_BATCHES) {
    fail("E_OBSERVATION_BATCH_COUNT", "exactly two observations files are required");
  }
  const parsed = await readExternalJson(indexPath, "index", projectRoot);
  const expectedIds = validateCanonicalIndex(parsed.value);
  const indexRoot = dirname(parsed.path);
  const reports = [];
  for (const [position, batch] of parsed.value.canonical.batches.entries()) {
    const manifestPath = resolve(indexRoot, batch.file);
    if (!inside(indexRoot, manifestPath)) fail("E_BATCH_PATH", "batch escaped the index directory");
    const manifestBytes = await readFile(manifestPath).catch((error) =>
      fail("E_INPUT_READ", `batch ${position + 1} could not be read: ${error.code ?? error.message}`));
    if (sha256(manifestBytes) !== batch.sha256) fail("E_BATCH_HASH", `batch ${position + 1} SHA-256 mismatch`);
    const report = await buildLocalQualificationReport({
      manifestPath,
      observationsPath: observationsPaths[position],
      projectRoot,
      minimumCases: 12,
    });
    if (report.corpus.manifestSha256 !== batch.sha256 || report.corpus.caseCount !== batch.cases) {
      fail("E_BATCH_CONTRACT", `batch ${position + 1} does not match the local index`);
    }
    reports.push(report);
  }
  const environment = reports[0].environment;
  if (!reports.every((report) => sameEnvironment(report.environment, environment))) {
    fail("E_ENVIRONMENT_DRIFT", "all batches must use the same player, WASM and Chrome environment");
  }
  const entries = reports.flatMap(({ entries: batchEntries }) => batchEntries);
  const observedIds = new Set(entries.map(({ id }) => id));
  if (entries.length !== EXPECTED_CANONICAL_CASES
    || observedIds.size !== EXPECTED_CANONICAL_CASES
    || [...expectedIds].some((id) => !observedIds.has(id))) {
    fail("E_OBSERVATION_COVERAGE", "observations must cover every canonical cart exactly once");
  }
  if (entries.some(({ sourceRevision }) => sourceRevision !== parsed.value.source.revision)) {
    fail("E_SOURCE_REVISION", "manifest source revision drifted from the expanded index");
  }
  if (entries.some(({ requestedTicks }) => requestedTicks !== 120)) {
    fail("E_TRACE", "every canonical smoke trace must request exactly 120 ticks");
  }
  if (entries.some(({ completed }) => !completed)) {
    fail("E_OBSERVATION_COVERAGE", "every canonical observation must complete");
  }

  const counts = Object.fromEntries(CART_RESULTS.map((result) => [result, 0]));
  const failureClusters = Object.fromEntries(EXPANDED_FAILURE_CLUSTERS.map((cluster) => [cluster, 0]));
  const smokeOutcomes = { boots: 0, fails: 0, notRun: 0 };
  let screenshotsCaptured = 0;
  let withFrame = 0;
  let nonBlack = 0;
  let blackOnly = 0;
  for (const entry of entries) {
    counts[entry.classification] += 1;
    if (entry.failureCluster !== null) failureClusters[entry.failureCluster] += 1;
    if (entry.smokeOutcome === "boots") smokeOutcomes.boots += 1;
    else if (entry.smokeOutcome === "fails") smokeOutcomes.fails += 1;
    else smokeOutcomes.notRun += 1;
    if (entry.screenshotCaptured === true) screenshotsCaptured += 1;
    if ((entry.frameCount ?? 0) > 0) withFrame += 1;
    if ((entry.nonBlackPixels ?? 0) > 0) nonBlack += 1;
    else blackOnly += 1;
  }
  if (screenshotsCaptured !== EXPECTED_CANONICAL_CASES) {
    fail("E_SCREENSHOT_COVERAGE", "every canonical observation must capture a local screenshot");
  }
  return {
    schemaVersion: 1,
    runner: EXPANDED_SMOKE_RUNNER,
    targetRuntime: "PICO-8 v0.2.7",
    corpusFingerprint: parsed.value.corpusFingerprint,
    sourceRevision: parsed.value.source.revision,
    environment,
    summary: {
      caseCount: EXPECTED_CANONICAL_CASES,
      completedCaseCount: EXPECTED_CANONICAL_CASES,
      smokeOutcomes,
      counts,
      failureClusters,
      framebuffer: { withFrame, nonBlack, blackOnly },
      screenshots: { captured: screenshotsCaptured, missing: 0 },
      resources: {
        completedBatchRuns: reports.length,
        infrastructureFailures: 0,
      },
    },
  };
}

export async function writeExpandedSmokeAggregate({ outputPath, report, projectRoot = repositoryRoot }) {
  const safePath = assertSafeLocalOutputPath(outputPath, projectRoot);
  await writeFile(safePath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return safePath;
}
