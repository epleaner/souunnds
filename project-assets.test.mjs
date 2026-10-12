import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { createProjectRequestHandler } from "./src/server/share-project-routes.mjs";
import { ProjectAssetService } from "./src/server/project-assets.mjs";
import { MemoryProjectStore, ProjectService } from "./src/server/share-projects.mjs";

const servers = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

function wavFixture() {
  const wav = Buffer.alloc(48);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(4, 40);
  return wav;
}

async function api() {
  const store = new MemoryProjectStore();
  const objectDeletes = [];
  const objects = new Map();
  const bucket = {
    presignPost: (key, contentType, size) => ({
      url: "https://bucket.test/", fields: { key, "Content-Type": contentType, declaredSize: String(size) }, expiresIn: 300,
    }),
    presignGet: (key) => ({ url: `https://bucket.test/${key}`, expiresIn: 300 }),
    readObject: async (key, expectedSize) => {
      const object = objects.get(key);
      if (!object || object.bytes.length !== expectedSize) throw new Error("Missing or mismatched upload");
      return { contentType: object.contentType, size: object.bytes.length, bytes: Buffer.from(object.bytes) };
    },
    publishObject: async (key, bytes, contentType) => {
      objects.set(key, { bytes: Buffer.from(bytes), contentType });
    },
    deleteObject: async (key) => { objectDeletes.push(key); objects.delete(key); },
  };
  const projects = new ProjectService(store, { bucket });
  const assets = new ProjectAssetService(store, projects, bucket);
  const handler = createProjectRequestHandler(projects, assets);
  const server = createServer((request, response) => void handler(request, response));
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  servers.push(server);
  return { base: `http://127.0.0.1:${server.address().port}`, store, objectDeletes, objects, assets, bucket };
}

const missingManifest = {
  version: 1,
  sources: [{ id: "source-1", name: "Bass.wav", duration: 2.5, kind: "missing" }],
  state: { sources: [{ id: "source-1", name: "Bass.wav", duration: 2.5 }], layers: [], sequencers: [], effects: {} },
};

