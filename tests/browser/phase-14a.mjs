import {
  createPico8WebPlayer,
  PICO8_WEB_PLAYER_API_VERSION,
} from "../../apps/web-player/dist/release/main/player.mjs";

const encoder = new TextEncoder();
const resultNode = document.querySelector("#result");
const label = document.querySelector("#label");
const mount = document.querySelector("#mount");
const NativeWorker = window.Worker;
const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
const nativeCancelAnimationFrame = window.cancelAnimationFrame.bind(window);
const workers = [];
const activeAnimationFrames = new Set();
const contexts = [];
let terminatedWorkers = 0;

window.Worker = class TrackedWorker extends NativeWorker {
  constructor(...args) {
    super(...args);
    workers.push(this);
  }

  terminate() {
    if (!this.__phase14Terminated) {
      this.__phase14Terminated = true;
      terminatedWorkers += 1;
    }
    return super.terminate();
  }
};
window.requestAnimationFrame = (callback) => {
  let handle;
  handle = nativeRequestAnimationFrame((timestamp) => {
    activeAnimationFrames.delete(handle);
    callback(timestamp);
  });
  activeAnimationFrames.add(handle);
  return handle;
};
window.cancelAnimationFrame = (handle) => {
  activeAnimationFrames.delete(handle);
  nativeCancelAnimationFrame(handle);
};

const audio = {
  contextFactory(options) {
    const context = new AudioContext(options);
    contexts.push(context);
    return context;
  },
};

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function cart(color, marker) {
  return encoder.encode(`pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
function _draw()
 cls(${color})
 print("${marker}",8,8,7)
end
`);
}

function pixel(canvas) {
  return [...canvas.getContext("2d").getImageData(0, 0, 1, 1).data];
}

async function waitFor(predicate, message, timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function startAndObserve(player, frames) {
  let resolved = false;
  const starting = player.start().then(() => { resolved = true; });
  await Promise.resolve();
  check(!resolved, "start resolved in the Worker acknowledgement turn");
  await starting;
  check(frames.length > 0, "start resolved before a public frame event");
  check(player.state === "running" || player.state === "audio-blocked",
    `start completed in ${player.state}`);
}

async function run() {
  const firstFrames = [];
  const player = await createPico8WebPlayer({ root: mount, shell: "hosted", audio });
  player.on("frame", (event) => firstFrames.push({
    generation: event.sessionGeneration,
    frameId: event.frameId,
  }));

  document.body.dataset.progress = "cart-a";
  await player.loadCart(cart(2, "A"), { displayName: "cart-a.p8" });
  await startAndObserve(player, firstFrames);
  const firstPixel = pixel(player.canvas);
  const firstGeneration = firstFrames.at(-1).generation;

  await player.stop();
  await waitFor(() => activeAnimationFrames.size === 0,
    "stop retained an animation frame");
  document.body.dataset.progress = "cart-b";
  label.textContent = "Cart B visible after cart A stopped";
  await player.loadCart(cart(8, "B"), { displayName: "cart-b.p8" });
  const secondFrameOffset = firstFrames.length;
  await startAndObserve(player, firstFrames);
  const secondFrames = firstFrames.slice(secondFrameOffset);
  const secondPixel = pixel(player.canvas);
  const secondGeneration = secondFrames.at(-1).generation;
  check(secondGeneration > firstGeneration, "cart switch did not advance session generation");
  check(JSON.stringify(secondPixel) !== JSON.stringify(firstPixel),
    "cart B retained cart A's Canvas pixels");

  document.body.dataset.progress = "capture";
  await new Promise((resolve) => { window.__phase14Resume = resolve; });

  await player.dispose();
  await waitFor(() => terminatedWorkers === 1 && contexts[0]?.state === "closed" &&
    activeAnimationFrames.size === 0, "first facade did not release browser resources");
  mount.replaceChildren();

  document.body.dataset.progress = "fresh-player";
  label.textContent = "Fresh player visible after dispose";
  const freshFrames = [];
  const fresh = await createPico8WebPlayer({ root: mount, shell: "hosted", audio });
  fresh.on("frame", (event) => freshFrames.push(event.frameId));
  await fresh.loadCart(cart(3, "FRESH"), { displayName: "fresh.p8" });
  await startAndObserve(fresh, freshFrames);
  const freshPixel = pixel(fresh.canvas);
  check(JSON.stringify(freshPixel) !== JSON.stringify(secondPixel),
    "fresh facade inherited the disposed Canvas pixels");
  await fresh.dispose();
  await waitFor(() => terminatedWorkers === 2 && contexts.every(({ state }) => state === "closed") &&
    activeAnimationFrames.size === 0, "fresh facade did not release browser resources");

  return {
    apiVersion: PICO8_WEB_PLAYER_API_VERSION,
    firstFrames: secondFrameOffset,
    secondFrames: secondFrames.length,
    freshFrames: freshFrames.length,
    generations: [firstGeneration, secondGeneration],
    pixels: { first: firstPixel, second: secondPixel, fresh: freshPixel },
    workerCount: workers.length,
    terminatedWorkers,
    audioContextCount: contexts.length,
    closedAudioContexts: contexts.filter(({ state }) => state === "closed").length,
    activeAnimationFrames: activeAnimationFrames.size,
  };
}

try {
  resultNode.textContent = JSON.stringify(await run());
  document.body.dataset.progress = "complete";
  document.body.dataset.status = "complete";
} catch (error) {
  resultNode.textContent = error instanceof Error
    ? `${error.message}\n${error.stack ?? ""}`
    : String(error);
  document.body.dataset.status = "error";
}
