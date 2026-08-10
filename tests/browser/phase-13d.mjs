import {
  createPico8WebPlayer,
  PICO8_WEB_PLAYER_API_VERSION,
} from "../../apps/web-player/dist/release/main/player.mjs";

const resultNode = document.querySelector("#result");
const encoder = new TextEncoder();

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function cart() {
  return encoder.encode(`pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
function _init()
 cartdata("mobile_host")
 dset(1,42)
end
function _update60()
 if btn(4) then dset(0,dget(0)+1) end
end
function _draw() cls(1) print(dget(0),8,8,7) end
`);
}

function seed(value) {
  const bytes = new Uint8Array(256);
  new DataView(bytes.buffer).setInt32(0, value * 65536, true);
  return bytes;
}

async function waitFor(predicate, message, timeoutMs = 10000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function run() {
  const writes = [];
  let adapterFlushes = 0;
  const persistence = {
    async hydrate(contentId) {
      check(contentId === "sha256:phase13d", "content identity drifted");
      return [{ id: "mobile_host", bytes: seed(3) }];
    },
    async write(contentId, commit) {
      writes.push({ contentId, id: commit.id, revision: commit.revision, bytes: commit.bytes });
    },
    async flush() { adapterFlushes += 1; },
  };
  const statuses = [];
  const frames = [];
  const player = await createPico8WebPlayer({
    root: document.querySelector("#mount"),
    shell: "hosted",
    persistence,
  });
  player.on("persistence", (event) => statuses.push(event.status));
  player.on("frame", (event) => frames.push(event.frameId));
  await player.loadCart(cart(), { displayName: "phase13d.p8", contentId: "sha256:phase13d" });
  await player.start();
  player.setInput({
    controllers: [16, 0, 0, 0, 0, 0, 0, 0],
    devkit: {
      mouseXRaw: 0, mouseYRaw: 0, mouseButtons: 0, wheelRaw: 0,
      movementXRaw: 0, movementYRaw: 0, keypresses: [],
    },
  });
  await waitFor(() => frames.length >= 4 && writes.length >= 2,
    "hosted player did not produce frames and cartdata commits");
  player.setInput({
    controllers: [0, 0, 0, 0, 0, 0, 0, 0],
    devkit: {
      mouseXRaw: 0, mouseYRaw: 0, mouseButtons: 0, wheelRaw: 0,
      movementXRaw: 0, movementYRaw: 0, keypresses: [],
    },
  });
  const background = await player.handleLifecycle("background");
  const shell = document.querySelector(".pico8-player");
  const toolbar = document.querySelector(".pico8-player__toolbar");
  const value = new DataView(writes.at(-1).bytes.buffer).getInt32(0, true) / 65536;
  check(background.durable === true, "background flush was not durable");
  check(player.state === "paused", "background did not pause the player");
  check(shell.dataset.shellMode === "hosted", "hosted shell mode is missing");
  check(getComputedStyle(toolbar).display === "none",
    `hosted toolbar is visible: mode=${shell.dataset.shellMode} display=${
      getComputedStyle(toolbar).display
    } sheets=${[...document.styleSheets].map((sheet) => `${sheet.href ?? "inline"}:${
      sheet.cssRules.length
    }`).join(",")}`);
  check(value > 3, "external O input did not reach RuntimeCore");
  check(statuses.includes("saving") && statuses.includes("saved"),
    "persistence status events are incomplete");
  await player.dispose();
  return {
    apiVersion: PICO8_WEB_PLAYER_API_VERSION,
    frames: frames.length,
    writes: writes.length,
    adapterFlushes,
    finalValue: value,
    backgroundStatus: background.status,
    hostedToolbarHidden: true,
  };
}

try {
  document.body.dataset.progress = "host ports";
  resultNode.textContent = JSON.stringify(await run());
  document.body.dataset.progress = "complete";
  document.body.dataset.status = "complete";
} catch (error) {
  resultNode.textContent = error instanceof Error
    ? `${error.message}\n${error.stack ?? ""}`
    : String(error);
  document.body.dataset.status = "error";
}
