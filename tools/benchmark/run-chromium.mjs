import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { assertValidInteropResult } from "../../benchmarks/interop/validate.mjs";
import { projectRoot } from "./common.mjs";
import { startBenchmarkServer } from "./server.mjs";

const CHROMIUM_CANDIDATES = [
  process.env.P8W_CHROMIUM,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

const delay = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

async function firstAvailable(paths) {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {
      // Continue to the next explicit candidate.
    }
  }
  throw new Error("Chromium executable not found; set P8W_CHROMIUM");
}

async function installed(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function waitForDevToolsPort(path, processHandle) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (processHandle.exitCode !== null) throw new Error(`Chromium exited before CDP was ready (${processHandle.exitCode})`);
    try {
      const [port, browserPath] = (await readFile(path, "utf8")).trim().split(/\r?\n/u);
      if (port && browserPath) return { port: Number(port), browserPath };
    } catch {
      // DevToolsActivePort is written asynchronously.
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for Chromium DevToolsActivePort");
}

class CdpConnection {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(String(data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  async open() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise((resolvePromise, reject) => {
      this.socket.addEventListener("open", resolvePromise, { once: true });
      this.socket.addEventListener("error", () => reject(new Error("Unable to connect to Chromium CDP")), { once: true });
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
}

async function evaluate(cdp, expression) {
  const response = await cdp.command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text ?? "Browser evaluation failed");
  return response.result.value;
}

async function stopProcess(processHandle) {
  if (processHandle.exitCode !== null) return;
  processHandle.kill("SIGTERM");
  await Promise.race([
    new Promise((resolvePromise) => processHandle.once("exit", resolvePromise)),
    delay(3_000),
  ]);
  if (processHandle.exitCode === null) processHandle.kill("SIGKILL");
}

const smoke = process.argv.includes("--smoke");
const outputIndex = process.argv.indexOf("--output");
const outputPath = outputIndex === -1
  ? join(projectRoot, "benchmarks", "interop", "results", smoke ? "chromium-smoke.json" : "chromium-macos-arm64.json")
  : resolve(projectRoot, process.argv[outputIndex + 1]);
const chromium = await firstAvailable(CHROMIUM_CANDIDATES);
const version = spawnSync(chromium, ["--version"], { encoding: "utf8" }).stdout.trim();
const firefoxInstalled = await installed("/Applications/Firefox.app/Contents/MacOS/firefox");
const safariInstalled = await installed("/Applications/Safari.app/Contents/MacOS/Safari");
const availability = [
  { engine: "chromium", status: "measured" },
  {
    engine: "firefox",
    status: firefoxInstalled ? "not-run" : "unavailable",
    reason: firefoxInstalled ? "Firefox was not automated in this run" : "Firefox executable was not installed on this runner",
  },
  {
    engine: "webkit",
    status: "not-run",
    reason: safariInstalled
      ? "Safari is installed, but Safari Remote Automation was not enabled or changed by this benchmark"
      : "Safari executable was not installed on this runner",
  },
  { engine: "node", status: "not-run", reason: "DedicatedWorker Chromium measurement" },
];
const benchmarkServer = await startBenchmarkServer({ availability });
const profileDirectory = await mkdtemp(join(tmpdir(), "p8w-phase0c-chromium-"));
const chromiumProcess = spawn(
  chromium,
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDirectory}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
let stderr = "";
chromiumProcess.stderr.setEncoding("utf8");
chromiumProcess.stderr.on("data", (chunk) => { stderr += chunk; });
let cdp;
try {
  const { port } = await waitForDevToolsPort(join(profileDirectory, "DevToolsActivePort"), chromiumProcess);
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = pages.find(({ type }) => type === "page");
  if (!page) throw new Error("Chromium did not expose a page target");
  cdp = new CdpConnection(page.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.command("Runtime.enable");
  await cdp.command("Page.enable");
  const url = `${benchmarkServer.origin}/benchmarks/interop/index.html${smoke ? "?smoke=1" : ""}`;
  await cdp.command("Page.navigate", { url });
  const deadline = Date.now() + (smoke ? 120_000 : 1_200_000);
  let previousProgress = "";
  for (;;) {
    if (Date.now() > deadline) throw new Error(`Timed out running ${smoke ? "smoke" : "full"} Chromium benchmark`);
    const state = await evaluate(cdp, "document.body?.dataset?.status ?? 'loading'");
    const progress = await evaluate(cdp, "document.body?.dataset?.progress ?? ''");
    if (progress && progress !== previousProgress) {
      previousProgress = progress;
      process.stderr.write(`\r${progress}                                                  `);
    }
    if (state === "complete") break;
    if (state === "error") {
      const message = await evaluate(cdp, "document.querySelector('#result')?.textContent ?? 'Unknown browser benchmark error'");
      throw new Error(message);
    }
    await delay(500);
  }
  process.stderr.write("\n");
  const json = await evaluate(cdp, "document.querySelector('#result').textContent");
  const result = JSON.parse(json);
  result.environment.browserVersionCommand = version;
  assertValidInteropResult(result);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${outputPath}\n`);
} catch (error) {
  if (stderr) process.stderr.write(`\nChromium stderr:\n${stderr.slice(-4000)}\n`);
  throw error;
} finally {
  cdp?.close();
  await benchmarkServer.close();
  await stopProcess(chromiumProcess);
  await rm(profileDirectory, { recursive: true, force: true });
}
