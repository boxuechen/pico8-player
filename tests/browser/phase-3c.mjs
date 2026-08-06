import { mountPico8Player } from "../../apps/web-player/dist/main/main.js";

const encoder = new TextEncoder();
const resultNode = document.querySelector("#result");
const workerErrors = [];

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(predicate, message, timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function key(type, code) {
  window.dispatchEvent(new KeyboardEvent(type, {
    code,
    bubbles: true,
    cancelable: true,
  }));
}

function pointer(target, type, pointerId) {
  target.dispatchEvent(new PointerEvent(type, {
    pointerId,
    pointerType: "touch",
    isPrimary: pointerId === 101,
    bubbles: true,
    cancelable: true,
  }));
}

function button(pressed = false) {
  return { pressed, touched: pressed, value: pressed ? 1 : 0 };
}

function standardGamepad(index, pressedButtons = []) {
  const buttons = Array.from({ length: 16 }, () => button());
  for (const buttonIndex of pressedButtons) buttons[buttonIndex] = button(true);
  return {
    axes: [0, 0, 0, 0],
    buttons,
    connected: true,
    id: `phase-3c-pad-${index}`,
    index,
    mapping: "standard",
    timestamp: performance.now(),
    vibrationActuator: null,
  };
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
  return [20, 40, 60, 80].map((y) => whitePixelX(canvas, y));
}

async function waitFrames(composition, count) {
  const target = composition.presenter.lastFrameId + count;
  await waitFor(
    () => composition.presenter.lastFrameId >= target,
    `rAF did not advance ${count} frames`,
  );
}

async function run() {
  let gamepads = [];
  const gamepadSource = { getGamepads: () => gamepads };
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
    gamepadSource,
  });
  const { controller, composition, elements } = mounted;
  const cart = encoder.encode(`pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
p0l=8 p0x=8 p1o=8 p2o=8
function _update60()
 if btn(0,0) then p0l+=1 end
 if btn(5,0) then p0x+=1 end
 if btn(4,1) then p1o+=1 end
 if btn(4,2) then p2o+=1 end
end
function _draw()
 cls(1)
 pset(p0l,20,7)
 pset(p0x,40,7)
 pset(p1o,60,7)
 pset(p2o,80,7)
end
`);

  document.body.dataset.progress = "load and start";
  await controller.loadCart(cart, "phase-3c.p8");
  await controller.start();
  await waitFor(() => composition.presenter.lastFrameId >= 3, "player did not start rAF");
  check(positions(elements.canvas).every((x) => x === 8), "cart did not cold boot");

  const touchLeft = elements.touchControls.querySelector('[data-pico-button="0"]');
  const touchX = elements.touchControls.querySelector('[data-pico-button="5"]');
  check(touchLeft !== null && touchX !== null, "touch controls are missing");

  document.body.dataset.progress = "simultaneous keyboard gamepad and multitouch";
  gamepads = [null, null, standardGamepad(2, [0])];
  key("keydown", "ShiftLeft");
  pointer(touchLeft, "pointerdown", 101);
  pointer(touchX, "pointerdown", 102);
  check(
    JSON.stringify(controller.inputControllers.slice(0, 3)) === JSON.stringify([33, 16, 16]),
    `source merge mismatch: ${controller.inputControllers}`,
  );
  await waitFrames(composition, 6);
  const simultaneous = positions(elements.canvas);
  check(simultaneous.every((x) => x >= 12), `cart missed a source: ${simultaneous}`);

  document.body.dataset.progress = "cancel disconnect and independent release";
  pointer(touchLeft, "pointercancel", 101);
  gamepads = [];
  key("keyup", "ShiftLeft");
  check(
    JSON.stringify(controller.inputControllers.slice(0, 3)) === JSON.stringify([32, 0, 0]),
    `source release cleared the wrong state: ${controller.inputControllers}`,
  );
  await waitFrames(composition, 2);
  const partialStart = positions(elements.canvas);
  await waitFrames(composition, 4);
  const partialEnd = positions(elements.canvas);
  check(partialEnd[0] === partialStart[0], "pointercancel left a stuck touch button");
  check(partialEnd[1] > partialStart[1], "remaining touch pointer was cleared");
  check(partialEnd[2] === partialStart[2], "keyboard keyup left a stuck button");
  check(partialEnd[3] === partialStart[3], "Gamepad disconnect left a stuck button");

  pointer(touchX, "pointerup", 102);
  check(controller.inputControllers.every((mask) => mask === 0), "touch release did not clear input");
  await waitFrames(composition, 2);
  const releasedStart = positions(elements.canvas);
  await waitFrames(composition, 4);
  check(
    JSON.stringify(positions(elements.canvas)) === JSON.stringify(releasedStart),
    "released controllers continued moving the cart",
  );

  document.body.dataset.progress = "blur lifecycle and rAF recovery";
  gamepads = [null, null, standardGamepad(2, [0])];
  key("keydown", "ShiftLeft");
  pointer(touchLeft, "pointerdown", 103);
  check(
    JSON.stringify(controller.inputControllers.slice(0, 3)) === JSON.stringify([1, 16, 16]),
    `pre-blur input setup failed: ${controller.inputControllers}`,
  );
  window.dispatchEvent(new Event("blur"));
  await waitFor(() => controller.state === "paused", "blur did not pause production player");
  gamepads = [];
  check(controller.inputControllers.every((mask) => mask === 0), "blur did not clear all sources");
  const pausedFrame = composition.presenter.lastFrameId;
  await new Promise((resolve) => setTimeout(resolve, 80));
  check(composition.presenter.lastFrameId === pausedFrame, "blurred player continued rendering");
  window.dispatchEvent(new Event("focus"));
  await waitFor(() => controller.state === "running", "focus did not resume production player");
  await waitFrames(composition, 3);
  const resumedStart = positions(elements.canvas);
  await waitFrames(composition, 3);
  check(
    JSON.stringify(positions(elements.canvas)) === JSON.stringify(resumedStart),
    "blurred input leaked after resume",
  );

  document.body.dataset.progress = "cold generation recovery";
  const generationBeforeReset = composition.runtime.sessionGeneration;
  await controller.pause();
  await controller.reset();
  await controller.start();
  await waitFor(() => composition.presenter.lastFrameId >= 1, "reset generation did not render");
  const generationAfterReset = composition.runtime.sessionGeneration;
  const resetPositions = positions(elements.canvas);
  check(generationAfterReset > generationBeforeReset, "reset did not advance generation");
  check(resetPositions.every((x) => x === 8), `reset retained controller state: ${resetPositions}`);
  check(workerErrors.length === 0, `production Worker errors: ${workerErrors.join("; ")}`);

  await controller.stop();
  const result = {
    phase: "3C",
    simultaneous,
    partialStart,
    partialEnd,
    releasedStart,
    resumedStart,
    resetPositions,
    generationBeforeReset,
    generationAfterReset,
    touchControlCount: elements.touchControls.querySelectorAll("[data-pico-button]").length,
    audioMode: composition.audio === undefined ? "disabled" : "worklet",
    workerErrors,
    finalState: controller.state,
    userAgent: navigator.userAgent,
  };
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
