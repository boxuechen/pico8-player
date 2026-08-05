import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { artifactMetadata, machineMetadata, projectRoot, sourceRevision } from "./common.mjs";

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".wasm", "application/wasm"],
]);

export async function startBenchmarkServer({ availability } = {}) {
  const metadata = {
    sourceRevision: sourceRevision(),
    artifact: await artifactMetadata(),
    machine: machineMetadata(),
    availability: availability ?? [
      { engine: "chromium", status: "not-run", reason: "Manual benchmark server" },
      { engine: "node", status: "not-run", reason: "Browser benchmark run" },
    ],
  };
  const rootPrefix = `${projectRoot}${sep}`;
  const server = createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/__phase0c_metadata.json") {
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify(metadata));
        return;
      }
      const requestedPath = url.pathname === "/" ? "/benchmarks/interop/" : url.pathname;
      const pathname = requestedPath.endsWith("/") ? `${requestedPath}index.html` : requestedPath;
      const path = resolve(projectRoot, `.${decodeURIComponent(pathname)}`);
      if (path !== projectRoot && !path.startsWith(rootPrefix)) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      const contents = await readFile(path);
      response.writeHead(200, {
        "content-type": CONTENT_TYPES.get(extname(path)) ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      response.end(contents);
    } catch (error) {
      response.writeHead(error?.code === "ENOENT" ? 404 : 500, { "content-type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise())),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const benchmarkServer = await startBenchmarkServer();
  process.stdout.write(`${benchmarkServer.origin}/benchmarks/interop/\n`);
}
