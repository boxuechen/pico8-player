import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".wasm", "application/wasm"],
]);

export async function startTestServer() {
  const rootPrefix = `${projectRoot}${sep}`;
  const server = createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const requestedPath = url.pathname === "/" ? "/apps/web-player/dist/release/demo/" : url.pathname;
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
  const testServer = await startTestServer();
  process.stdout.write(`${testServer.origin}/apps/web-player/dist/release/demo/\n`);
}
