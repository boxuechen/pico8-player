import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertSafeLocalObservationsPath,
  assertSafeLocalOutputPath,
  buildLocalQualificationReport,
} from "./local-qualification-v1.mjs";

export const PLAYABILITY_RUNNER = "phase-8f-representative-playability-v1";
export const PLAYABILITY_CASES = 10;
export const CRITICAL_FLOW_CASES = 8;
export const DURATION_CASES = 2;
export const DURATION_SECONDS = 900;
export const DURATION_TICKS = 27_000;
export const PLAYABILITY_RISKS = Object.freeze([
  "graphics", "audio", "input", "persistence", "multicart", "complex-flow",
]);

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REVIEWED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

export class RepresentativePlayabilityError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "RepresentativePlayabilityError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new RepresentativePlayabilityError(code, message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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

async function readExternalJson(path, label, projectRoot) {
  if (String(path).includes("://")) fail("E_PATH_URL", `${label} must be a local path`);
  const unresolved = resolve(path);
  const metadata = await lstat(unresolved).catch((error) =>
    fail("E_INPUT_READ", `${label} could not be inspected: ${error.code ?? error.message}`));
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    fail("E_PATH_SYMLINK", `${label} must be a regular non-symlink file`);
  }
  const actual = await realpath(unresolved);
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

async function newExternalDirectory(path, inputs, projectRoot) {
  if (String(path).includes("://")) fail("E_PATH_URL", "output must be a local path");
  const unresolved = resolve(path);
  const parent = await realpath(dirname(unresolved)).catch((error) =>
    fail("E_OUTPUT_PARENT", `output parent could not be resolved: ${error.code ?? error.message}`));
  if (inside(resolve(projectRoot), parent)) fail("E_PATH_REPOSITORY", "output must be outside the repository");
  await mkdir(unresolved, { recursive: false }).catch((error) =>
    fail("E_OUTPUT_CREATE", `output must be a new directory: ${error.code ?? error.message}`));
  const actual = await realpath(unresolved);
  if (inputs.some((input) => inside(actual, input))) {
    fail("E_PATH_OVERLAP", "output and input paths must not overlap");
  }
  return actual;
}

async function writeJson(path, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await writeFile(path, bytes, { flag: "wx" });
  return { path, sha256: sha256(bytes) };
}

function validateExpandedIndex(index) {
  if (!isRecord(index) || !isRecord(index.canonical) || !Array.isArray(index.canonical.cases)
    || index.canonical.cases.length !== 100) {
    fail("E_INDEX", "expanded index must contain the frozen 100 canonical cases");
  }
  if (!isRecord(index.source) || index.source.revision === undefined) {
    fail("E_INDEX", "expanded index source revision is required");
  }
  assertSha256(index.corpusFingerprint, "expandedIndex.corpusFingerprint");
  const cases = new Map();
  for (const entry of index.canonical.cases) {
    if (!isRecord(entry)) fail("E_INDEX", "expanded canonical case is invalid");
    requiredString(entry.id, "expandedCase.id", 128);
    requiredString(entry.file, "expandedCase.file");
    assertSha256(entry.sha256, "expandedCase.sha256");
    if (cases.has(entry.id)) fail("E_INDEX", "expanded canonical ids must be unique");
    cases.set(entry.id, entry);
  }
  return cases;
}

