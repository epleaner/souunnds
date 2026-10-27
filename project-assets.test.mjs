import { Buffer } from "node:buffer";
import { expect, it } from "vitest";
import { MemoryProjectStore, ProjectService } from "./src/server/share-projects.mjs";
import { R2ProjectAssets } from "./src/server/r2-project-assets.mjs";

function wav(sample = 0) {
  const bytes = Buffer.alloc(48);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(40, 4);
  bytes.write("WAVEfmt ", 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(4, 40);
  bytes.writeInt16LE(sample, 44);
  return bytes;
}
const manifest = { version: 1, state: { sources: [] }, sources: [] };
function setup({ beforePut = async () => {} } = {}) {
  const store = new MemoryProjectStore();
  const projects = new ProjectService(store);
  const objects = new Map();
  const bucket = {
    async put(key, bytes, options) {
      await beforePut(key);
      if (options.onlyIf?.get("If-None-Match") === "*" && objects.has(key)) return null;
      objects.set(key, { bytes: Buffer.from(bytes), contentType: options.httpMetadata.contentType });
      return { key };
    },
    async get(key) {
      const object = objects.get(key);
      return object && { size: object.bytes.length, httpMetadata: { contentType: object.contentType },
        arrayBuffer: async () => object.bytes, body: new ReadableStream({ start(controller) { controller.enqueue(object.bytes); controller.close(); } }) };
    },
    async delete(key) { objects.delete(key); },
  };
  return { store, projects, assets: new R2ProjectAssets(store, projects, bucket), objects, bucket };
}
const uploadRequest = (bytes) => new Request("https://example.test/upload", {
  method: "PUT", headers: { "Content-Type": "audio/wav" }, body: bytes,
});

it("requires a creator bearer token for staging and completing audio, and publishes only referenced audio", async () => {
  const { projects, assets, objects } = setup();
  const { project, capability } = await projects.create(manifest);
  await expect(assets.beginUpload(project.id, "", { fileName: "piano.wav", contentType: "audio/wav", size: 48 }))
    .rejects.toMatchObject({ status: 401 });
  const grant = await assets.beginUpload(project.id, capability, { fileName: "piano.wav", contentType: "audio/wav", size: 48 });
  await expect(assets.upload(project.id, "A".repeat(43), grant.assetId, uploadRequest(wav())))
    .rejects.toMatchObject({ status: 403 });
  await assets.upload(project.id, capability, grant.assetId, uploadRequest(wav()));
  await expect(assets.completeUpload(project.id, "", grant.assetId)).rejects.toMatchObject({ status: 401 });
  await assets.completeUpload(project.id, capability, grant.assetId);
  await expect(assets.file(project.id, grant.assetId)).rejects.toMatchObject({ status: 404 });
  const shared = { ...manifest, sources: [{ id: "piano", name: "Piano", kind: "asset", assetId: grant.assetId, duration: 1 }] };
  await projects.update(project.id, capability, 1, shared);
  const file = await assets.file(project.id, grant.assetId);
  expect(Buffer.from(await file.arrayBuffer())).toEqual(wav());
  expect(file.headers.get("content-type")).toBe("audio/wav");
  expect(objects.has(`${project.id}/${grant.assetId}`)).toBe(true);
});

it("rejects corrupt, oversized and expired staged uploads before exposing a public file", async () => {
  const { projects, assets, store, objects } = setup();
  const { project, capability } = await projects.create(manifest);
  await expect(assets.beginUpload(project.id, capability, { fileName: "huge.wav", contentType: "audio/wav", size: 25 * 1024 * 1024 + 1 }))
    .rejects.toMatchObject({ status: 400 });
  const grant = await assets.beginUpload(project.id, capability, { fileName: "bad.wav", contentType: "audio/wav", size: 48 });
  await expect(assets.upload(project.id, capability, grant.assetId, uploadRequest(Buffer.alloc(49))))
    .rejects.toMatchObject({ status: 400 });
  await assets.upload(project.id, capability, grant.assetId, uploadRequest(Buffer.alloc(48)));
  await expect(assets.completeUpload(project.id, capability, grant.assetId)).rejects.toMatchObject({ status: 400 });
  expect(objects.has(`${project.id}/${grant.assetId}`)).toBe(false);
  await store.recordUploadGrant(`${project.id}/${grant.assetId}.upload`, new Date(Date.now() - 1000).toISOString());
  await expect(assets.upload(project.id, capability, grant.assetId, uploadRequest(wav())))
    .rejects.toMatchObject({ status: 410 });
});

it("retention removes unreferenced assets and never removes a referenced completed object", async () => {
  const { projects, assets, store, objects } = setup();
  const { project, capability } = await projects.create(manifest);
  const grant = await assets.beginUpload(project.id, capability, { fileName: "piano.wav", contentType: "audio/wav", size: 48 });
  await assets.upload(project.id, capability, grant.assetId, uploadRequest(wav()));
  await assets.completeUpload(project.id, capability, grant.assetId);
  const key = `${project.id}/${grant.assetId}`;
  await assets.cleanupExpired(new Date(Date.now() + 48 * 60 * 60 * 1000));
  expect(await store.getAsset(project.id, grant.assetId)).toBeNull();
  expect(objects.has(key)).toBe(false);
});

it("publishes one immutable audio body when completions race with conflicting staged snapshots", async () => {
  let releaseFirst;
  let announceFirst;
  const firstPaused = new Promise((resolve) => { announceFirst = resolve; });
  let finalWrites = 0;
  const { projects, assets, objects } = setup({
    async beforePut(key) {
      if (key.endsWith(".upload") || ++finalWrites !== 1) return;
      await new Promise((resolve) => {
        releaseFirst = resolve;
        announceFirst();
      });
    },
  });
  const { project, capability } = await projects.create(manifest);
  const grant = await assets.beginUpload(project.id, capability,
    { fileName: "piano.wav", contentType: "audio/wav", size: 48 });
  await assets.upload(project.id, capability, grant.assetId, uploadRequest(wav(1111)));
  await expect(assets.upload(project.id, capability, grant.assetId, uploadRequest(wav(2222))))
    .rejects.toMatchObject({ status: 409 });
  const pendingFirst = assets.completeUpload(project.id, capability, grant.assetId);
  await firstPaused;
  // Competing in-flight completions may already hold different staged snapshots;
  // publishing the second snapshot must not allow the first to overwrite it.
  objects.set(`${project.id}/${grant.assetId}.upload`,
    { bytes: wav(2222), contentType: "audio/wav" });
  await assets.completeUpload(project.id, capability, grant.assetId);
  releaseFirst();
  await pendingFirst;
  await projects.update(project.id, capability, 1, {
    ...manifest, sources: [{ id: "piano", name: "Piano", kind: "asset", assetId: grant.assetId, duration: 1 }],
  });
  expect(Buffer.from(await (await assets.file(project.id, grant.assetId)).arrayBuffer())).toEqual(wav(2222));
  expect(objects.get(`${project.id}/${grant.assetId}`).bytes).toEqual(wav(2222));
  await assets.completeUpload(project.id, capability, grant.assetId);
  expect(objects.get(`${project.id}/${grant.assetId}`).bytes).toEqual(wav(2222));
});

it("cleans beyond 100 retained referenced assets and grants without deleting live audio", async () => {
  const { projects, assets, store, objects, bucket } = setup();
  const { project, capability } = await projects.create(manifest);
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const sources = [];
  for (let index = 0; index < 105; index++) {
    const assetId = String(index).padStart(16, "0");
    const objectKey = `${project.id}/${assetId}`;
    await store.createAsset({ projectId: project.id, assetId, objectKey,
      fileName: `${index}.wav`, contentType: "audio/wav", size: 48, createdAt: old });
    await store.completeAsset(project.id, assetId);
    await bucket.put(objectKey, wav(), { httpMetadata: { contentType: "audio/wav" } });
    sources.push({ id: `source-${index}`, kind: "asset", assetId, name: `${index}.wav`, duration: 1 });
  }
  await projects.update(project.id, capability, 1, { ...manifest, sources });
  const orphanId = "zzzzzzzzzzzzzzzz";
  const orphanKey = `${project.id}/${orphanId}`;
  await store.createAsset({ projectId: project.id, assetId: orphanId, objectKey: orphanKey,
    fileName: "orphan.wav", contentType: "audio/wav", size: 48, createdAt: old });
  await bucket.put(orphanKey, wav(), { httpMetadata: { contentType: "audio/wav" } });
  await store.recordUploadGrant("zzzzzzzzzzzzzzzz/orphan", old);
  await bucket.put("zzzzzzzzzzzzzzzz/orphan", wav(), { httpMetadata: { contentType: "audio/wav" } });
  await assets.cleanupExpired(new Date(Date.now() + 48 * 60 * 60 * 1000));
  expect(await store.getAsset(project.id, orphanId)).toBeNull();
  expect(objects.has(orphanKey)).toBe(false);
  expect(objects.has("zzzzzzzzzzzzzzzz/orphan")).toBe(false);
  expect(await store.uploadGrant("zzzzzzzzzzzzzzzz/orphan")).toBeNull();
  expect(Buffer.from(await (await assets.file(project.id, sources.at(-1).assetId)).arrayBuffer())).toEqual(wav());
});
