import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

export const LOCAL_QUALIFICATION_RUNNER = "phase-6-local-qualification-v1";
export const CART_RESULTS = Object.freeze(["C0", "C1", "C2", "C3", "CU"]);
export const FAILURE_CLUSTERS = Object.freeze([
  "parse",
  "language",
  "ram",
  "graphics",
  "audio",
  "input",
  "timing",
  "persistence",
  "unsupported-host-feature",
]);

const PERMISSION_STATES = new Set([
  "caller-authorized-local-research",
  "licensed-local-test",
  "author-provided",
]);
const ID_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PLAYER_COMMIT_PATTERN = /^[a-f0-9]{7,40}$/u;
const CHROME_VERSION_PATTERN = /^(Google Chrome|Chromium) [0-9]/u;
const REVIEWED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
const MAXIMUM_CART_BYTES = 1024 * 1024;
const MAXIMUM_CASES = 64;
const MAXIMUM_BUNDLE_ENTRIES = 64;

export class QualificationInputError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "QualificationInputError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new QualificationInputError(code, message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(record, allowed, label) {
  if (!isRecord(record)) fail("E_SCHEMA", `${label} must be an object`);
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) fail("E_SCHEMA", `${label}.${key} is not allowed`);
  }
}

function requiredString(value, label, maximumLength = 512) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    fail("E_SCHEMA", `${label} must be a non-empty string up to ${maximumLength} characters`);
  }
  if (/\p{Cc}/u.test(value)) fail("E_SCHEMA", `${label} contains a control character`);
  return value;
}

function validateLocalRef(value, label) {
  const ref = requiredString(value, label, 256);
  if (ref.includes("://") || ref.includes("\\") || ref.startsWith("/") || ref.startsWith("#")
    || ref.split("/").some((part) => part.length === 0 || part === "." || part === "..")) {
    fail("E_SCHEMA", `${label} must be a canonical relative opaque name`);
  }
  return ref;
}