async function loadCanonicalManifestEntries(expanded, expandedIndexPath, canonicalCases) {
  if (!Array.isArray(expanded.canonical.batches) || expanded.canonical.batches.length < 1) {
    fail("E_INDEX", "expanded index must retain canonical batch manifests");
  }
  const indexRoot = dirname(expandedIndexPath);
  const entries = new Map();
  for (const [position, batch] of expanded.canonical.batches.entries()) {
    if (!isRecord(batch) || basename(batch.file ?? "") !== batch.file) {
      fail("E_INDEX", `expanded canonical batch ${position + 1} is invalid`);
    }
    assertSha256(batch.sha256, `expanded.canonical.batches[${position}].sha256`);
    const batchPath = resolve(indexRoot, batch.file);
    if (!inside(indexRoot, batchPath)) fail("E_INDEX", "expanded canonical batch escaped index directory");
    const bytes = await readFile(batchPath).catch((error) =>
      fail("E_INPUT_READ", `canonical batch could not be read: ${error.code ?? error.message}`));
    if (sha256(bytes) !== batch.sha256) fail("E_INDEX", "expanded canonical batch hash mismatch");
    let manifest;
    try {
      manifest = JSON.parse(bytes.toString("utf8"));
    } catch {
      fail("E_JSON", "expanded canonical batch is not valid JSON");
    }
    if (!Array.isArray(manifest.entries) || manifest.entries.length !== batch.cases) {
      fail("E_INDEX", "expanded canonical batch case count drifted");
    }
    for (const entry of manifest.entries) {
      const canonical = canonicalCases.get(entry.id);
      if (canonical === undefined || canonical.sha256 !== entry.sha256 || entries.has(entry.id)) {
        fail("E_INDEX", "expanded canonical manifest entry drifted from the index");
      }
      entries.set(entry.id, entry);
    }
  }
  if (entries.size !== canonicalCases.size) {
    fail("E_INDEX", "expanded canonical manifests do not cover the frozen index");
  }
  return entries;
}

function validateTrace(trace, label) {
  exactKeys(trace, ["mode", "ticks", "stepMilliseconds", "inputs"], label);
  if (trace.mode !== "fixed-ticks" || !Number.isInteger(trace.ticks)
    || trace.ticks < 1 || trace.ticks > 36_000 || trace.stepMilliseconds !== 1000 / 30
    || !Array.isArray(trace.inputs)) {
    fail("E_TRACE", `${label} must be a bounded 30 Hz fixed-ticks trace`);
  }
  return trace;
}

function validatePlan(plan, canonicalCases, corpusFingerprint) {
  exactKeys(plan, ["schemaVersion", "corpusFingerprint", "entries"], "plan");
  if (plan.schemaVersion !== 1) fail("E_SCHEMA_VERSION", "plan.schemaVersion must be 1");
  if (plan.corpusFingerprint !== corpusFingerprint) fail("E_CORPUS_FINGERPRINT", "plan corpus drifted");
  if (!Array.isArray(plan.entries) || plan.entries.length !== PLAYABILITY_CASES) {
    fail("E_CASE_COUNT", "playability plan must contain exactly 10 cases");
  }
  const ids = new Set();
  let critical = 0;
  let duration = 0;
  const coveredRisks = new Set();
  const entries = plan.entries.map((entry, position) => {
    const label = `plan.entries[${position}]`;
    exactKeys(entry, [
      "id", "risks", "gate", "trace", "criticalFlow", "mainVerbs", "audio",
      "persistence",
    ], label);
    if (!canonicalCases.has(entry.id) || ids.has(entry.id)) fail("E_SELECTION", `${label}.id is invalid`);
    ids.add(entry.id);
    if (!Array.isArray(entry.risks) || entry.risks.length < 1
      || entry.risks.some((risk) => !PLAYABILITY_RISKS.includes(risk))) {
      fail("E_RISK_COVERAGE", `${label}.risks is invalid`);
    }
    for (const risk of entry.risks) coveredRisks.add(risk);
    if (!Array.isArray(entry.mainVerbs) || entry.mainVerbs.length < 1 || entry.mainVerbs.length > 16) {
      fail("E_MAIN_VERBS", `${label}.mainVerbs must contain 1..16 verbs`);
    }
    entry.mainVerbs.forEach((verb, index) => requiredString(verb, `${label}.mainVerbs[${index}]`, 128));
    requiredString(entry.criticalFlow, `${label}.criticalFlow`, 512);
    if (!["pass", "known-minor-difference", "not-applicable"].includes(entry.audio)
      || !["pass", "not-applicable"].includes(entry.persistence)) {
      fail("E_EXPECTATION", `${label} audio/persistence expectation is invalid`);
    }
    const trace = validateTrace(entry.trace, `${label}.trace`);
    if (entry.gate === "critical-flow") critical += 1;
    else if (entry.gate === "duration") {
      duration += 1;
      if (trace.ticks !== DURATION_TICKS) fail("E_DURATION", "duration cases require 27000 logical ticks");
    } else fail("E_GATE", `${label}.gate is invalid`);
    return { ...entry, risks: [...new Set(entry.risks)].sort() };
  });
  if (critical !== CRITICAL_FLOW_CASES || duration !== DURATION_CASES) {
    fail("E_GATE_DISTRIBUTION", "plan must contain exactly 8 critical-flow and 2 duration cases");
  }
  for (const risk of ["graphics", "audio", "input", "persistence"]) {
    if (!coveredRisks.has(risk)) fail("E_RISK_COVERAGE", `plan does not cover ${risk}`);
  }
  if (!coveredRisks.has("multicart") && !coveredRisks.has("complex-flow")) {
    fail("E_RISK_COVERAGE", "plan must cover multicart or complex-flow");
  }
  return entries;
}

