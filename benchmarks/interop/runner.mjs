const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;
const DEFAULT_SEED = 0x12345678;
const MAX_SPRITE_POSITION = 120;

function nextRandom(state) {
  return (Math.imul(state, 1664525) + 1013904223) >>> 0;
}

function combine(accumulator, value, index) {
  return Math.imul((accumulator ^ value ^ index) >>> 0, FNV_PRIME) >>> 0;
}

function fnv1a(bytes) {
  let hash = FNV_OFFSET;
  for (const byte of bytes) {
    hash = Math.imul(hash ^ byte, FNV_PRIME) >>> 0;
  }
  return hash;
}

function byteChecksum(bytes) {
  return fnv1a(bytes);
}

function raw3Value(a, b, c) {
  return ((a + ((b << 7) | (b >>> 25))) ^ c) >>> 0;
}

function quantile(sorted, probability) {
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const fraction = position - lower;
  return sorted[lower] + (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]) * fraction;
}

function summarize(samples, callsPerFrame) {
  const sorted = [...samples].sort((left, right) => left - right);
  const p50Ms = quantile(sorted, 0.5);
  return {
    p50Ms,
    p95Ms: quantile(sorted, 0.95),
    p99Ms: quantile(sorted, 0.99),
    meanMs: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    minMs: sorted[0],
    maxMs: sorted.at(-1),
    callsPerSecondAtP50: p50Ms === 0 ? null : callsPerFrame / (p50Ms / 1000),
    nanosecondsPerCallAtP50: (p50Ms * 1_000_000) / callsPerFrame,
  };
}

function timerResolution(now) {
  let previous = now();
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 0; index < 10_000; index += 1) {
    const current = now();
    const delta = current - previous;
    if (delta > 0 && delta < minimum) minimum = delta;
    previous = current;
  }
  return Number.isFinite(minimum) ? minimum : 0;
}

function jsHeapSnapshot() {
  const memory = globalThis.performance?.memory;
  if (!memory || !Number.isFinite(memory.usedJSHeapSize)) {
    return { status: "unavailable", reason: "performance.memory is not exposed" };
  }
  return { status: "measured", usedBytes: memory.usedJSHeapSize };
}

function seedRam(context) {
  context.module._p8w0b_ram_reset(context.handle);
  for (let index = 0; index < 0x2000; index += 1) {
    context.ram[index] = (index * 37 + 11) & 0xff;
  }
}

function makeDirectFrame(context, spec) {
  const { module, handle, bytePointer } = context;
  const { operation, callsPerFrame, byteLength, seed } = spec;
  return () => {
    let state = seed;
    let accumulator = FNV_OFFSET;
    for (let index = 0; index < callsPerFrame; index += 1) {
      let result;
      switch (operation) {
        case "noop_scalar":
          state = nextRandom(state);
          result = module._p8w0c_bench_export_noop(state);
          break;
        case "raw_q16x3": {
          state = nextRandom(state);
          const a = state;
          state = nextRandom(state);
          const b = state;
          state = nextRandom(state);
          result = module._p8w0c_bench_export_raw3(a, b, state);
          break;
        }
        case "byte_string":
          state = nextRandom(state);
          result = module._p8w0c_bench_export_bytes(bytePointer, byteLength) ^ state;
          break;
        case "pset": {
          state = nextRandom(state);
          const x = state & 0x7f;
          state = nextRandom(state);
          const y = state & 0x7f;
          state = nextRandom(state);
          result = module._p8w0c_bench_export_pset(handle, x, y, state & 0x0f);
          break;
        }
        case "peek_poke": {
          state = nextRandom(state);
          const logical = (state & 1) === 0 ? state & 0x1fff : 0x6000 + (state & 0x1fff);
          state = nextRandom(state);
          result = module._p8w0c_bench_export_peek_poke(handle, logical, state);
          break;
        }
        case "spr_8x8": {
          state = nextRandom(state);
          const sprite = state & 0x7f;
          state = nextRandom(state);
          const x = state % (MAX_SPRITE_POSITION + 1);
          state = nextRandom(state);
          result = module._p8w0c_bench_export_spr(handle, sprite, x, state % (MAX_SPRITE_POSITION + 1));
          break;
        }
        default:
          throw new Error(`Unknown operation: ${operation}`);
      }
      accumulator = combine(accumulator, result >>> 0, index);
    }
    return accumulator >>> 0;
  };
}

