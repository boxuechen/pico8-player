const PATHS = new Set(["js_to_wasm_export", "wasm_to_js_import", "wasm_control", "js_shared_memory"]);
const OPERATIONS = new Set(["noop_scalar", "raw_q16x3", "byte_string", "peek_poke", "pset", "spr_8x8"]);
const STATUSES = new Set(["measured", "not-run", "unavailable"]);

function requireValue(condition, message, errors) {
  if (!condition) errors.push(message);
}

export function validateInteropResult(result) {
  const errors = [];
  requireValue(result && typeof result === "object", "result must be an object", errors);
  if (errors.length) return errors;
  requireValue(result.schemaVersion === 1, "schemaVersion must be 1", errors);
  requireValue(result.suiteId === "phase-0c-interop-v1", "suiteId is invalid", errors);
  requireValue(typeof result.runId === "string" && result.runId.length > 0, "runId is required", errors);
  requireValue(!Number.isNaN(Date.parse(result.createdAt)), "createdAt must be an ISO date", errors);
  requireValue(typeof result.sourceRevision === "string" && result.sourceRevision.length > 0, "sourceRevision is required", errors);
  requireValue(result.artifact?.benchmarkAbiVersion === 0x00030000, "benchmark ABI must be 0x00030000", errors);
  requireValue(Number.isInteger(result.artifact?.wasmBytes) && result.artifact.wasmBytes > 0, "artifact.wasmBytes is invalid", errors);
  requireValue(/^[0-9a-f]{64}$/u.test(result.artifact?.wasmSha256 ?? ""), "artifact.wasmSha256 is invalid", errors);
  requireValue(typeof result.environment?.runtime === "string", "environment.runtime is required", errors);
  requireValue(Number.isFinite(result.environment?.timerResolutionMs), "timer resolution is required", errors);
  requireValue(Array.isArray(result.availability), "availability must be an array", errors);
  for (const [index, entry] of (result.availability ?? []).entries()) {
    requireValue(["chromium", "firefox", "webkit", "node"].includes(entry.engine), `availability[${index}].engine is invalid`, errors);
    requireValue(STATUSES.has(entry.status), `availability[${index}].status is invalid`, errors);
    if (entry.status !== "measured") requireValue(typeof entry.reason === "string" && entry.reason.length > 0, `availability[${index}].reason is required`, errors);
  }
  requireValue(Array.isArray(result.cases) && result.cases.length > 0, "cases must be a non-empty array", errors);
  const ids = new Set();
  for (const [index, benchmarkCase] of (result.cases ?? []).entries()) {
    const at = `cases[${index}]`;
    requireValue(typeof benchmarkCase.caseId === "string" && !ids.has(benchmarkCase.caseId), `${at}.caseId must be unique`, errors);
    ids.add(benchmarkCase.caseId);
    requireValue(PATHS.has(benchmarkCase.path), `${at}.path is invalid`, errors);
    requireValue(OPERATIONS.has(benchmarkCase.operation), `${at}.operation is invalid`, errors);
    requireValue(Number.isInteger(benchmarkCase.callsPerFrame) && benchmarkCase.callsPerFrame > 0, `${at}.callsPerFrame is invalid`, errors);
    requireValue(benchmarkCase.correctness?.passed === true, `${at}.correctness must pass`, errors);
    requireValue(Number.isInteger(benchmarkCase.correctness?.resultChecksum), `${at}.resultChecksum is invalid`, errors);
    requireValue(Number.isInteger(benchmarkCase.correctness?.ramHash), `${at}.ramHash is invalid`, errors);
    requireValue(benchmarkCase.memory?.wasmBufferStable === true, `${at}.wasm buffer was not stable`, errors);
    requireValue(benchmarkCase.memory?.wasmBytesBefore === benchmarkCase.memory?.wasmBytesAfter, `${at}.wasm memory size changed`, errors);
    requireValue(Array.isArray(benchmarkCase.samplesMsPerFrame) && benchmarkCase.samplesMsPerFrame.length === result.protocol?.measuredSamples, `${at}.sample count is invalid`, errors);
    for (const name of ["p50Ms", "p95Ms", "p99Ms", "meanMs", "minMs", "maxMs", "nanosecondsPerCallAtP50"]) {
      requireValue(Number.isFinite(benchmarkCase.summary?.[name]) && benchmarkCase.summary[name] >= 0, `${at}.summary.${name} is invalid`, errors);
    }
    requireValue(
      benchmarkCase.summary?.callsPerSecondAtP50 === null || Number.isFinite(benchmarkCase.summary?.callsPerSecondAtP50),
      `${at}.summary.callsPerSecondAtP50 is invalid`,
      errors,
    );
  }

  const groups = new Map();
  for (const benchmarkCase of result.cases ?? []) {
    const key = `${benchmarkCase.operation}:${benchmarkCase.callsPerFrame}:${benchmarkCase.byteLength ?? "none"}`;
    const prior = groups.get(key);
    const value = `${benchmarkCase.correctness?.resultChecksum}:${benchmarkCase.correctness?.ramHash}`;
    if (prior && prior !== value) errors.push(`cross-path correctness mismatch for ${key}`);
    groups.set(key, value);
  }
  return errors;
}

export function assertValidInteropResult(result) {
  const errors = validateInteropResult(result);
  if (errors.length > 0) throw new Error(`Invalid Phase 0C result:\n- ${errors.join("\n- ")}`);
  return result;
}
