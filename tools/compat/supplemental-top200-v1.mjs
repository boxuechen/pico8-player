import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

import {
  CART_RESULTS,
  FAILURE_CLUSTERS,
  assertSafeLocalOutputPath,
  buildLocalQualificationReport,
} from "./local-qualification-v1.mjs";

export const TOP200_CORPUS_RUNNER = "phase-8f-supplemental-top200-corpus-v1";
export const TOP200_SMOKE_RUNNER = "phase-8f-supplemental-top200-smoke-v1";
export const TOP200_CASES = 200;
export const TOP200_BATCHES = 4;
export const TOP200_BATCH_CASES = 50;
export const TOP200_SMOKE_TICKS = 120;

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CART_FILE_PATTERN = /^carts\/[a-zA-Z0-9._-]+\.p8\.png$/u;

export class SupplementalTop200Error extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "SupplementalTop200Error";
    this.code = code;
  }
}

function fail(code, message) {
  throw new SupplementalTop200Error(code, message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableJsonHash(value) {
  return sha256(Buffer.from(JSON.stringify(value)));
}

function inside(parent, candidate) {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
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

function requiredString(value, label, maximum = 4096) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    fail("E_SCHEMA", `${label} must be a non-empty string`);
  }
  return value;
}

function assertSha256(value, label) {
  if (!SHA256_PATTERN.test(value ?? "")) fail("E_SCHEMA", `${label} must be SHA-256`);
}

async function externalDirectory(path, label, projectRoot) {
  if (String(path).includes("://")) fail("E_PATH_URL", `${label} must be a local path`);
  const unresolved = resolve(path);
  const metadata = await lstat(unresolved).catch((error) =>
    fail("E_INPUT_READ", `${label} could not be inspected: ${error.code ?? error.message}`));
  if (metadata.isSymbolicLink()) fail("E_PATH_SYMLINK", `${label} must not be a symbolic link`);
  if (!metadata.isDirectory()) fail("E_PATH_TYPE", `${label} must be a directory`);
  const actual = await realpath(unresolved);
  if (inside(resolve(projectRoot), actual)) {
    fail("E_PATH_REPOSITORY", `${label} must be outside the project repository`);
  }
  return actual;
}

async function newExternalDirectory(path, sourceRoot, projectRoot) {
  if (String(path).includes("://")) fail("E_PATH_URL", "output must be a local path");
  const unresolved = resolve(path);
  const parent = await realpath(dirname(unresolved)).catch((error) =>
    fail("E_OUTPUT_PARENT", `output parent could not be resolved: ${error.code ?? error.message}`));
  if (inside(resolve(projectRoot), parent)) {
    fail("E_PATH_REPOSITORY", "output must be outside the project repository");
  }
  await mkdir(unresolved, { recursive: false }).catch((error) =>
    fail("E_OUTPUT_CREATE", `output must be a new directory: ${error.code ?? error.message}`));
  const actual = await realpath(unresolved);
  if (inside(sourceRoot, actual) || inside(actual, sourceRoot)) {
    fail("E_PATH_OVERLAP", "source and output must not overlap");
  }
  return actual;
}

async function writeJson(path, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await writeFile(path, bytes, { flag: "wx" });
  return { bytes: bytes.length, sha256: sha256(bytes) };
}

function validateInventory(inventory) {
  exactKeys(inventory, ["schemaVersion", "source", "policy", "counts", "entries"], "inventory");
  if (inventory.schemaVersion !== 1) fail("E_SCHEMA_VERSION", "inventory.schemaVersion must be 1");
  exactKeys(inventory.source,
    ["url", "label", "rankingWindow", "pageDataDate", "fetchedAt", "htmlSha256"],
    "inventory.source");
  for (const field of ["label", "rankingWindow", "pageDataDate"]) {
    requiredString(inventory.source[field], `inventory.source.${field}`, 256);
  }
  assertSha256(inventory.source.htmlSha256, "inventory.source.htmlSha256");
  exactKeys(inventory.policy,
    ["localOnly", "trackedInput", "redistributionClaimed", "downloadOrigin"],
    "inventory.policy");
  if (inventory.policy.localOnly !== true || inventory.policy.trackedInput !== false
    || inventory.policy.redistributionClaimed !== false) {
    fail("E_POLICY", "inventory must remain local-only, untracked and non-redistributable");
  }
  exactKeys(inventory.counts, ["ranked", "downloaded", "no-public-p8png", "failed"],
    "inventory.counts");
  if (inventory.counts.ranked !== TOP200_CASES || inventory.counts.downloaded !== TOP200_CASES
    || inventory.counts["no-public-p8png"] !== 0 || inventory.counts.failed !== 0) {
    fail("E_CASE_COUNT", "inventory must contain exactly 200 downloaded carts and no gaps");
  }
  if (!Array.isArray(inventory.entries) || inventory.entries.length !== TOP200_CASES) {
    fail("E_CASE_COUNT", "inventory.entries must contain exactly 200 carts");
  }
}

async function validatedCases(sourceRoot, inventory) {
  const cases = [];
  const hashes = new Set();
  for (const [index, entry] of inventory.entries.entries()) {
    const label = `inventory.entries[${index}]`;
    exactKeys(entry, [
      "rank", "title", "developer", "rating", "pagePid", "bbsUrl", "status", "cartUrl",
      "file", "byteLength", "sha256",
    ], label);
    if (entry.rank !== index + 1 || entry.status !== "downloaded") {
      fail("E_RANK", `${label} must be the downloaded rank ${index + 1}`);
    }
    if (!CART_FILE_PATTERN.test(entry.file ?? "")) {
      fail("E_CART_PATH", `${label}.file must be a canonical carts/*.p8.png path`);
    }
    if (!Number.isInteger(entry.byteLength) || entry.byteLength < 1 || entry.byteLength > 1024 * 1024) {
      fail("E_CART_SIZE", `${label}.byteLength must be 1..1048576`);
    }
    assertSha256(entry.sha256, `${label}.sha256`);
    if (hashes.has(entry.sha256)) fail("E_DUPLICATE_CART", `${label}.sha256 is duplicated`);
    hashes.add(entry.sha256);
    const unresolved = resolve(sourceRoot, entry.file);
    if (!inside(sourceRoot, unresolved)) fail("E_CART_PATH", `${label}.file escaped source`);
    const metadata = await lstat(unresolved).catch((error) =>
      fail("E_INPUT_READ", `${label}.file could not be inspected: ${error.code ?? error.message}`));
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      fail("E_PATH_SYMLINK", `${label}.file must be a regular non-symlink file`);
    }
    const actual = await realpath(unresolved);
    if (!inside(sourceRoot, actual)) fail("E_CART_PATH", `${label}.file escaped source`);
    const bytes = await readFile(actual);
    if (bytes.length !== entry.byteLength || sha256(bytes) !== entry.sha256) {
      fail("E_CART_HASH", `${label}.file does not match the inventory`);
    }
    cases.push({ rank: entry.rank, sourcePath: actual, byteLength: bytes.length, sha256: entry.sha256 });
  }
  return cases;
}