export async function prepareRepresentativePlayability({
  expandedIndexPath,
  planPath,
  outputRoot,
  projectRoot = repositoryRoot,
}) {
  const [expanded, plan] = await Promise.all([
    readExternalJson(expandedIndexPath, "expanded index", projectRoot),
    readExternalJson(planPath, "playability plan", projectRoot),
  ]);
  const canonicalCases = validateExpandedIndex(expanded.value);
  const canonicalManifestEntries = await loadCanonicalManifestEntries(
    expanded.value,
    expanded.actual,
    canonicalCases,
  );
  const planEntries = validatePlan(plan.value, canonicalCases, expanded.value.corpusFingerprint);
  const externalOutput = await newExternalDirectory(outputRoot, [expanded.actual, plan.actual], projectRoot);
  const manifest = {
    $schema: "https://pico8-web-player.invalid/spec/compat/local-corpus-v1.schema.json",
    schemaVersion: 1,
    corpusId: "phase-8f-representative-playability-v1",
    policy: "developer-supplied-local-only",
    entries: planEntries.map((planned) => {
      const cart = canonicalManifestEntries.get(planned.id);
      return {
        ...cart,
        label: `representative case ${String(planEntries.indexOf(planned) + 1).padStart(2, "0")}`,
        trace: planned.trace,
      };
    }),
  };
  const manifestFile = "representative-playability-manifest.json";
  const manifestWritten = await writeJson(join(externalOutput, manifestFile), manifest);
  const selection = {
    $schema: "https://pico8-web-player.invalid/spec/compat/representative-playability-selection-v1.schema.json",
    schemaVersion: 1,
    runner: PLAYABILITY_RUNNER,
    targetRuntime: "PICO-8 v0.2.7",
    corpusFingerprint: expanded.value.corpusFingerprint,
    sourceRevision: expanded.value.source.revision,
    manifest: { file: manifestFile, cases: PLAYABILITY_CASES, sha256: manifestWritten.sha256 },
    entries: planEntries.map(({ trace: _trace, ...entry }) => entry),
  };
  const selectionPath = join(externalOutput, "representative-playability-selection.json");
  const selectionWritten = await writeJson(selectionPath, selection);
  return {
    outputRoot: externalOutput,
    manifestPath: manifestWritten.path,
    selectionPath,
    selectionSha256: selectionWritten.sha256,
    selection,
  };
}

