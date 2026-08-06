import {
  PlayerComposition,
} from "../../apps/web-player/dist/main/main.js";

const encoder = new TextEncoder();
const resultNode = document.querySelector("#result");
const startButton = document.querySelector("#start");
const playersNode = document.querySelector("#players");
const manifest = await fetch("./phase-3b.cases.json").then((response) => response.json());
const workerErrors = [];

const cart = encoder.encode(`pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
function _init()
 poke(0x3100,0x80,0xc0,0x40,0x40)
 for i=0,31 do
  poke(0x3200+i*2,24+i%12,14)
 end
 poke(0x3241,8)
 poke(0x3242,0)
 poke(0x3243,16)
 music(0,nil,1)
 print(chr(7).."s4x5c1egc2")
end
function _update60() end
function _draw()
 cls(1)
 print("phase 3b",46,61,7)
end
`);

function nextAnimationFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

async function createCase(requestedSampleRate) {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-label", `${requestedSampleRate} Hz production player`);
  playersNode.append(canvas);
  const composition = await PlayerComposition.create({
    canvas,
    runtimeWorkerFactory: () => {
      const worker = new Worker(
        "/apps/web-player/dist/browser/player-worker.mjs",
        { type: "module" },
      );
      worker.addEventListener("error", (event) => {
        workerErrors.push(`${event.message} @ ${event.filename}:${event.lineno}`);
      });
      return worker;
    },
    commandTimeoutMs: 5000,
    workletModuleUrl: "/apps/web-player/dist/worklet/pico8-audio-processor.js",
    audio: { requestedSampleRate, outputGain: 0 },
  });
  await composition.loadCart(cart);
  await composition.start();
  return {
    composition,
    requestedSampleRate,
    initialContextState: composition.audio.contextState,
  };
}

async function pulseAll(cases, timestampMs) {
  await Promise.all(cases.map(({ composition }) =>
    composition.pulse(timestampMs, { buttons: 0 })));
}

async function prepare() {
  const cases = await Promise.all(manifest.requestedSampleRates.map(createCase));
  let timestampMs = 0;
  for (let index = 0; index < 45; index += 1) {
    await pulseAll(cases, timestampMs);
    timestampMs += 1000 / 60;
  }
  const prebufferStats = await Promise.all(cases.map(({ composition }) =>
    composition.audio.waitForStats((stats) =>
      stats.sessionGeneration === 1 &&
      stats.queuedSourceFrames >= manifest.prebufferSourceFrames,
    10_000)));
  return { cases, prebufferStats, timestampMs };
}

try {
  const prepared = await prepare();
  startButton.disabled = false;
  document.body.dataset.status = "awaiting-gesture";
  document.body.dataset.progress = "awaiting trusted click";

  startButton.addEventListener("click", async (event) => {
    try {
      startButton.disabled = true;
      document.body.dataset.status = "running";
      document.body.dataset.progress = "production audio output";
      const gesture = {
        eventIsTrusted: event.isTrusted,
        userActivationIsActive: navigator.userActivation.isActive,
      };
      await Promise.all(prepared.cases.map(({ composition }) => composition.resumeAudio()));
      const statesAfterResume = prepared.cases.map(
        ({ composition }) => composition.audio.contextState,
      );
      const startedAt = performance.now();
      let pulseCount = 0;
      let elapsed = 0;
      while (elapsed < manifest.durationMs) {
        const now = await nextAnimationFrame();
        elapsed = now - startedAt;
        await pulseAll(prepared.cases, prepared.timestampMs + elapsed);
        pulseCount += 1;
      }
      const finalStats = await Promise.all(prepared.cases.map(
        ({ composition }) => composition.audio.requestStats(),
      ));
      const results = prepared.cases.map((entry, index) => ({
        requestedSampleRate: entry.requestedSampleRate,
        actualSampleRate: entry.composition.audio.deviceSampleRate,
        initialContextState: entry.initialContextState,
        stateAfterResume: statesAfterResume[index],
        prebufferStats: prepared.prebufferStats[index],
        finalStats: finalStats[index],
      }));

      await Promise.all(prepared.cases.map(({ composition }) => composition.stop()));
      const resetStats = await Promise.all(prepared.cases.map(
        ({ composition }) => composition.audio.waitForStats((stats) =>
          stats.sessionGeneration === 1 &&
          stats.receivedChunks === 0 &&
          stats.queuedSourceFrames === 0,
        5000),
      ));
      await Promise.all(prepared.cases.map(({ composition }) => composition.dispose()));
      const result = {
        manifest,
        gesture,
        actualDurationMs: performance.now() - startedAt,
        pulseCount,
        workerErrors,
        cases: results,
        resetStats,
        userAgent: navigator.userAgent,
      };
      window.phase3bResult = result;
      resultNode.textContent = JSON.stringify(result, null, 2);
      document.body.dataset.progress = "complete";
      document.body.dataset.status = "complete";
    } catch (error) {
      resultNode.textContent = error instanceof Error
        ? `${error.message}\n${error.stack ?? ""}`
        : String(error);
      document.body.dataset.status = "error";
    }
  }, { once: true });
} catch (error) {
  resultNode.textContent = error instanceof Error
    ? `${error.message}\n${error.stack ?? ""}`
    : String(error);
  document.body.dataset.status = "error";
}