export async function prepareSupplementalTop200({
  sourceRoot,
  outputRoot,
  projectRoot = repositoryRoot,
}) {
  const externalSource = await externalDirectory(sourceRoot, "source", projectRoot);
  const inventoryPath = join(externalSource, "inventory.json");
  const inventoryMetadata = await lstat(inventoryPath).catch((error) =>
    fail("E_INPUT_READ", `inventory could not be inspected: ${error.code ?? error.message}`));
  if (inventoryMetadata.isSymbolicLink() || !inventoryMetadata.isFile()) {
    fail("E_PATH_SYMLINK", "inventory must be a regular non-symlink file");
  }
  const inventoryBytes = await readFile(inventoryPath);
  let inventory;
  try {
    inventory = JSON.parse(inventoryBytes.toString("utf8"));
  } catch {
    fail("E_JSON", "inventory is not valid JSON");
  }
  validateInventory(inventory);
  const sourceCases = await validatedCases(externalSource, inventory);
  const externalOutput = await newExternalDirectory(outputRoot, externalSource, projectRoot);
  const cartsRoot = join(externalOutput, "carts");
  await mkdir(cartsRoot);

  const cases = [];
  for (const entry of sourceCases) {
    const number = String(entry.rank).padStart(3, "0");
    const outputName = `case-${number}.p8.png`;
    const outputPath = join(cartsRoot, outputName);
    await copyFile(entry.sourcePath, outputPath);
    cases.push({
      id: `phase8f/top200/case-${number}`,
      rank: entry.rank,
      file: `carts/${outputName}`,
      byteLength: entry.byteLength,
      sha256: entry.sha256,
    });
  }

  const sourceRevision = `snapshot-${inventory.source.pageDataDate}`;
  const batches = [];
  for (let batchIndex = 0; batchIndex < TOP200_BATCHES; batchIndex += 1) {
    const batchCases = cases.slice(batchIndex * TOP200_BATCH_CASES,
      (batchIndex + 1) * TOP200_BATCH_CASES);
    const manifest = {
      $schema: "https://pico8-web-player.invalid/spec/compat/local-corpus-v1.schema.json",
      schemaVersion: 1,
      corpusId: `phase-8f-supplemental-top200-batch-${String(batchIndex + 1).padStart(2, "0")}`,
      policy: "developer-supplied-local-only",
      entries: batchCases.map((entry) => ({
        id: entry.id,
        label: `supplemental case ${String(entry.rank).padStart(3, "0")}`,
        file: resolve(externalOutput, entry.file),
        sha256: entry.sha256,
        pico8Version: "0.2.7",
        source: {
          label: "caller-authorized Top 200 snapshot",
          revision: sourceRevision,
          permissionStatus: "caller-authorized-local-research",
          permissionBasis: "User authorized local compatibility research; redistribution is not authorized.",
        },
        trace: {
          mode: "fixed-ticks",
          ticks: TOP200_SMOKE_TICKS,
          stepMilliseconds: 1000 / 30,
          inputs: [],
        },
      })),
    };
    const file = `top200-batch-${String(batchIndex + 1).padStart(2, "0")}.json`;
    const written = await writeJson(join(externalOutput, file), manifest);
    batches.push({ file, cases: TOP200_BATCH_CASES, sha256: written.sha256 });
  }

  const corpusFingerprint = stableJsonHash({
    rankingWindow: inventory.source.rankingWindow,
    pageDataDate: inventory.source.pageDataDate,
    cases: cases.map(({ rank, byteLength, sha256: hash }) => ({ rank, byteLength, sha256: hash })),
  });
  const index = {
    $schema: "https://pico8-web-player.invalid/spec/compat/supplemental-top200-index-v1.schema.json",
    schemaVersion: 1,
    runner: TOP200_CORPUS_RUNNER,
    targetRuntime: "PICO-8 v0.2.7",
    corpusFingerprint,
    source: {
      label: inventory.source.label,
      rankingWindow: inventory.source.rankingWindow,
      pageDataDate: inventory.source.pageDataDate,
      inventorySha256: sha256(inventoryBytes),
      localOnly: true,
      redistributionAuthorized: false,
    },
    cases,
    batches,
  };
  const indexPath = join(externalOutput, "supplemental-top200-index.json");
  const written = await writeJson(indexPath, index);
  return { outputRoot: externalOutput, indexPath, indexSha256: written.sha256, index };
}

