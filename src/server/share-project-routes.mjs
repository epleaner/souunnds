import { MAX_MANIFEST_BYTES, ProjectError } from "./share-projects.mjs";

async function readJson(request) {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw new ProjectError(415, "Expected JSON request");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_MANIFEST_BYTES + 1024) throw new ProjectError(413, "Request is too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ProjectError(400, "Invalid JSON");
  }
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  }).end(body === undefined ? undefined : JSON.stringify(body));
}

function editCapability(request) {
  return request.headers.authorization?.startsWith("Bearer ")
    ? request.headers.authorization.slice(7) : "";
}

export function createProjectRequestHandler(service, assetService = null) {
  return async function handleProjectRequest(request, response) {
    const url = new URL(request.url || "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "api" || parts[1] !== "projects") return false;
    try {
      if (parts.length === 2 && request.method === "POST") {
        const body = await readJson(request);
        const created = await service.create(body?.manifest);
        send(response, 201, created, { ETag: `"${created.project.revision}"` });
      } else if (parts.length === 3) {
        const id = parts[2];
        if (request.method === "GET") {
          const project = await service.read(id);
          send(response, 200, project, { ETag: `"${project.revision}"` });
        } else if (request.method === "PUT") {
          const etag = request.headers["if-match"];
          const expectedRevision = typeof etag === "string" && /^"[1-9]\d*"$/.test(etag)
            ? Number(etag.slice(1, -1)) : NaN;
          const body = await readJson(request);
          const project = await service.update(id, editCapability(request), expectedRevision, body?.manifest);
          send(response, 200, project, { ETag: `"${project.revision}"` });
        } else if (request.method === "DELETE") {
          await service.delete(id, editCapability(request));
          send(response, 204);
        } else {
          send(response, 405, { error: "Method not allowed" }, { Allow: "GET, PUT, DELETE" });
        }
      } else if (parts.length === 4 && parts[3] === "assets" && request.method === "POST") {
        if (!assetService) throw new ProjectError(503, "Project audio storage is not configured");
        const body = await readJson(request);
        const upload = await assetService.beginUpload(parts[2], editCapability(request), body);
        send(response, 201, upload);
      } else if (parts.length === 5 && parts[3] === "assets") {
        if (!assetService) throw new ProjectError(503, "Project audio storage is not configured");
        if (request.method === "GET") {
          send(response, 200, await assetService.download(parts[2], parts[4]));
        } else if (request.method === "DELETE") {
          await assetService.cancelUpload(parts[2], editCapability(request), parts[4]);
          send(response, 204);
        } else {
          send(response, 405, { error: "Method not allowed" }, { Allow: "GET, DELETE" });
        }
      } else if (parts.length === 6 && parts[3] === "assets" && parts[5] === "complete" && request.method === "POST") {
        if (!assetService) throw new ProjectError(503, "Project audio storage is not configured");
        const completed = await assetService.completeUpload(parts[2], editCapability(request), parts[4]);
        send(response, 200, completed);
      } else {
        send(response, 404, { error: "Project route not found" });
      }
    } catch (error) {
      const status = error instanceof ProjectError ? error.status : 500;
      send(response, status, { error: error instanceof ProjectError ? error.message : "Project request failed" });
    }
    return true;
  };
}
