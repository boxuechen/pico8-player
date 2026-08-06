import {
  DedicatedAudioFrontend,
} from "../../apps/web-player/dist/main/audio-frontend.js";

const resultNode = document.querySelector("#result");
const startButton = document.querySelector("#start");
const parameters = new URLSearchParams(location.search);
const durationMs = Number(parameters.get("durationMs") ?? 5000);
const requestedRates = [44_100, 48_000];

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitForWorker(worker, type, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.removeEventListener("message", receive);
      reject(new Error(`timed out waiting for Worker ${type}`));
    }, timeoutMs);
    function receive(event) {
      if (event.data?.type !== type) return;
      clearTimeout(timer);
      worker.removeEventListener("message", receive);
      resolve(event.data);
    }
    worker.addEventListener("message", receive);
  });
}

async function prepareCase(requestedSampleRate) {
  const worker = new Worker("./phase-0f-audio-worker.mjs", { type: "module" });
  worker.addEventListener("error", (event) => {
    resultNode.textContent = `Audio Worker error: ${event.message}`;
    document.body.dataset.status = "error";
  });
  const target = {
    sessionGeneration: 1,
    attachAudioPort(port) {
      worker.postMessage(
        { type: "attach", sessionGeneration: this.sessionGeneration, port },
        [port],
      );
    },
  };
  const attached = waitForWorker(worker, "attached");
  const frontend = await DedicatedAudioFrontend.create(
    target,
    "/apps/web-player/dist/worklet/pico8-audio-processor.js",
    { requestedSampleRate, outputGain: 0 },
  );
  await attached;
  const initialState = frontend.contextState;
  const primed = waitForWorker(worker, "primed");
  worker.postMessage({ type: "prime", frameCount: 22_050 });
  await primed;
  const prebufferStats = await frontend.waitForStats(
    (stats) =>
      stats.sessionGeneration === 1 && stats.queuedSourceFrames >= 11_025,
  );
  return { frontend, initialState, prebufferStats, requestedSampleRate, worker };
}

function startRafMonitor() {
  let callbacks = 0;
  const intervals = [];
  let last;
  let requestId;
  function frame(now) {
    if (last !== undefined) intervals.push(now - last);
    last = now;
    callbacks += 1;
    requestId = requestAnimationFrame(frame);
  }
  requestId = requestAnimationFrame(frame);
  return () => {
    cancelAnimationFrame(requestId);
    const sortedIntervals = intervals.toSorted((left, right) => left - right);
    const nominalIntervalMs = sortedIntervals.length === 0
      ? Number.POSITIVE_INFINITY
      : sortedIntervals[Math.floor(sortedIntervals.length / 2)];
    const missedFrames = intervals.reduce(
      (total, interval) => total
        + Math.max(0, Math.round(interval / nominalIntervalMs) - 1),
      0,
    );
    return {
      callbacks,
      nominalIntervalMs,
      missedFrames,
      missedRatio: missedFrames / Math.max(1, callbacks + missedFrames),
    };
  };
}

try {
  if (!Number.isFinite(durationMs) || durationMs < 1000) {
    throw new Error("durationMs must be at least 1000");
  }
  const cases = await Promise.all(requestedRates.map(prepareCase));
  startButton.disabled = false;
  document.body.dataset.status = "awaiting-gesture";
  document.body.dataset.progress = "awaiting trusted click";

  startButton.addEventListener(
    "click",
    async (event) => {
      try {
        startButton.disabled = true;
        document.body.dataset.status = "running";
        document.body.dataset.progress = `audio soak ${durationMs}ms`;
        const gesture = {
          eventIsTrusted: event.isTrusted,
          userActivationIsActive: navigator.userActivation.isActive,
        };
        await Promise.all(cases.map(({ frontend }) => frontend.resume()));
        const statesAfterResume = cases.map(({ frontend }) => frontend.contextState);
        const started = cases.map(({ worker }) => waitForWorker(worker, "producerStarted"));
        for (const { worker } of cases) worker.postMessage({ type: "start" });
        await Promise.all(started);
        const finishRafMonitor = startRafMonitor();
        const startedAt = performance.now();
        await wait(durationMs);
        const actualDurationMs = performance.now() - startedAt;
        const finalStats = await Promise.all(
          cases.map(({ frontend }) => frontend.requestStats()),
        );
        await Promise.all(cases.map(({ frontend }) => frontend.suspend()));
        const stopped = cases.map(({ worker }) => waitForWorker(worker, "producerStopped"));
        for (const { worker } of cases) worker.postMessage({ type: "stop" });
        const producerStats = await Promise.all(stopped);
        const raf = finishRafMonitor();
        const results = cases.map((entry, index) => ({
          requestedSampleRate: entry.requestedSampleRate,
          actualSampleRate: entry.frontend.deviceSampleRate,
          initialContextState: entry.initialState,
          stateAfterResume: statesAfterResume[index],
          prebufferStats: entry.prebufferStats,
          finalStats: finalStats[index],
          producer: producerStats[index],
        }));
        await Promise.all(cases.map(({ frontend }) => frontend.dispose()));
        for (const { worker } of cases) worker.terminate();
        const result = {
          durationMs,
          actualDurationMs,
          gesture,
          raf,
          cases: results,
          userAgent: navigator.userAgent,
        };
        window.phase0fAudioResult = result;
        resultNode.textContent = JSON.stringify(result, null, 2);
        document.body.dataset.status = "complete";
        document.body.dataset.progress = "complete";
      } catch (error) {
        resultNode.textContent = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
        document.body.dataset.status = "error";
      }
    },
    { once: true },
  );
} catch (error) {
  resultNode.textContent = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  document.body.dataset.status = "error";
}