function validateCartAccess(value, label) {
  exactKeys(value, ["load", "reloadData", "cstoreData", "include"], label);
  for (const capability of ["load", "reloadData", "cstoreData", "include"]) {
    if (typeof value[capability] !== "boolean") fail("E_SCHEMA", `${label}.${capability} must be boolean`);
  }
  return {
    load: value.load,
    reloadData: value.reloadData,
    cstoreData: value.cstoreData,
    include: value.include,
  };
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

function repositoryPath(projectRoot, candidate) {
  const path = relative(projectRoot, candidate);
  return inside(projectRoot, candidate) ? path.split(sep).join("/") : null;
}

function assertNotReferencePath(projectRoot, candidate, label) {
  const path = repositoryPath(projectRoot, candidate);
  if (path === "ref" || path?.startsWith("ref/")) {
    fail("E_PATH_REF", `${label} must not resolve inside ref/`);
  }
}

function assertLocalInputPath(projectRoot, candidate, label, kind) {
  assertNotReferencePath(projectRoot, candidate, label);
  const path = repositoryPath(projectRoot, candidate);
  if (path === null) return;
  const allowed = kind === "manifest"
    ? path === "tests/conformance/local-corpus.json"
    : kind === "observations"
      ? path === "tests/conformance/local-observations.json"
      : path.startsWith("tests/conformance/local-corpus/");
  if (!allowed) {
    fail("E_PATH_TRACKED", `${label} must stay outside the repository or in its gitignored local corpus path`);
  }
}

export function assertSafeLocalOutputPath(outputPath, projectRoot) {
  const absoluteRoot = resolve(projectRoot);
  const absoluteOutput = resolve(outputPath);
  assertNotReferencePath(absoluteRoot, absoluteOutput, "output");
  const path = repositoryPath(absoluteRoot, absoluteOutput);
  if (path !== null && !path.startsWith("tests/conformance/local-corpus-results/")) {
    fail("E_OUTPUT_PATH", "output must stay outside the repository or under the gitignored local-corpus-results directory");
  }
  return absoluteOutput;
}

export function assertSafeLocalObservationsPath(observationsPath, projectRoot) {
  const absoluteRoot = resolve(projectRoot);
  const absolutePath = resolve(observationsPath);
  assertLocalInputPath(absoluteRoot, absolutePath, "observations", "observations");
  return absolutePath;
}

function validateTrace(trace, label) {
  exactKeys(trace, ["mode", "ticks", "stepMilliseconds", "inputs"], label);
  if (trace.mode !== "fixed-ticks") fail("E_SCHEMA", `${label}.mode must be fixed-ticks`);
  if (!Number.isInteger(trace.ticks) || trace.ticks < 1 || trace.ticks > 36_000) {
    fail("E_SCHEMA", `${label}.ticks must be an integer from 1 to 36000`);
  }
  if (typeof trace.stepMilliseconds !== "number" || !Number.isFinite(trace.stepMilliseconds)
    || trace.stepMilliseconds <= 0 || trace.stepMilliseconds > 1000) {
    fail("E_SCHEMA", `${label}.stepMilliseconds must be finite and in (0, 1000]`);
  }
  if (!Array.isArray(trace.inputs) || trace.inputs.length > 4096) {
    fail("E_SCHEMA", `${label}.inputs must contain at most 4096 events`);
  }
  let previousKey = "";
  const normalizedInputs = trace.inputs.map((input, index) => {
    const inputLabel = `${label}.inputs[${index}]`;
    exactKeys(input, ["tick", "player", "button", "pressed"], inputLabel);
    if (!Number.isInteger(input.tick) || input.tick < 0 || input.tick >= trace.ticks) {
      fail("E_SCHEMA", `${inputLabel}.tick is outside the trace`);
    }
    if (!Number.isInteger(input.player) || input.player < 0 || input.player > 7) {
      fail("E_SCHEMA", `${inputLabel}.player must be 0..7`);
    }
    if (!Number.isInteger(input.button) || input.button < 0 || input.button > 5) {
      fail("E_SCHEMA", `${inputLabel}.button must be 0..5`);
    }
    if (typeof input.pressed !== "boolean") fail("E_SCHEMA", `${inputLabel}.pressed must be boolean`);
    const key = `${String(input.tick).padStart(5, "0")}:${input.player}:${input.button}`;
    if (key <= previousKey) fail("E_SCHEMA", `${label}.inputs must be unique and sorted`);
    previousKey = key;
    return { tick: input.tick, player: input.player, button: input.button, pressed: input.pressed };
  });
  return {
    mode: trace.mode,
    ticks: trace.ticks,
    stepMilliseconds: trace.stepMilliseconds,
    inputs: normalizedInputs,
  };
}

async function parseJsonFile(path, label) {
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    fail("E_INPUT_READ", `${label} could not be read: ${error.code ?? error.message}`);
  }
  try {
    return { bytes, value: JSON.parse(bytes.toString("utf8")) };
  } catch {
    fail("E_JSON", `${label} is not valid JSON`);
  }
}

