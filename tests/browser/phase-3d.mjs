import { mountPico8Player } from "../../apps/web-player/dist/main/main.js";

const encoder = new TextEncoder();
const resultNode = document.querySelector("#result");
const workerErrors = [];
window.__phase3dCdpDone = false;
window.__phase3dPointerLockErrors = 0;
window.__phase3dPointerLockRejections = [];
window.__phase3dGesture = null;
const requestPointerLock = HTMLCanvasElement.prototype.requestPointerLock;
HTMLCanvasElement.prototype.requestPointerLock = function (...args) {
  const pending = requestPointerLock.apply(this, args);
  if (pending === undefined) return pending;
  return pending.catch((error) => {
    window.__phase3dPointerLockRejections.push(
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    );
    throw error;
  });
};
document.addEventListener("pointerlockerror", () => {
  window.__phase3dPointerLockErrors += 1;
});

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(predicate, message, timeoutMs = 10_000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitFrames(composition, count) {
  const target = composition.presenter.lastFrameId + count;
  await waitFor(
    () => composition.presenter.lastFrameId >= target,
    `rAF did not advance ${count} frames`,
  );
}

function whitePixelX(canvas, y) {
  const pixels = canvas.getContext("2d").getImageData(0, y, 128, 1).data;
  for (let x = 0; x < 128; x += 1) {
    const offset = x * 4;
    if (
      pixels[offset] === 0xff && pixels[offset + 1] === 0xf1 &&
      pixels[offset + 2] === 0xe8 && pixels[offset + 3] === 0xff
    ) return x;
  }
  return -1;
}

function positions(canvas) {
  return Array.from({ length: 8 }, (_, y) => whitePixelX(canvas, y));
}

async function run() {
  const mounted = await mountPico8Player({
    root: document.querySelector("#player"),
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
  });
  const { controller, composition, elements } = mounted;
  elements.canvas.addEventListener("pointerdown", (event) => {
    window.__phase3dGesture = {
      trusted: event.isTrusted,
      active: navigator.userActivation.isActive,
      button: event.button,
    };
  }, { capture: true });
  const flags = [];
  const removeListener = composition.runtime.onEvent((event) => {
    if (event.type === "state" || event.type === "frame") flags.push(event.devkitFlags);
  });
  const cart = encoder.encode(`pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
mx=0 my=0 keyc=8 wheelc=8 relc=8 leftc=8 rightc=8 middlec=8
function _init() poke(0x5f2d,7) end
function _update60()
 mx=flr(stat(32)) my=flr(stat(33))
 if stat(30) then local c=stat(31) if c=="q" then keyc+=1 end end
 if stat(36)!=0 then wheelc+=1 end
 if stat(38)!=0 or stat(39)!=0 then relc+=1 end
 if btn(4) then leftc+=1 end
 if btn(5) then rightc+=1 end
 if btn(6) then middlec+=1 end
end
function _draw()
 cls(1)
 pset(mx,0,7) pset(my,1,7) pset(keyc,2,7) pset(wheelc,3,7)
 pset(relc,4,7) pset(leftc,5,7) pset(rightc,6,7) pset(middlec,7,7)
end
`);

  await controller.loadCart(cart, "phase-3d.p8");
  await controller.start();
  await waitFor(() => composition.presenter.lastFrameId >= 3, "player did not start rAF");
  check(flags.includes(7), `devkit flags were not published: ${flags}`);

  document.body.dataset.progress = "await-trusted-pointer-lock";
  await waitFor(() => window.__phase3dCdpDone, "CDP did not finish trusted input", 30_000);
  const pointerLockEntered = document.pointerLockElement === elements.canvas;
  await waitFrames(composition, 8);
  const observed = positions(elements.canvas);
  check(observed[0] >= 0 && observed[0] <= 127, `mouse x was invalid: ${observed}`);
  check(observed[1] >= 0 && observed[1] <= 127, `mouse y was invalid: ${observed}`);
  check(observed[2] === 9, `keyboard event was missing or duplicated: ${observed}`);
  check(observed[3] === 9, `wheel event was missing or duplicated: ${observed}`);
  check(observed[4] > 8, `relative pointer movement was not visible: ${observed}`);
  check(observed.slice(5).every((value) => value > 8), `mouse button overlay failed: ${observed}`);

  await controller.pause();
  await waitFor(() => document.pointerLockElement === null, "pause retained pointer lock");
  const pointerLockExitedOnPause = document.pointerLockElement === null;
  const generationBeforeReset = composition.runtime.sessionGeneration;
  await controller.reset();
  await controller.start();
  await waitFor(() => composition.presenter.lastFrameId >= 2, "reset generation did not render");
  await waitFrames(composition, 3);
  const reset = positions(elements.canvas);
  const generationAfterReset = composition.runtime.sessionGeneration;
  check(reset.slice(2).every((value) => value === 8), `reset retained devkit events: ${reset}`);
  check(generationAfterReset > generationBeforeReset, "reset did not advance generation");
  check(workerErrors.length === 0, `production Worker errors: ${workerErrors.join("; ")}`);

  await controller.stop();
  const result = {
    phase: "3D",
    observed,
    reset,
    pointerLockEntered,
    pointerLockExitedOnPause,
    generationBeforeReset,
    generationAfterReset,
    publishedFlags: [...new Set(flags)],
    workerErrors,
    finalState: controller.state,
    userAgent: navigator.userAgent,
  };
  removeListener();
  await controller.dispose();
  return result;
}

try {
  const result = await run();
  resultNode.textContent = JSON.stringify(result);
  document.body.dataset.progress = "complete";
  document.body.dataset.status = "complete";
} catch (error) {
  resultNode.textContent = error instanceof Error
    ? `${error.message}\n${error.stack ?? ""}`
    : String(error);
  document.body.dataset.status = "error";
}
