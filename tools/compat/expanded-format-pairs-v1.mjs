import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CartCodecError,
  P8PNG_CODE_OFFSET,
  decodeCart,
} from "@pico8-web/cart-codec";

import {
  FAILURE_CLUSTERS,
  assertSafeLocalOutputPath,
  buildLocalQualificationReport,
  loadLocalCorpusManifest,
} from "./local-qualification-v1.mjs";
import { EXPANDED_CORPUS_RUNNER } from "./expanded-corpus-v1.mjs";

export const EXPANDED_FORMAT_PAIR_RUNNER = "phase-8-expanded-format-pairs-v1";
export const EXPECTED_FORMAT_PAIRS = 65;
export const EXPECTED_PAIR_CASES = 130;
export const EXPECTED_PAIR_BATCHES = 3;
export const PAIR_RISKS = Object.freeze([
  "multicart",
  "graphics",
  "audio",
  "input",
  "persistence",
]);

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ID_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,127}$/u;
const REVIEWED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
const EXPECTED_BATCH_CASES = Object.freeze([44, 44, 42]);
const PAIR_FAILURE_CLUSTERS = Object.freeze([
  ...FAILURE_CLUSTERS.slice(0, -1),
  "multicart",
  FAILURE_CLUSTERS.at(-1),
]);
const RISK_PATTERNS = Object.freeze({
  multicart: /\b(?:load|reload|cstore)\s*\(/u,
  graphics: /\b(?:camera|circ|circfill|clip|cls|color|fillp|fget|fset|line|map|mget|mset|oval|ovalfill|pal|palt|pget|print|pset|rect|rectfill|sget|spr|sset|sspr|tline)\s*\(/u,
  audio: /\b(?:music|sfx)\s*\(/u,
  input: /\b(?:btn|btnp)\s*\(/u,
  persistence: /\b(?:cartdata|dget|dset)\s*\(/u,
});

export class ExpandedFormatPairError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "ExpandedFormatPairError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ExpandedFormatPairError(code, message);
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

function assertString(value, label, maximum = 4096) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    fail("E_SCHEMA", `${label} must be a non-empty string up to ${maximum} characters`);
  }
}

function assertSha256(value, label) {
  if (!SHA256_PATTERN.test(value ?? "")) fail("E_SCHEMA", `${label} must be SHA-256`);
}

async function readExternalJson(path, label, projectRoot) {
  if (String(path).includes("://")) fail("E_PATH_URL", `${label} must be a local path`);
  const actual = await realpath(resolve(path)).catch((error) =>
    fail("E_INPUT_READ", `${label} could not be resolved: ${error.code ?? error.message}`));
  if (inside(resolve(projectRoot), actual)) {
    fail("E_PATH_REPOSITORY", `${label} must be outside the project repository`);
  }
  const bytes = await readFile(actual).catch((error) =>
    fail("E_INPUT_READ", `${label} could not be read: ${error.code ?? error.message}`));
  try {
    return { path: actual, bytes, value: JSON.parse(bytes.toString("utf8")) };
  } catch {
    fail("E_JSON", `${label} is not valid JSON`);
  }
}

function validateIndex(index) {
  exactKeys(index, [
    "$schema", "schemaVersion", "runner", "targetRuntime", "corpusFingerprint",
    "source", "inventory", "canonical", "formatPairs",
  ], "index");
  if (index.schemaVersion !== 1 || index.runner !== EXPANDED_CORPUS_RUNNER) {
    fail("E_SCHEMA_VERSION", "index must use the expanded corpus v1 contract");
  }
  if (index.targetRuntime !== "PICO-8 v0.2.7") {
    fail("E_TARGET_VERSION", "index target must be PICO-8 v0.2.7");
  }
  assertSha256(index.corpusFingerprint, "index.corpusFingerprint");
  exactKeys(index.source, [
    "repository", "revision", "label", "root", "permissionStatus", "redistributionAuthorized",
  ], "index.source");
  for (const field of ["repository", "revision", "label", "root"]) {
    assertString(index.source[field], `index.source.${field}`);
  }
  if (index.source.permissionStatus !== "caller-authorized-local-research"
    || index.source.redistributionAuthorized !== false) {
    fail("E_PERMISSION", "index source must remain caller-authorized, local-only and non-redistributable");
  }
  exactKeys(index.inventory, [
    "topLevelProjects", "cartFiles", "p8Files", "p8PngFiles", "byteUniqueFiles",
    "logicalIdentities", "canonicalLogicalCarts", "formatPairs",
  ], "index.inventory");
  if (index.inventory.canonicalLogicalCarts !== 100
    || index.inventory.formatPairs !== EXPECTED_FORMAT_PAIRS) {
    fail("E_CASE_COUNT", "index must contain exactly 100 canonical carts and 65 format pairs");
  }
  exactKeys(index.formatPairs, ["pairs", "batches"], "index.formatPairs");
  if (!Array.isArray(index.formatPairs.pairs)
    || index.formatPairs.pairs.length !== EXPECTED_FORMAT_PAIRS) {
    fail("E_CASE_COUNT", `index.formatPairs.pairs must contain ${EXPECTED_FORMAT_PAIRS} pairs`);
  }
  const identities = new Set();
  const ids = new Set();
  const pairs = index.formatPairs.pairs.map((pair, position) => {
    const label = `index.formatPairs.pairs[${position}]`;
    exactKeys(pair, ["identity", "p8Id", "p8PngId", "p8Sha256", "p8PngSha256"], label);
    assertString(pair.identity, `${label}.identity`, 512);
    if (identities.has(pair.identity)) fail("E_DUPLICATE_PAIR", `${pair.identity} occurs more than once`);
    identities.add(pair.identity);
    for (const field of ["p8Id", "p8PngId"]) {
      if (!ID_PATTERN.test(pair[field] ?? "")) fail("E_SCHEMA", `${label}.${field} is invalid`);
      if (ids.has(pair[field])) fail("E_DUPLICATE_ID", `${pair[field]} occurs more than once`);
      ids.add(pair[field]);
    }
    if (!pair.p8Id.endsWith("/p8") || !pair.p8PngId.endsWith("/p8.png")) {
      fail("E_PAIR_ID", `${label} must name its two formats explicitly`);
    }
    assertSha256(pair.p8Sha256, `${label}.p8Sha256`);
    assertSha256(pair.p8PngSha256, `${label}.p8PngSha256`);
    return pair;
  });
  if (!Array.isArray(index.formatPairs.batches)
    || index.formatPairs.batches.length !== EXPECTED_PAIR_BATCHES) {
    fail("E_BATCH_COUNT", `index.formatPairs.batches must contain ${EXPECTED_PAIR_BATCHES} batches`);
  }
  let caseCount = 0;
  for (const [position, batch] of index.formatPairs.batches.entries()) {
    const label = `index.formatPairs.batches[${position}]`;
    exactKeys(batch, ["file", "cases", "sha256"], label);
    assertString(batch.file, `${label}.file`, 256);
    if (basename(batch.file) !== batch.file
      || !/^format-pairs-batch-[0-9]{2}\.json$/u.test(batch.file)) {
      fail("E_BATCH_PATH", `${label}.file must be a local format-pair batch basename`);
    }
    if (batch.cases !== EXPECTED_BATCH_CASES[position]) {
      fail("E_BATCH_SIZE", `${label}.cases must be ${EXPECTED_BATCH_CASES[position]}`);
    }
    assertSha256(batch.sha256, `${label}.sha256`);
    caseCount += batch.cases;
  }
  if (caseCount !== EXPECTED_PAIR_CASES) fail("E_CASE_COUNT", "pair batches must total 130 cases");
  return { pairs, ids };
}

function normalizedCode(code) {
  let end = code.length;
  while (end > 0 && [0x09, 0x0a, 0x0d, 0x20].includes(code[end - 1])) end -= 1;
  return code.subarray(0, end);
}

function signalText(code) {
  let text = "";
  for (const byte of code) text += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : " ";
  return text;
}

function riskSignals(code, hasBundle) {
  const text = signalText(code);
  return PAIR_RISKS.filter((risk) =>
    (risk === "multicart" && hasBundle) || RISK_PATTERNS[risk].test(text));
}

async function decodeEntry(entry) {
  const includeEntries = await Promise.all(entry.localCartBundle.map(async (bundleEntry) => [
    bundleEntry.ref,
    new Uint8Array(await readFile(bundleEntry.cartPath)),
  ]));
  const includes = new Map(includeEntries);
  try {
    const cart = decodeCart(new Uint8Array(await readFile(entry.cartPath)), {
      p8: { includeResolver: (specifier) => includes.get(specifier) },
    });
    return {
      success: true,
      format: cart.format,
      version: cart.version,
      normalizedRomSha256: sha256(cart.rom.subarray(0, P8PNG_CODE_OFFSET)),
      normalizedCodeSha256: sha256(normalizedCode(cart.code)),
      risks: riskSignals(cart.code, entry.localCartBundle.length > 0),
    };
  } catch (error) {
    return {
      success: false,
      faultCode: error instanceof CartCodecError ? error.code : "E_DECODE_UNKNOWN",
      risks: entry.localCartBundle.length > 0 ? ["multicart"] : [],
    };
  }
}

function expectedTermination(entry) {
  return entry.expectedTermination === undefined
    ? null
    : { kind: entry.expectedTermination.kind, faultCode: entry.expectedTermination.faultCode };
}

function runtimeSnapshot(entry, observation) {
  return {
    completed: observation.completed,
    smokeOutcome: observation.smokeOutcome,
    classification: observation.classification,
    failureCluster: observation.failureCluster,
    completedTicks: observation.completedTicks,
    faultCode: observation.faultCode ?? null,
    frameCount: observation.frameCount ?? 0,
    framebufferPresent: (observation.frameCount ?? 0) > 0,
    screenSha256: observation.screenSha256 ?? null,
    expectedTermination: expectedTermination(entry),
    expectedTerminationMatched: observation.expectedTerminationMatched === true,
    screenshotCaptured: observation.screenshotCaptured === true,
  };
}

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function comparePair(pair, leftEntry, rightEntry, leftDecode, rightDecode, observations) {
  const leftRuntime = runtimeSnapshot(leftEntry, observations.get(leftEntry.id));
  const rightRuntime = runtimeSnapshot(rightEntry, observations.get(rightEntry.id));
  const complete = leftRuntime.completed && rightRuntime.completed;
  const decodeStatusMatched = leftDecode.success === rightDecode.success
    && (leftDecode.success || leftDecode.faultCode === rightDecode.faultCode);
  const versionMatched = leftDecode.success && rightDecode.success
    ? leftDecode.version === rightDecode.version
    : null;
  const romMatched = leftDecode.success && rightDecode.success
    ? leftDecode.normalizedRomSha256 === rightDecode.normalizedRomSha256
    : null;
  const codeMatched = leftDecode.success && rightDecode.success
    ? leftDecode.normalizedCodeSha256 === rightDecode.normalizedCodeSha256
    : null;
  const contentMatched = decodeStatusMatched
    && versionMatched !== false && romMatched !== false && codeMatched !== false;
  const runtimeMatched = equal(leftRuntime, rightRuntime);
  const visualMatched = leftRuntime.framebufferPresent === rightRuntime.framebufferPresent
    && leftRuntime.screenSha256 === rightRuntime.screenSha256;
  const disposition = !complete
    ? "not-run"
    : contentMatched && runtimeMatched ? "matched" : "divergent";
  const risks = [...new Set([...leftDecode.risks, ...rightDecode.risks])].sort();
  const reasons = [];
  if (!decodeStatusMatched) reasons.push("decode-status");
  if (versionMatched === false) reasons.push("cart-version");
  if (romMatched === false) reasons.push("normalized-rom");
  if (codeMatched === false) reasons.push("normalized-code");
  if (!runtimeMatched) reasons.push("runtime");
  if (!visualMatched) reasons.push("framebuffer");
  return {
    identity: pair.identity,
    ids: { p8: pair.p8Id, p8Png: pair.p8PngId },
    sourceHashes: { p8: pair.p8Sha256, p8Png: pair.p8PngSha256 },
    disposition,
    reasons,
    decode: {
      p8: leftDecode,
      p8Png: rightDecode,
      statusMatched: decodeStatusMatched,
      versionMatched,
      romMatched,
      codeMatched,
      contentMatched,
    },
    runtime: { p8: leftRuntime, p8Png: rightRuntime, matched: runtimeMatched, visualMatched },
    risks,
  };
}

function sameEnvironment(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function emptyRiskSummary() {
  return Object.fromEntries(PAIR_RISKS.map((risk) => [risk, {
    signaledPairs: 0,
    completedPairs: 0,
    runtimeMatched: 0,
    runtimeDivergent: 0,
    notRun: 0,
  }]));
}

function reviewAvailability(details) {
  return {
    matchedBoot: details.filter(({ runtime }) =>
      runtime.matched && runtime.p8.smokeOutcome === "boots").length,
    fault: details.filter(({ runtime }) =>
      runtime.p8.smokeOutcome === "fails" || runtime.p8Png.smokeOutcome === "fails").length,
    divergent: details.filter(({ runtime }) => !runtime.matched || !runtime.visualMatched).length,
  };
}

function validateReview(review, availability) {
  exactKeys(review, [
    "schemaVersion", "reviewedAt", "reviewer", "evidenceSha256", "samples", "unavailable", "findings",
  ], "review");
  if (review.schemaVersion !== 1) fail("E_REVIEW", "review.schemaVersion must be 1");
  if (!REVIEWED_AT_PATTERN.test(review.reviewedAt ?? "")) {
    fail("E_REVIEW", "review.reviewedAt must be an ISO UTC timestamp");
  }
  assertString(review.reviewer, "review.reviewer", 128);
  assertSha256(review.evidenceSha256, "review.evidenceSha256");
  exactKeys(review.samples, ["matchedBoot", "fault", "divergent"], "review.samples");
  exactKeys(review.unavailable, ["fault", "divergent"], "review.unavailable");
  exactKeys(review.findings, ["P0", "P1", "P2", "P3"], "review.findings");
  for (const kind of ["matchedBoot", "fault", "divergent"]) {
    const count = review.samples[kind];
    if (!Number.isInteger(count) || count < 0 || count > availability[kind]) {
      fail("E_REVIEW", `review.samples.${kind} exceeds available local screenshots`);
    }
  }
  if (availability.matchedBoot > 0 && review.samples.matchedBoot < 1) {
    fail("E_REVIEW", "at least one matched boot screenshot must be reviewed");
  }
  for (const kind of ["fault", "divergent"]) {
    if (typeof review.unavailable[kind] !== "boolean") {
      fail("E_REVIEW", `review.unavailable.${kind} must be boolean`);
    }
    if (availability[kind] > 0
      && (review.samples[kind] < 1 || review.unavailable[kind])) {
      fail("E_REVIEW", `an available ${kind} screenshot must be reviewed`);
    }
    if (availability[kind] === 0
      && (review.samples[kind] !== 0 || !review.unavailable[kind])) {
      fail("E_REVIEW", `unavailable ${kind} screenshots must be marked not applicable`);
    }
  }
  for (const severity of ["P0", "P1", "P2", "P3"]) {
    if (!Number.isInteger(review.findings[severity])
      || review.findings[severity] < 0 || review.findings[severity] > 100) {
      fail("E_REVIEW", `review.findings.${severity} must be 0..100`);
    }
  }
  return {
    status: "complete",
    samples: { ...review.samples },
    unavailable: { ...review.unavailable },
    findings: { ...review.findings },
  };
}

function pendingReview(availability) {
  return {
    status: "pending",
    samples: { matchedBoot: 0, fault: 0, divergent: 0 },
    unavailable: { fault: availability.fault === 0, divergent: availability.divergent === 0 },
    findings: { P0: null, P1: null, P2: null, P3: null },
  };
}

export async function buildExpandedFormatPairQualification({
  indexPath,
  observationsPaths,
  reviewPath,
  projectRoot = repositoryRoot,
}) {
  if (!Array.isArray(observationsPaths)
    || observationsPaths.length !== EXPECTED_PAIR_BATCHES) {
    fail("E_OBSERVATION_BATCH_COUNT", "exactly three pair observation files are required");
  }
  const parsed = await readExternalJson(indexPath, "index", projectRoot);
  const validated = validateIndex(parsed.value);
  const indexRoot = dirname(parsed.path);
  const environments = [];
  const entries = new Map();
  const observations = new Map();
  for (const [position, batch] of parsed.value.formatPairs.batches.entries()) {
    const manifestPath = resolve(indexRoot, batch.file);
    if (!inside(indexRoot, manifestPath)) fail("E_BATCH_PATH", "batch escaped the index directory");
    const manifestBytes = await readFile(manifestPath).catch((error) =>
      fail("E_INPUT_READ", `batch ${position + 1} could not be read: ${error.code ?? error.message}`));
    if (sha256(manifestBytes) !== batch.sha256) {
      fail("E_BATCH_HASH", `batch ${position + 1} SHA-256 mismatch`);
    }
    const [corpus, report] = await Promise.all([
      loadLocalCorpusManifest({ manifestPath, projectRoot, minimumCases: 12 }),
      buildLocalQualificationReport({
        manifestPath,
        observationsPath: observationsPaths[position],
        projectRoot,
        minimumCases: 12,
      }),
    ]);
    if (report.corpus.manifestSha256 !== batch.sha256
      || report.corpus.caseCount !== batch.cases) {
      fail("E_BATCH_CONTRACT", `batch ${position + 1} does not match the local index`);
    }
    environments.push(report.environment);
    for (const entry of corpus.entries) entries.set(entry.id, entry);
    for (const observation of report.entries) observations.set(observation.id, observation);
  }
  if (!environments.every((environment) => sameEnvironment(environment, environments[0]))) {
    fail("E_ENVIRONMENT_DRIFT", "all pair batches must use the same player, WASM and Chrome environment");
  }
  if (entries.size !== EXPECTED_PAIR_CASES || observations.size !== EXPECTED_PAIR_CASES
    || [...validated.ids].some((id) => !entries.has(id) || !observations.has(id))) {
    fail("E_OBSERVATION_COVERAGE", "observations must cover both sides of every pair exactly once");
  }
  if ([...observations.values()].some(({ completed }) => !completed)) {
    fail("E_OBSERVATION_COVERAGE", "every pair observation must complete before aggregation");
  }
  if ([...entries.values()].some(({ source }) => source.revision !== parsed.value.source.revision)) {
    fail("E_SOURCE_REVISION", "manifest source revision drifted from the expanded index");
  }
  if ([...entries.values()].some(({ trace }) => trace.ticks !== 120)) {
    fail("E_TRACE", "every pair smoke trace must request exactly 120 ticks");
  }

  const details = [];
  for (const pair of validated.pairs) {
    const leftEntry = entries.get(pair.p8Id);
    const rightEntry = entries.get(pair.p8PngId);
    if (leftEntry.cartSha256 !== pair.p8Sha256
      || rightEntry.cartSha256 !== pair.p8PngSha256) {
      fail("E_PAIR_HASH", "pair index and manifest cart hashes disagree");
    }
    const [leftDecode, rightDecode] = await Promise.all([
      decodeEntry(leftEntry),
      decodeEntry(rightEntry),
    ]);
    details.push(comparePair(
      pair,
      leftEntry,
      rightEntry,
      leftDecode,
      rightDecode,
      observations,
    ));
  }

  const dispositions = { matched: 0, divergent: 0, notRun: 0 };
  const decode = {
    successfulSides: 0,
    faultedSides: 0,
    status: { matched: 0, divergent: 0 },
    version: { matched: 0, divergent: 0, notApplicable: 0 },
    normalizedRom: { matched: 0, divergent: 0, notApplicable: 0 },
    normalizedCode: { matched: 0, divergent: 0, notApplicable: 0 },
    content: { matched: 0, divergent: 0 },
  };
  const boot = { matched: 0, divergent: 0, notRun: 0 };
  const framebuffer = { matched: 0, divergent: 0 };
  const screenshots = { capturedSides: 0, missingSides: 0 };
  const failureClusters = Object.fromEntries(PAIR_FAILURE_CLUSTERS.map((cluster) => [cluster, 0]));
  const risks = emptyRiskSummary();
  let potentialRuntimeDefects = 0;
  for (const detail of details) {
    const dispositionKey = detail.disposition === "not-run" ? "notRun" : detail.disposition;
    dispositions[dispositionKey] += 1;
    for (const side of [detail.decode.p8, detail.decode.p8Png]) {
      if (side.success) decode.successfulSides += 1;
      else decode.faultedSides += 1;
    }
    decode.status[detail.decode.statusMatched ? "matched" : "divergent"] += 1;
    for (const [field, result] of [
      ["version", detail.decode.versionMatched],
      ["normalizedRom", detail.decode.romMatched],
      ["normalizedCode", detail.decode.codeMatched],
    ]) {
      decode[field][result === null ? "notApplicable" : result ? "matched" : "divergent"] += 1;
    }
    decode.content[detail.decode.contentMatched ? "matched" : "divergent"] += 1;
    if (detail.disposition === "not-run") boot.notRun += 1;
    else boot[detail.runtime.matched ? "matched" : "divergent"] += 1;
    framebuffer[detail.runtime.visualMatched ? "matched" : "divergent"] += 1;
    for (const side of [detail.runtime.p8, detail.runtime.p8Png]) {
      screenshots[side.screenshotCaptured ? "capturedSides" : "missingSides"] += 1;
    }
    for (const cluster of new Set([
      detail.runtime.p8.failureCluster,
      detail.runtime.p8Png.failureCluster,
    ].filter(Boolean))) failureClusters[cluster] += 1;
    if (detail.decode.contentMatched && !detail.runtime.matched) potentialRuntimeDefects += 1;
    for (const risk of detail.risks) {
      const summary = risks[risk];
      summary.signaledPairs += 1;
      if (detail.disposition === "not-run") summary.notRun += 1;
      else {
        summary.completedPairs += 1;
        summary[detail.runtime.matched ? "runtimeMatched" : "runtimeDivergent"] += 1;
      }
    }
  }
  const availability = reviewAvailability(details);
  const review = reviewPath === undefined
    ? pendingReview(availability)
    : validateReview((await readExternalJson(reviewPath, "review", projectRoot)).value, availability);
  const aggregate = {
    schemaVersion: 1,
    runner: EXPANDED_FORMAT_PAIR_RUNNER,
    targetRuntime: "PICO-8 v0.2.7",
    corpusFingerprint: parsed.value.corpusFingerprint,
    sourceRevision: parsed.value.source.revision,
    environment: environments[0],
    summary: {
      pairCount: EXPECTED_FORMAT_PAIRS,
      caseCount: EXPECTED_PAIR_CASES,
      completedPairCount: EXPECTED_FORMAT_PAIRS - dispositions.notRun,
      dispositions,
      decode,
      boot,
      framebuffer,
      screenshots,
      failureClusters,
      risks,
      potentialRuntimeDefects,
      review,
      resources: { completedBatchRuns: EXPECTED_PAIR_BATCHES, infrastructureFailures: dispositions.notRun },
      qualificationComplete: dispositions.notRun === 0
        && screenshots.missingSides === 0
        && review.status === "complete"
        && review.findings.P0 === 0
        && review.findings.P1 === 0,
    },
  };
  return {
    aggregate,
    localDetails: {
      schemaVersion: 1,
      runner: `${EXPANDED_FORMAT_PAIR_RUNNER}-local-details`,
      corpusFingerprint: parsed.value.corpusFingerprint,
      sourceRevision: parsed.value.source.revision,
      environment: environments[0],
      reviewAvailability: availability,
      details,
    },
  };
}

export async function writeExpandedFormatPairAggregate({
  outputPath,
  report,
  projectRoot = repositoryRoot,
}) {
  const safePath = assertSafeLocalOutputPath(outputPath, projectRoot);
  await writeFile(safePath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return safePath;
}

export async function writeExpandedFormatPairLocalDetails({
  outputPath,
  report,
  projectRoot = repositoryRoot,
}) {
  const unresolved = resolve(outputPath);
  const parent = await realpath(dirname(unresolved)).catch((error) =>
    fail("E_OUTPUT_PARENT", `local-details parent could not be resolved: ${error.code ?? error.message}`));
  if (inside(resolve(projectRoot), parent)) {
    fail("E_PATH_REPOSITORY", "local pair details must remain outside the project repository");
  }
  await writeFile(unresolved, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return unresolved;
}
