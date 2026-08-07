const resultNode = document.querySelector("#result");
const startButton = document.querySelector("#start");
const primaryRoot = document.querySelector("#player");
const secondaryRoot = document.querySelector("#secondary");

function check(condition, message) {
  if (!condition) throw new Error(message);
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(predicate, message, timeoutMs = 10_000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(message);
    await delay(10);
  }
}

async function readBytes(path) {
  const response = await fetch(path);
  check(response.ok, `unable to read project cart ${path}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function errorCode(error) {
  return error?.record?.code ?? error?.code ?? error?.name ?? "unknown";
}

function fuzzBytes(seed, length) {
  let state = seed >>> 0;
  const bytes = new Uint8Array(length);
  bytes[0] = 0x01;
  for (let index = 1; index < bytes.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

try {
  const [manifestResponse, validCart, faultCart] = await Promise.all([
    fetch("../../apps/web-player/dist/release/manifest.json"),
    readBytes("../conformance/carts/phase-7g/release-hardening.p8"),
    readBytes("../conformance/carts/phase-7g/fault.p8"),
  ]);
  check(manifestResponse.ok, "release manifest was unavailable");
  const manifest = await manifestResponse.json();
  const releaseRoot = new URL("../../apps/web-player/dist/release/", import.meta.url);
  const stylesheetResponse = await fetch(
    new URL(manifest.artifacts.styles.path, releaseRoot),
  );
  check(stylesheetResponse.ok, "release stylesheet was unavailable");
  const stylesheet = document.createElement("style");
  stylesheet.textContent = await stylesheetResponse.text();
  document.head.append(stylesheet);
  const module = await import(new URL(manifest.artifacts.main.path, releaseRoot).href);
  let player = await module.createPico8WebPlayer({
    root: primaryRoot,
    commandTimeoutMs: 500,
    audio: { requestedSampleRate: 48_000 },
  });
  const states = [];
  const faults = [];
  const diagnostics = [];
  const frames = [];
  const removers = [
    player.on("state", (event) => states.push(event.state)),
    player.on("fault", (event) => faults.push(event.error.code)),
    player.on("diagnostic", (event) => diagnostics.push(event.error.code)),
    player.on("frame", (event) => frames.push({
      sessionGeneration: event.sessionGeneration,
      frameId: event.frameId,
    })),
  ];
  await player.loadCart(validCart, { displayName: "release-hardening.p8" });

  async function start() {
    await player.start();
    await waitFor(() => frames.length >= 3, "release cart did not publish frames");
    return { state: player.state, frames: frames.length };
  }

  async function menuEnvironmentProbe() {
    check(player.state === "menu-open", "pause menu was not open before blur probe");
    window.dispatchEvent(new Event("blur"));
    await waitFor(() => player.state === "paused", "blur did not enter host pause");
    check(document.querySelector(".pico8-player")?.dataset.menuOpen === "false",
      "blur left the cartridge menu open");
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => player.state === "running" || player.state === "audio-blocked",
      "focus did not resume after closing the cartridge menu");
    return player.state;
  }

  async function environmentProbe() {
    check(player.state === "running" || player.state === "audio-blocked",
      `environment probe started from ${player.state}`);
    let visibility = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    try {
      window.dispatchEvent(new Event("blur"));
      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      await waitFor(() => player.state === "paused" || player.state === "faulted",
        "blur/visibility did not settle");
      check(player.state === "paused", "duplicate environment pause faulted the player");
      const pausedFrames = frames.length;
      await delay(120);
      check(frames.length === pausedFrames, "hidden player accumulated frames");
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
      await waitFor(() => player.state === "running" || player.state === "audio-blocked",
        "visible/focus did not resume the player");

      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
      await waitFor(() => player.state === "paused" || player.state === "faulted",
        "persisted pagehide did not pause the player");
      check(player.state === "paused", "persisted pagehide faulted the player");
      const bfcacheFrames = frames.length;
      await delay(120);
      check(frames.length === bfcacheFrames, "bfcache pagehide accumulated frames");
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      await waitFor(() => player.state === "running" || player.state === "audio-blocked",
        "persisted pageshow did not resume the player");
    } finally {
      delete document.visibilityState;
    }
    return {
      pausedFrames: states.filter((state) => state === "paused").length,
      finalState: player.state,
    };
  }

  async function forceFault() {
    let faultCode;
    try {
      await player.loadCart(faultCart, {
        displayName: "fault.p8",
        instructionBudget: 1_000,
      });
    } catch (error) {
      faultCode = errorCode(error);
    }
    check(faultCode === "E_VM_INSTRUCTION_BUDGET",
      `fault cart returned ${faultCode}`);
    check(player.state === "faulted", "fault cart did not produce visible fault state");
    return faultCode;
  }

  async function recover() {
    await player.loadCart(validCart, { displayName: "release-hardening.p8" });
    await player.start();
    const baseline = frames.length;
    await waitFor(() => frames.length >= baseline + 2, "fault recovery produced no frames");
    return player.state;
  }

  async function deterministicIngressFuzz(iterations = 64) {
    let structuredRejections = 0;
    for (let index = 0; index < iterations; index += 1) {
      try {
        await player.loadCart(fuzzBytes(0x7a00 + index, 1 + (index % 127)), {
          displayName: `fuzz-${index}.p8`,
        });
      } catch (error) {
        const code = errorCode(error);
        check(typeof code === "string" && code.length > 0,
          `fuzz input ${index} was not rejected structurally`);
        structuredRejections += 1;
      }
    }
    check(structuredRejections === iterations,
      `${iterations - structuredRejections} malformed byte inputs were accepted`);
    await recover();
    return { iterations, structuredRejections };
  }

  async function recoveryCycles(iterations = 20) {
    const tracker = window.__phase7g;
    const generationBefore = frames.at(-1)?.sessionGeneration ?? 0;
    let watchdogs = 0;
    for (let index = 0; index < iterations; index += 1) {
      const worker = tracker.workers.at(-1);
      check(worker !== undefined && !worker.__phase7gTerminated,
        `cycle ${index} had no active Worker`);
      worker.terminate();
      try {
        await player.pause();
      } catch (error) {
        check(errorCode(error) === "E_VM_WATCHDOG",
          `cycle ${index} returned ${errorCode(error)} instead of E_VM_WATCHDOG`);
        watchdogs += 1;
      }
      check(player.state === "faulted", `cycle ${index} was not visibly faulted`);
      const countAtFault = frames.length;
      await delay(30);
      check(frames.length === countAtFault, `cycle ${index} accepted stale frames`);
      await player.reset();
      await player.start();
      await waitFor(() => frames.length > countAtFault,
        `cycle ${index} did not recover a frame`);
    }
    const activeWorkers = tracker.workers.length - tracker.terminatedWorkers;
    check(watchdogs === iterations, "not every forced termination hit the watchdog");
    check(activeWorkers === 1, `recovery retained ${activeWorkers} active Workers`);
    check((frames.at(-1)?.sessionGeneration ?? 0) > generationBefore,
      "recovery cycles did not advance session generation");
    return {
      iterations,
      watchdogs,
      activeWorkers,
      workersCreated: tracker.workers.length,
      workersTerminated: tracker.terminatedWorkers,
    };
  }

  async function multipleInstanceProbe() {
    const firstBaseline = frames.length;
    const second = await module.createPico8WebPlayer({
      root: secondaryRoot,
      commandTimeoutMs: 2_000,
      audio: { requestedSampleRate: 44_100 },
    });
    let secondFrames = 0;
    second.on("frame", () => secondFrames += 1);
    await second.loadCart(validCart, { displayName: "second.p8" });
    await second.start();
    await waitFor(() => secondFrames >= 3 && frames.length >= firstBaseline + 3,
      "multiple instances did not advance independently");
    await second.dispose();
    const postDispose = frames.length;
    await waitFor(() => frames.length >= postDispose + 2,
      "disposing the second instance stopped the first");
    return { secondFrames, firstFramesAfterSecondDispose: frames.length - postDispose };
  }

  async function dispose() {
    const tracker = window.__phase7g;
    for (const remove of removers.splice(0)) remove();
    await player.dispose();
    await delay(100);
    const resources = {
      workersCreated: tracker.workers.length,
      workersTerminated: tracker.terminatedWorkers,
      activeAnimationFrames: tracker.activeAnimationFrames.size,
      audioStates: tracker.contexts.map((context) => context.state),
    };
    check(resources.workersCreated === resources.workersTerminated,
      "dispose retained a Worker");
    check(resources.activeAnimationFrames === 0,
      "dispose retained an animation frame");
    check(resources.audioStates.every((state) => state === "closed"),
      "dispose retained an AudioContext");
    return resources;
  }

  window.phase7gHarness = {
    get player() { return player; },
    get summary() {
      return {
        state: player.state,
        states: [...states],
        faults: [...faults],
        diagnostics: [...diagnostics],
        frames: frames.length,
      };
    },
    start,
    menuEnvironmentProbe,
    environmentProbe,
    forceFault,
    recover,
    deterministicIngressFuzz,
    recoveryCycles,
    multipleInstanceProbe,
    dispose,
  };

  startButton.disabled = false;
  startButton.addEventListener("click", async () => {
    startButton.disabled = true;
    try {
      const result = await start();
      resultNode.textContent = JSON.stringify(result);
      document.body.dataset.status = "running";
      document.body.dataset.progress = "visual-playfield";
    } catch (error) {
      resultNode.textContent = error instanceof Error ? error.stack ?? error.message : String(error);
      document.body.dataset.status = "error";
    }
  }, { once: true });
  document.body.dataset.status = "awaiting-gesture";
  document.body.dataset.progress = "start";
} catch (error) {
  resultNode.textContent = error instanceof Error ? error.stack ?? error.message : String(error);
  document.body.dataset.status = "error";
}
