import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import {
  makeChunk,
  makePxaLiteralCode,
  PNG_SIGNATURE,
} from "../../tests/fixtures/p8png/fixture-builder.mjs";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REFERENCE_DIR = join(PROJECT_ROOT, "ref/phase0e-official-web");
const CALLBACK_STARTUP = process.argv.includes("--callback-startup");
const CALLBACK60_STARTUP = process.argv.includes("--callback60-startup");
const PROBE_NAME = CALLBACK60_STARTUP
  ? "phase-0e-callback60-startup-time"
  : CALLBACK_STARTUP
    ? "phase-0e-callback-startup-time"
    : "phase-0e-custom-loop-time";
const PROBE_SOURCE = join(PROJECT_ROOT, `tests/fixtures/official-web/${PROBE_NAME}.p8`);
const PROBE_PNG = join(REFERENCE_DIR, `${PROBE_NAME}.p8.png`);
const CAPTURE_PNG = join(REFERENCE_DIR, `${PROBE_NAME}-page.png`);
const CANVAS_CAPTURE_PNG = join(REFERENCE_DIR, `${PROBE_NAME}-canvas.png`);
const OFFICIAL_WIDGET = {
  path: join(REFERENCE_DIR, "bbs-widget.html"),
  url: "https://www.lexaloffle.com/bbs/widget.php?pid=pico_repl",
};
const OFFICIAL_PLAYER = {
  path: join(REFERENCE_DIR, "pico8_0207.js"),
  url: "https://www.lexaloffle.com/play/pico8_0207.js",
};
const CANDIDATES = [
  process.env.P8W_CHROMIUM,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);
const REFRESH = process.argv.includes("--refresh");
const delay = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
const CART_WIDTH = 160;
const CART_HEIGHT = 205;
const ROM_BYTES = 0x8000;
const PAYLOAD_BYTES = 0x8020;
const CODE_OFFSET = 0x4300;

async function firstAvailable() {
  for (const path of CANDIDATES) {
    try {
      await access(path);
      return path;
    } catch {}
  }
  throw new Error("Chrome/Chromium executable not found; set P8W_CHROMIUM");
}

async function ensureReference(reference) {
  if (!REFRESH) {
    try {
      await access(reference.path);
      return;
    } catch {}
  }
  const response = await fetch(reference.url);
  if (!response.ok) throw new Error(`Unable to download ${reference.url}: HTTP ${response.status}`);
  await writeFile(reference.path, new Uint8Array(await response.arrayBuffer()));
}

async function fileSha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function extractLua(p8Source) {
  const marker = /^__lua__\r?$/imu.exec(p8Source);
  if (!marker) throw new Error("Probe cart has no __lua__ section");
  const sectionStart = marker.index + marker[0].length;
  const afterMarker = p8Source.slice(sectionStart).replace(/^\r?\n/u, "");
  const nextMarker = /^__[a-z0-9_]+__\r?$/imu.exec(afterMarker);
  return nextMarker ? afterMarker.slice(0, nextMarker.index) : afterMarker;
}

