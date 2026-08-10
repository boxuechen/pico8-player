import {
  createPico8WebPlayer,
  PICO8_WEB_PLAYER_API_VERSION,
} from "../../apps/web-player/dist/main/public.js";

const resultNode = document.querySelector("#result");
const encoder = new TextEncoder();
const NativeWorker = window.Worker;
const workers = [];
let terminatedWorkers = 0;
window.Worker = class TrackedWorker extends NativeWorker {
  constructor(...args) {
    super(...args);
    workers.push(this);
  }

  terminate() {
    if (!this.__phase7bTerminated) {
      this.__phase7bTerminated = true;
      terminatedWorkers += 1;
    }
    return super.terminate();
  }
};

const contexts = [];
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

function cart(color) {
  return encoder.encode(`pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
x=0
function _update60() x=x+1 end
function _draw() cls(${color}) pset(x%128,${color},7) end
`);
}

async function waitFor(predicate, message, timeoutMs = 8000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function run() {
  document.body.dataset.progress = "create independent players";
  const [first, second] = await Promise.all([
    createPico8WebPlayer({ root: document.querySelector("#first"), audio }),
    createPico8WebPlayer({ root: document.querySelector("#second"), audio }),
  ]);
  check(PICO8_WEB_PLAYER_API_VERSION === 2, "unexpected public API version");
  check(workers.length === 2, "create did not allocate one Worker per player");
  check(contexts.length === 2 && contexts[0] !== contexts[1],
    "create did not allocate independent audio contexts");

  const firstFrames = [];
  const secondFrames = [];
  const firstStates = [];
  first.on("frame", (event) => firstFrames.push(event.frameId));
  second.on("frame", (event) => secondFrames.push(event.frameId));
  first.on("state", (event) => firstStates.push(event.state));

  document.body.dataset.progress = "serialized load and start";
  const firstLoad = first.loadCart(cart(1), { displayName: "first.p8" });
  const firstStart = first.start();
  await Promise.all([
    firstLoad,
    firstStart,
    second.loadCart(cart(2), { displayName: "second.p8" }).then(() => second.start()),
  ]);
  await waitFor(() => firstFrames.length >= 4 && secondFrames.length >= 4,
    "both instances did not publish frames");
  check(firstStates.includes("loading") && firstStates.includes("ready") &&
    firstStates.includes("running"), "typed state lifecycle is incomplete");
  check(first.canvas !== second.canvas, "players share a canvas");

  document.body.dataset.progress = "pause and teardown isolation";
  await first.pause();
  const pausedFirstCount = firstFrames.length;
  const runningSecondCount = secondFrames.length;
  await waitFor(() => secondFrames.length >= runningSecondCount + 4,
    "pausing first stopped second");
  check(firstFrames.length === pausedFirstCount, "paused instance kept rendering");
  await first.dispose();
  check(terminatedWorkers === 1, "first dispose did not terminate exactly one Worker");
  check(contexts[0].state === "closed", "first dispose did not close first audio context");
  const afterFirstDispose = secondFrames.length;
  await waitFor(() => secondFrames.length >= afterFirstDispose + 3,
    "disposing first stopped second");

  document.body.dataset.progress = "load/dispose race";
  const race = await createPico8WebPlayer({
    root: document.querySelector("#race"),
    audio,
  });
  const raceEvents = [];
  for (const type of ["state", "frame", "diagnostic", "fault"]) {
    race.on(type, (event) => raceEvents.push(event.type));
  }
  const racingLoad = race.loadCart(cart(3));
  await Promise.resolve();
  const disposeOne = race.dispose();
  const disposeTwo = race.dispose();
  check(disposeOne === disposeTwo, "dispose did not return its idempotent promise");
  const eventCountAtBarrier = raceEvents.length;
  const loadResult = await Promise.allSettled([racingLoad, disposeOne]);
  check(loadResult[0].status === "rejected", "in-flight load survived dispose barrier");
  await new Promise((resolve) => setTimeout(resolve, 100));
  check(raceEvents.length === eventCountAtBarrier, "stale output escaped dispose barrier");

  await second.dispose();
  check(terminatedWorkers === 3, "each instance did not terminate its own Worker");
  check(contexts.every((context) => context.state === "closed"),
    "audio contexts were not independently closed");
  return {
    apiVersion: PICO8_WEB_PLAYER_API_VERSION,
    workerCount: workers.length,
    terminatedWorkers,
    audioContextCount: contexts.length,
    firstFrameCount: firstFrames.length,
    secondFrameCount: secondFrames.length,
    raceEventCount: raceEvents.length,
    loadRaceRejected: loadResult[0].status === "rejected",
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
