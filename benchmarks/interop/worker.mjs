import createZ8LuaPhase0CModule from "/wasm/dist/z8lua-phase-0c.mjs";
import { runInteropBenchmark } from "./runner.mjs";
import { assertValidInteropResult } from "./validate.mjs";

self.addEventListener("message", async ({ data }) => {
  if (data?.type !== "run") return;
  try {
    const [manifestResponse, metadataResponse] = await Promise.all([
      fetch("./case-manifest.json", { cache: "no-store" }),
      fetch("/__phase0c_metadata.json", { cache: "no-store" }),
    ]);
    if (!manifestResponse.ok || !metadataResponse.ok) throw new Error("Unable to load benchmark metadata");
    const [manifest, metadata] = await Promise.all([manifestResponse.json(), metadataResponse.json()]);
    const module = await createZ8LuaPhase0CModule();
    const smoke = Boolean(data.smoke);
    const result = await runInteropBenchmark({
      module,
      manifest,
      sourceRevision: metadata.sourceRevision,
      artifact: metadata.artifact,
      environment: {
        runtime: `${navigator.userAgent} (DedicatedWorker)`,
        userAgent: navigator.userAgent,
        hardwareConcurrency: navigator.hardwareConcurrency ?? 0,
        language: navigator.language,
        crossOriginIsolated: self.crossOriginIsolated,
        ...metadata.machine,
      },
      availability: metadata.availability,
      protocolOverrides: smoke
        ? {
            warmupFrames: 2,
            measuredSamples: 3,
            targetSampleDurationMs: 2,
            maximumCalibrationRepeats: 4096,
            callCounts: [1024],
            byteStringLengths: [0, 8, 1024],
          }
        : {},
      onProgress(progress) {
        self.postMessage({ type: "progress", progress });
      },
    });
    assertValidInteropResult(result);
    self.postMessage({ type: "complete", result });
  } catch (error) {
    self.postMessage({
      type: "error",
      error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
    });
  }
});
