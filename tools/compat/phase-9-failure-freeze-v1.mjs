import { createHash } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const PHASE_9_FAILURE_FREEZE_RUNNER = "phase-9a-failure-freeze-v1";
export const PHASE_9_BASELINE_AGGREGATE_SHA256 =
  "54c352ff737973e944a773afe8396e30b012915ac40d5c3a0252932553505a7b";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const FAILURE_CLUSTERS = ["language", "timing", "unsupported-host-feature"];
const SIGNALS = ["pre-first-frame", "post-black-frame", "post-visible-frame"];

export class Phase9FailureFreezeError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "Phase9FailureFreezeError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new Phase9FailureFreezeError(code, message);
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

function integer(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail("E_SCHEMA", `${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function nonEmptyString(value, label, maximum = 512) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    fail("E_SCHEMA", `${label} must be a non-empty string`);
  }
  return value;
}

async function readExternalJson(path, label, projectRoot) {
  if (typeof path !== "string" || path.includes("://")) {
    fail("E_PATH_URL", `${label} must be a local filesystem path`);
  }
  const unresolved = resolve(path);
  const metadata = await lstat(unresolved).catch((error) =>
    fail("E_INPUT_READ", `${label} could not be inspected: ${error.code ?? error.message}`));
  if (metadata.isSymbolicLink()) fail("E_PATH_SYMLINK", `${label} must not be a symbolic link`);
  if (!metadata.isFile()) fail("E_PATH_TYPE", `${label} must be a regular file`);
  const actual = await realpath(unresolved);
  if (inside(resolve(projectRoot), actual)) {
    fail("E_PATH_REPOSITORY", `${label} must stay outside the repository and ref directory`);
  }
  const bytes = await readFile(actual);
  try {
    return { actual, bytes, value: JSON.parse(bytes.toString("utf8")) };
  } catch {
    fail("E_JSON", `${label} is not valid JSON`);
  }
}

function validateEnvironment(value, label) {
  exactKeys(value, ["target", "playerCommit", "runtimeWasmSha256", "chromeVersion"], label);
  if (value.target !== "chrome-production") fail("E_ENVIRONMENT", `${label}.target drifted`);
  nonEmptyString(value.playerCommit, `${label}.playerCommit`, 40);
  if (!SHA256_PATTERN.test(value.runtimeWasmSha256 ?? "")) {
    fail("E_ENVIRONMENT", `${label}.runtimeWasmSha256 must be SHA-256`);
  }
  if (!/^(Google Chrome|Chromium) [0-9]/u.test(value.chromeVersion ?? "")) {
    fail("E_ENVIRONMENT", `${label}.chromeVersion must identify Chrome or Chromium`);
  }
}

function validateAggregate(aggregate) {
  if (!isRecord(aggregate) || aggregate.schemaVersion !== 1
    || aggregate.runner !== "phase-8f-supplemental-top200-smoke-v1"
    || aggregate.targetRuntime !== "PICO-8 v0.2.7") {
    fail("E_AGGREGATE_SCHEMA", "aggregate must be the Phase 8F supplemental Top 200 v1 report");
  }
  validateEnvironment(aggregate.environment, "aggregate.environment");
  const summary = aggregate.summary;
  if (!isRecord(summary) || summary.caseCount !== 200 || summary.completedCaseCount !== 200) {
    fail("E_AGGREGATE_COVERAGE", "aggregate must cover exactly 200 completed cases");
  }
  if (JSON.stringify(summary.smokeOutcomes) !== JSON.stringify({ boots: 149, fails: 51, notRun: 0 })) {
    fail("E_AGGREGATE_OUTCOMES", "aggregate must preserve the 149/51/0 baseline");
  }
  const expectedClusters = {
    parse: 0,
    language: 45,
    ram: 0,
    graphics: 0,
    audio: 0,
    input: 0,
    timing: 5,
    persistence: 0,
    "unsupported-host-feature": 1,
  };
  if (JSON.stringify(summary.failureClusters) !== JSON.stringify(expectedClusters)) {
    fail("E_AGGREGATE_CLUSTERS", "aggregate failure clusters must preserve the 45/5/1 baseline");
  }
}

function validateObservationReport(report, label) {
  exactKeys(report, ["$schema", "schemaVersion", "environment", "entries"], label);
  if (report.schemaVersion !== 1) fail("E_SCHEMA_VERSION", `${label}.schemaVersion must be 1`);
  validateEnvironment(report.environment, `${label}.environment`);
  if (!Array.isArray(report.entries) || report.entries.length !== 50) {
    fail("E_OBSERVATION_BATCH", `${label}.entries must contain exactly 50 cases`);
  }
  for (const [index, entry] of report.entries.entries()) {
    const entryLabel = `${label}.entries[${index}]`;
    if (!isRecord(entry)) fail("E_SCHEMA", `${entryLabel} must be an object`);
    nonEmptyString(entry.id, `${entryLabel}.id`, 128);
    if (entry.completed !== true) fail("E_OBSERVATION_COVERAGE", `${entryLabel} did not complete`);
    if (!["boots", "fails", "not-run"].includes(entry.smokeOutcome)) {
      fail("E_SCHEMA", `${entryLabel}.smokeOutcome is invalid`);
    }
    integer(entry.completedTicks, `${entryLabel}.completedTicks`, 0, 120);
    if (entry.frameCount !== undefined) integer(entry.frameCount, `${entryLabel}.frameCount`, 0, 120);
    if (entry.nonBlackPixels !== undefined) {
      integer(entry.nonBlackPixels, `${entryLabel}.nonBlackPixels`, 0, 16384);
    }
    if (entry.screenSha256 !== undefined && entry.screenSha256 !== null
      && !SHA256_PATTERN.test(entry.screenSha256)) {
      fail("E_SCHEMA", `${entryLabel}.screenSha256 must be SHA-256 or null`);
    }
    if (entry.smokeOutcome === "fails") {
      if (!FAILURE_CLUSTERS.includes(entry.failureCluster)) {
        fail("E_FAILURE_CLUSTER", `${entryLabel}.failureCluster is outside the Phase 9 backlog`);
      }
      nonEmptyString(entry.faultCode, `${entryLabel}.faultCode`, 128);
      nonEmptyString(entry.faultMessage, `${entryLabel}.faultMessage`, 512);
    }
  }
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function signalFor(entry) {
  if ((entry.frameCount ?? 0) === 0) return "pre-first-frame";
  return (entry.nonBlackPixels ?? 0) > 0 ? "post-visible-frame" : "post-black-frame";
}

const candidate = ({
  id,
  ownerPhase,
  cluster,
  faultCodes,
  stage,
  ownerBoundary,
  hypothesis,
  fixture,
  purpose,
  expectedBehavior,
  command,
  evidenceGap,
  matches,
}) => ({
  id,
  ownerPhase,
  cluster,
  faultCodes,
  stage,
  ownerBoundary,
  hypothesis,
  reproducerPlan: { fixture, purpose, expectedBehavior, command },
  evidenceGap,
  matches,
});

const DEFINITIONS = [
  candidate({
    id: "language-boolean-value-semantics",
    ownerPhase: "9B",
    cluster: "language",
    faultCodes: ["E_VM_RUNTIME"],
    stage: "vm-value-semantics",
    ownerBoundary: "wasm/z8lua dialect and value semantics",
    hypothesis: "a shared value-semantics gap propagates boolean values into numeric, string or sequence operations",
    fixture: "tests/fixtures/phase-9/language-boolean-value-semantics.p8",
    purpose: "exercise comparison, arithmetic, length, print and random-call value semantics without third-party code",
    expectedBehavior: "the project-authored cart completes deterministic assertions without a VM type fault",
    command: "pnpm run test:phase-9b",
    evidenceGap: "the exact operator or value-conversion source remains unconfirmed until the minimal real-WASM reproducer isolates it",
    matches: (entry) => entry.faultCode === "E_VM_RUNTIME" && /\bboolean\b/u.test(entry.faultMessage),
  }),
  candidate({
    id: "language-poke-varargs-semantics",
    ownerPhase: "9B",
    cluster: "language",
    faultCodes: ["E_VM_RUNTIME"],
    stage: "host-api-dispatch",
    ownerBoundary: "WASM host bindings for poke() argument expansion and coercion",
    hypothesis: "poke() vararg expansion or absent-value handling diverges from the target dialect",
    fixture: "tests/fixtures/phase-9/language-poke-varargs-semantics.p8",
    purpose: "cover finite table expansion, absent values and the documented write range using project-owned bytes",
    expectedBehavior: "valid calls write deterministically and invalid calls follow the official boundary without bridge corruption",
    command: "pnpm run test:phase-9b",
    evidenceGap: "the observations do not distinguish caller-side expansion from bridge-side coercion",
    matches: (entry) => entry.faultCode === "E_VM_RUNTIME"
      && (/bad argument #2 to 'poke'/u.test(entry.faultMessage)
        || /poke value count exceeds/u.test(entry.faultMessage)),
  }),
  candidate({
    id: "language-extcmd-library-surface",
    ownerPhase: "9B",
    cluster: "language",
    faultCodes: ["E_VM_RUNTIME"],
    stage: "vm-library-surface",
    ownerBoundary: "PICO-8 library surface and bounded host command policy",
    hypothesis: "the target library surface does not currently expose the in-profile extcmd() behavior",
    fixture: "tests/fixtures/phase-9/language-extcmd-library-surface.p8",
    purpose: "call only explicitly accepted, no-authority extcmd() operations from original test code",
    expectedBehavior: "accepted operations return deterministically and disallowed operations fail closed",
    command: "pnpm run test:phase-9b",
    evidenceGap: "the external observations do not identify which command tokens are required or whether each is in profile",
    matches: (entry) => entry.faultCode === "E_VM_RUNTIME"
      && /global 'extcmd' \(a nil value\)/u.test(entry.faultMessage),
  }),
  candidate({
    id: "language-cartdata-index-boundary",
    ownerPhase: "9B",
    cluster: "language",
    faultCodes: ["E_HOST_API"],
    stage: "host-api-dispatch",
    ownerBoundary: "RuntimeCore persistence API and WASM host argument contract",
    hypothesis: "cartdata() index conversion or accepted index range diverges before persistence is selected",
    fixture: "tests/fixtures/phase-9/language-cartdata-index-boundary.p8",
    purpose: "exercise boundary, fractional and fixed-point cartdata() indices with isolated project namespaces",
    expectedBehavior: "documented indices select deterministic storage and invalid indices fail without widening authority",
    command: "pnpm run test:phase-9b",
    evidenceGap: "the redacted observations preserve the boundary fault but not the original argument shape",
    matches: (entry) => entry.faultCode === "E_HOST_API"
      && /cartdata index must be between/u.test(entry.faultMessage),
  }),
  candidate({
    id: "language-cls-color-coercion",
    ownerPhase: "9B",
    cluster: "language",
    faultCodes: ["E_VM_RUNTIME"],
    stage: "host-api-dispatch",
    ownerBoundary: "WASM host binding coercion for cls()",
    hypothesis: "cls() argument conversion rejects a target-dialect value before the graphics owner receives it",
    fixture: "tests/fixtures/phase-9/language-cls-color-coercion.p8",
    purpose: "exercise omitted, numeric and coercible color values in an original graphics fixture",
    expectedBehavior: "accepted color inputs clear the framebuffer to the documented palette index",
    command: "pnpm run test:phase-9b",
    evidenceGap: "the official acceptance rule for the observed non-number value still needs a minimal comparison",
    matches: (entry) => entry.faultCode === "E_VM_RUNTIME"
      && /bad argument #1 to 'cls'/u.test(entry.faultMessage),
  }),
  candidate({
    id: "language-missing-global-library-surface",
    ownerPhase: "9B",
    cluster: "language",
    faultCodes: ["E_VM_RUNTIME"],
    stage: "vm-library-surface",
    ownerBoundary: "z8lua prelude and generated PICO-8 API bindings",
    hypothesis: "one or more required global library entries are absent or a declaration was not installed",
    fixture: "tests/fixtures/phase-9/language-missing-global-library-surface.p8",
    purpose: "probe the accepted global library inventory and declaration lifetime using only project-authored helpers",
    expectedBehavior: "official globals exist and project declarations retain the target scope and lifetime",
    command: "pnpm run test:phase-9b",
    evidenceGap: "the observations cannot distinguish a missing official builtin from an earlier declaration or scope failure",
    matches: (entry) => entry.faultCode === "E_VM_RUNTIME"
      && /global '(flr|pack|_set_fps|mapdraw)' \(a nil value\)/u.test(entry.faultMessage),
  }),
  candidate({
    id: "language-parser-if-do-shorthand",
    ownerPhase: "9B",
    cluster: "language",
    faultCodes: ["E_VM_SYNTAX"],
    stage: "parser-dialect",
    ownerBoundary: "z8lua PICO-8 source preprocessor",
    hypothesis: "the preprocessor does not lower an accepted conditional do-form before Lua parsing",
    fixture: "tests/fixtures/phase-9/language-parser-if-do-shorthand.p8",
    purpose: "cover conditional do/end forms and nested blocks in a project-authored parser fixture",
    expectedBehavior: "accepted PICO-8 syntax lowers to valid Lua with unchanged control flow",
    command: "pnpm run test:phase-9b",
    evidenceGap: "the exact accepted grammar must be confirmed against the official v0.2.7 syntax section",
    matches: (entry) => entry.faultCode === "E_VM_SYNTAX"
      && /'then' expected near 'do'/u.test(entry.faultMessage),
  }),
  candidate({
    id: "language-vm-memory-pressure",
    ownerPhase: "9B",
    cluster: "language",
    faultCodes: ["E_VM_OOM"],
    stage: "vm-memory",
    ownerBoundary: "z8lua allocator and RuntimeCore session limits",
    hypothesis: "a finite boot workload crosses the current VM memory ceiling or retains temporary allocations",
    fixture: "tests/fixtures/phase-9/language-vm-memory-pressure.p8",
    purpose: "allocate and release bounded project-owned tables and strings around the observed limit",
    expectedBehavior: "finite in-profile workloads complete without leaking while explicit runaway allocation still fails closed",
    command: "pnpm run test:phase-9b",
    evidenceGap: "a minimal reproducer must separate a compatibility ceiling from a legitimate runaway allocation",
    matches: (entry) => entry.faultCode === "E_VM_OOM",
  }),
  candidate({
    id: "language-nil-arithmetic-flow",
    ownerPhase: "9B",
    cluster: "language",
    faultCodes: ["E_VM_RUNTIME"],
    stage: "vm-value-semantics",
    ownerBoundary: "z8lua dialect lowering and local assignment semantics",
    hypothesis: "an earlier expression, assignment or control-flow lowering leaves a numeric local absent",
    fixture: "tests/fixtures/phase-9/language-nil-arithmetic-flow.p8",
    purpose: "combine multi-assignment, shorthand control flow and arithmetic in an original deterministic fixture",
    expectedBehavior: "locals retain target-dialect values through the lowered control flow",
    command: "pnpm run test:phase-9b",
    evidenceGap: "the final nil arithmetic fault is downstream evidence and does not identify the earlier divergence",
    matches: (entry) => entry.faultCode === "E_VM_RUNTIME"
      && /attempt to perform arithmetic on local '.+' \(a nil value\)/u.test(entry.faultMessage),
  }),
  candidate({
    id: "language-parser-question-print-shorthand",
    ownerPhase: "9B",
    cluster: "language",
    faultCodes: ["E_VM_SYNTAX"],
    stage: "parser-dialect",
    ownerBoundary: "z8lua PICO-8 source preprocessor",
    hypothesis: "the line-leading question-mark print shorthand reaches Lua without lowering",
    fixture: "tests/fixtures/phase-9/language-parser-question-print-shorthand.p8",
    purpose: "cover line-leading print shorthand, expressions and comments in original source",
    expectedBehavior: "the shorthand produces the same call and evaluation order as print()",
    command: "pnpm run test:phase-9b",
    evidenceGap: "the source position and surrounding lexical context remain to be isolated by the minimal fixture",
    matches: (entry) => entry.faultCode === "E_VM_SYNTAX"
      && /unexpected symbol near \?/u.test(entry.faultMessage),
  }),
  candidate({
    id: "language-all-iteration-semantics",
    ownerPhase: "9B",
    cluster: "language",
    faultCodes: ["E_VM_RUNTIME"],
    stage: "vm-library-surface",
    ownerBoundary: "z8lua PICO-8 collection helpers",
    hypothesis: "all() argument/default or iterator semantics diverge before collection traversal",
    fixture: "tests/fixtures/phase-9/language-all-iteration-semantics.p8",
    purpose: "exercise all() over lists, empty values and mutation using project-authored tables",
    expectedBehavior: "accepted collections iterate in target order and invalid inputs follow the official rule",
    command: "pnpm run test:phase-9b",
    evidenceGap: "the observations do not preserve whether the invalid value was produced by all() or an earlier expression",
    matches: (entry) => entry.faultCode === "E_VM_RUNTIME"
      && /bad argument #1 to 'all'/u.test(entry.faultMessage),
  }),
  candidate({
    id: "language-runtime-bootstrap-invariant",
    ownerPhase: "9B",
    cluster: "language",
    faultCodes: ["E_INVARIANT"],
    stage: "runtime-bootstrap",
    ownerBoundary: "z8lua VM adapter boot and fault translation",
    hypothesis: "a guest bootstrap condition escapes as a raw WASM trap instead of a structured VM result",
    fixture: "tests/fixtures/phase-9/language-runtime-bootstrap-invariant.p8",
    purpose: "exercise bounded bootstrap traps and structured error translation from original source",
    expectedBehavior: "supported boot completes and unsupported guest behavior returns a stable typed fault",
    command: "pnpm run test:phase-9b",
    evidenceGap: "the generic unreachable trap contains no guest-level cause and requires narrowed real-WASM instrumentation",
    matches: (entry) => entry.faultCode === "E_INVARIANT"
      && /runtime boot threw: unreachable/u.test(entry.faultMessage),
  }),
  candidate({
    id: "language-rnd-string-semantics",
    ownerPhase: "9B",
    cluster: "language",
    faultCodes: ["E_VM_RUNTIME"],
    stage: "vm-library-surface",
    ownerBoundary: "z8lua PICO-8 random helper",
    hypothesis: "rnd() sequence/string overload or argument conversion is absent",
    fixture: "tests/fixtures/phase-9/language-rnd-string-semantics.p8",
    purpose: "exercise deterministic numeric, list and string random selection with a fixed seed",
    expectedBehavior: "accepted overloads return deterministic members without coercing the container incorrectly",
    command: "pnpm run test:phase-9b",
    evidenceGap: "the accepted string overload and return representation need official v0.2.7 confirmation",
    matches: (entry) => entry.faultCode === "E_VM_RUNTIME"
      && /bad argument #1 to 'rnd' \(number expected, got string\)/u.test(entry.faultMessage),
  }),
  candidate({
    id: "timing-instruction-budget-boundary",
    ownerPhase: "9C",
    cluster: "timing",
    faultCodes: ["E_VM_INSTRUCTION_BUDGET"],
    stage: "scheduler-instruction-budget",
    ownerBoundary: "RuntimeCore scheduler and z8lua instruction hook",
    hypothesis: "finite startup or frame work crosses the current slice budget before a valid boundary",
    fixture: "tests/fixtures/phase-9/timing-instruction-budget-boundary.p8",
    purpose: "measure finite and intentionally runaway loops against deterministic startup and frame slices",
    expectedBehavior: "finite in-profile work reaches the next boundary while a no-yield runaway still faults deterministically",
    command: "pnpm run test:phase-9c",
    evidenceGap: "the observations alone cannot distinguish legitimate heavy work from a guest infinite loop",
    matches: (entry) => entry.faultCode === "E_VM_INSTRUCTION_BUDGET",
  }),
  candidate({
    id: "host-external-cartdata-request",
    ownerPhase: "9D",
    cluster: "unsupported-host-feature",
    faultCodes: ["E_HOST_REQUEST"],
    stage: "host-request-boundary",
    ownerBoundary: "RuntimeCore host request contract and caller-authorized cart repository",
    hypothesis: "an external cart-data request has no in-profile bounded resolution behavior",
    fixture: "tests/fixtures/phase-9/host-external-cartdata-request.p8",
    purpose: "request project-owned external cart data through the existing accepted resolver boundary",
    expectedBehavior: "accepted repository keys resolve locally and missing or unauthorized keys fail without network or filesystem authority",
    command: "pnpm run test:phase-9d",
    evidenceGap: "the local observation proves the request class but not whether the requested key exists in the accepted repository",
    matches: (entry) => entry.faultCode === "E_HOST_REQUEST"
      && /external cart-data request failed/u.test(entry.faultMessage),
  }),
];

function resultCandidate(definition, entries) {
  const signals = Object.fromEntries(SIGNALS.map((signal) => [signal, 0]));
  let minimumTick = Number.MAX_SAFE_INTEGER;
  let maximumTick = 0;
  for (const entry of entries) {
    signals[signalFor(entry)] += 1;
    minimumTick = Math.min(minimumTick, entry.completedTicks);
    maximumTick = Math.max(maximumTick, entry.completedTicks);
  }
  return {
    id: definition.id,
    ownerPhase: definition.ownerPhase,
    cluster: definition.cluster,
    cases: entries.length,
    faultCodes: definition.faultCodes,
    stage: definition.stage,
    signals,
    completedTickRange: { minimum: minimumTick, maximum: maximumTick },
    ownerBoundary: definition.ownerBoundary,
    hypothesis: definition.hypothesis,
    reproducerPlan: definition.reproducerPlan,
    evidenceGap: definition.evidenceGap,
  };
}

function assertReportRedacted(report, rawEntries, aggregate) {
  const serialized = JSON.stringify(report);
  for (const entry of rawEntries) {
    for (const sensitive of [entry.id, entry.screenSha256, entry.faultMessage]) {
      if (typeof sensitive === "string" && sensitive.length > 0 && serialized.includes(sensitive)) {
        fail("E_REDACTION", "tracked failure contract contains per-case or raw diagnostic detail");
      }
    }
  }
  for (const sensitive of [aggregate.corpusFingerprint, aggregate.sourceSnapshot]) {
    if (typeof sensitive === "string" && sensitive.length > 0 && serialized.includes(sensitive)) {
      fail("E_REDACTION", "tracked failure contract contains supplemental source identity");
    }
  }
}

export async function buildPhase9FailureFreeze({
  aggregatePath,
  observationsPaths,
  projectRoot = repositoryRoot,
  expectedAggregateSha256 = PHASE_9_BASELINE_AGGREGATE_SHA256,
}) {
  if (!SHA256_PATTERN.test(expectedAggregateSha256 ?? "")) {
    fail("E_AGGREGATE_HASH", "expected aggregate hash must be SHA-256");
  }
  if (!Array.isArray(observationsPaths) || observationsPaths.length !== 4) {
    fail("E_OBSERVATION_BATCH", "exactly four external observation batches are required");
  }
  const aggregateInput = await readExternalJson(aggregatePath, "aggregate", projectRoot);
  const aggregateSha256 = sha256(aggregateInput.bytes);
  if (aggregateSha256 !== expectedAggregateSha256) {
    fail("E_AGGREGATE_HASH", "aggregate bytes do not match the frozen Phase 8F baseline");
  }
  validateAggregate(aggregateInput.value);

  const reports = [];
  const paths = new Set([aggregateInput.actual]);
  for (const [index, path] of observationsPaths.entries()) {
    const report = await readExternalJson(path, `observations[${index}]`, projectRoot);
    if (paths.has(report.actual)) fail("E_OBSERVATION_COVERAGE", "input paths must be distinct");
    paths.add(report.actual);
    validateObservationReport(report.value, `observations[${index}]`);
    reports.push(report.value);
  }
  if (!reports.every((report) => sameValue(report.environment, aggregateInput.value.environment))) {
    fail("E_ENVIRONMENT_DRIFT", "aggregate and observation environments must match exactly");
  }
  const entries = reports.flatMap((report) => report.entries);
  const ids = new Set(entries.map((entry) => entry.id));
  if (entries.length !== 200 || ids.size !== 200) {
    fail("E_OBSERVATION_COVERAGE", "observations must cover 200 unique cases exactly once");
  }
  const outcomes = { boots: 0, fails: 0, notRun: 0 };
  const clusters = Object.fromEntries(FAILURE_CLUSTERS.map((cluster) => [cluster, 0]));
  for (const entry of entries) {
    if (entry.smokeOutcome === "boots") outcomes.boots += 1;
    else if (entry.smokeOutcome === "fails") {
      outcomes.fails += 1;
      clusters[entry.failureCluster] += 1;
    } else outcomes.notRun += 1;
  }
  if (!sameValue(outcomes, { boots: 149, fails: 51, notRun: 0 })
    || !sameValue(clusters, { language: 45, timing: 5, "unsupported-host-feature": 1 })) {
    fail("E_OBSERVATION_DRIFT", "observations do not reproduce the frozen 149/51 and 45/5/1 baseline");
  }

  const failures = entries.filter((entry) => entry.smokeOutcome === "fails");
  const grouped = new Map(DEFINITIONS.map((definition) => [definition.id, []]));
  const unclassified = [];
  for (const entry of failures) {
    const matches = DEFINITIONS.filter((definition) => definition.cluster === entry.failureCluster
      && definition.matches(entry));
    if (matches.length > 1) fail("E_GROUPING_AMBIGUOUS", "a failure matched multiple root-cause rules");
    if (matches.length === 0) unclassified.push(entry);
    else grouped.get(matches[0].id).push(entry);
  }
  if (unclassified.length > 0) {
    fail("E_EVIDENCE_GAP", `${unclassified.length} failures require an explicit new root-cause candidate`);
  }
  const candidates = DEFINITIONS
    .map((definition) => resultCandidate(definition, grouped.get(definition.id)))
    .filter(({ cases }) => cases > 0);
  const candidateCases = candidates.reduce((sum, entry) => sum + entry.cases, 0);
  if (candidateCases !== failures.length || candidates.length !== DEFINITIONS.length) {
    fail("E_ROOT_CAUSE_COVERAGE", "every frozen failure must map to one non-empty candidate");
  }

  const report = {
    $schema: "https://pico8-web-player.invalid/spec/compat/phase-9-root-cause-contract-v1.schema.json",
    schemaVersion: 1,
    runner: PHASE_9_FAILURE_FREEZE_RUNNER,
    targetRuntime: "PICO-8 v0.2.7",
    sourceAggregateSha256: aggregateSha256,
    summary: {
      observedCases: 200,
      bootCases: 149,
      failureCases: 51,
      candidateCases,
      unclassifiedCases: 0,
      rootCauseCandidates: candidates.length,
      clusters,
    },
    privacy: {
      localObservationsOnly: true,
      refInputAllowed: false,
      cartIdentitiesTracked: false,
      sourcePathsTracked: false,
      cartHashesTracked: false,
      screenHashesTracked: false,
      faultMessagesTracked: false,
      screenshotsTracked: false,
      thirdPartyCodeTracked: false,
    },
    candidates,
  };
  assertReportRedacted(report, entries, aggregateInput.value);
  return report;
}

export async function writePhase9FailureFreeze({
  outputPath,
  report,
  projectRoot = repositoryRoot,
}) {
  if (typeof outputPath !== "string" || outputPath.includes("://")) {
    fail("E_PATH_URL", "output must be a local filesystem path");
  }
  const unresolved = resolve(outputPath);
  const parent = await realpath(dirname(unresolved)).catch((error) =>
    fail("E_OUTPUT_PARENT", `output parent could not be resolved: ${error.code ?? error.message}`));
  if (inside(resolve(projectRoot), parent)) {
    fail("E_PATH_REPOSITORY", "generated failure contract output must stay outside the repository");
  }
  await writeFile(unresolved, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" }).catch((error) =>
    fail("E_OUTPUT_WRITE", `output could not be written: ${error.code ?? error.message}`));
  return unresolved;
}