function makeLoopFrame(context, spec, kind) {
  const { module, handle, bytePointer } = context;
  const prefix = kind === "import" ? "_p8w0c_bench_import_" : "_p8w0c_bench_control_";
  const suffix = {
    noop_scalar: "noop",
    raw_q16x3: "raw3",
    byte_string: "bytes",
    pset: "pset",
    peek_poke: "peek_poke",
    spr_8x8: "spr",
  }[spec.operation];
  const operation = module[`${prefix}${suffix}`];
  if (typeof operation !== "function") throw new Error(`Missing benchmark export: ${prefix}${suffix}`);

  if (spec.operation === "byte_string") {
    return () => operation(bytePointer, spec.byteLength, spec.callsPerFrame, spec.seed) >>> 0;
  }
  if (["pset", "peek_poke", "spr_8x8"].includes(spec.operation)) {
    return () => operation(handle, spec.callsPerFrame, spec.seed) >>> 0;
  }
  return () => operation(spec.callsPerFrame, spec.seed) >>> 0;
}

function writePackedPixel(ram, physicalAddress, x, color) {
  const shift = (x & 1) << 2;
  const mask = 0x0f << shift;
  const updated = (ram[physicalAddress] & ~mask) | ((color & 0x0f) << shift);
  ram[physicalAddress] = updated;
  return updated;
}

function makeSharedMemoryFrame(context, spec) {
  const { ram, gfxBase, screenBase, byteBytes } = context;
  return () => {
    let state = spec.seed;
    let accumulator = FNV_OFFSET;
    for (let index = 0; index < spec.callsPerFrame; index += 1) {
      let result;
      switch (spec.operation) {
        case "noop_scalar":
          state = nextRandom(state);
          result = state;
          break;
        case "raw_q16x3": {
          state = nextRandom(state);
          const a = state;
          state = nextRandom(state);
          const b = state;
          state = nextRandom(state);
          result = raw3Value(a, b, state);
          break;
        }
        case "byte_string":
          state = nextRandom(state);
          result = byteChecksum(byteBytes.subarray(0, spec.byteLength)) ^ state;
          break;
        case "pset": {
          state = nextRandom(state);
          const x = state & 0x7f;
          state = nextRandom(state);
          const y = state & 0x7f;
          state = nextRandom(state);
          result = writePackedPixel(ram, screenBase + y * 64 + (x >>> 1), x, state & 0x0f);
          break;
        }
        case "peek_poke": {
          state = nextRandom(state);
          const physical = ((state & 1) === 0 ? gfxBase : screenBase) + (state & 0x1fff);
          state = nextRandom(state);
          const previous = ram[physical];
          const updated = state & 0xff;
          ram[physical] = updated;
          result = previous | (updated << 8);
          break;
        }
        case "spr_8x8": {
          state = nextRandom(state);
          const sprite = state & 0x7f;
          state = nextRandom(state);
          const destinationX = state % (MAX_SPRITE_POSITION + 1);
          state = nextRandom(state);
          const destinationY = state % (MAX_SPRITE_POSITION + 1);
          const sourceX = (sprite & 0x0f) << 3;
          const sourceY = (sprite >>> 4) << 3;
          let hash = FNV_OFFSET;
          for (let row = 0; row < 8; row += 1) {
            for (let column = 0; column < 8; column += 1) {
              const x = sourceX + column;
              const packed = ram[gfxBase + (sourceY + row) * 64 + (x >>> 1)];
              const color = (packed >>> ((x & 1) << 2)) & 0x0f;
              const outputX = destinationX + column;
              const updated = writePackedPixel(
                ram,
                screenBase + (destinationY + row) * 64 + (outputX >>> 1),
                outputX,
                color,
              );
              hash = Math.imul(hash ^ updated, FNV_PRIME) >>> 0;
            }
          }
          result = hash;
          break;
        }
        default:
          throw new Error(`Unknown operation: ${spec.operation}`);
      }
      accumulator = combine(accumulator, result >>> 0, index);
    }
    return accumulator >>> 0;
  };
}

function createFrame(context, spec, path) {
  if (path === "js_to_wasm_export") return makeDirectFrame(context, spec);
  if (path === "wasm_to_js_import") return makeLoopFrame(context, spec, "import");
  if (path === "wasm_control") return makeLoopFrame(context, spec, "control");
  if (path === "js_shared_memory") return makeSharedMemoryFrame(context, spec);
  throw new Error(`Unknown benchmark path: ${path}`);
}