export async function loadLocalCorpusManifest({ manifestPath, projectRoot, minimumCases = 12 }) {
  const absoluteRoot = resolve(projectRoot);
  const unresolvedManifest = resolve(manifestPath);
  assertLocalInputPath(absoluteRoot, unresolvedManifest, "manifest", "manifest");
  let absoluteManifest;
  try {
    absoluteManifest = await realpath(unresolvedManifest);
  } catch (error) {
    fail("E_INPUT_READ", `manifest could not be resolved: ${error.code ?? error.message}`);
  }
  assertLocalInputPath(absoluteRoot, absoluteManifest, "manifest", "manifest");
  const parsed = await parseJsonFile(absoluteManifest, "manifest");
  const manifest = parsed.value;
  exactKeys(manifest, ["$schema", "schemaVersion", "corpusId", "policy", "entries"], "manifest");
  if (manifest.schemaVersion !== 1) fail("E_SCHEMA_VERSION", "manifest.schemaVersion must be 1");
  if (!ID_PATTERN.test(manifest.corpusId ?? "")) fail("E_SCHEMA", "manifest.corpusId is invalid");
  if (manifest.policy !== "developer-supplied-local-only") {
    fail("E_POLICY", "manifest.policy must be developer-supplied-local-only");
  }
  if (!Number.isInteger(minimumCases) || minimumCases < 1 || minimumCases > MAXIMUM_CASES) {
    fail("E_ARGUMENT", "minimumCases must be an integer from 1 to 64");
  }
  if (!Array.isArray(manifest.entries)
    || manifest.entries.length < minimumCases
    || manifest.entries.length > MAXIMUM_CASES) {
    fail("E_CASE_COUNT", `manifest.entries must contain ${minimumCases}..${MAXIMUM_CASES} cases`);
  }

  const seen = new Set();
  const entries = [];
  for (const [index, entry] of manifest.entries.entries()) {
    const label = `manifest.entries[${index}]`;
    exactKeys(entry, [
      "id", "label", "file", "sha256", "pico8Version", "source", "trace", "bundle",
      "expectedTermination",
    ], label);
    if (!ID_PATTERN.test(entry.id ?? "")) fail("E_SCHEMA", `${label}.id is invalid`);
    if (seen.has(entry.id)) fail("E_DUPLICATE_ID", `${entry.id} appears more than once`);
    seen.add(entry.id);
    requiredString(entry.label, `${label}.label`, 128);
    const file = requiredString(entry.file, `${label}.file`, 4096);
    if (file.includes("://")) fail("E_PATH_URL", `${label}.file must be a local path`);
    if (!SHA256_PATTERN.test(entry.sha256 ?? "")) fail("E_SCHEMA", `${label}.sha256 is invalid`);
    if (entry.pico8Version !== "0.2.7") fail("E_TARGET_VERSION", `${label}.pico8Version must be 0.2.7`);
    exactKeys(entry.source, ["label", "revision", "permissionStatus", "permissionBasis", "url"], `${label}.source`);
    requiredString(entry.source.label, `${label}.source.label`, 128);
    requiredString(entry.source.revision, `${label}.source.revision`, 128);
    if (!PERMISSION_STATES.has(entry.source.permissionStatus)) {
      fail("E_PERMISSION", `${label}.source.permissionStatus is not accepted`);
    }
    requiredString(entry.source.permissionBasis, `${label}.source.permissionBasis`, 512);
    if (entry.source.url !== undefined) requiredString(entry.source.url, `${label}.source.url`, 2048);
    const trace = validateTrace(entry.trace, `${label}.trace`);
    let expectedTermination;
    if (entry.expectedTermination !== undefined) {
      exactKeys(entry.expectedTermination, ["kind", "faultCode", "basis"],
        `${label}.expectedTermination`);
      if (entry.expectedTermination.kind !== "fault"
        || !/^E_[A-Z0-9_]+$/u.test(entry.expectedTermination.faultCode ?? "")) {
        fail("E_SCHEMA", `${label}.expectedTermination must name an E_* fault`);
      }
      expectedTermination = {
        kind: "fault",
        faultCode: entry.expectedTermination.faultCode,
        basis: requiredString(entry.expectedTermination.basis,
          `${label}.expectedTermination.basis`, 256),
      };
    }

    const unresolvedCart = isAbsolute(file) ? resolve(file) : resolve(dirname(absoluteManifest), file);
    assertLocalInputPath(absoluteRoot, unresolvedCart, `${label}.file`, "cart");
    let cartPath;
    try {
      cartPath = await realpath(unresolvedCart);
    } catch (error) {
      fail("E_INPUT_READ", `${label}.file could not be resolved: ${error.code ?? error.message}`);
    }
    assertLocalInputPath(absoluteRoot, cartPath, `${label}.file`, "cart");
    const extension = extname(cartPath).toLowerCase();
    if (extension !== ".p8" && !cartPath.toLowerCase().endsWith(".p8.png")) {
      fail("E_CART_FORMAT", `${label}.file must end in .p8 or .p8.png`);
    }
    const cartBytes = await readFile(cartPath);
    if (cartBytes.length === 0 || cartBytes.length > MAXIMUM_CART_BYTES) {
      fail("E_CART_SIZE", `${label}.file must contain 1..${MAXIMUM_CART_BYTES} bytes`);
    }
    const actualSha256 = sha256(cartBytes);
    if (actualSha256 !== entry.sha256) fail("E_CART_HASH", `${entry.id} SHA-256 mismatch`);
    if (entry.bundle !== undefined && (!Array.isArray(entry.bundle)
      || entry.bundle.length > MAXIMUM_BUNDLE_ENTRIES)) {
      fail("E_SCHEMA", `${label}.bundle must contain at most ${MAXIMUM_BUNDLE_ENTRIES} entries`);
    }
    const seenBundleRefs = new Set();
    const localCartBundle = [];
    for (const [bundleIndex, bundleEntry] of (entry.bundle ?? []).entries()) {
      const bundleLabel = `${label}.bundle[${bundleIndex}]`;
      exactKeys(bundleEntry, ["ref", "file", "sha256", "access"], bundleLabel);
      const ref = validateLocalRef(bundleEntry.ref, `${bundleLabel}.ref`);
      if (seenBundleRefs.has(ref)) fail("E_DUPLICATE_ID", `${ref} appears more than once in bundle`);
      seenBundleRefs.add(ref);
      const bundleFile = requiredString(bundleEntry.file, `${bundleLabel}.file`, 4096);
      if (bundleFile.includes("://")) fail("E_PATH_URL", `${bundleLabel}.file must be a local path`);
      if (!SHA256_PATTERN.test(bundleEntry.sha256 ?? "")) {
        fail("E_SCHEMA", `${bundleLabel}.sha256 is invalid`);
      }
      const access = validateCartAccess(bundleEntry.access, `${bundleLabel}.access`);
      const unresolvedBundle = isAbsolute(bundleFile)
        ? resolve(bundleFile)
        : resolve(dirname(absoluteManifest), bundleFile);
      assertLocalInputPath(absoluteRoot, unresolvedBundle, `${bundleLabel}.file`, "cart");
      const bundlePath = await realpath(unresolvedBundle).catch((error) =>
        fail("E_INPUT_READ", `${bundleLabel}.file could not be resolved: ${error.code ?? error.message}`));
      assertLocalInputPath(absoluteRoot, bundlePath, `${bundleLabel}.file`, "cart");
      const bundleBytes = await readFile(bundlePath);
      if (bundleBytes.length === 0 || bundleBytes.length > MAXIMUM_CART_BYTES) {
        fail("E_CART_SIZE", `${bundleLabel}.file must contain 1..${MAXIMUM_CART_BYTES} bytes`);
      }
      const bundleSha256 = sha256(bundleBytes);
      if (bundleSha256 !== bundleEntry.sha256) fail("E_CART_HASH", `${ref} SHA-256 mismatch`);
      localCartBundle.push({ ref, cartPath: bundlePath, cartSha256: bundleSha256, access });
    }
    entries.push({
      id: entry.id,
      label: entry.label,
      cartPath,
      cartSha256: actualSha256,
      cartBytes: cartBytes.length,
      pico8Version: entry.pico8Version,
      source: {
        label: entry.source.label,
        revision: entry.source.revision,
        permissionStatus: entry.source.permissionStatus,
      },
      trace,
      traceSha256: stableJsonHash(trace),
      localCartBundle,
      ...(expectedTermination === undefined ? {} : { expectedTermination }),
    });
  }
  entries.sort((left, right) => left.id.localeCompare(right.id));
  return {
    corpusId: manifest.corpusId,
    policy: manifest.policy,
    manifestSha256: sha256(parsed.bytes),
    entries,
  };
}

