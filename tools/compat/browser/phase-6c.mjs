import {
  PlayerComposition,
  PlayerController,
  PlayerShellView,
} from "/apps/web-player/dist/main/main.js";
import { failureClusterForFault } from "../failure-clusters-v1.mjs";

const shell = document.querySelector("#shell");
let mounted;

function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

const KEY_CODES = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "KeyZ", "KeyX"];

function applyInput(event) {
  if (event.player !== 0) throw new Error("Phase 6C Chrome baseline supports player 0 traces only");
  window.dispatchEvent(new KeyboardEvent(event.pressed ? "keydown" : "keyup", {
    code: KEY_CODES[event.button],
    bubbles: true,
    cancelable: true,
  }));
}

class ManualAnimationFrames {
  #callback;
  #handle = 0;

  request(callback) {
    if (this.#callback !== undefined) throw new Error("animation callback already pending");
    const handle = ++this.#handle;
    this.#callback = { handle, callback };
    return handle;
  }

  cancel(handle) {
    if (this.#callback?.handle === handle) this.#callback = undefined;
  }

  async fire(timestamp, state) {
    const pending = this.#callback;
    if (pending === undefined) throw new Error("animation callback is not scheduled");
    this.#callback = undefined;
    pending.callback(timestamp);
    const deadline = performance.now() + 15_000;
    while (this.#callback === undefined && state() === "running") {
      if (performance.now() > deadline) throw new Error("animation callback did not settle");
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

function elements() {
  return PlayerShellView.create(shell, { window, document });
}

async function screenTelemetry(canvas, hasFrame) {
  if (!hasFrame) {
    return { screenSha256: null, nonBlackPixels: 0, distinctColors: 0 };
  }
  const pixels = canvas.getContext("2d").getImageData(0, 0, 128, 128).data;
  const digest = await crypto.subtle.digest("SHA-256", pixels);
  const screenSha256 = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
  const colors = new Set();
  let nonBlackPixels = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const color = `${pixels[offset]},${pixels[offset + 1]},${pixels[offset + 2]}`;
    colors.add(color);
    if (pixels[offset] !== 0 || pixels[offset + 1] !== 0 || pixels[offset + 2] !== 0) {
      nonBlackPixels += 1;
    }
  }
  return { screenSha256, nonBlackPixels, distinctColors: colors.size };
}

function faultCode(diagnostic, fallback) {
  return /^E_[A-Z0-9_]+/u.exec(diagnostic)?.[0] ?? fallback;
}

async function dispose() {
  if (mounted === undefined) return;
  await mounted.controller.dispose();
  mounted.removeRuntimeListener();
  mounted = undefined;
}

async function runCase(payloadBase64, trace, localCartBundle = [], expectedTermination) {
  await dispose();
  const animationFrames = new ManualAnimationFrames();
  const view = elements();
  const playerElements = view.elements;
  const composition = await PlayerComposition.create({
    canvas: playerElements.canvas,
    runtimeWorkerFactory: () => new Worker(
      "/apps/web-player/dist/browser/player-worker.mjs",
      { type: "module" },
    ),
    commandTimeoutMs: 15_000,
    ...(globalThis.__phase6cEnableAudio === true ? {
      workletModuleUrl: "/apps/web-player/dist/worklet/pico8-audio-processor.js",
    } : {}),
  });
  const controller = new PlayerController(composition, view, {
    animationFrames,
    window,
    document,
  });
  let completedTicks = 0;
  let frameCount = 0;
  let firstFault;
  const removeRuntimeListener = composition.runtime.onEvent((event) => {
    if (event.type === "heartbeat") completedTicks += event.tickCount;
    if (event.type === "frame") frameCount += 1;
    if (event.type === "fault" && firstFault === undefined) firstFault = event.error;
  });
  mounted = { controller, removeRuntimeListener };

  try {
    await controller.loadCart(decodeBase64(payloadBase64), {
      displayName: "local qualification cart",
      localCartBundle: localCartBundle.map((entry) => ({
        ref: entry.ref,
        bytes: decodeBase64(entry.cartBase64),
        access: entry.access,
      })),
    });
  } catch (error) {
    if (controller.state !== "faulted") throw error;
  }
  if (controller.state === "ready") await controller.start();

  let timestamp = performance.now();
  let nextInputIndex = 0;
  let pulseCount = 0;
  const maximumPulses = trace.ticks * 4 + 10;
  while (controller.state === "running"
    && completedTicks < trace.ticks
    && pulseCount < maximumPulses) {
    while (trace.inputs[nextInputIndex]?.tick <= completedTicks) {
      applyInput(trace.inputs[nextInputIndex]);
      nextInputIndex += 1;
    }
    timestamp += trace.stepMilliseconds;
    await animationFrames.fire(timestamp, () => controller.state);
    if (globalThis.__phase6cRealTimePacing === true) {
      await new Promise((resolve) => setTimeout(resolve, trace.stepMilliseconds));
    }
    pulseCount += 1;
  }
  if (controller.state === "running" && completedTicks < trace.ticks) {
    throw new Error("Chrome trace driver did not reach the requested logical tick count");
  }
  let audioDevice;
  if (controller.state === "running" && composition.audio !== undefined) {
    const stats = await composition.audio.requestStats(5_000);
    audioDevice = {
      contextState: composition.audio.contextState,
      deviceSampleRate: stats.deviceSampleRate,
      receivedChunks: stats.receivedChunks,
      renderedDeviceFrames: stats.renderedDeviceFrames,
      playing: stats.playing,
      steadyUnderruns: stats.steadyUnderruns,
      overruns: stats.overruns,
      droppedSourceFrames: stats.droppedSourceFrames,
      discontinuities: stats.discontinuities,
    };
  }
  if (controller.state === "running") await controller.pause();

  const diagnostic = playerElements.diagnostic.textContent ?? "";
  const code = firstFault?.code ?? faultCode(diagnostic, "E_FRAME_MISSING");
  const cleanStop = controller.state === "stopped" && firstFault === undefined
    && !/^E_[A-Z0-9_]+/u.test(diagnostic);
  const expectedTerminationMatched = expectedTermination?.kind === "fault"
    && firstFault?.code === expectedTermination.faultCode;
  const boots = cleanStop || (completedTicks >= trace.ticks && frameCount > 0
    && (controller.state === "paused" || controller.state === "running"));
  const compatibleUntested = boots || expectedTerminationMatched;
  const telemetry = await screenTelemetry(playerElements.canvas, frameCount > 0);
  return {
    completed: true,
    smokeOutcome: boots ? "boots" : "fails",
    classification: compatibleUntested ? "CU" : "C0",
    failureCluster: compatibleUntested ? null : failureClusterForFault(code),
    completedTicks: Math.min(completedTicks, trace.ticks),
    ...(boots ? {} : { faultCode: code, faultMessage: diagnostic.slice(0, 512) || code }),
    ...(expectedTerminationMatched ? { expectedTerminationMatched: true } : {}),
    frameCount,
    ...telemetry,
    ...(audioDevice === undefined ? {} : { audioDevice }),
    screenshotCaptured: false,
  };
}

globalThis.__phase6cRunCase = runCase;
globalThis.__phase6cDispose = dispose;
document.body.dataset.status = "ready";