function caseSpecs(manifest, overrides) {
  const allowedCounts = overrides.callCounts ?? manifest.protocol.callCounts;
  const allowedByteLengths = overrides.byteStringLengths ?? manifest.protocol.byteStringLengths;
  const specs = [];
  for (const operation of manifest.operations) {
    for (const callsPerFrame of operation.callCounts.filter((value) => allowedCounts.includes(value))) {
      const byteLengths = operation.id === "byte_string"
        ? operation.byteLengths.filter((value) => allowedByteLengths.includes(value))
        : [null];
      for (const byteLength of byteLengths) {
        for (const path of manifest.paths.map(({ id }) => id)) {
          specs.push({
            operation: operation.id,
            callsPerFrame,
            byteLength,
            path,
            seed: manifest.seed ?? DEFAULT_SEED,
          });
        }
      }
    }
  }
  return specs;
}

function contextFor(module, maximumByteLength) {
  const handle = module._p8w0b_create(0);
  if (handle === 0) throw new Error("Unable to create Phase 0B benchmark context");
  const ramPointer = module._p8w0b_ram_ptr(handle);
  const bytePointer = module._p8w0b_alloc(Math.max(maximumByteLength, 1));
  if (ramPointer === 0 || bytePointer === 0) {
    if (bytePointer !== 0) module._p8w0b_free(bytePointer);
    module._p8w0b_destroy(handle);
    throw new Error("Unable to allocate Phase 0C benchmark buffers");
  }
  const byteBytes = module.HEAPU8.subarray(bytePointer, bytePointer + maximumByteLength);
  for (let index = 0; index < byteBytes.length; index += 1) byteBytes[index] = (index * 29) & 0xff;
  return {
    module,
    handle,
    ramPointer,
    ram: module.HEAPU8.subarray(ramPointer, ramPointer + 0x10000),
    bytePointer,
    byteBytes,
    gfxBase: module._p8w0b_map_address(handle, 0),
    screenBase: module._p8w0b_map_address(handle, 0x6000),
    destroy() {
      module._p8w0b_free(bytePointer);
      module._p8w0b_destroy(handle);
    },
  };
}

async function measureCase(context, spec, protocol, now) {
  seedRam(context);
  const frame = createFrame(context, spec, spec.path);
  for (let index = 0; index < protocol.warmupFrames; index += 1) frame();

  let repeats = 1;
  let calibrationElapsedMs = 0;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const start = now();
    let sink = 0;
    for (let repeat = 0; repeat < repeats; repeat += 1) sink ^= frame();
    calibrationElapsedMs = now() - start;
    globalThis.__p8w0cBenchSink = sink;
    if (calibrationElapsedMs >= protocol.targetSampleDurationMs * 0.9 || repeats >= protocol.maximumCalibrationRepeats) break;
    const safeElapsed = Math.max(calibrationElapsedMs, protocol.timerResolutionMs || 0.001);
    repeats = Math.min(
      protocol.maximumCalibrationRepeats,
      Math.max(repeats + 1, Math.ceil(repeats * (protocol.targetSampleDurationMs / safeElapsed) * 1.1)),
    );
  }

  const samplesMsPerFrame = [];
  const heapBefore = jsHeapSnapshot();
  const bufferBefore = context.module.HEAPU8.buffer;
  const wasmBytesBefore = bufferBefore.byteLength;
  for (let sample = 0; sample < protocol.measuredSamples; sample += 1) {
    const start = now();
    let sink = 0;
    for (let repeat = 0; repeat < repeats; repeat += 1) sink ^= frame();
    const elapsed = now() - start;
    globalThis.__p8w0cBenchSink = sink;
    samplesMsPerFrame.push(elapsed / repeats);
    await Promise.resolve();
  }
  const heapAfter = jsHeapSnapshot();
  const bufferAfter = context.module.HEAPU8.buffer;
  const jsHeap = heapBefore.status === "measured" && heapAfter.status === "measured"
    ? {
        status: "measured",
        usedBytesBefore: heapBefore.usedBytes,
        usedBytesAfter: heapAfter.usedBytes,
        deltaBytes: heapAfter.usedBytes - heapBefore.usedBytes,
      }
    : heapAfter;

  return {
    calibration: {
      repeatsPerSample: repeats,
      warmupFrames: protocol.warmupFrames,
      targetSampleDurationMs: protocol.targetSampleDurationMs,
      calibrationElapsedMs,
      reachedTarget: calibrationElapsedMs >= protocol.targetSampleDurationMs * 0.9,
    },
    samplesMsPerFrame,
    summary: summarize(samplesMsPerFrame, spec.callsPerFrame),
    memory: {
      wasmBufferStable: bufferBefore === bufferAfter,
      wasmBytesBefore,
      wasmBytesAfter: bufferAfter.byteLength,
      jsHeap,
    },
  };
}

