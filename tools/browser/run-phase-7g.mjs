import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startBenchmarkServer } from "../benchmark/server.mjs";
import {
  delay,
  evaluate,
  launchChrome,
  waitForDocumentStatus,
} from "./chrome-cdp.mjs";

function check(condition, message) {
  if (!condition) throw new Error(message);
}

const server = await startBenchmarkServer({ availability: [] });
const chrome = await launchChrome({
  profilePrefix: "p8w-phase7g-",
  extraFlags: [
    "--autoplay-policy=no-user-gesture-required",
    "--enable-precise-memory-info",
  ],
});
const screenshotDirectory = await mkdtemp(join(tmpdir(), "p8w-phase7g-screenshots-"));

async function waitFor(expression, message, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await evaluate(chrome.cdp, expression)) return;
    const status = await evaluate(chrome.cdp, "document.body?.dataset.status ?? 'loading'");
    if (status === "error") {
      const detail = await evaluate(
        chrome.cdp,
        "document.querySelector('#result')?.textContent ?? ''",
      );
      throw new Error(`${message}: ${detail}`);
    }
    if (Date.now() > deadline) throw new Error(message);
    await delay(25);
  }
}

async function trustedClick(selector) {
  const bounds = await evaluate(chrome.cdp, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error('missing click target: ${selector}');
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = element.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      disabled: Boolean(element.disabled),
    };
  })()`);
  check(!bounds.disabled, `click target is disabled: ${selector}`);
  await chrome.cdp.command("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: bounds.x,
    y: bounds.y,
    button: "left",
    clickCount: 1,
  });
  await chrome.cdp.command("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: bounds.x,
    y: bounds.y,
    button: "left",
    clickCount: 1,
  });
}

async function capture(name) {
  const { data } = await chrome.cdp.command("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
    fromSurface: true,
  });
  const path = join(screenshotDirectory, `${name}.png`);
  await writeFile(path, Buffer.from(data, "base64"));
  return path;
}

try {
  await chrome.cdp.command("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const NativeWorker = window.Worker;
      const NativeAudioContext = window.AudioContext;
      const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
      const nativeCancelAnimationFrame = window.cancelAnimationFrame.bind(window);
      const nativeAddEventListener = EventTarget.prototype.addEventListener;
      const nativeRemoveEventListener = EventTarget.prototype.removeEventListener;
      const listenerIds = new WeakMap();
      let nextListenerId = 1;
      const tracker = window.__phase7g = {
        workers: [],
        terminatedWorkers: 0,
        contexts: [],
        activeAnimationFrames: new Set(),
        activeDomListeners: new Set(),
      };
      function listenerId(listener) {
        if ((typeof listener !== 'object' || listener === null) && typeof listener !== 'function') {
          return String(listener);
        }
        let id = listenerIds.get(listener);
        if (id === undefined) {
          id = nextListenerId++;
          listenerIds.set(listener, id);
        }
        return id;
      }
      function listenerKey(target, type, listener, options) {
        const targetName = target === window ? 'window' : target === document ? 'document' : '';
        const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
        return targetName ? targetName + ':' + type + ':' + capture + ':' + listenerId(listener) : '';
      }
      EventTarget.prototype.addEventListener = function(type, listener, options) {
        const key = listenerKey(this, type, listener, options);
        if (key) tracker.activeDomListeners.add(key);
        return nativeAddEventListener.call(this, type, listener, options);
      };
      EventTarget.prototype.removeEventListener = function(type, listener, options) {
        const key = listenerKey(this, type, listener, options);
        if (key) tracker.activeDomListeners.delete(key);
        return nativeRemoveEventListener.call(this, type, listener, options);
      };
      window.Worker = class TrackedWorker extends NativeWorker {
        constructor(...args) {
          super(...args);
          tracker.workers.push(this);
        }
        terminate() {
          if (!this.__phase7gTerminated) {
            this.__phase7gTerminated = true;
            tracker.terminatedWorkers += 1;
          }
          return super.terminate();
        }
      };
      window.AudioContext = class TrackedAudioContext extends NativeAudioContext {
        constructor(...args) {
          super(...args);
          tracker.contexts.push(this);
        }
      };
      window.requestAnimationFrame = (callback) => {
        let handle;
        handle = nativeRequestAnimationFrame((timestamp) => {
          tracker.activeAnimationFrames.delete(handle);
          callback(timestamp);
        });
        tracker.activeAnimationFrames.add(handle);
        return handle;
      };
      window.cancelAnimationFrame = (handle) => {
        tracker.activeAnimationFrames.delete(handle);
        return nativeCancelAnimationFrame(handle);
      };
    })();`,
  });
  await chrome.cdp.command("Emulation.setDeviceMetricsOverride", {
    width: 960,
    height: 820,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await chrome.cdp.command("Emulation.setEmulatedMedia", {
    media: "screen",
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await chrome.cdp.command("Page.navigate", {
    url: `${server.origin}/tests/browser/phase-7g.html`,
  });
  await waitForDocumentStatus(chrome.cdp, {
    accepted: ["awaiting-gesture"],
    timeoutMs: 120_000,
  });
  check(await evaluate(chrome.cdp, "crossOriginIsolated === false"),
    "hardening page unexpectedly required cross-origin isolation");

  await trustedClick("#start");
  await waitFor("document.body.dataset.status === 'running'", "release cart did not start");
  const playScreenshot = await capture("playfield");

  const visual = await evaluate(chrome.cdp, `(() => {
    const shell = document.querySelector('.pico8-player');
    const canvas = shell.querySelector('canvas');
    const rect = canvas.getBoundingClientRect();
    return {
      state: shell.dataset.playerState,
      backing: [canvas.width, canvas.height],
      css: [rect.width, rect.height],
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      canvasChildren: canvas.childElementCount,
    };
  })()`);
  check(["running", "audio-blocked"].includes(visual.state),
    `visual shell entered ${visual.state}`);
  check(visual.backing.join("x") === "128x128", "playfield backing store changed");
  check(visual.css[0] === visual.css[1] && visual.css[0] % 128 === 0,
    "playfield did not use an integer square scale");
  check(visual.reducedMotion, "reduced-motion emulation was not active");
  check(visual.canvasChildren === 0, "Canvas contained DOM UI");

  await chrome.cdp.command("Emulation.setDeviceMetricsOverride", {
    width: 620,
    height: 760,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await delay(100);
  const resized = await evaluate(chrome.cdp, `(() => {
    const rect = document.querySelector('.pico8-player canvas').getBoundingClientRect();
    return [rect.width, rect.height];
  })()`);
  check(resized[0] === resized[1] && resized[0] % 128 === 0,
    "narrow HiDPI resize lost integer scaling");

  await trustedClick("[data-action=mute]");
  check(await evaluate(
    chrome.cdp,
    "document.querySelector('[data-action=mute]').getAttribute('aria-pressed') === 'true'",
  ), "mute did not become visible in the public shell");
  await trustedClick("[data-action=mute]");
  check(await evaluate(
    chrome.cdp,
    "document.querySelector('[data-action=mute]').getAttribute('aria-pressed') === 'false'",
  ), "unmute did not restore the public shell state");

  await trustedClick("[data-action=fullscreen]");
  await waitFor("document.fullscreenElement !== null", "fullscreen entry failed");
  await evaluate(chrome.cdp, "document.exitFullscreen()");
  await waitFor("document.fullscreenElement === null", "fullscreen exit failed");

  await trustedClick("[data-action=menu]");
  await waitFor("window.phase7gHarness.player.state === 'menu-open'", "pause menu did not open");
  const menuScreenshot = await capture("pause-menu");
  await evaluate(chrome.cdp, "window.phase7gHarness.menuEnvironmentProbe()");
  await trustedClick("[data-action=menu-continue]");
  await waitFor(
    "['running','audio-blocked'].includes(window.phase7gHarness.player.state)",
    "pause menu did not close",
  );

  const lifecycle = await evaluate(chrome.cdp, "window.phase7gHarness.environmentProbe()");
  const faultCode = await evaluate(chrome.cdp, "window.phase7gHarness.forceFault()");
  const faultScreenshot = await capture("structured-fault");
  await evaluate(chrome.cdp, "window.phase7gHarness.recover()");
  const fuzz = await evaluate(
    chrome.cdp,
    "window.phase7gHarness.deterministicIngressFuzz(64)",
  );
  const recovery = await evaluate(
    chrome.cdp,
    "window.phase7gHarness.recoveryCycles(20)",
  );
  const multipleInstance = await evaluate(
    chrome.cdp,
    "window.phase7gHarness.multipleInstanceProbe()",
  );
  const summary = await evaluate(chrome.cdp, "window.phase7gHarness.summary");
  const resources = await evaluate(chrome.cdp, "window.phase7gHarness.dispose()");
  check(resources.activeDomListeners === undefined || resources.activeDomListeners === 0,
    "dispose retained DOM listeners");
  const listenerCount = await evaluate(chrome.cdp, "window.__phase7g.activeDomListeners.size");
  check(listenerCount === 0, `dispose retained ${listenerCount} window/document listeners`);

  const externalRequests = await evaluate(chrome.cdp, `performance.getEntriesByType('resource')
    .map((entry) => entry.name)
    .filter((url) => new URL(url).origin !== location.origin).length`);
  check(externalRequests === 0, "hardening gate made an external network request");
  check(faultCode === "E_VM_INSTRUCTION_BUDGET", "fault containment gate changed");
  check(fuzz.structuredRejections === 64, "byte ingress fuzz was incomplete");
  check(recovery.iterations === 20 && recovery.watchdogs === 20,
    "Worker recovery cycle gate was incomplete");
  check(resources.workersCreated === resources.workersTerminated,
    "final teardown retained a Worker");
  check(resources.audioStates.every((state) => state === "closed"),
    "final teardown retained an AudioContext");

  const result = {
    schemaVersion: 1,
    phase: "7G",
    browser: chrome.version,
    crossOriginIsolated: false,
    visual,
    lifecycle,
    faultCode,
    fuzz,
    recovery,
    multipleInstance,
    eventTotals: {
      states: summary.states.length,
      faults: summary.faults.length,
      diagnostics: summary.diagnostics.length,
      frames: summary.frames,
    },
    resources: { ...resources, activeDomListeners: listenerCount },
    externalRequests,
    screenshots: [playScreenshot, menuScreenshot, faultScreenshot],
  };
  if (process.env.P8W_PHASE7G_BROWSER_RESULT) {
    await writeFile(
      process.env.P8W_PHASE7G_BROWSER_RESULT,
      `${JSON.stringify(result, null, 2)}\n`,
    );
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await server.close();
  await chrome.close();
  if (process.env.P8W_KEEP_PHASE7G_SCREENSHOTS !== "1") {
    await rm(screenshotDirectory, { recursive: true, force: true });
  }
}