function joinBytes(parts) {
  const joined = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

function u32be(value) {
  return Uint8Array.of(value >>> 24, value >>> 16, value >>> 8, value);
}

function encodeRgbaPng(rgba) {
  const ihdr = new Uint8Array(13);
  ihdr.set(u32be(CART_WIDTH), 0);
  ihdr.set(u32be(CART_HEIGHT), 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const rowBytes = CART_WIDTH * 4;
  const scanlines = new Uint8Array(CART_HEIGHT * (rowBytes + 1));
  for (let row = 0; row < CART_HEIGHT; row += 1) {
    scanlines.set(
      rgba.subarray(row * rowBytes, (row + 1) * rowBytes),
      row * (rowBytes + 1) + 1,
    );
  }
  return joinBytes([
    PNG_SIGNATURE,
    makeChunk("IHDR", ihdr),
    makeChunk("IDAT", deflateSync(scanlines)),
    makeChunk("IEND"),
  ]);
}

async function writeProbePng() {
  const lua = extractLua(await readFile(PROBE_SOURCE, "utf8"));
  const luaBytes = Buffer.from(lua);
  const codeBlock = makePxaLiteralCode(luaBytes);
  if (codeBlock.length >= ROM_BYTES - CODE_OFFSET) throw new Error("Probe code exceeds cart capacity");
  const payload = new Uint8Array(PAYLOAD_BYTES);
  payload.set(codeBlock, CODE_OFFSET);
  payload[ROM_BYTES] = 42;
  payload.set(
    createHash("sha1").update(payload.subarray(0, ROM_BYTES)).digest(),
    ROM_BYTES + 6,
  );
  const rgba = new Uint8Array(CART_WIDTH * CART_HEIGHT * 4);
  for (let pixel = 0; pixel < PAYLOAD_BYTES; pixel += 1) {
    const byte = payload[pixel];
    const offset = pixel * 4;
    rgba[offset] = (byte >>> 4) & 3;
    rgba[offset + 1] = (byte >>> 2) & 3;
    rgba[offset + 2] = byte & 3;
    rgba[offset + 3] = 0xfc | ((byte >>> 6) & 3);
  }
  const png = encodeRgbaPng(rgba);
  await writeFile(PROBE_PNG, png);
  return createHash("sha256").update(png).digest("hex");
}

async function waitForPort(path, processHandle) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (processHandle.exitCode !== null) throw new Error("Chrome exited before CDP was ready");
    try {
      const [port] = (await readFile(path, "utf8")).trim().split(/\r?\n/u);
      if (port) return Number(port);
    } catch {}
    await delay(100);
  }
  throw new Error("Timed out waiting for Chrome DevToolsActivePort");
}

class CdpConnection {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.eventHandlers = new Set();
    this.socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(String(data));
      const pending = this.pending.get(message.id);
      if (!pending) {
        if (message.method) {
          this.events.push(message);
          for (const handler of this.eventHandlers) handler(message);
        }
        return;
      }
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  async open() {
    await new Promise((resolvePromise, reject) => {
      this.socket.addEventListener("open", resolvePromise, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
  }

  command(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }

  onEvent(handler) {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }
}

async function evaluate(cdp, expression) {
  const response = await cdp.command("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? "Chrome evaluation failed");
  }
  return response.result.value;
}

async function waitFor(cdp, expression, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await evaluate(cdp, expression)) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await delay(100);
  }
}

async function stop(processHandle) {
  if (processHandle.exitCode !== null) return;
  processHandle.kill("SIGTERM");
  await Promise.race([
    new Promise((resolvePromise) => processHandle.once("exit", resolvePromise)),
    delay(3000),
  ]);
  if (processHandle.exitCode === null) processHandle.kill("SIGKILL");
}

await mkdir(REFERENCE_DIR, { recursive: true });
await Promise.all([
  ensureReference(OFFICIAL_WIDGET),
  ensureReference(OFFICIAL_PLAYER),
]);
const probeSha256 = await writeProbePng();
const probeSourceSha256 = await fileSha256(PROBE_SOURCE);
const officialWidgetSha256 = await fileSha256(OFFICIAL_WIDGET.path);
const officialPlayerSha256 = await fileSha256(OFFICIAL_PLAYER.path);
const chrome = await firstAvailable();
const browser = spawnSync(chrome, ["--version"], { encoding: "utf8" }).stdout.trim();
const profile = await mkdtemp(join(tmpdir(), "p8w-official-phase0e-chrome-"));
const processHandle = spawn(
  chrome,
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "about:blank",
  ],
  { stdio: "ignore" },
);

