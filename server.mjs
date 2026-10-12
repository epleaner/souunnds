import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AudioRequestError, extractAudio, videoUrl } from "./youtube-audio.mjs";
import { ProjectService } from "./src/server/share-projects.mjs";
import { createProjectRequestHandler } from "./src/server/share-project-routes.mjs";
import { PostgresProjectStore } from "./src/server/postgres-project-store.mjs";
import { Pool } from "pg";
import { RailwayBucket } from "./src/server/railway-bucket.mjs";
import { ProjectAssetService } from "./src/server/project-assets.mjs";

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

async function youtubeAudio(request, response) {
  const controller = new AbortController();
  const disconnect = () => {
    if (!response.writableEnded) controller.abort();
  };
  response.on("close", disconnect);
  try {
    if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
      throw new AudioRequestError(415, "Expected JSON request");
    }
    let bytes = 0;
    const chunks = [];
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 2048) throw new AudioRequestError(413, "Request is too large");
      chunks.push(chunk);
    }
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new AudioRequestError(400, "Invalid JSON");
    }
    const url = videoUrl(body?.url);
    if (!url) throw new AudioRequestError(400, "Enter a valid YouTube video URL");
    const { audio, title } = await extractAudio(url, controller.signal);
    if (!response.destroyed) {
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "audio/wav",
        "X-Source-Title": encodeURIComponent(title),
        "Content-Length": audio.length,
      }).end(audio);
    }
  } catch (error) {
    if (!response.destroyed) {
      const status = error instanceof AudioRequestError && error.status !== 499 ? error.status : 500;
      const message = error instanceof AudioRequestError ? error.message : "Audio extraction failed";
      const payload = JSON.stringify({ error: message });
      response.writeHead(status, {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
      }).end(payload);
    }
  } finally {
    response.off("close", disconnect);
  }
}

let projectRequestHandler = null;

async function initializeProjectService() {
  if (!process.env.DATABASE_URL) return;
  const bucketSettings = [
    process.env.RAILWAY_BUCKET_ENDPOINT,
    process.env.RAILWAY_BUCKET_NAME,
    process.env.RAILWAY_BUCKET_ACCESS_KEY_ID,
    process.env.RAILWAY_BUCKET_SECRET_ACCESS_KEY,
  ];
  const hasBucketSettings = bucketSettings.some(Boolean);
  if (hasBucketSettings && bucketSettings.some((value) => !value)) {
    throw new Error("Railway Bucket environment configuration is incomplete");
  }
  const bucket = hasBucketSettings ? new RailwayBucket({
    endpoint: process.env.RAILWAY_BUCKET_ENDPOINT,
    bucket: process.env.RAILWAY_BUCKET_NAME,
    accessKeyId: process.env.RAILWAY_BUCKET_ACCESS_KEY_ID,
    secretAccessKey: process.env.RAILWAY_BUCKET_SECRET_ACCESS_KEY,
    region: process.env.RAILWAY_BUCKET_REGION,
    pathStyle: process.env.RAILWAY_BUCKET_PATH_STYLE === "true",
  }) : null;
  const store = new PostgresProjectStore(new Pool({ connectionString: process.env.DATABASE_URL }));
  await store.initialize();
  const projects = new ProjectService(store, { bucket });
  const assets = bucket ? new ProjectAssetService(store, projects, bucket) : null;
  projectRequestHandler = createProjectRequestHandler(projects, assets);
  if (assets) {
    const cleanupExpiredAssets = () => void assets.cleanupExpired()
      .catch((error) => console.error("Expired audio asset cleanup failed", error));
    cleanupExpiredAssets();
    const cleanupTimer = setInterval(cleanupExpiredAssets, 6 * 60 * 60 * 1000);
    cleanupTimer.unref();
  }
}

function unavailableProjectApi(response) {
  response.writeHead(503, {
    "Retry-After": "60",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  }).end(JSON.stringify({ error: "Project sharing is not configured" }));
}
const server = createServer(async (request, response) => {
  if (request.url === "/api/youtube/audio") {
    if (request.method !== "POST") {
      response.writeHead(405, {
        Allow: "POST",
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
      }).end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    await youtubeAudio(request, response);
    return;
  }
  const requestPath = new URL(request.url || "/", "http://localhost").pathname;
  if (requestPath === "/api/projects" || requestPath.startsWith("/api/projects/")) {
    if (!projectRequestHandler) unavailableProjectApi(response);
    else await projectRequestHandler(request, response);
    return;
  }

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

async function start() {
  await initializeProjectService();
  server.listen(port, "0.0.0.0", () => {
    console.log(`souunnds listening on ${port}`);
  });
}

void start();
