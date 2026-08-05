import { mountPico8Player } from "../../apps/web-player/dist/main/main.js";

const resultNode = document.querySelector("#result");
const encoder = new TextEncoder();

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

function whitePixelX(canvas) {
  const pixels = canvas.getContext("2d").getImageData(0, 64, 128, 1).data;
  for (let x = 0; x < 128; x += 1) {
    const offset = x * 4;
    if (
      pixels[offset] === 0xff && pixels[offset + 1] === 0xf1 &&
      pixels[offset + 2] === 0xe8 && pixels[offset + 3] === 0xff
    ) return x;
  }
  return -1;
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
        document.body.dataset.progress = "Worker error";
        resultNode.textContent = `${event.message} @ ${event.filename}:${event.lineno}`;
        document.body.dataset.status = "error";
      });
      return worker;
    },
    commandTimeoutMs: 2000,
  });
  const { controller, composition, elements } = mounted;
  const cart = encoder.encode(`pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
x=10
function _update60()
 if btn(1) then x=x+1 end
end
function _draw()
 cls(1)
 pset(x,64,7)
end
`);

  document.body.dataset.progress = "load and rAF scheduling";
  await controller.loadCart(cart, "phase-1e.p8");
  check(controller.state === "ready", "load did not enter ready");
  await controller.start();
  await waitFor(() => composition.presenter.lastFrameId >= 3, "rAF did not publish frames");
  const frameBeforeInput = composition.presenter.lastFrameId;

  document.body.dataset.progress = "keyboard mapping";
  key("keydown", "ArrowRight");
  check(controller.inputButtons === 2, "ArrowRight did not normalize to button 1");
  await waitFor(
    () => composition.presenter.lastFrameId >= frameBeforeInput + 5,
    "held input did not advance scheduled frames",
  );
  key("keyup", "ArrowRight");
  const movedX = whitePixelX(elements.canvas);
  check(movedX >= 14, `cart did not move right: x=${movedX}`);

  key("keydown", "KeyC");
  key("keydown", "KeyZ");
  check(controller.inputButtons === 16, "O aliases did not map to button 4");
  key("keyup", "KeyC");
  check(controller.inputButtons === 16, "releasing one O alias cleared another held alias");
  key("keyup", "KeyZ");
  check(controller.inputButtons === 0, "O aliases did not release");

  document.body.dataset.progress = "blur pause and resume anchor";
  key("keydown", "ArrowLeft");
  window.dispatchEvent(new Event("blur"));
  check(controller.inputButtons === 0, "blur did not clear held input");
  await waitFor(() => controller.state === "paused", "blur did not pause player");
  const pausedFrame = composition.presenter.lastFrameId;
  await new Promise((resolve) => setTimeout(resolve, 80));
  check(composition.presenter.lastFrameId === pausedFrame, "paused player continued rendering");
  window.dispatchEvent(new Event("focus"));
  await waitFor(() => controller.state === "running", "focus did not resume player");
  await waitFor(
    () => composition.presenter.lastFrameId > pausedFrame,
    "resume did not re-anchor scheduling",
  );

  document.body.dataset.progress = "cold reset and stop";
  await controller.pause();
  await controller.reset();
  check(composition.presenter.lastFrameId === -1, "reset did not clear presenter generation");
  await controller.start();
  await waitFor(() => composition.presenter.lastFrameId >= 1, "reset cart did not restart");
  const resetX = whitePixelX(elements.canvas);
  check(resetX === 10, `cold reset retained cart state: x=${resetX}`);
  await controller.stop();
  check(controller.state === "stopped", "stop did not update shell state");

  document.body.dataset.progress = "fault UI";
  let faultCode = "";
  try {
    await controller.loadCart(encoder.encode("not a cart"), "broken.p8");
  } catch (error) {
    faultCode = error?.record?.code ?? "unknown";
  }
  check(faultCode === "E_CART_PARSE", `malformed cart returned ${faultCode}`);
  check(controller.state === "faulted", "fault did not update shell state");
  check(elements.diagnostic.textContent.includes("E_CART_PARSE"), "fault diagnostic is missing");

  const result = {
    targetFps: 60,
    frameBeforeInput,
    movedX,
    resetX,
    faultCode,
    finalState: controller.state,
    workerGeneration: composition.runtime.workerGeneration,
    sessionGeneration: composition.runtime.sessionGeneration,
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
