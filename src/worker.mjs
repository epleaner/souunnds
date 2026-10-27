import { Buffer } from "node:buffer";
import { DurableObject } from "cloudflare:workers";
import { videoUrl } from "../youtube-url.mjs";
import { ProjectService, ProjectError, MAX_MANIFEST_BYTES } from "./server/share-projects.mjs";
import { D1ProjectStore } from "./server/d1-project-store.mjs";
import { R2ProjectAssets } from "./server/r2-project-assets.mjs";

export class MediaContainer extends DurableObject {
  starting;
  ready = false;

  constructor(ctx, env) {
    super(ctx, env);
    if (ctx.container?.running) {
      ctx.blockConcurrencyWhile(() => ctx.container.setInactivityTimeout(5 * 60_000));
    }
  }

  async fetch(request) {
    if (!this.ready || !this.ctx.container?.running) {
      this.ready = false;
      if (!this.starting) this.starting = this.startMedia().finally(() => { this.starting = null; });
      await this.starting;
    }
    return this.ctx.container.getTcpPort(8080).fetch(request);
  }

  async startMedia() {
    const container = this.ctx.container;
    if (!container) throw new Error("Media container is not configured");
    if (!container.running) {
      container.start({ image: container.images.base, instance: "standard-1", enableInternet: true });
      await container.setInactivityTimeout(5 * 60_000);
    }
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const response = await container.getTcpPort(8080).fetch("http://media.internal/health", {
          signal: AbortSignal.timeout(2_000),
        });
        if (response.status === 204) {
          this.ready = true;
          return;
        }
      } catch {
        // The container may still be allocating or starting its HTTP server.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("Media container did not become ready");
  }
}

function json(status, value, headers = {}) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store", ...headers } });
}
function bearer(request) {
  const header = request.headers.get("authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}
async function bodyJson(request, max = MAX_MANIFEST_BYTES + 1024) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    throw new ProjectError(415, "Expected JSON request");
  if (Number(request.headers.get("content-length")) > max) throw new ProjectError(413, "Request is too large");
  const reader = request.body?.getReader();
  if (!reader) throw new ProjectError(400, "Invalid JSON");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw new ProjectError(413, "Request is too large");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks, size))); }
  catch { throw new ProjectError(400, "Invalid JSON"); }
}

async function projectRoute(request, env, parts) {
  if (!env.DB || !env.AUDIO) return json(503, { error: "Project sharing is not configured" }, { "Retry-After": "60" });
  const store = new D1ProjectStore(env.DB);
  const projects = new ProjectService(store);
  const assets = new R2ProjectAssets(store, projects, env.AUDIO);
  const method = request.method;
  const id = parts[2];
  const assetId = parts[4];
  if (parts.length === 2 && method === "POST") {
    const created = await projects.create((await bodyJson(request)).manifest);
    return json(201, created, { ETag: `"${created.project.revision}"` });
  }
  if (parts.length === 3 && method === "GET") {
    const project = await projects.read(id);
    return json(200, project, { ETag: `"${project.revision}"` });
  }
  if (parts.length === 3 && method === "PUT") {
    const etag = request.headers.get("if-match");
    const revision = /^"[1-9]\d*"$/.test(etag || "") ? Number(etag.slice(1, -1)) : NaN;
    const project = await projects.update(id, bearer(request), revision, (await bodyJson(request)).manifest);
    return json(200, project, { ETag: `"${project.revision}"` });
  }
  if (parts.length === 3 && method === "DELETE") {
    await projects.delete(id, bearer(request));
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }
  if (parts.length === 4 && parts[3] === "assets" && method === "POST") {
    return json(201, await assets.beginUpload(id, bearer(request), await bodyJson(request)));
  }
  if (parts.length === 5 && parts[3] === "assets" && method === "GET")
    return json(200, await assets.download(id, assetId));
  if (parts.length === 5 && parts[3] === "assets" && method === "DELETE") {
    await assets.cancelUpload(id, bearer(request), assetId);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }
  if (parts.length === 6 && parts[3] === "assets" && parts[5] === "upload" && method === "PUT") {
    await assets.upload(id, bearer(request), assetId, request);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }
  if (parts.length === 6 && parts[3] === "assets" && parts[5] === "complete" && method === "POST")
    return json(200, await assets.completeUpload(id, bearer(request), assetId));
  if (parts.length === 6 && parts[3] === "assets" && parts[5] === "file" && method === "GET")
    return assets.file(id, assetId);
  return json(404, { error: "Project route not found" });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/youtube/audio") {
      if (request.method !== "POST") return json(405, { error: "Method not allowed" }, { Allow: "POST" });
      try {
        const url = videoUrl((await bodyJson(request, 2048))?.url);
        if (!url) throw new ProjectError(400, "Enter a valid YouTube video URL");
        return await ctx.exports.MediaContainer.getByName("youtube").fetch(new Request("http://media.internal/api/youtube/audio", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }), signal: request.signal,
        }));
      } catch (error) {
        return json(error instanceof ProjectError ? error.status : 503,
          { error: error instanceof ProjectError ? error.message : "Audio extraction failed" });
      }
    }
    if (url.pathname === "/api/projects" || url.pathname.startsWith("/api/projects/")) {
      try { return await projectRoute(request, env, url.pathname.split("/").filter(Boolean)); }
      catch (error) {
        if (!(error instanceof ProjectError)) console.error("Project request failed", error);
        return json(error instanceof ProjectError ? error.status : 500,
          { error: error instanceof ProjectError ? error.message : "Project request failed" });
      }
    }
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404 || !request.headers.get("accept")?.includes("text/html")) return asset;
    return env.ASSETS.fetch(new Request(new URL("/index.html", request.url), request));
  },
  async scheduled(_event, env) {
    if (!env.DB || !env.AUDIO) return;
    const store = new D1ProjectStore(env.DB);
    await new R2ProjectAssets(store, new ProjectService(store), env.AUDIO).cleanupExpired();
  },
};
