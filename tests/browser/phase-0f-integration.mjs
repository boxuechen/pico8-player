import {
  Phase0FPlayerComposition,
} from "../../apps/web-player/dist/main/compose-player.js";
import {
  RuntimeClientError,
} from "../../apps/web-player/dist/main/runtime-client.js";
import {
  FRAME_FIXTURE_RGBA_SHA256,
} from "../fixtures/phase-0f/frame-fixture.mjs";

const resultNode = document.querySelector("#result");
const startButton = document.querySelector("#start");
const canvas = document.querySelector("#screen");
const stage = document.querySelector("#stage");
let workerCount = 0;
let terminateCount = 0;

function workerFactory() {
  workerCount += 1;
  const worker = new Worker("./phase-0f-integration-worker.mjs", { type: "module" });
  worker.addEventListener("error", (event) => {
    resultNode.textContent = `Integration Worker error: ${JSON.stringify({
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      error: event.error instanceof Error
        ? `${event.error.message}\n${event.error.stack ?? ""}`
        : String(event.error),
    })}`;
    document.body.dataset.status = "error";
  });
  return {
    postMessage(message, transfer = []) {
      worker.postMessage(message, transfer);
    },
    addEventListener(type, listener) {
      worker.addEventListener(type, listener);
    },
    terminate() {
      terminateCount += 1;
      worker.terminate();
    },
  };
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

try {
  const composition = await Phase0FPlayerComposition.create({
    canvas,
    runtimeWorkerFactory: workerFactory,
    workletModuleUrl: "/apps/web-player/dist/worklet/pico8-audio-processor.js",
    commandTimeoutMs: 1000,
    audio: { requestedSampleRate: 48_000, outputGain: 0 },
  });
  const bounds = stage.getBoundingClientRect();
  composition.resize(bounds.width, bounds.height);
  const ready = await composition.loadCart(new Uint8Array([1]));
  if (ready.type !== "ready") throw new Error("integration Worker did not become ready");
  await composition.audio.waitForStats(
    (stats) => stats.sessionGeneration === 1 && stats.queuedSourceFrames >= 11_025,
  );
  startButton.disabled = false;
  document.body.dataset.status = "awaiting-gesture";
  document.body.dataset.progress = "awaiting trusted click";

  startButton.addEventListener(
    "click",
    async (event) => {
      try {
        startButton.disabled = true;
        document.body.dataset.status = "running";
        document.body.dataset.progress = "frame/audio/watchdog/dispose";
        const gesture = {
          eventIsTrusted: event.isTrusted,
          userActivationIsActive: navigator.userActivation.isActive,
        };
        await composition.resumeAudio();
        const firstFrame = await composition.step({ buttons: 0 });
        if (firstFrame.type !== "frame") throw new Error("first frame was not published");
        const firstGeneration = composition.runtime.sessionGeneration;
        const firstRgba = canvas.getContext("2d").getImageData(0, 0, 128, 128).data;
        const firstRgbaSha256 = await sha256(firstRgba);
        let watchdogCode = "";
        try {
          await composition.step({ buttons: 0x3f });
        } catch (error) {
          if (error instanceof RuntimeClientError) watchdogCode = error.record.code;
        }
        const secondGeneration = composition.runtime.sessionGeneration;
        const recovered = await composition.loadCart(new Uint8Array([2]));
        if (recovered.type !== "ready") throw new Error("replacement Worker did not load");
        await composition.audio.waitForStats(
          (stats) =>
            stats.sessionGeneration === secondGeneration &&
            stats.queuedSourceFrames >= 11_025,
        );
        const recoveredFrame = await composition.step({ buttons: 0 });
        if (recoveredFrame.type !== "frame") throw new Error("replacement Worker did not frame");
        const finalStats = await composition.audio.requestStats();
        await composition.suspendAudio();
        await composition.dispose();
        const result = {
          gesture,
          firstGeneration,
          secondGeneration,
          watchdogCode,
          recovered: true,
          firstRgbaSha256,
          expectedRgbaSha256: FRAME_FIXTURE_RGBA_SHA256,
          presenterGeneration: composition.presenter.sessionGeneration,
          finalStats,
          audioStateAfterDispose: composition.audio.contextState,
          workerCount,
          terminateCount,
        };
        window.phase0fIntegrationResult = result;
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