let cdp;
try {
  const port = await waitForPort(join(profile, "DevToolsActivePort"), processHandle);
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = pages.find(({ type }) => type === "page");
  if (!page) throw new Error("Chrome did not expose a page target");
  cdp = new CdpConnection(page.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.command("Runtime.enable");
  await cdp.command("Page.enable");
  await cdp.command("Log.enable");
  const probeBody = (await readFile(PROBE_PNG)).toString("base64");
  const probeBytes = Buffer.byteLength(probeBody, "base64");
  cdp.onEvent((event) => {
    if (event.method !== "Fetch.requestPaused") return;
    cdp.command("Fetch.fulfillRequest", {
      requestId: event.params.requestId,
      responseCode: 200,
      responseHeaders: [
        { name: "content-type", value: "image/png" },
        { name: "content-length", value: String(probeBytes) },
        { name: "cache-control", value: "no-store" },
      ],
      body: probeBody,
    }).catch(() => {});
  });
  await cdp.command("Fetch.enable", {
    patterns: [{
      urlPattern: "*://www.lexaloffle.com/bbs/get_cart.php*",
      requestStage: "Request",
    }],
  });
  await cdp.command("Emulation.setDeviceMetricsOverride", {
    width: 900,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.command("Page.navigate", {
    url: OFFICIAL_WIDGET.url,
  });
  await waitFor(
    cdp,
    `document.readyState === "complete" &&
      document.querySelector('img[onclick*="activate_p8_player"]') !== null`,
    "the official BBS play button",
    60_000,
  );
  const playButton = await evaluate(cdp, `(() => {
    const rect = document.querySelector('img[onclick*="activate_p8_player"]').getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await cdp.command("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: playButton.x,
    y: playButton.y,
    button: "left",
    clickCount: 1,
  });
  await cdp.command("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: playButton.x,
    y: playButton.y,
    button: "left",
    clickCount: 1,
  });
  await waitFor(
    cdp,
    "typeof Module?.pico8TogglePaused === 'function' && document.querySelector('#canvas')?.width > 0",
    "the official player runtime",
    60_000,
  );
  await waitFor(
    cdp,
    "typeof codo_mounted_filesystem !== 'undefined' && codo_mounted_filesystem === 1",
    "the official player filesystem",
    60_000,
  );
  await waitFor(
    cdp,
    "typeof pico8_state?.frame_number === 'number' && pico8_state.frame_number >= 5",
    "the official player startup frames",
    60_000,
  );
  await delay(500);
  await evaluate(cdp, "document.querySelector('#canvas').click(); true");
  await cdp.command("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "x",
    code: "KeyX",
    windowsVirtualKeyCode: 88,
    nativeVirtualKeyCode: 88,
  });
  await delay(100);
  await cdp.command("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "x",
    code: "KeyX",
    windowsVirtualKeyCode: 88,
    nativeVirtualKeyCode: 88,
  });
  await waitFor(
    cdp,
    `(() => {
      const canvas = document.querySelector("#canvas");
      if (!canvas || canvas.width < 62 || canvas.height < 62) return false;
      const pixel = canvas.getContext("2d", { willReadFrequently: true })
        .getImageData(61, 61, 1, 1).data;
      return pixel[0] === 0 && pixel[1] === 228 && pixel[2] === 54;
    })()`,
    "the project-owned probe completion marker",
    60_000,
  );

  const capture = await cdp.command("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  await writeFile(CAPTURE_PNG, Buffer.from(capture.data, "base64"));

  const pixels = await evaluate(cdp, `(() => {
    const source = document.querySelector("#canvas");
    const target = document.createElement("canvas");
    target.width = 128;
    target.height = 128;
    const context = target.getContext("2d", { willReadFrequently: true });
    context.imageSmoothingEnabled = false;
    context.drawImage(source, 0, 0, 128, 128);
    const bytes = context.getImageData(0, 0, 128, 128).data;
    const rgb = (x, y) => {
      const offset = (y * 128 + x) * 4;
      return [bytes[offset], bytes[offset + 1], bytes[offset + 2]];
    };
    return {
      canvas: { width: source.width, height: source.height },
      dataUrl: target.toDataURL("image/png"),
      background: rgb(40, 40),
      completion: rgb(61, 61),
      rowMarkers: Array.from({ length: 8 }, (_, row) => rgb(61, row * 4 + 1)),
      sampleBits: Array.from({ length: 8 }, (_, row) =>
        Array.from({ length: 8 }, (_, bit) => rgb(bit * 4 + 1, row * 4 + 1))
      ),
    };
  })()`);
  await writeFile(CANVAS_CAPTURE_PNG, Buffer.from(pixels.dataUrl.split(",")[1], "base64"));
  const canvasScreenshotSha256 = await fileSha256(CANVAS_CAPTURE_PNG);
  delete pixels.dataUrl;

  const colorKey = (rgb) => rgb.join(",");
  const bitColor = "255,241,232";
  const markerColor = "255,0,77";
  const completionColor = "0,228,54";
  const backgroundColor = "0,0,0";
  const runtimeState = await evaluate(cdp, `({
    p8IsRunning: typeof p8_is_running === "undefined" ? null : p8_is_running,
    frameNumber: typeof pico8_state === "undefined" ? null : pico8_state.frame_number,
    paused: typeof pico8_state === "undefined" ? null : pico8_state.is_paused,
    audioState: typeof pico8_audio_context === "undefined" ? null : pico8_audio_context.state,
    arguments: Module?.arguments ?? null,
    codoCommand: typeof codo_command === "undefined" ? null : codo_command,
    cartName: typeof _cartname === "undefined" ? null : _cartname,
    resources: performance.getEntriesByType("resource").map((entry) => ({
      name: entry.name,
      transferSize: entry.transferSize,
      duration: entry.duration,
    })),
  })`);
  runtimeState.console = cdp.events.flatMap((event) => {
    if (event.method === "Runtime.consoleAPICalled") {
      return [event.params.args.map((argument) => argument.value ?? argument.description).join(" ")];
    }
    if (event.method === "Log.entryAdded") return [event.params.entry.text];
    if (event.method === "Runtime.exceptionThrown") {
      return [event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text];
    }
    return [];
  });
  const samples = [];
  for (let row = 0; row < 8; row += 1) {
    if (colorKey(pixels.rowMarkers[row]) !== markerColor) {
      throw new Error(`Missing row marker at y=${row}: ${JSON.stringify({
        runtimeState,
        canvas: pixels.canvas,
        rowMarkers: pixels.rowMarkers.map(colorKey),
        sampleBits: pixels.sampleBits.map((gridRow) => gridRow.map(colorKey)),
      })}`);
    }
    let value = 0;
    for (let bit = 0; bit < 8; bit += 1) {
      const color = colorKey(pixels.sampleBits[row][bit]);
      if (color === bitColor) value |= 1 << bit;
      else if (color !== backgroundColor) {
        throw new Error(`Unexpected bit color at row=${row}, bit=${bit}: ${color}`);
      }
    }
    samples.push(value);
  }
  const expectedSamples = CALLBACK60_STARTUP
    ? [2, 2, 3, 4, 5, 6, 7, 8]
    : CALLBACK_STARTUP
      ? [1, 1, 2, 3, 4, 5, 6, 7]
      : [1, 2, 3, 4, 5, 6, 7, 8];
  if (samples.some((sample, index) => sample !== expectedSamples[index])) {
    throw new Error(`Official clock samples changed: expected ${expectedSamples}, received ${samples}`);
  }
  if (colorKey(pixels.completion) !== completionColor) {
    throw new Error(`Completion marker was not distinguishable in official-player capture: ${JSON.stringify({
      runtimeState,
      samples,
      bitColor,
      markerColor,
      completionColor,
      capturedCompletion: colorKey(pixels.completion),
      capturedBackground: colorKey(pixels.background),
    })}`);
  }

  process.stdout.write(`${JSON.stringify({
    browser,
    probe: PROBE_NAME,
    officialWidget: OFFICIAL_WIDGET.url,
    officialWidgetSha256,
    officialPlayer: OFFICIAL_PLAYER.url,
    officialPlayerSha256,
    probeSource: PROBE_SOURCE,
    probeSourceSha256,
    probeSha256,
    canvas: pixels.canvas,
    samples,
    expectedSamples,
    colors: { bitColor, markerColor, completionColor },
    pageScreenshot: CAPTURE_PNG,
    canvasScreenshot: CANVAS_CAPTURE_PNG,
    canvasScreenshotSha256,
  }, null, 2)}\n`);
} finally {
  cdp?.close();
  await stop(processHandle);
  await rm(profile, { recursive: true, force: true });
}