function validateSelection(selection) {
  exactKeys(selection, [
    "$schema", "schemaVersion", "runner", "targetRuntime", "corpusFingerprint", "sourceRevision",
    "manifest", "entries",
  ], "selection");
  if (selection.schemaVersion !== 1 || selection.runner !== PLAYABILITY_RUNNER
    || selection.targetRuntime !== "PICO-8 v0.2.7") {
    fail("E_SCHEMA_VERSION", "selection must use the representative playability v1 contract");
  }
  assertSha256(selection.corpusFingerprint, "selection.corpusFingerprint");
  exactKeys(selection.manifest, ["file", "cases", "sha256"], "selection.manifest");
  if (basename(selection.manifest.file) !== selection.manifest.file
    || selection.manifest.cases !== PLAYABILITY_CASES) {
    fail("E_MANIFEST", "selection manifest is invalid");
  }
  assertSha256(selection.manifest.sha256, "selection.manifest.sha256");
  if (!Array.isArray(selection.entries) || selection.entries.length !== PLAYABILITY_CASES) {
    fail("E_CASE_COUNT", "selection must contain exactly 10 entries");
  }
  return new Map(selection.entries.map((entry) => [entry.id, entry]));
}

function validateReview(review, selectionIds) {
  exactKeys(review, ["schemaVersion", "reviewer", "reviewedAt", "findings", "entries"], "review");
  if (review.schemaVersion !== 1) fail("E_SCHEMA_VERSION", "review.schemaVersion must be 1");
  requiredString(review.reviewer, "review.reviewer", 128);
  if (!REVIEWED_AT_PATTERN.test(review.reviewedAt ?? "")) fail("E_REVIEW", "review.reviewedAt must be UTC");
  if (!Array.isArray(review.findings)) fail("E_REVIEW", "review.findings must be an array");
  const findings = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const [position, finding] of review.findings.entries()) {
    exactKeys(finding, ["severity", "status", "summary"], `review.findings[${position}]`);
    if (!Object.hasOwn(findings, finding.severity) || !["open", "closed"].includes(finding.status)) {
      fail("E_REVIEW", "finding severity/status is invalid");
    }
    requiredString(finding.summary, `review.findings[${position}].summary`, 256);
    if (finding.status === "open") findings[finding.severity] += 1;
  }
  if (findings.P0 !== 0 || findings.P1 !== 0) fail("E_OPEN_HIGH_SEVERITY", "open P0/P1 must be zero");
  if (!Array.isArray(review.entries) || review.entries.length !== PLAYABILITY_CASES) {
    fail("E_CASE_COUNT", "review must contain exactly 10 entries");
  }
  const entries = new Map();
  for (const [position, entry] of review.entries.entries()) {
    exactKeys(entry, [
      "id", "criticalFlowCompleted", "input", "visual", "audio", "persistence", "crashFree",
      "softLockFree",
    ], `review.entries[${position}]`);
    if (!selectionIds.has(entry.id) || entries.has(entry.id)) fail("E_REVIEW", "review id is invalid");
    if (typeof entry.criticalFlowCompleted !== "boolean"
      || !["pass", "not-applicable"].includes(entry.input)
      || !["pass", "known-minor-difference"].includes(entry.visual)
      || !["pass", "known-minor-difference", "not-applicable"].includes(entry.audio)
      || !["pass", "not-applicable"].includes(entry.persistence)
      || entry.crashFree !== true || entry.softLockFree !== true) {
      fail("E_REVIEW", "review outcomes are invalid");
    }
    entries.set(entry.id, entry);
  }
  return { entries, openFindings: findings };
}

async function selectionContext(selectionPath, projectRoot) {
  const parsed = await readExternalJson(selectionPath, "selection", projectRoot);
  const entries = validateSelection(parsed.value);
  const manifestPath = resolve(dirname(parsed.actual), parsed.value.manifest.file);
  if (!inside(dirname(parsed.actual), manifestPath)) fail("E_MANIFEST", "manifest escaped selection directory");
  const manifestBytes = await readFile(manifestPath).catch((error) =>
    fail("E_INPUT_READ", `manifest could not be read: ${error.code ?? error.message}`));
  if (sha256(manifestBytes) !== parsed.value.manifest.sha256) fail("E_MANIFEST_HASH", "manifest hash mismatch");
  return { parsed, entries, manifestPath };
}

