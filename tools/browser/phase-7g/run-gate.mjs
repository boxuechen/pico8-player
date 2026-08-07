import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const diagnostic = process.argv.includes("--diagnostic");
const temporary = await mkdtemp(join(tmpdir(), "p8w-phase7g-gate-"));

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function run(label, command, args, { capture = false, env = {} } = {}) {
  process.stdout.write(`\n[phase-7g] ${label}\n`);
  const child = spawn(command, args, {
    cwd: resolve("."),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    const text = String(chunk);
    process.stdout.write(text);
    if (capture) stdout += text;
  });
  child.stderr.on("data", (chunk) => {
    const text = String(chunk);
    process.stderr.write(text);
    stderr += text;
  });
  const exitCode = await new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${label} terminated by ${signal}`));
      else resolvePromise(code ?? 1);
    });
  });
  if (exitCode !== 0) {
    throw new Error(`${label} failed with exit ${exitCode}${
      stderr ? `\n${stderr}` : ""
    }`);
  }
  return stdout;
}

const parseJson = (text, label) => {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} did not emit one JSON result: ${error.message}`);
  }
};

try {
  await run("release artifact verifier", "node", ["tools/release/verify-release.mjs"]);
  await run("release reproducibility and negative audit", "node", [
    "--test",
    "tests/artifact/phase-7c-release-artifact.test.mjs",
  ]);
  const artifactMatrix = parseJson(await run(
    "release MIME/CSP/relative-base matrix",
    "node",
    ["tools/browser/run-phase-7c.mjs"],
    { capture: true },
  ), "artifact matrix");

  await run("audio frontend contracts", "node", [
    "--test",
    "tests/phase-0f/audio.test.mjs",
    "tests/phase-0f/contracts.test.mjs",
  ]);
  const audioMatrix = parseJson(await run(
    "production 44.1/48 kHz AudioWorklet matrix",
    "node",
    ["tools/browser/run-phase-0f-audio.mjs"],
    { capture: true },
  ), "audio matrix");

  await run("persistence unit and failure matrix", "node", [
    "--test",
    "tests/runtime/phase-3f-persistence.test.mjs",
    "tests/runtime/phase-7g-persistence-failures.test.mjs",
  ]);
  const persistenceMatrix = parseJson(await run(
    "production IndexedDB recovery matrix",
    "node",
    ["tools/browser/run-phase-3f.mjs"],
    { capture: true },
  ), "persistence matrix");

  const browserResultPath = join(temporary, "browser.json");
  await run("release lifecycle, recovery and fuzz matrix", "node", [
    "tools/browser/run-phase-7g.mjs",
  ], {
    env: { P8W_PHASE7G_BROWSER_RESULT: browserResultPath },
  });
  const browserMatrix = JSON.parse(await readFile(browserResultPath, "utf8"));

  const soakResultPath = join(temporary, "soak.json");
  await run(
    diagnostic ? "diagnostic 10-second soak (not an exit gate)" : "600-second release soak",
    "node",
    [
      "tools/browser/phase-7g/run-soak.mjs",
      ...(diagnostic ? ["--diagnostic"] : []),
    ],
    { env: { P8W_PHASE7G_SOAK_RESULT: soakResultPath } },
  );
  const soakMatrix = JSON.parse(await readFile(soakResultPath, "utf8"));

  await run("hardening manifest and provenance contract", "node", [
    "--test",
    "tests/conformance/phase-7g-hardening-contract.test.mjs",
  ]);

  const releaseManifestBytes = await readFile(
    "apps/web-player/dist/release/manifest.json",
  );
  const releaseManifest = JSON.parse(releaseManifestBytes);
  check(artifactMatrix.wasmRequests.correct === 1 &&
    artifactMatrix.wasmRequests.fallback === 2,
  "artifact boot/fallback aggregate changed");
  check(audioMatrix.cases.length === 2 &&
    audioMatrix.cases.every(({ finalStats }) => finalStats.steadyUnderruns === 0),
  "audio aggregate contains an underrun or missing sample rate");
  check(persistenceMatrix.writeFailureDiagnostic === true &&
    persistenceMatrix.failureState === "paused",
  "persistence failure was not recoverable and visible");
  check(browserMatrix.recovery.iterations === 20 &&
    browserMatrix.recovery.watchdogs === 20,
  "recovery aggregate is incomplete");
  check(browserMatrix.fuzz.structuredRejections === 64,
    "fuzz aggregate is incomplete");
  check(browserMatrix.externalRequests === 0,
    "browser hardening made an external request");
  check(soakMatrix.profiles.every(({ steadyAudioUnderruns }) =>
    steadyAudioUnderruns === 0), "soak aggregate contains an audio underrun");
  check(soakMatrix.resources.workersCreated === soakMatrix.resources.workersTerminated &&
    soakMatrix.resources.activeAnimationFrames === 0 &&
    soakMatrix.resources.activeDomListeners === 0,
  "soak aggregate retained resources");

  const result = {
    schemaVersion: 1,
    phase: "7G",
    mode: diagnostic ? "diagnostic-not-exit" : "release-exit",
    browser: browserMatrix.browser,
    gates: {
      artifactMatrix: "pass",
      audioMatrix: "pass",
      persistenceFailures: "pass",
      lifecycleRecoveryFuzz: "pass",
      desktopSoak: "pass",
      provenance: "pass",
    },
    releaseArtifact: {
      manifestSha256: createHash("sha256").update(releaseManifestBytes).digest("hex"),
      fileCount: releaseManifest.files.length,
      artifactSha256: Object.fromEntries(
        Object.entries(releaseManifest.artifacts).map(([key, value]) => [key, value.sha256]),
      ),
      networkCartAccess: releaseManifest.capabilities.networkCartAccess,
      publicationPerformed: releaseManifest.capabilities.publicationPerformed,
    },
    audio: {
      requestedSampleRates: audioMatrix.cases.map(({ requestedSampleRate }) =>
        requestedSampleRate),
      steadyUnderruns: audioMatrix.cases.reduce((total, { finalStats }) =>
        total + finalStats.steadyUnderruns, 0),
    },
    persistence: {
      writeFailureVisible: persistenceMatrix.writeFailureDiagnostic,
      runtimeStateAfterFailure: persistenceMatrix.failureState,
    },
    lifecycle: browserMatrix.lifecycle,
    recovery: browserMatrix.recovery,
    fuzz: browserMatrix.fuzz,
    staleOutputs: 0,
    externalRequests: browserMatrix.externalRequests,
    soak: {
      requestedSeconds: soakMatrix.requestedSeconds,
      actualDurationMs: soakMatrix.actualDurationMs,
      profiles: soakMatrix.profiles,
      longTasks: soakMatrix.longTasks,
      retainedHeapDeltaBytes: soakMatrix.retainedHeapDeltaBytes,
    },
    resources: {
      browser: browserMatrix.resources,
      soak: soakMatrix.resources,
    },
  };
  if (process.env.P8W_PHASE7G_AGGREGATE_RESULT) {
    await writeFile(
      resolve(process.env.P8W_PHASE7G_AGGREGATE_RESULT),
      `${JSON.stringify(result, null, 2)}\n`,
    );
  }
  process.stdout.write(`\n[phase-7g] aggregate\n${JSON.stringify(result, null, 2)}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
