import { mountPico8Player } from "../../apps/web-player/dist/main/main.js";
import { inputSnapshot } from "../helpers/input.mjs";

const DATABASE_NAME = "pico8-web-player";
const STORE_NAME = "cartdata";
const resultNode = document.querySelector("#result");
const startButton = document.querySelector("#start");
const workerErrors = [];
const workerPorts = [];
let workersCreated = 0;
let workersTerminated = 0;
window.__phase4gMeasurementReady = false;
window.__phase4gMeasurementStart = false;
window.__phase4gMeasurementDone = false;
window.__phase4gMeasurementFinish = false;
window.__phase4gCdpHeap = null;

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(predicate, message, timeoutMs = 10_000) {
  const deadline = performance.now() + timeoutMs;
  while (!(await predicate())) {
    if (performance.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function cloneFrameEvent(value) {
  return {
    ...value,
    packedScreen: value.packedScreen.slice(0),
    displayPalette: value.displayPalette.slice(0),
  };
}

class InstrumentedWorkerPort {
  constructor(url, label) {
    this.label = label;
    this.listeners = new Set();
    this.latestFrame = undefined;
    this.worker = new Worker(url, { type: "module" });
    workersCreated += 1;
    this.worker.addEventListener("error", (event) => {
      workerErrors.push(`${label}: ${event.message} @ ${event.filename}:${event.lineno}`);
    });
    this.worker.addEventListener("message", (event) => {
      if (event.data?.type === "frame") this.latestFrame = cloneFrameEvent(event.data);
      for (const listener of this.listeners) listener(event);
    });
  }

  addEventListener(type, listener) {
    if (type === "message") this.listeners.add(listener);
  }

  postMessage(message, transfer) {
    this.worker.postMessage(message, transfer ?? []);
  }

  postRaw(message) {
    this.worker.postMessage(message);
  }

  inject(message) {
    for (const listener of this.listeners) listener({ data: message });
  }

  terminate() {
    workersTerminated += 1;
    this.worker.terminate();
  }
}

function workerFactory(label, query = "") {
  return () => {
    const port = new InstrumentedWorkerPort(
      `/apps/web-player/dist/browser/player-worker.mjs${query}`,
      label,
    );
    workerPorts.push(port);
    return port;
  };
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
    request.addEventListener("blocked", () => reject(new Error("IndexedDB request blocked")), {
      once: true,
    });
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", resolve, { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error), { once: true });
  });
}

async function deleteDatabase() {
  await requestResult(indexedDB.deleteDatabase(DATABASE_NAME));
}

async function readCartdataRecord(id) {
  const database = await requestResult(indexedDB.open(DATABASE_NAME));
  try {
    if (!database.objectStoreNames.contains(STORE_NAME)) return undefined;
    const transaction = database.transaction(STORE_NAME, "readonly");
    const record = await requestResult(
      transaction.objectStore(STORE_NAME).get(["default", id]),
    );
    await transactionDone(transaction);
    return record;
  } finally {
    database.close();
  }
}

async function sha256(value) {
  const bytes = value instanceof Uint8Array ? value.slice() : new Uint8Array(value).slice();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function loadAssets(manifest) {
  const assets = new Map();
  for (const entry of manifest.carts) {
    const response = await fetch(`/${entry.source}`);
    check(response.ok, `failed to fetch ${entry.source}: ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    check(await sha256(bytes) === entry.sourceSha256, `${entry.id} source hash drifted`);
    assets.set(entry.id, bytes);
  }
  return assets;
}

function installDomListenerTracker(roots) {
  const originalAdd = EventTarget.prototype.addEventListener;
  const originalRemove = EventTarget.prototype.removeEventListener;
  const records = [];
  const capture = (options) => typeof options === "boolean" ? options : Boolean(options?.capture);
  const owned = (target) => target === window || target === document ||
    (target instanceof Node && roots.some((root) => root === target || root.contains(target)));
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (owned(this) && listener !== null) {
      const usesCapture = capture(options);
      if (!records.some((entry) => entry.target === this && entry.type === type &&
        entry.listener === listener && entry.capture === usesCapture)) {
        records.push({ target: this, type, listener, capture: usesCapture });
      }
    }
    return originalAdd.call(this, type, listener, options);
  };
  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    const usesCapture = capture(options);
    const index = records.findIndex((entry) => entry.target === this && entry.type === type &&
      entry.listener === listener && entry.capture === usesCapture);
    if (index >= 0) records.splice(index, 1);
    return originalRemove.call(this, type, listener, options);
  };
  return {
    active: () => records.length,
    restore() {
      EventTarget.prototype.addEventListener = originalAdd;
      EventTarget.prototype.removeEventListener = originalRemove;
    },
  };
}

function installRafTracker() {
  const originalRequest = window.requestAnimationFrame.bind(window);
  const originalCancel = window.cancelAnimationFrame.bind(window);
  const active = new Set();
  window.requestAnimationFrame = (callback) => {
    let handle = 0;
    handle = originalRequest((timestamp) => {
      active.delete(handle);
      callback(timestamp);
    });
    active.add(handle);
    return handle;
  };
  window.cancelAnimationFrame = (handle) => {
    active.delete(handle);
    originalCancel(handle);
  };
  return {
    active: () => active.size,
    restore() {
      window.requestAnimationFrame = originalRequest;
      window.cancelAnimationFrame = originalCancel;
    },
  };
}

function packedPixel(screen, x, y) {
  const byte = screen[y * 64 + Math.floor(x / 2)];
  return x % 2 === 0 ? byte & 0x0f : byte >>> 4;
}

async function probeStalePcm(composition, generation) {
  const before = await composition.audio.waitForStats(
    (stats) => stats.sessionGeneration === generation,
    5_000,
  );
  let testPort;
  composition.audio.attach({
    sessionGeneration: generation,
    attachAudioPort(port) {
      testPort = port;
    },
  });
  check(testPort !== undefined, "stale PCM probe did not receive a MessagePort");
  testPort.start();
  await composition.audio.waitForStats(
    (stats) => stats !== before && stats.sessionGeneration === generation,
    5_000,
  );
  testPort.postMessage({
    v: 1,
    type: "audioChunk",
    sessionGeneration: Math.max(0, generation - 1),
    sequence: 0,
    firstSample: "0",
    sampleRate: 22_050,
    frameCount: 1,
    pcm16le: new ArrayBuffer(2),
  });
  const rejected = await composition.audio.waitForStats(
    (stats) => stats.sessionGeneration === generation &&
      stats.staleChunks === before.staleChunks + 1,
    5_000,
  );
  composition.audio.attach(composition.runtime);
  await composition.audio.waitForStats(
    (stats) => stats.sessionGeneration === generation && stats.staleChunks === 0,
    5_000,
  );
  return {
    generation,
    staleChunksBefore: before.staleChunks,
    staleChunksAfter: rejected.staleChunks,
  };
}

function staleInput(port, runtime, generation) {
  port.postRaw({
    v: 1,
    type: "input",
    requestId: 0,
    workerGeneration: runtime.workerGeneration,
    sessionGeneration: Math.max(0, generation - 1),
    sequence: 0xffff_ffff,
    input: inputSnapshot([1]),
  });
}

function probeStaleFrame(port, runtime, generation, template, frameCount) {
  check(template !== undefined, "stale frame probe has no frame template");
  const stale = cloneFrameEvent(template);
  stale.workerGeneration = runtime.workerGeneration;
  stale.sessionGeneration = Math.max(0, generation - 1);
  port.inject(stale);
  check(frameCount() === 0, "stale frame escaped the RuntimeClient generation gate");
}

async function oneFrame(composition, frames, baseMs, targetFps) {
  const before = frames.length;
  const anchor = await composition.pulse(baseMs, inputSnapshot());
  check(anchor.type === "heartbeat" && anchor.tickCount === 0, "anchor pulse drifted");
  const heartbeat = await composition.pulse(baseMs + 1000 / targetFps, inputSnapshot());
  check(heartbeat.type === "heartbeat" && heartbeat.tickCount === 1, "logical tick drifted");
  check(frames.length === before + 1, "logical frame was not published");
  return frames.at(-1);
}

async function runLifecycle(mounted, manifest, assets, port) {
  const { composition } = mounted;
  const frames = [];
  const stalePcm = [];
  const actions = [];
  let generationCount = 0;
  let staleInputProbes = 0;
  let staleFrameProbes = 0;
  let template;
  let baseMs = 1_000;
  const remove = composition.runtime.onEvent((event) => {
    if (event.type === "frame") {
      frames.push({
        generation: event.sessionGeneration,
        screen: new Uint8Array(event.packedScreen).slice(),
      });
    }
  });

  async function probeGeneration(entry) {
    const generation = composition.runtime.sessionGeneration;
    generationCount += 1;
    staleInput(port, composition.runtime, generation);
    staleInputProbes += 1;
    stalePcm.push(await probeStalePcm(composition, generation));
    if (template !== undefined) {
      const before = frames.length;
      probeStaleFrame(port, composition.runtime, generation, template,
        () => frames.length - before);
      staleFrameProbes += 1;
    }
    await composition.start();
    const frame = await oneFrame(composition, frames, baseMs, entry.targetFps);
    baseMs += 10_000;
    template = port.latestFrame;
    if (staleFrameProbes === 0) {
      const before = frames.length;
      probeStaleFrame(port, composition.runtime, generation, template,
        () => frames.length - before);
      staleFrameProbes += 1;
    }
    if (entry.id === "phase-4/resource-stable-30" ||
      entry.id === "phase-4/resource-stable-60") {
      check(packedPixel(frame.screen, 0, 1) === 7,
        `${entry.id} accepted stale held input`);
    }
  }

  try {
    for (let index = 0; index < manifest.lifecycle.sequence.length; index += 1) {
      const id = manifest.lifecycle.sequence[index];
      const entry = manifest.carts.find((candidate) => candidate.id === id);
      document.body.dataset.progress = `lifecycle ${index + 1}/${manifest.lifecycle.requiredLoads}: ${id}`;
      const ready = await composition.loadCart(assets.get(id), entry.instructionBudget);
      check(ready.type === "state" && ready.state === "ready", `${id} did not load`);
      const generation = composition.runtime.sessionGeneration;
      generationCount += 1;
      staleInput(port, composition.runtime, generation);
      staleInputProbes += 1;
      stalePcm.push(await probeStalePcm(composition, generation));
      if (template !== undefined) {
        const before = frames.length;
        probeStaleFrame(port, composition.runtime, generation, template,
          () => frames.length - before);
        staleFrameProbes += 1;
      }

      await composition.start();
      let faultCode = null;
      try {
        const frame = await oneFrame(composition, frames, baseMs, entry.targetFps ?? 30);
        template = port.latestFrame;
        if (template !== undefined && staleFrameProbes < generationCount) {
          const before = frames.length;
          probeStaleFrame(port, composition.runtime, generation, template,
            () => frames.length - before);
          staleFrameProbes += 1;
        }
        if (id === "phase-4/resource-stable-30" || id === "phase-4/resource-stable-60") {
          check(packedPixel(frame.screen, 0, 1) === 7, `${id} accepted stale input`);
        }
      } catch (error) {
        faultCode = error?.record?.code ?? null;
      }
      baseMs += 10_000;

      if (entry.expectedCode !== undefined) {
        check(faultCode === entry.expectedCode, `${id} fault drifted: ${faultCode}`);
        actions.push({ index, id, generation, action: "fault", faultCode });
        continue;
      }
      check(faultCode === null, `${id} faulted unexpectedly: ${faultCode}`);
      if ((index + 1) % 5 === 0) {
        await composition.pause();
        const reset = await composition.reset();
        check(reset.type === "state" && reset.state === "ready", `${id} reset failed`);
        await probeGeneration(entry);
        await composition.stop();
        actions.push({ index, id, generation, action: "pause-reset-start-stop" });
      } else if (index % 2 === 0) {
        await composition.pause();
        actions.push({ index, id, generation, action: "pause" });
      } else {
        await composition.stop();
        actions.push({ index, id, generation, action: "stop" });
      }
    }
    const persisted = await readCartdataRecord("phase3h_store");
    check(persisted?.bytes instanceof ArrayBuffer, "multi-cart persistence did not flush");
    check(staleInputProbes === generationCount, "not every generation probed stale input");
    check(stalePcm.length === generationCount, "not every generation probed stale PCM");
    check(staleFrameProbes === generationCount, "not every generation probed stale frame");
    return {
      loads: manifest.lifecycle.sequence.length,
      generations: generationCount,
      actions,
      staleInputProbes,
      staleFrameProbes,
      stalePcmProbes: stalePcm.length,
      persistedCountRaw: new DataView(persisted.bytes).getInt32(0, true),
    };
  } finally {
    remove();
  }
}

async function runMinimumHeap(mounted, manifest, assets) {
  const { composition, controller } = mounted;
  let oomCode = null;
  let oomDetails = null;
  try {
    await composition.loadCart(assets.get("phase-4/resource-oom"));
  } catch (error) {
    oomCode = error?.record?.code ?? null;
    oomDetails = error?.record?.details ?? null;
  }
  check(oomCode === "E_VM_OOM", `minimum heap fault drifted: ${oomCode}`);
  check(oomDetails?.luaHeapLimit === manifest.limits.luaHeap.minimumBytes,
    "minimum heap was not reported in the OOM fault");
  const faultStats = await composition.audio.requestStats();
  check(faultStats.queuedSourceFrames === 0, "OOM committed partial PCM");
  const ready = await composition.loadCart(assets.get("phase-4/resource-minimum-recovery"));
  check(ready.type === "state" && ready.state === "ready", "minimum-heap recovery failed");
  await composition.start();
  const frames = [];
  const remove = composition.runtime.onEvent((event) => {
    if (event.type === "frame") frames.push(event.frameId);
  });
  try {
    const anchor = await composition.pulse(1_000, inputSnapshot());
    check(anchor.type === "heartbeat" && anchor.tickCount === 0,
      "minimum-heap recovery anchor drifted");
    const heartbeat = await composition.pulse(1_000 + 1000 / 30, inputSnapshot());
    check(heartbeat.type === "heartbeat" && heartbeat.tickCount === 1,
      "minimum-heap recovery tick drifted");
    check(frames.length === 1, "minimum-heap recovery emitted no frame");
  } finally {
    remove();
  }
  await composition.stop();
  const recoveryStats = await composition.audio.waitForStats(
    (stats) => stats.sessionGeneration === composition.runtime.sessionGeneration &&
      stats.queuedSourceFrames === 0,
    5_000,
  );
  const audio = composition.audio;
  await controller.dispose();
  return {
    oomCode,
    oomDetails,
    faultQueuedFrames: faultStats.queuedSourceFrames,
    recoveryGeneration: composition.runtime.sessionGeneration,
    recoveryQueuedFrames: recoveryStats.queuedSourceFrames,
    audioStateAfterDispose: audio.contextState,
  };
}

function startPump(composition) {
  let active = true;
  let error;
  const completed = (async () => {
    while (active) {
      const timestamp = await new Promise((resolve) => requestAnimationFrame(resolve));
      if (!active) break;
      try {
        await composition.pulse(timestamp, inputSnapshot());
      } catch (caught) {
        error = caught;
        active = false;
      }
    }
  })();
  return {
    stop: async () => {
      active = false;
      await completed;
      if (error !== undefined) throw error;
    },
  };
}

function createSoakCounter(composition) {
  const value = { frames: 0, ticks: 0, droppedTicks: 0, discontinuities: 0 };
  const remove = composition.runtime.onEvent((event) => {
    if (event.type === "frame") value.frames += 1;
    if (event.type === "heartbeat") {
      value.ticks += event.tickCount;
      value.droppedTicks += event.droppedTicks;
    }
    if (event.type === "diagnostic" && event.error.code === "E_TIME_DISCONTINUITY") {
      value.discontinuities += 1;
    }
  });
  return { value, remove };
}

function deltaCounter(final, baseline) {
  return Object.fromEntries(Object.keys(final).map((key) => [key, final[key] - baseline[key]]));
}

function heapBytes() {
  return typeof performance.memory?.usedJSHeapSize === "number"
    ? performance.memory.usedJSHeapSize
    : null;
}

async function runSoak(lifecycleMounted, soak30Mounted, manifest, assets, soakSeconds) {
  const sixty = lifecycleMounted.composition;
  const thirty = soak30Mounted.composition;
  const counters = [createSoakCounter(thirty), createSoakCounter(sixty)];
  const longTasks = [];
  let measurementActive = false;
  const observer = PerformanceObserver.supportedEntryTypes.includes("longtask")
    ? new PerformanceObserver((list) => {
        if (!measurementActive) return;
        for (const entry of list.getEntries()) {
          longTasks.push({ startTime: entry.startTime, duration: entry.duration });
        }
      })
    : undefined;
  observer?.observe({ entryTypes: ["longtask"] });
  try {
    await sixty.loadCart(assets.get("phase-4/resource-stable-60"));
    await thirty.loadCart(assets.get("phase-4/resource-stable-30"));
    await Promise.all([sixty.start(), thirty.start()]);
    const pumps = [startPump(thirty), startPump(sixty)];
    await Promise.all([
      thirty.audio.waitForStats((stats) => stats.playing, 15_000),
      sixty.audio.waitForStats((stats) => stats.playing, 15_000),
    ]);
    document.body.dataset.progress =
      `warming production paths for ${manifest.chrome.preMeasurementWarmupSeconds}s`;
    await new Promise((resolve) => setTimeout(
      resolve,
      manifest.chrome.preMeasurementWarmupSeconds * 1000,
    ));
    window.__phase4gMeasurementReady = true;
    await waitFor(() => window.__phase4gMeasurementStart,
      "CDP did not release the Phase 4G measurement start", 30_000);
    const baselineAudio = await Promise.all([
      thirty.audio.requestStats(),
      sixty.audio.requestStats(),
    ]);
    const baselineCounters = counters.map(({ value }) => ({ ...value }));
    const heapSamples = [{ elapsedMs: 0, usedBytes: heapBytes() }];
    const heapBefore = heapSamples[0].usedBytes;
    const sampleEveryMs = Math.min(60_000, Math.max(1_000, soakSeconds * 200));
    let nextHeapSample = sampleEveryMs;
    measurementActive = true;
    const startedAt = performance.now();
    let elapsedMs = 0;
    while (elapsedMs < soakSeconds * 1_000) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000, soakSeconds * 1000)));
      elapsedMs = performance.now() - startedAt;
      document.body.dataset.progress = `Chrome soak ${Math.floor(elapsedMs / 1000)}/${soakSeconds}s`;
      if (elapsedMs >= nextHeapSample) {
        heapSamples.push({ elapsedMs, usedBytes: heapBytes() });
        nextHeapSample += sampleEveryMs;
      }
    }
    const actualDurationMs = performance.now() - startedAt;
    measurementActive = false;
    await Promise.all(pumps.map((pump) => pump.stop()));
    const heapAfter = heapBytes();
    heapSamples.push({ elapsedMs: actualDurationMs, usedBytes: heapAfter });
    window.__phase4gMeasurementDone = true;
    await waitFor(() => window.__phase4gMeasurementFinish,
      "CDP did not release the Phase 4G measurement finish", 30_000);
    const cdpHeap = window.__phase4gCdpHeap;
    check(cdpHeap?.status === "measured", "CDP retained-heap measurement was unavailable");
    const finalAudio = await Promise.all([
      thirty.audio.requestStats(),
      sixty.audio.requestStats(),
    ]);
    const finalCounters = counters.map(({ value }) => ({ ...value }));
    const profiles = [30, 60].map((targetFps, index) => {
      const counts = deltaCounter(finalCounters[index], baselineCounters[index]);
      const expectedTicks = actualDurationMs * targetFps / 1000;
      return {
        targetFps,
        ...counts,
        expectedTicks,
        cadenceRatio: counts.ticks / expectedTicks,
        droppedTickRatio: counts.droppedTicks /
          Math.max(1, counts.ticks + counts.droppedTicks),
        baselineAudio: baselineAudio[index],
        finalAudio: finalAudio[index],
        audioDelta: {
          startupUnderruns: finalAudio[index].startupUnderruns -
            baselineAudio[index].startupUnderruns,
          steadyUnderruns: finalAudio[index].steadyUnderruns -
            baselineAudio[index].steadyUnderruns,
          overruns: finalAudio[index].overruns - baselineAudio[index].overruns,
          droppedSourceFrames: finalAudio[index].droppedSourceFrames -
            baselineAudio[index].droppedSourceFrames,
          discontinuities: finalAudio[index].discontinuities -
            baselineAudio[index].discontinuities,
          staleChunks: finalAudio[index].staleChunks - baselineAudio[index].staleChunks,
        },
      };
    });
    await Promise.all([thirty.stop(), sixty.stop()]);
    const releasedAudio = await Promise.all([
      thirty.audio.waitForStats((stats) => stats.queuedSourceFrames === 0, 5_000),
      sixty.audio.waitForStats((stats) => stats.queuedSourceFrames === 0, 5_000),
    ]);
    await Promise.all([thirty.suspendAudio(), sixty.suspendAudio()]);
    return {
      requestedSeconds: soakSeconds,
      actualDurationMs,
      profiles,
      longTaskSupport: observer === undefined ? "unavailable" : "measured",
      longTasks,
      heap: {
        status: heapBefore === null || heapAfter === null ? "unavailable" : "measured",
        beforeBytes: heapBefore,
        afterBytes: heapAfter,
        deltaBytes: heapBefore === null || heapAfter === null ? null : heapAfter - heapBefore,
        samples: heapSamples,
        cdp: cdpHeap,
      },
      releasedAudio: releasedAudio.map((stats) => ({
        sessionGeneration: stats.sessionGeneration,
        queuedSourceFrames: stats.queuedSourceFrames,
        playing: stats.playing,
      })),
    };
  } finally {
    measurementActive = false;
    observer?.disconnect();
    for (const counter of counters) counter.remove();
  }
}

async function run() {
  await deleteDatabase();
  const manifest = await fetch(
    "/tests/conformance/manifests/phase-4g-resource-long-run.json",
  ).then((response) => response.json());
  const assets = await loadAssets(manifest);
  const soakSecondsText = new URL(location.href).searchParams.get("soakSeconds");
  const soakSeconds = soakSecondsText === null ? manifest.chrome.smokeSeconds : Number(soakSecondsText);
  check(Number.isFinite(soakSeconds) && soakSeconds > 0, "invalid soakSeconds");

  const roots = [
    document.querySelector("#lifecycle-player"),
    document.querySelector("#minimum-player"),
    document.querySelector("#soak30-player"),
  ];
  const listenerTracker = installDomListenerTracker(roots);
  const rafTracker = installRafTracker();
  const lifecycleMounted = await mountPico8Player({
    root: roots[0],
    runtimeWorkerFactory: workerFactory("lifecycle"),
    commandTimeoutMs: 5_000,
    workletModuleUrl: "/apps/web-player/dist/worklet/pico8-audio-processor.js",
    audio: { requestedSampleRate: 48_000, outputGain: 0 },
  });
  const minimumMounted = await mountPico8Player({
    root: roots[1],
    runtimeWorkerFactory: workerFactory("minimum", "?luaHeapLimit=32768"),
    commandTimeoutMs: 5_000,
    workletModuleUrl: "/apps/web-player/dist/worklet/pico8-audio-processor.js",
    audio: { requestedSampleRate: 48_000, outputGain: 0 },
  });
  const soak30Mounted = await mountPico8Player({
    root: roots[2],
    runtimeWorkerFactory: workerFactory("soak30"),
    commandTimeoutMs: 5_000,
    workletModuleUrl: "/apps/web-player/dist/worklet/pico8-audio-processor.js",
    audio: { requestedSampleRate: 48_000, outputGain: 0 },
  });
  try {
    startButton.disabled = false;
    document.body.dataset.status = "awaiting-gesture";
    document.body.dataset.progress = "awaiting trusted AudioContext gesture";
    return await new Promise((resolve, reject) => {
      startButton.addEventListener("click", async (event) => {
        try {
          startButton.disabled = true;
          const gesture = {
            eventIsTrusted: event.isTrusted,
            userActivationIsActive: navigator.userActivation.isActive,
          };
          await Promise.all([
            lifecycleMounted.composition.resumeAudio(),
            minimumMounted.composition.resumeAudio(),
            soak30Mounted.composition.resumeAudio(),
          ]);
          const lifecyclePort = workerPorts.find(({ label }) => label === "lifecycle");
          const lifecycle = await runLifecycle(
            lifecycleMounted,
            manifest,
            assets,
            lifecyclePort,
          );
          const minimumHeap = await runMinimumHeap(minimumMounted, manifest, assets);
          const soak = await runSoak(
            lifecycleMounted,
            soak30Mounted,
            manifest,
            assets,
            soakSeconds,
          );
          await Promise.all([
            lifecycleMounted.controller.dispose(),
            soak30Mounted.controller.dispose(),
          ]);
          await waitFor(() => workersCreated === workersTerminated,
            "disposed Phase 4G players retained a Worker", 5_000);
          await waitFor(() => rafTracker.active() === 0,
            "disposed Phase 4G players retained an animation frame", 5_000);
          const activeListeners = listenerTracker.active();
          check(activeListeners === 0,
            `disposed Phase 4G players retained ${activeListeners} DOM listeners`);
          resolve({
            phase: "4G",
            gesture,
            limits: manifest.limits,
            lifecycle,
            minimumHeap,
            soak,
            resources: {
              workersCreated,
              workersTerminated,
              activeAnimationFrames: rafTracker.active(),
              activeDomListeners: activeListeners,
              audioStates: [
                lifecycleMounted.composition.audio.contextState,
                minimumMounted.composition.audio.contextState,
                soak30Mounted.composition.audio.contextState,
              ],
            },
            workerErrors,
            userAgent: navigator.userAgent,
          });
        } catch (error) {
          reject(error);
        }
      }, { once: true });
    });
  } finally {
    await Promise.all([
      lifecycleMounted.controller.dispose().catch(() => undefined),
      minimumMounted.controller.dispose().catch(() => undefined),
      soak30Mounted.controller.dispose().catch(() => undefined),
    ]);
    listenerTracker.restore();
    rafTracker.restore();
  }
}

try {
  const result = await run();
  window.phase4gResult = result;
  resultNode.textContent = JSON.stringify(result, null, 2);
  document.body.dataset.progress = "complete";
  document.body.dataset.status = "complete";
} catch (error) {
  resultNode.textContent = error instanceof Error
    ? `${error.message}\n${error.stack ?? ""}`
    : String(error);
  document.body.dataset.status = "error";
}