export async function finalizeRepresentativePlayability({
  selectionPath,
  rawObservationsPath,
  reviewPath,
  screenshotsDirectory,
  outputPath,
  projectRoot = repositoryRoot,
}) {
  const [selection, review] = await Promise.all([
    selectionContext(selectionPath, projectRoot),
    readExternalJson(reviewPath, "review", projectRoot),
  ]);
  const validatedReview = validateReview(review.value, selection.entries);
  const rawReport = await buildLocalQualificationReport({
    manifestPath: selection.manifestPath,
    observationsPath: rawObservationsPath,
    projectRoot,
    minimumCases: PLAYABILITY_CASES,
  });
  const outputEntries = [];
  for (const [position, raw] of rawReport.entries.entries()) {
    const planned = selection.entries.get(raw.id);
    const reviewed = validatedReview.entries.get(raw.id);
    if (!raw.completed || raw.smokeOutcome !== "boots" || !["CU", "C2"].includes(raw.classification)) {
      fail("E_RAW_OBSERVATION", "every selected case must boot and complete before C2 review");
    }
    if (planned.gate === "duration" && raw.completedTicks !== DURATION_TICKS) {
      fail("E_DURATION", "duration case did not complete 27000 logical ticks");
    }
    if (planned.gate === "critical-flow" && reviewed.criticalFlowCompleted !== true) {
      fail("E_CRITICAL_FLOW", "critical-flow case was not completed");
    }
    if (planned.risks.includes("audio") && reviewed.audio === "not-applicable") {
      fail("E_RISK_REVIEW", "audio risk requires an audio conclusion");
    }
    if (planned.risks.includes("persistence") && reviewed.persistence !== "pass") {
      fail("E_RISK_REVIEW", "persistence risk requires a passing persistence conclusion");
    }
    const screenshotPath = resolve(screenshotsDirectory,
      `${String(position + 1).padStart(2, "0")}.png`);
    const screenshotMetadata = await lstat(screenshotPath).catch((error) =>
      fail("E_SCREENSHOT", `screenshot ${position + 1} could not be inspected: ${error.code ?? error.message}`));
    if (screenshotMetadata.isSymbolicLink() || !screenshotMetadata.isFile()) {
      fail("E_SCREENSHOT", "screenshots must be regular non-symlink files");
    }
    const screenshotBytes = await readFile(screenshotPath);
    const evidenceSha256 = sha256(Buffer.concat([
      screenshotBytes,
      Buffer.from(JSON.stringify({ raw, planned, reviewed })),
    ]));
    outputEntries.push({
      id: raw.id,
      completed: true,
      smokeOutcome: "boots",
      classification: "C2",
      failureCluster: null,
      completedTicks: raw.completedTicks,
      ...(raw.frameCount === undefined ? {} : { frameCount: raw.frameCount }),
      ...(raw.screenSha256 === undefined ? {} : { screenSha256: raw.screenSha256 }),
      ...(raw.nonBlackPixels === undefined ? {} : { nonBlackPixels: raw.nonBlackPixels }),
      ...(raw.distinctColors === undefined ? {} : { distinctColors: raw.distinctColors }),
      screenshotCaptured: true,
      playability: {
        gate: planned.gate,
        durationSeconds: Math.floor(raw.completedTicks / 30),
        criticalFlow: planned.criticalFlow,
        criticalFlowCompleted: reviewed.criticalFlowCompleted,
        mainVerbs: planned.mainVerbs,
        input: reviewed.input,
        visual: reviewed.visual,
        audio: reviewed.audio,
        persistence: reviewed.persistence,
        crashFree: true,
        softLockFree: true,
        reviewedAt: review.value.reviewedAt,
        reviewer: review.value.reviewer,
        evidenceSha256,
      },
    });
  }
  const output = { schemaVersion: 1, environment: rawReport.environment, entries: outputEntries };
  const safeOutput = assertSafeLocalObservationsPath(outputPath, projectRoot);
  await writeFile(safeOutput, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" });
  return { outputPath: safeOutput, observations: output, openFindings: validatedReview.openFindings };
}

export async function buildRepresentativePlayabilityAggregate({
  selectionPath,
  observationsPath,
  reviewPath,
  projectRoot = repositoryRoot,
}) {
  const [selection, review] = await Promise.all([
    selectionContext(selectionPath, projectRoot),
    readExternalJson(reviewPath, "review", projectRoot),
  ]);
  const validatedReview = validateReview(review.value, selection.entries);
  const report = await buildLocalQualificationReport({
    manifestPath: selection.manifestPath,
    observationsPath,
    projectRoot,
    minimumCases: PLAYABILITY_CASES,
  });
  if (report.entries.length !== PLAYABILITY_CASES
    || report.entries.some((entry) => !entry.completed || entry.classification !== "C2"
      || entry.screenshotCaptured !== true || entry.playability === undefined)) {
    fail("E_C2_COVERAGE", "all 10 selected cases must be reviewed C2 observations");
  }
  const gateCounts = { criticalFlow: 0, duration: 0 };
  const riskCoverage = Object.fromEntries(PLAYABILITY_RISKS.map((risk) => [risk, 0]));
  const outcomes = {
    inputPass: 0,
    visualPass: 0,
    visualKnownMinorDifference: 0,
    audioPass: 0,
    audioKnownMinorDifference: 0,
    audioNotApplicable: 0,
    persistencePass: 0,
    persistenceNotApplicable: 0,
    crashFree: 0,
    softLockFree: 0,
  };
  const evidenceHashes = [];
  for (const entry of report.entries) {
    const planned = selection.entries.get(entry.id);
    if (entry.playability.gate !== planned.gate) fail("E_GATE", "observation gate drifted from selection");
    if (planned.gate === "critical-flow") gateCounts.criticalFlow += 1;
    else gateCounts.duration += 1;
    for (const risk of planned.risks) riskCoverage[risk] += 1;
    if (entry.playability.input === "pass") outcomes.inputPass += 1;
    if (entry.playability.visual === "pass") outcomes.visualPass += 1;
    else outcomes.visualKnownMinorDifference += 1;
    if (entry.playability.audio === "pass") outcomes.audioPass += 1;
    else if (entry.playability.audio === "known-minor-difference") outcomes.audioKnownMinorDifference += 1;
    else outcomes.audioNotApplicable += 1;
    if (entry.playability.persistence === "pass") outcomes.persistencePass += 1;
    else outcomes.persistenceNotApplicable += 1;
    if (entry.playability.crashFree) outcomes.crashFree += 1;
    if (entry.playability.softLockFree) outcomes.softLockFree += 1;
    evidenceHashes.push(entry.playability.evidenceSha256);
  }
  if (gateCounts.criticalFlow !== CRITICAL_FLOW_CASES || gateCounts.duration !== DURATION_CASES) {
    fail("E_GATE_DISTRIBUTION", "C2 results must contain 8 critical-flow and 2 duration gates");
  }
  return {
    schemaVersion: 1,
    runner: PLAYABILITY_RUNNER,
    targetRuntime: "PICO-8 v0.2.7",
    corpusFingerprint: selection.parsed.value.corpusFingerprint,
    sourceRevision: selection.parsed.value.sourceRevision,
    environment: report.environment,
    summary: {
      caseCount: PLAYABILITY_CASES,
      c2CaseCount: PLAYABILITY_CASES,
      gateCounts,
      riskCoverage,
      outcomes,
      screenshotsReviewed: PLAYABILITY_CASES,
      openFindings: validatedReview.openFindings,
      evidenceSha256: sha256(Buffer.from([...evidenceHashes].sort().join(""))),
    },
  };
}

export async function writeRepresentativePlayabilityAggregate({
  outputPath,
  report,
  projectRoot = repositoryRoot,
}) {
  const safeOutput = assertSafeLocalOutputPath(outputPath, projectRoot);
  await writeFile(safeOutput, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return safeOutput;
}