it("authorizes audio uploads, validates completion, serves referenced assets, and cleans removed objects", async () => {
  const { base, store, objectDeletes, objects, assets } = await api();
  const createdResponse = await fetch(`${base}/api/projects`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ manifest: missingManifest }),
  });
  const created = await createdResponse.json();
  const projectPath = `${base}/api/projects/${created.project.id}`;
  const assetsPath = `${projectPath}/assets`;
  const input = { fileName: "Bass.wav", contentType: "audio/wav", size: wavFixture().length };

  expect((await fetch(assetsPath, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  })).status).toBe(401);
  expect((await fetch(assetsPath, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${created.capability}` },
    body: JSON.stringify({ ...input, contentType: "text/html" }),
  })).status).toBe(400);

  const uploadResponse = await fetch(assetsPath, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${created.capability}` },
    body: JSON.stringify(input),
  });
  expect(uploadResponse.status).toBe(201);
  const upload = await uploadResponse.json();
  expect(upload.assetId).toMatch(/^[A-Za-z0-9_-]{24}$/);
  expect(upload.uploadUrl).toBe("https://bucket.test/");
  expect(upload.fields).toEqual({ key: `${created.project.id}/${upload.assetId}.upload`, "Content-Type": "audio/wav", declaredSize: "48" });
  objects.set(upload.fields.key, { bytes: wavFixture(), contentType: "audio/wav" });
  const assetPath = `${assetsPath}/${upload.assetId}`;
  expect((await fetch(`${assetPath}/complete`, {
    method: "POST", headers: { Authorization: `Bearer ${created.capability}` },
  })).status).toBe(200);

  const manifest = structuredClone(missingManifest);
  manifest.sources[0] = { ...manifest.sources[0], kind: "asset", assetId: upload.assetId };
  const stateSource = { ...manifest.state.sources[0], assetId: upload.assetId };
  manifest.state.sources[0] = stateSource;
  const update = await fetch(projectPath, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${created.capability}`, "If-Match": '"1"' },
    body: JSON.stringify({ manifest }),
  });
  expect(update.status).toBe(200);
  expect(objects.get(`${created.project.id}/${upload.assetId}`).bytes).toEqual(wavFixture());
  expect((await fetch(assetPath)).status).toBe(200);
  objects.set(upload.fields.key, { bytes: Buffer.alloc(48), contentType: "audio/wav" });
  expect((await fetch(`${assetPath}/complete`, {
    method: "POST", headers: { Authorization: `Bearer ${created.capability}` },
  })).status).toBe(200);
  expect(objects.get(`${created.project.id}/${upload.assetId}`).bytes).toEqual(wavFixture());

  await assets.cleanupExpired(new Date(Date.now() + 25 * 60 * 60 * 1000));
  expect(objectDeletes).toContain(upload.fields.key);
  expect((await fetch(assetPath, { method: "DELETE", headers: { Authorization: `Bearer ${created.capability}` } })).status).toBe(409);

  const removeAudio = structuredClone(missingManifest);
  const removal = await fetch(projectPath, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${created.capability}`, "If-Match": '"2"' },
    body: JSON.stringify({ manifest: removeAudio }),
  });

  expect(removal.status).toBe(200);
  expect(await store.getAsset(created.project.id, upload.assetId)).toBeNull();
  expect(objectDeletes).toContain(`${created.project.id}/${upload.assetId}`);
  expect((await fetch(assetPath)).status).toBe(404);
});
it("expires abandoned uploads after a day while retaining assets referenced by projects", async () => {
  const { base, store, objectDeletes, objects, assets } = await api();
  const created = await (await fetch(`${base}/api/projects`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ manifest: missingManifest }),
  })).json();
  const response = await fetch(`${base}/api/projects/${created.project.id}/assets`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${created.capability}` },
    body: JSON.stringify({ fileName: "Bass.wav", contentType: "audio/wav", size: wavFixture().length }),
  });
  const upload = await response.json();
  objects.set(upload.fields.key, { bytes: wavFixture(), contentType: "audio/wav" });

  await assets.cleanupExpired(new Date(Date.now() + 25 * 60 * 60 * 1000));
  expect(await store.getAsset(created.project.id, upload.assetId)).toBeNull();
  expect(objectDeletes).toContain(upload.fields.key);
});

it("rejects asset references that are not completed and scoped to the project", async () => {
  const { base } = await api();
  const created = await (await fetch(`${base}/api/projects`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ manifest: missingManifest }),
  })).json();
  const manifest = structuredClone(missingManifest);
  manifest.sources[0] = { ...manifest.sources[0], kind: "asset", assetId: "A".repeat(24) };
  const response = await fetch(`${base}/api/projects/${created.project.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${created.capability}`, "If-Match": '"1"' },
    body: JSON.stringify({ manifest }),
  });
  expect(response.status).toBe(400);
});

it("rejects mismatched MIME and content and cleans failed uploads without publishing", async () => {
  const { base, store, objects } = await api();
  const created = await (await fetch(`${base}/api/projects`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ manifest: missingManifest }),
  })).json();
  const path = `${base}/api/projects/${created.project.id}/assets`;
  for (const [bytes, contentType] of [[wavFixture(), "audio/mpeg"], [Buffer.alloc(48), "audio/wav"]]) {
    const upload = await (await fetch(path, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${created.capability}` },
      body: JSON.stringify({ fileName: "Bass.wav", contentType: "audio/wav", size: 48 }),
    })).json();
    objects.set(upload.fields.key, { bytes, contentType });
    expect((await fetch(`${path}/${upload.assetId}/complete`, {
      method: "POST", headers: { Authorization: `Bearer ${created.capability}` },
    })).status).toBe(400);
    expect(await store.getAsset(created.project.id, upload.assetId)).toBeNull();
    expect(objects.has(upload.fields.key)).toBe(false);
    expect(objects.has(`${created.project.id}/${upload.assetId}`)).toBe(false);
  }
});

it("removes an object when its actual size does not match the declared upload size", async () => {
  const { base, store, objects, bucket } = await api();
  const created = await (await fetch(`${base}/api/projects`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ manifest: missingManifest }),
  })).json();
  const assetsPath = `${base}/api/projects/${created.project.id}/assets`;
  const auth = { Authorization: `Bearer ${created.capability}` };
  const upload = await (await fetch(assetsPath, {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ fileName: "Bass.wav", contentType: "audio/wav", size: 48 }),
  })).json();
  objects.set(upload.fields.key, { bytes: Buffer.alloc(49), contentType: "audio/wav" });
  const read = bucket.readObject;
  bucket.readObject = async (...args) => {
    try {
      return await read(...args);
    } catch (error) {
      error.invalidUpload = true;
      throw error;
    }
  };
  expect((await fetch(`${assetsPath}/${upload.assetId}/complete`, { method: "POST", headers: auth })).status).toBe(400);
  expect(objects.has(upload.fields.key)).toBe(false);
  expect(await store.getAsset(created.project.id, upload.assetId)).toBeNull();
});