export async function runInteropBenchmark({
  module,
  manifest,
  environment,
  sourceRevision,
  artifact,
  availability,
  protocolOverrides = {},
  onProgress = () => {},
}) {
  if (module._p8w0c_bench_abi_version() >>> 0 !== manifest.benchmarkAbiVersion) {
    throw new Error("Phase 0C benchmark ABI does not match the case manifest");
  }
  const now = () => globalThis.performance.now();
  const measuredResolution = timerResolution(now);
  const protocol = {
    ...manifest.protocol,
    ...protocolOverrides,
    timerResolutionMs: measuredResolution,
    quantileMethod: "R-7 linear interpolation",
  };
  const specs = caseSpecs(manifest, protocolOverrides);
  if (specs.length === 0) throw new Error("Benchmark selection produced no cases");
  const maximumByteLength = Math.max(...manifest.protocol.byteStringLengths);
  const context = contextFor(module, maximumByteLength);
  const references = new Map();
  const cases = [];
  const initialBuffer = module.HEAPU8.buffer;
  try {
    for (let index = 0; index < specs.length; index += 1) {
      const spec = specs[index];
      const key = `${spec.operation}:${spec.callsPerFrame}:${spec.byteLength ?? "none"}`;
      const caseId = `${key}:${spec.path}`;
      onProgress({ stage: "correctness", current: index + 1, total: specs.length, caseId });
      seedRam(context);
      const checksum = createFrame(context, spec, spec.path)() >>> 0;
      const ramHash = fnv1a(context.ram);
      const reference = references.get(key);
      if (!reference) {
        references.set(key, { checksum, ramHash });
      } else if (reference.checksum !== checksum || reference.ramHash !== ramHash) {
        throw new Error(
          `Correctness mismatch for ${caseId}: expected ${reference.checksum}/${reference.ramHash}, got ${checksum}/${ramHash}`,
        );
      }
      if (module.HEAPU8.buffer !== initialBuffer) throw new Error(`Wasm memory buffer changed during ${caseId}`);

      onProgress({ stage: "measurement", current: index + 1, total: specs.length, caseId });
      const measurement = await measureCase(context, spec, protocol, now);
      if (!measurement.memory.wasmBufferStable) throw new Error(`Wasm memory grew during ${caseId}`);
      cases.push({
        caseId,
        operation: spec.operation,
        path: spec.path,
        callsPerFrame: spec.callsPerFrame,
        byteLength: spec.byteLength,
        logicalWorkUnitsPerFrame: spec.operation === "spr_8x8" ? spec.callsPerFrame * 64 : spec.callsPerFrame,
        correctness: { passed: true, resultChecksum: checksum, ramHash },
        ...measurement,
      });
    }
  } finally {
    context.destroy();
  }

  return {
    schemaVersion: manifest.schemaVersion,
    suiteId: manifest.suiteId,
    runId: `${environment.runtime}-${new Date().toISOString().replaceAll(/[:.]/gu, "-")}`,
    createdAt: new Date().toISOString(),
    sourceRevision,
    artifact: { ...artifact, benchmarkAbiVersion: manifest.benchmarkAbiVersion },
    environment: { ...environment, timerResolutionMs: measuredResolution },
    protocol: {
      warmupFrames: protocol.warmupFrames,
      measuredSamples: protocol.measuredSamples,
      targetSampleDurationMs: protocol.targetSampleDurationMs,
      maximumCalibrationRepeats: protocol.maximumCalibrationRepeats,
      quantileMethod: protocol.quantileMethod,
      seed: manifest.seed,
    },
    availability,
    cases,
    notes: [
      "Timing starts only after cross-path checksum and full 64 KiB RAM hash equality passes.",
      "JS heap deltas are diagnostic only and unavailable when the runtime does not expose performance.memory.",
      "p8w0c_bench_* is a bounded benchmark-only ABI and is not a production host API.",
    ],
  };
}

export { fnv1a, summarize };