function validateEnvironment(environment) {
  exactKeys(environment, ["target", "playerCommit", "runtimeWasmSha256", "chromeVersion"], "observations.environment");
  if (environment.target !== "chrome-production") fail("E_TARGET", "environment.target must be chrome-production");
  if (!PLAYER_COMMIT_PATTERN.test(environment.playerCommit ?? "")) fail("E_ENVIRONMENT", "environment.playerCommit is invalid");
  if (!SHA256_PATTERN.test(environment.runtimeWasmSha256 ?? "")) fail("E_ENVIRONMENT", "environment.runtimeWasmSha256 is invalid");
  if (!CHROME_VERSION_PATTERN.test(environment.chromeVersion ?? "")) fail("E_BROWSER", "environment.chromeVersion must identify Chrome or Chromium");
  return {
    target: environment.target,
    playerCommit: environment.playerCommit,
    runtimeWasmSha256: environment.runtimeWasmSha256,
    chromeVersion: environment.chromeVersion,
  };
}

function validateAudioDevice(audioDevice, label) {
  exactKeys(audioDevice, [
    "contextState",
    "deviceSampleRate",
    "receivedChunks",
    "renderedDeviceFrames",
    "playing",
    "steadyUnderruns",
    "overruns",
    "droppedSourceFrames",
    "discontinuities",
  ], label);
  if (audioDevice.contextState !== "running") fail("E_AUDIO_DEVICE", `${label}.contextState must be running`);
  for (const field of [
    "deviceSampleRate", "receivedChunks", "renderedDeviceFrames", "steadyUnderruns", "overruns",
    "droppedSourceFrames", "discontinuities",
  ]) {
    if (!Number.isSafeInteger(audioDevice[field]) || audioDevice[field] < 0) {
      fail("E_AUDIO_DEVICE", `${label}.${field} must be a non-negative safe integer`);
    }
  }
  if (typeof audioDevice.playing !== "boolean") fail("E_AUDIO_DEVICE", `${label}.playing must be boolean`);
  return { ...audioDevice };
}

