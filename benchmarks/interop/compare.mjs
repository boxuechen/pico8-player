import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { assertValidInteropResult } from "./validate.mjs";

export function compareInteropResults(
  baseline,
  candidate,
  { warningRatio = 0.05, failureRatio = 0.10, confirmedRepeat = false } = {},
) {
  assertValidInteropResult(baseline);
  assertValidInteropResult(candidate);
  const sameMachine = baseline.environment?.machineId && baseline.environment.machineId === candidate.environment?.machineId;
  const baselineCases = new Map(baseline.cases.map((entry) => [entry.caseId, entry]));
  const comparisons = [];
  for (const entry of candidate.cases) {
    const prior = baselineCases.get(entry.caseId);
    if (!prior) continue;
    const ratio = prior.summary.p50Ms === 0 ? 0 : entry.summary.p50Ms / prior.summary.p50Ms - 1;
    comparisons.push({
      caseId: entry.caseId,
      baselineP50Ms: prior.summary.p50Ms,
      candidateP50Ms: entry.summary.p50Ms,
      ratio,
      status: !sameMachine
        ? "informational"
        : ratio > failureRatio
          ? confirmedRepeat
            ? "fail"
            : "repeat-required"
          : ratio > warningRatio
            ? "warn"
            : "pass",
    });
  }
  return {
    sameMachine: Boolean(sameMachine),
    warningRatio,
    failureRatio,
    status: comparisons.some(({ status }) => status === "fail")
      ? "fail"
      : comparisons.some(({ status }) => status === "repeat-required")
        ? "repeat-required"
      : comparisons.some(({ status }) => status === "warn")
        ? "warn"
        : sameMachine
          ? "pass"
          : "informational",
    comparisons,
    note: sameMachine
      ? confirmedRepeat
        ? "The caller confirmed this is the required repeated registered-runner execution; >10% regressions fail."
        : "A single >10% result is a signal; rerun and pass confirmedRepeat only when the registered-runner regression repeats."
      : "Different or unidentified machines are informational only; absolute thresholds are not portable.",
  };
}

async function main() {
  const [, , baselinePath, candidatePath] = process.argv;
  if (!baselinePath || !candidatePath) throw new Error("Usage: node benchmarks/interop/compare.mjs <baseline.json> <candidate.json>");
  const [baseline, candidate] = await Promise.all(
    [baselinePath, candidatePath].map(async (path) => JSON.parse(await readFile(path, "utf8"))),
  );
  const comparison = compareInteropResults(baseline, candidate, {
    confirmedRepeat: process.argv.includes("--confirmed"),
  });
  process.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`);
  if (comparison.status === "fail") process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
