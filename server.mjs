import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("./dist", import.meta.url)));
const port = Number(process.env.PORT || 4173);
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function safePath(requestUrl) {
  const pathname = decodeURIComponent(new URL(requestUrl, "http://localhost").pathname);
  const candidate = resolve(root, `.${normalize(pathname)}`);
  return candidate.startsWith(`${root}/`) || candidate === root ? candidate : null;
}

async function serve(pathname, response) {
  try {
    const info = await stat(pathname);
    if (!info.isFile()) throw new Error("not a file");
    response.writeHead(200, {
      "Cache-Control": pathname.endsWith("/index.html") ? "no-cache" : "public, max-age=31536000, immutable",
      "Content-Type": mimeTypes[extname(pathname)] || "application/octet-stream",
    });
    createReadStream(pathname).pipe(response);
    return true;
  } catch {
    return false;
  }
}

const server = createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }

  const pathname = safePath(request.url || "/");
  if (!pathname) {
    response.writeHead(400).end("Bad request");
    return;
  }

  const served = await serve(pathname, response);
  if (served || response.writableEnded) return;

  const acceptsHtml = request.headers.accept?.includes("text/html");
  if (acceptsHtml && (await serve(join(root, "index.html"), response))) return;

  response.writeHead(404).end("Not found");
});

server.listen(port, "0.0.0.0", () => {
  console.log(`souunnds listening on ${port}`);
});