async function readExternalJson(path, label, projectRoot) {
  if (String(path).includes("://")) fail("E_PATH_URL", `${label} must be a local path`);
  const actual = await realpath(resolve(path)).catch((error) =>
    fail("E_INPUT_READ", `${label} could not be resolved: ${error.code ?? error.message}`));
  if (inside(resolve(projectRoot), actual)) {
    fail("E_PATH_REPOSITORY", `${label} must be outside the project repository`);
  }
  const bytes = await readFile(actual);
  try {
    return { actual, bytes, value: JSON.parse(bytes.toString("utf8")) };
  } catch {
    fail("E_JSON", `${label} is not valid JSON`);
  }
}

function validateIndex(index) {
  exactKeys(index, [
    "$schema", "schemaVersion", "runner", "targetRuntime", "corpusFingerprint", "source", "cases",
    "batches",
  ], "index");
  if (index.schemaVersion !== 1 || index.runner !== TOP200_CORPUS_RUNNER) {
    fail("E_SCHEMA_VERSION", "index must use the supplemental Top 200 v1 contract");
  }
  if (index.targetRuntime !== "PICO-8 v0.2.7") fail("E_TARGET_VERSION", "target must be PICO-8 v0.2.7");
  assertSha256(index.corpusFingerprint, "index.corpusFingerprint");
  exactKeys(index.source, [
    "label", "rankingWindow", "pageDataDate", "inventorySha256", "localOnly",
    "redistributionAuthorized",
  ], "index.source");
  if (index.source.localOnly !== true || index.source.redistributionAuthorized !== false) {
    fail("E_POLICY", "index source must remain local-only and non-redistributable");
  }
  if (!Array.isArray(index.cases) || index.cases.length !== TOP200_CASES) {
    fail("E_CASE_COUNT", "index must contain exactly 200 cases");
  }
  const ids = new Set();
  for (const [position, entry] of index.cases.entries()) {
    exactKeys(entry, ["id", "rank", "file", "byteLength", "sha256"], `index.cases[${position}]`);
    if (entry.rank !== position + 1 || ids.has(entry.id)) fail("E_RANK", "index rank or id is invalid");
    ids.add(entry.id);
    assertSha256(entry.sha256, `index.cases[${position}].sha256`);
  }
  if (!Array.isArray(index.batches) || index.batches.length !== TOP200_BATCHES) {
    fail("E_BATCH_COUNT", "index must contain exactly four batches");
  }
  for (const [position, batch] of index.batches.entries()) {
    exactKeys(batch, ["file", "cases", "sha256"], `index.batches[${position}]`);
    if (basename(batch.file) !== batch.file || batch.cases !== TOP200_BATCH_CASES) {
      fail("E_BATCH_SIZE", "every Top 200 batch must contain exactly 50 cases");
    }
    assertSha256(batch.sha256, `index.batches[${position}].sha256`);
  }
  return ids;
}

