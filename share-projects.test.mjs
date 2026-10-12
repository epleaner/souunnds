import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { createProjectRequestHandler } from "./src/server/share-project-routes.mjs";
import { MemoryProjectStore, ProjectService } from "./src/server/share-projects.mjs";

const servers = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

function manifest(name = "First") {
  return {
    version: 1,
    sources: [{ id: "source-1", name, duration: 2.5, kind: "missing" }],
    state: { layers: [{ id: "layer-1", sourceId: "source-1" }], sequencers: [], effects: {} },
  };
}

async function api() {
  const service = new ProjectService(new MemoryProjectStore());
  const server = createServer((request, response) => void createProjectRequestHandler(service)(request, response));
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

it("creates a read-only share project and returns the edit capability only at creation", async () => {
  const base = await api();
  const createdResponse = await fetch(`${base}/api/projects`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ manifest: manifest() }),
  });
  expect(createdResponse.status).toBe(201);
  const created = await createdResponse.json();
  expect(created.capability).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(created.project.revision).toBe(1);
  expect(createdResponse.headers.get("etag")).toBe('"1"');

  const shareResponse = await fetch(`${base}/api/projects/${created.project.id}`);
  expect(shareResponse.status).toBe(200);
  const shared = await shareResponse.json();
  expect(shared).toEqual(created.project);
  expect(shareResponse.headers.get("cache-control")).toBe("no-store");
  expect(JSON.stringify(shared)).not.toContain(created.capability);
});

it("requires the owner capability and rejects stale writes without changing saved data", async () => {
  const base = await api();
  const created = await (await fetch(`${base}/api/projects`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ manifest: manifest() }),
  })).json();
  const path = `${base}/api/projects/${created.project.id}`;
  const update = (capability, revision, name) => fetch(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${capability}`, "If-Match": `"${revision}"` },
    body: JSON.stringify({ manifest: manifest(name) }),
  });
  expect((await update("A".repeat(43), 1, "Nope")).status).toBe(403);
  expect((await update(created.capability, 1, "Saved")).status).toBe(200);
  expect((await update(created.capability, 1, "Stale")).status).toBe(409);
  const competing = await Promise.all([
    update(created.capability, 2, "Concurrent A"),
    update(created.capability, 2, "Concurrent B"),
  ]);
  expect(competing.map((response) => response.status).sort()).toEqual([200, 409]);
  const saved = await (await fetch(path)).json();
  expect(saved.revision).toBe(3);
  expect(["Concurrent A", "Concurrent B"]).toContain(saved.manifest.sources[0].name);
});

it("rejects invalid manifests and supports owner deletion", async () => {
  const base = await api();
  const invalid = await fetch(`${base}/api/projects`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ manifest: { version: 99 } }),
  });
  expect(invalid.status).toBe(400);
  const invalidYoutube = manifest();
  invalidYoutube.sources[0] = { ...invalidYoutube.sources[0], kind: "youtube", url: "https://evil.example/watch?v=abcdefghijk" };
  const rejectedYoutube = await fetch(`${base}/api/projects`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ manifest: invalidYoutube }),
  });
  expect(rejectedYoutube.status).toBe(400);
  const created = await (await fetch(`${base}/api/projects`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ manifest: manifest() }),
  })).json();
  const path = `${base}/api/projects/${created.project.id}`;
  expect((await fetch(path, { method: "DELETE" })).status).toBe(401);
  expect((await fetch(path, { method: "DELETE", headers: { Authorization: `Bearer ${created.capability}` } })).status).toBe(204);
  expect((await fetch(path)).status).toBe(404);
});