function validatePlayability(playability, label) {
  exactKeys(playability, [
    "gate",
    "durationSeconds",
    "criticalFlow",
    "criticalFlowCompleted",
    "mainVerbs",
    "input",
    "visual",
    "audio",
    "persistence",
    "crashFree",
    "softLockFree",
    "reviewedAt",
    "reviewer",
    "evidenceSha256",
  ], label);
  if (!["duration", "critical-flow"].includes(playability.gate)) {
    fail("E_PLAYABILITY", `${label}.gate is invalid`);
  }
  if (!Number.isInteger(playability.durationSeconds)
    || playability.durationSeconds < 0
    || playability.durationSeconds > 36_000) {
    fail("E_PLAYABILITY", `${label}.durationSeconds must be 0..36000`);
  }
  requiredString(playability.criticalFlow, `${label}.criticalFlow`, 512);
  if (typeof playability.criticalFlowCompleted !== "boolean") {
    fail("E_PLAYABILITY", `${label}.criticalFlowCompleted must be boolean`);
  }
  if (!Array.isArray(playability.mainVerbs)
    || playability.mainVerbs.length < 1
    || playability.mainVerbs.length > 16) {
    fail("E_PLAYABILITY", `${label}.mainVerbs must contain 1..16 items`);
  }
  const mainVerbs = playability.mainVerbs.map((verb, index) =>
    requiredString(verb, `${label}.mainVerbs[${index}]`, 128));
  if (!["pass", "not-applicable"].includes(playability.input)) {
    fail("E_PLAYABILITY", `${label}.input is invalid`);
  }
  if (!["pass", "known-minor-difference"].includes(playability.visual)) {
    fail("E_PLAYABILITY", `${label}.visual is invalid`);
  }
  if (!["pass", "known-minor-difference", "not-applicable"].includes(playability.audio)) {
    fail("E_PLAYABILITY", `${label}.audio is invalid`);
  }
  if (!["pass", "not-applicable"].includes(playability.persistence)) {
    fail("E_PLAYABILITY", `${label}.persistence is invalid`);
  }
  if (playability.crashFree !== true || playability.softLockFree !== true) {
    fail("E_PLAYABILITY", `${label} must be crash-free and soft-lock-free`);
  }
  if (!REVIEWED_AT_PATTERN.test(playability.reviewedAt ?? "")) {
    fail("E_PLAYABILITY", `${label}.reviewedAt must be an ISO UTC timestamp`);
  }
  requiredString(playability.reviewer, `${label}.reviewer`, 128);
  if (!SHA256_PATTERN.test(playability.evidenceSha256 ?? "")) {
    fail("E_PLAYABILITY", `${label}.evidenceSha256 is invalid`);
  }
  if (playability.gate === "duration" && playability.durationSeconds < 900) {
    fail("E_PLAYABILITY", `${label} duration gate requires at least 900 seconds`);
  }
  if (playability.gate === "critical-flow" && !playability.criticalFlowCompleted) {
    fail("E_PLAYABILITY", `${label} critical-flow gate must be complete`);
  }
  return {
    gate: playability.gate,
    durationSeconds: playability.durationSeconds,
    criticalFlow: playability.criticalFlow,
    criticalFlowCompleted: playability.criticalFlowCompleted,
    mainVerbs,
    input: playability.input,
    visual: playability.visual,
    audio: playability.audio,
    persistence: playability.persistence,
    crashFree: true,
    softLockFree: true,
    reviewedAt: playability.reviewedAt,
    reviewer: playability.reviewer,
    evidenceSha256: playability.evidenceSha256,
  };
}