function sameEnvironment(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function buildSupplementalTop200Aggregate({
  indexPath,
  observationsPaths,
  projectRoot = repositoryRoot,
}) {
  if (!Array.isArray(observationsPaths) || observationsPaths.length !== TOP200_BATCHES) {
    fail("E_OBSERVATION_BATCH_COUNT", "exactly four observations files are required");
  }
  const parsed = await readExternalJson(indexPath, "index", projectRoot);
  const expectedIds = validateIndex(parsed.value);
  const indexRoot = dirname(parsed.actual);
  const reports = [];
  for (const [position, batch] of parsed.value.batches.entries()) {
    const manifestPath = resolve(indexRoot, batch.file);
    if (!inside(indexRoot, manifestPath)) fail("E_BATCH_PATH", "batch escaped index directory");
    const manifestBytes = await readFile(manifestPath).catch((error) =>
      fail("E_INPUT_READ", `batch could not be read: ${error.code ?? error.message}`));
    if (sha256(manifestBytes) !== batch.sha256) fail("E_BATCH_HASH", `batch ${position + 1} hash mismatch`);
    const report = await buildLocalQualificationReport({
      manifestPath,
      observationsPath: observationsPaths[position],
      projectRoot,
      minimumCases: TOP200_BATCH_CASES,
    });
    reports.push(report);
  }
  const environment = reports[0].environment;
  if (!reports.every((report) => sameEnvironment(report.environment, environment))) {
    fail("E_ENVIRONMENT_DRIFT", "all Top 200 batches must use the same environment");
  }
  const entries = reports.flatMap((report) => report.entries);
  const observedIds = new Set(entries.map((entry) => entry.id));
  if (entries.length !== TOP200_CASES || observedIds.size !== TOP200_CASES
    || [...expectedIds].some((id) => !observedIds.has(id))) {
    fail("E_OBSERVATION_COVERAGE", "observations must cover all 200 cases exactly once");
  }
  if (entries.some((entry) => !entry.completed || entry.requestedTicks !== TOP200_SMOKE_TICKS)) {
    fail("E_OBSERVATION_COVERAGE", "every case must complete the 120-tick smoke trace");
  }
  const counts = Object.fromEntries(CART_RESULTS.map((result) => [result, 0]));
  const failureClusters = Object.fromEntries(FAILURE_CLUSTERS.map((cluster) => [cluster, 0]));
  const smokeOutcomes = { boots: 0, fails: 0, notRun: 0 };
  const framebuffer = { withFrame: 0, nonBlack: 0, blackOnly: 0 };
  let screenshotsCaptured = 0;
  for (const entry of entries) {
    counts[entry.classification] += 1;
    if (entry.failureCluster !== null) failureClusters[entry.failureCluster] += 1;
    if (entry.smokeOutcome === "boots") smokeOutcomes.boots += 1;
    else if (entry.smokeOutcome === "fails") smokeOutcomes.fails += 1;
    else smokeOutcomes.notRun += 1;
    if ((entry.frameCount ?? 0) > 0) framebuffer.withFrame += 1;
    if ((entry.nonBlackPixels ?? 0) > 0) framebuffer.nonBlack += 1;
    else framebuffer.blackOnly += 1;
    if (entry.screenshotCaptured === true) screenshotsCaptured += 1;
  }
  if (screenshotsCaptured !== TOP200_CASES) {
    fail("E_SCREENSHOT_COVERAGE", "every supplemental case must capture a local screenshot");
  }
  return {
    schemaVersion: 1,
    runner: TOP200_SMOKE_RUNNER,
    targetRuntime: "PICO-8 v0.2.7",
    corpusFingerprint: parsed.value.corpusFingerprint,
    sourceSnapshot: parsed.value.source.pageDataDate,
    formalPhase8DenominatorChanged: false,
    environment,
    summary: {
      caseCount: TOP200_CASES,
      completedCaseCount: TOP200_CASES,
      smokeOutcomes,
      counts,
      failureClusters,
      framebuffer,
      screenshots: { captured: screenshotsCaptured, missing: TOP200_CASES - screenshotsCaptured },
      resources: { completedBatchRuns: reports.length, infrastructureFailures: 0 },
    },
  };
}

export async function writeSupplementalTop200Aggregate({ outputPath, report, projectRoot = repositoryRoot }) {
  const safePath = assertSafeLocalOutputPath(outputPath, projectRoot);
  await writeFile(safePath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return safePath;
}
