import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { startBenchmarkServer } from "../benchmark/server.mjs";

const CANDIDATES = [
  process.env.P8W_CHROMIUM,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function firstAvailable() {
  for (const path of CANDIDATES) {
    try {
      await access(path);
      return path;
    } catch {}
  }
  throw new Error("Chrome/Chromium executable not found; set P8W_CHROMIUM");
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
    this.socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(String(data));
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
  }

  command(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

async function evaluate(cdp, expression) {
  const response = await cdp.command("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.exceptionDetails) throw new Error("Chrome evaluation failed");
  return response.result.value;
}

async function stop(processHandle) {
  if (processHandle.exitCode !== null) return;
  processHandle.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => processHandle.once("exit", resolve)),
    delay(3000),
  ]);
  if (processHandle.exitCode === null) processHandle.kill("SIGKILL");
}

const chrome = await firstAvailable();
const version = spawnSync(chrome, ["--version"], { encoding: "utf8" }).stdout.trim();
const server = await startBenchmarkServer({ availability: [] });
const profile = await mkdtemp(join(tmpdir(), "p8w-phase0e-chrome-"));
const processHandle = spawn(
  chrome,
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
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
  await cdp.command("Page.navigate", {
    url: `${server.origin}/tests/browser/phase-0e.html`,
  });
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error("Timed out running Phase 0E Chrome gate");
    const status = await evaluate(cdp, "document.body?.dataset?.status ?? 'loading'");
    if (status === "complete") break;
    if (status === "error") {
      const progress = await evaluate(cdp, "document.body?.dataset?.progress ?? ''");
      throw new Error(`${progress}: ${await evaluate(cdp, "document.querySelector('#result')?.textContent")}`);
    }
    await delay(100);
  }
  const result = JSON.parse(
    await evaluate(cdp, "document.querySelector('#result').textContent"),
  );
  if (
    result.callbackSteps !== 60 ||
    result.completedSlices !== "62" ||
    result.watchdogCode !== "E_VM_WATCHDOG" ||
    result.recovered !== true
  ) {
    throw new Error(`Invalid Phase 0E Chrome result: ${JSON.stringify(result)}`);
  }
  process.stdout.write(`${JSON.stringify({ browser: version, ...result }, null, 2)}\n`);
} finally {
  cdp?.close();
  await server.close();
  await stop(processHandle);
  await rm(profile, { recursive: true, force: true });
}