export async function loadLocalObservations({ observationsPath, projectRoot }) {
  const absoluteRoot = resolve(projectRoot);
  const unresolved = resolve(observationsPath);
  assertLocalInputPath(absoluteRoot, unresolved, "observations", "observations");
  let absolutePath;
  try {
    absolutePath = await realpath(unresolved);
  } catch (error) {
    fail("E_INPUT_READ", `observations could not be resolved: ${error.code ?? error.message}`);
  }
  assertLocalInputPath(absoluteRoot, absolutePath, "observations", "observations");
  const { value } = await parseJsonFile(absolutePath, "observations");
  exactKeys(value, ["$schema", "schemaVersion", "environment", "entries"], "observations");
  if (value.schemaVersion !== 1) fail("E_SCHEMA_VERSION", "observations.schemaVersion must be 1");
  const environment = validateEnvironment(value.environment);
  if (!Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > MAXIMUM_CASES) {
    fail("E_CASE_COUNT", "observations.entries must contain 1..64 entries");
  }
  const seen = new Set();
  const entries = new Map();
  for (const [index, entry] of value.entries.entries()) {
    const label = `observations.entries[${index}]`;
    exactKeys(entry, [
      "id",
      "completed",
      "smokeOutcome",
      "classification",
      "failureCluster",
      "completedTicks",
      "faultCode",
      "faultMessage",
      "frameCount",
      "screenSha256",
      "nonBlackPixels",
      "distinctColors",
      "screenshotCaptured",
      "expectedTerminationMatched",
      "playability",
      "audioDevice",
    ], label);
    if (!ID_PATTERN.test(entry.id ?? "")) fail("E_SCHEMA", `${label}.id is invalid`);
    if (seen.has(entry.id)) fail("E_DUPLICATE_ID", `${entry.id} appears more than once in observations`);
    seen.add(entry.id);
    if (typeof entry.completed !== "boolean") fail("E_SCHEMA", `${label}.completed must be boolean`);
    if (!["boots", "fails", "not-run"].includes(entry.smokeOutcome)) {
      fail("E_SMOKE_OUTCOME", `${label}.smokeOutcome is invalid`);
    }
    if (!CART_RESULTS.includes(entry.classification)) fail("E_CLASSIFICATION", `${label}.classification is invalid`);
    if (!Number.isInteger(entry.completedTicks) || entry.completedTicks < 0 || entry.completedTicks > 36_000) {
      fail("E_SCHEMA", `${label}.completedTicks must be 0..36000`);
    }
    if (entry.failureCluster !== null && !FAILURE_CLUSTERS.includes(entry.failureCluster)) {
      fail("E_FAILURE_CLUSTER", `${label}.failureCluster is invalid`);
    }
    if (!entry.completed && entry.classification !== "CU") {
      fail("E_INCOMPLETE", `${label} must be CU when completed is false`);
    }
    if (!entry.completed && (entry.smokeOutcome !== "not-run" || entry.completedTicks !== 0)) {
      fail("E_INCOMPLETE", `${label} must be not-run at zero ticks when completed is false`);
    }
    if (entry.completed && entry.smokeOutcome === "not-run") {
      fail("E_SMOKE_OUTCOME", `${label} cannot be not-run when completed is true`);
    }
    if (entry.classification === "C0" && entry.smokeOutcome !== "fails") {
      fail("E_SMOKE_OUTCOME", `${label} C0 must have a fails smoke outcome`);
    }
    if (["C1", "C2", "C3"].includes(entry.classification)
      && entry.completed && entry.smokeOutcome !== "boots") {
      fail("E_SMOKE_OUTCOME", `${label} completed ${entry.classification} must have a boots smoke outcome`);
    }
    if (entry.classification === "CU" && entry.completed && entry.smokeOutcome !== "boots"
      && entry.expectedTerminationMatched !== true) {
      fail("E_SMOKE_OUTCOME", `${label} completed CU failure must match an expected termination`);
    }
    if (entry.expectedTerminationMatched !== undefined
      && typeof entry.expectedTerminationMatched !== "boolean") {
      fail("E_OBSERVATION", `${label}.expectedTerminationMatched must be boolean`);
    }
    if (entry.expectedTerminationMatched === true
      && (entry.classification !== "CU" || entry.smokeOutcome !== "fails"
        || entry.failureCluster !== null || entry.faultCode === undefined)) {
      fail("E_OBSERVATION", `${label} matched expected termination must retain a CU fault observation`);
    }
    if (["C0", "C1"].includes(entry.classification) && entry.failureCluster === null) {
      fail("E_FAILURE_CLUSTER", `${label} requires a failure cluster for C0/C1`);
    }
    if (["C2", "C3", "CU"].includes(entry.classification) && entry.failureCluster !== null) {
      fail("E_FAILURE_CLUSTER", `${label} must not attach a failure cluster to C2/C3/CU`);
    }
    if (entry.faultCode !== undefined) requiredString(entry.faultCode, `${label}.faultCode`, 128);
    if (entry.faultMessage !== undefined) requiredString(entry.faultMessage, `${label}.faultMessage`, 512);
    for (const [field, maximum] of [
      ["frameCount", 36_000],
      ["nonBlackPixels", 16_384],
      ["distinctColors", 256],
    ]) {
      if (entry[field] !== undefined
        && (!Number.isInteger(entry[field]) || entry[field] < 0 || entry[field] > maximum)) {
        fail("E_OBSERVATION", `${label}.${field} must be an integer from 0 to ${maximum}`);
      }
    }
    if (entry.screenSha256 !== undefined
      && entry.screenSha256 !== null
      && !SHA256_PATTERN.test(entry.screenSha256)) {
      fail("E_OBSERVATION", `${label}.screenSha256 is invalid`);
    }
    if (entry.screenshotCaptured !== undefined && typeof entry.screenshotCaptured !== "boolean") {
      fail("E_OBSERVATION", `${label}.screenshotCaptured must be boolean`);
    }
    const playability = entry.playability === undefined
      ? undefined
      : validatePlayability(entry.playability, `${label}.playability`);
    const audioDevice = entry.audioDevice === undefined
      ? undefined
      : validateAudioDevice(entry.audioDevice, `${label}.audioDevice`);
    if (entry.classification === "C2" && playability === undefined) {
      fail("E_PLAYABILITY", `${label} C2 requires reviewed playability evidence`);
    }
    if (entry.classification !== "C2" && playability !== undefined) {
      fail("E_PLAYABILITY", `${label} playability evidence is reserved for C2`);
    }
    entries.set(entry.id, {
      id: entry.id,
      completed: entry.completed,
      smokeOutcome: entry.smokeOutcome,
      classification: entry.classification,
      failureCluster: entry.failureCluster,
      completedTicks: entry.completedTicks,
      ...(entry.faultCode === undefined ? {} : { faultCode: entry.faultCode }),
      ...(entry.frameCount === undefined ? {} : { frameCount: entry.frameCount }),
      ...(entry.screenSha256 === undefined ? {} : { screenSha256: entry.screenSha256 }),
      ...(entry.nonBlackPixels === undefined ? {} : { nonBlackPixels: entry.nonBlackPixels }),
      ...(entry.distinctColors === undefined ? {} : { distinctColors: entry.distinctColors }),
      ...(entry.screenshotCaptured === undefined ? {} : {
        screenshotCaptured: entry.screenshotCaptured,
      }),
      ...(entry.expectedTerminationMatched === undefined ? {} : {
        expectedTerminationMatched: entry.expectedTerminationMatched,
      }),
      ...(playability === undefined ? {} : { playability }),
      ...(audioDevice === undefined ? {} : { audioDevice }),
    });
  }
  return { environment, entries };
}