it("cleans staging and final objects on cancellation and project deletion", async () => {
  const { base, objects, store, assets } = await api();
  const created = await (await fetch(`${base}/api/projects`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ manifest: missingManifest }),
  })).json();
  const projectPath = `${base}/api/projects/${created.project.id}`;
  const assetsPath = `${projectPath}/assets`;
  const auth = { Authorization: `Bearer ${created.capability}` };
  const begin = async () => (await (await fetch(assetsPath, {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ fileName: "Bass.wav", contentType: "audio/wav", size: 48 }),
  })).json());
  const canceled = await begin();
  objects.set(canceled.fields.key, { bytes: wavFixture(), contentType: "audio/wav" });
  expect((await fetch(`${assetsPath}/${canceled.assetId}`, { method: "DELETE", headers: auth })).status).toBe(204);
  expect(objects.has(canceled.fields.key)).toBe(false);
  expect(await store.getAsset(created.project.id, canceled.assetId)).toBeNull();
  objects.set(canceled.fields.key, { bytes: Buffer.alloc(48), contentType: "audio/wav" });
  expect(objects.has(`${created.project.id}/${canceled.assetId}`)).toBe(false);
  expect((await fetch(`${assetsPath}/${canceled.assetId}/complete`, { method: "POST", headers: auth })).status).toBe(404);
  const completed = await begin();
  objects.set(completed.fields.key, { bytes: wavFixture(), contentType: "audio/wav" });
  expect((await fetch(`${assetsPath}/${completed.assetId}/complete`, { method: "POST", headers: auth })).status).toBe(200);
  objects.set(completed.fields.key, { bytes: Buffer.alloc(48), contentType: "audio/wav" });
  expect((await fetch(projectPath, { method: "DELETE", headers: auth })).status).toBe(204);
  expect(objects.has(completed.fields.key)).toBe(false);
  expect(objects.has(`${created.project.id}/${completed.assetId}`)).toBe(false);
  objects.set(completed.fields.key, { bytes: Buffer.alloc(48), contentType: "audio/wav" });
  expect(objects.has(`${created.project.id}/${completed.assetId}`)).toBe(false);
  await assets.cleanupExpired(new Date(Date.now() + 25 * 60 * 60 * 1000));
  expect(objects.has(canceled.fields.key)).toBe(false);
  expect(objects.has(completed.fields.key)).toBe(false);
});

it("serializes concurrent completion and publishes only verified snapshot bytes", async () => {
  const { base, store, objects, bucket } = await api();
  const created = await (await fetch(`${base}/api/projects`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ manifest: missingManifest }),
  })).json();
  const assetsPath = `${base}/api/projects/${created.project.id}/assets`;
  const auth = { Authorization: `Bearer ${created.capability}` };
  const upload = await (await fetch(assetsPath, {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ fileName: "Bass.wav", contentType: "audio/wav", size: 48 }),
  })).json();
  objects.set(upload.fields.key, { bytes: wavFixture(), contentType: "audio/wav" });
  const publish = bucket.publishObject;
  let releasePublish;
  const gate = new Promise((resolve) => { releasePublish = resolve; });
  let publishing;
  const entered = new Promise((resolve) => { publishing = resolve; });
  bucket.publishObject = async (...args) => {
    publishing();
    await gate;
    await publish(...args);
  };
  const complete = () => fetch(`${assetsPath}/${upload.assetId}/complete`, { method: "POST", headers: auth });
  const first = complete();
  await entered;
  objects.set(upload.fields.key, { bytes: Buffer.alloc(48), contentType: "audio/wav" });
  const second = complete();
  releasePublish();
  expect((await first).status).toBe(200);
  expect((await second).status).toBe(200);
  expect((await store.getAsset(created.project.id, upload.assetId)).completed).toBe(true);
  expect(objects.get(`${created.project.id}/${upload.assetId}`).bytes).toEqual(wavFixture());
});