export async function buildLocalQualificationReport({
  manifestPath,
  observationsPath,
  projectRoot,
  minimumCases = 12,
}) {
  const [corpus, observations] = await Promise.all([
    loadLocalCorpusManifest({ manifestPath, projectRoot, minimumCases }),
    loadLocalObservations({ observationsPath, projectRoot }),
  ]);
  const knownIds = new Set(corpus.entries.map(({ id }) => id));
  for (const id of observations.entries.keys()) {
    if (!knownIds.has(id)) fail("E_UNKNOWN_OBSERVATION", `observation ${id} is not present in the corpus`);
  }

  const counts = Object.fromEntries(CART_RESULTS.map((classification) => [classification, 0]));
  const failureClusters = Object.fromEntries(FAILURE_CLUSTERS.map((cluster) => [cluster, 0]));
  const entries = corpus.entries.map((entry) => {
    const observation = observations.entries.get(entry.id) ?? {
      completed: false,
      smokeOutcome: "not-run",
      classification: "CU",
      failureCluster: null,
      completedTicks: 0,
    };
    if (observation.completedTicks > entry.trace.ticks) {
      fail("E_TRACE", `${entry.id} completed more ticks than requested`);
    }
    if (observation.expectedTerminationMatched === true
      && (entry.expectedTermination?.kind !== "fault"
        || entry.expectedTermination.faultCode !== observation.faultCode)) {
      fail("E_EXPECTED_TERMINATION",
        `${entry.id} observation does not exactly match its declared expected fault`);
    }
    counts[observation.classification] += 1;
    if (observation.failureCluster !== null) failureClusters[observation.failureCluster] += 1;
    return {
      id: entry.id,
      label: entry.label,
      cartSha256: entry.cartSha256,
      cartBytes: entry.cartBytes,
      pico8Version: entry.pico8Version,
      sourceLabel: entry.source.label,
      sourceRevision: entry.source.revision,
      permissionStatus: entry.source.permissionStatus,
      traceSha256: entry.traceSha256,
      requestedTicks: entry.trace.ticks,
      completedTicks: observation.completedTicks,
      completed: observation.completed,
      smokeOutcome: observation.smokeOutcome,
      classification: observation.classification,
      failureCluster: observation.failureCluster,
      ...(observation.faultCode === undefined ? {} : { faultCode: observation.faultCode }),
      ...(observation.frameCount === undefined ? {} : { frameCount: observation.frameCount }),
      ...(observation.screenSha256 === undefined ? {} : {
        screenSha256: observation.screenSha256,
      }),
      ...(observation.nonBlackPixels === undefined ? {} : {
        nonBlackPixels: observation.nonBlackPixels,
      }),
      ...(observation.distinctColors === undefined ? {} : {
        distinctColors: observation.distinctColors,
      }),
      ...(observation.screenshotCaptured === undefined ? {} : {
        screenshotCaptured: observation.screenshotCaptured,
      }),
      ...(observation.expectedTerminationMatched === undefined ? {} : {
        expectedTerminationMatched: observation.expectedTerminationMatched,
      }),
      ...(observation.playability === undefined ? {} : {
        playability: observation.playability,
      }),
      ...(observation.audioDevice === undefined ? {} : {
        audioDevice: observation.audioDevice,
      }),
    };
  });
  const completedCaseCount = entries.filter(({ completed }) => completed).length;
  return {
    schemaVersion: 1,
    runner: LOCAL_QUALIFICATION_RUNNER,
    corpus: {
      id: corpus.corpusId,
      manifestSha256: corpus.manifestSha256,
      caseCount: corpus.entries.length,
      policy: corpus.policy,
    },
    environment: observations.environment,
    summary: {
      qualificationComplete: completedCaseCount === entries.length,
      completedCaseCount,
      incompleteCaseCount: entries.length - completedCaseCount,
      counts,
      failureClusters,
    },
    entries,
  };
}

export async function writeLocalQualificationReport({ outputPath, projectRoot, report }) {
  const safePath = assertSafeLocalOutputPath(outputPath, projectRoot);
  await writeFile(safePath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return safePath;
}
