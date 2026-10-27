import { Buffer } from "node:buffer";
import { MAX_AUDIO_BYTES, SUPPORTED_AUDIO_CONTENT_TYPES, isValidAudioContent } from "./audio-content.mjs";
import { ProjectError } from "./share-projects.mjs";

export class R2ProjectAssets {
  constructor(store, projects, bucket) { this.store = store; this.projects = projects; this.bucket = bucket; }

  async beginUpload(projectId, capability, input) {
    const owner = await this.projects.ownerRecord(projectId, capability);
    if (!input || typeof input !== "object" || Array.isArray(input)
      || typeof input.fileName !== "string" || !input.fileName.trim() || input.fileName.length > 255 || /[\u0000-\u001f\u007f]/.test(input.fileName)
      || typeof input.contentType !== "string" || !SUPPORTED_AUDIO_CONTENT_TYPES.has(input.contentType.toLowerCase())
      || !Number.isSafeInteger(input.size) || input.size < 1 || input.size > MAX_AUDIO_BYTES) {
      throw new ProjectError(400, "Audio file must be a supported WAV or MP3 file no larger than 25 MiB");
    }
    const assetId = crypto.randomUUID().replaceAll("-", "");
    const asset = { projectId, assetId, objectKey: `${projectId}/${assetId}`, fileName: input.fileName.trim(),
      contentType: input.contentType.toLowerCase(), size: input.size, ownerHash: owner.ownerHash,
      createdAt: new Date().toISOString() };
    await this.store.createAsset(asset);
    return { assetId, uploadUrl: `/api/projects/${projectId}/assets/${assetId}/upload`, expiresIn: 300 };
  }

  async upload(projectId, capability, assetId, request) {
    await this.projects.ownerRecord(projectId, capability);
    const asset = await this.store.getAsset(projectId, assetId);
    if (!asset || asset.completed) throw new ProjectError(404, "Audio upload not found");
    const grant = await this.store.uploadGrant(`${asset.objectKey}.upload`);
    if (!grant || Date.parse(grant.expires_at) <= Date.now()) throw new ProjectError(410, "Audio upload expired");
    const declaredLength = request.headers.get("content-length");
    if (request.headers.get("content-type")?.split(";", 1)[0].toLowerCase() !== asset.contentType
      || (declaredLength !== null && Number(declaredLength) !== asset.size)) {
      throw new ProjectError(400, "Audio upload type or size does not match its declaration");
    }
    const reader = request.body?.getReader();
    if (!reader) throw new ProjectError(400, "Audio upload is empty");
    const chunks = [];
    let received = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > asset.size || received > MAX_AUDIO_BYTES) throw new ProjectError(400, "Audio upload size does not match its declaration");
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    if (received !== asset.size) throw new ProjectError(400, "Audio upload size does not match its declaration");
    const bytes = Buffer.concat(chunks, received);
    const staged = await this.bucket.put(`${asset.objectKey}.upload`, bytes, {
      httpMetadata: { contentType: asset.contentType },
      onlyIf: new Headers({ "If-None-Match": "*" }),
    });
    if (!staged) throw new ProjectError(409, "Audio upload has already been staged");
  }

  async completeUpload(projectId, capability, assetId) {
    const owner = await this.projects.ownerRecord(projectId, capability);
    const asset = await this.store.getAsset(projectId, assetId);
    if (!asset) throw new ProjectError(404, "Audio upload not found");
    if (asset.completed) return { assetId };
    const grant = await this.store.uploadGrant(`${asset.objectKey}.upload`);
    if (!grant || Date.parse(grant.expires_at) <= Date.now()) throw new ProjectError(410, "Audio upload expired");
    const staged = await this.bucket.get(`${asset.objectKey}.upload`);
    if (!staged) throw new ProjectError(400, "Audio upload is missing or could not be verified");
    if (staged.size !== asset.size || staged.httpMetadata?.contentType !== asset.contentType) {
      throw new ProjectError(400, "Uploaded file content does not match its declared audio type and size");
    }
    const bytes = Buffer.from(await staged.arrayBuffer());
    if (!isValidAudioContent(asset.contentType, bytes, asset.size)) {
      await this.bucket.delete(`${asset.objectKey}.upload`);
      throw new ProjectError(400, "Uploaded file content does not match its declared audio type and size");
    }
    // R2 applies If-None-Match atomically. Competing completions may race
    // across Workers, but only the first bytes can ever occupy this final key.
    await this.bucket.put(asset.objectKey, bytes, {
      httpMetadata: { contentType: asset.contentType },
      onlyIf: new Headers({ "If-None-Match": "*" }),
    });
    if (!await this.store.completeAsset(projectId, assetId, owner.ownerHash)) {
      if (!(await this.store.getAsset(projectId, assetId))?.completed)
        throw new ProjectError(409, "Audio upload could not be finalized");
      return { assetId };
    }
    await this.bucket.delete(`${asset.objectKey}.upload`);
    return { assetId };
  }

  async download(projectId, assetId) {
    const project = await this.projects.read(projectId);
    const asset = await this.store.getAsset(projectId, assetId);
    if (!asset?.completed || !project.manifest.sources.some((source) => source.kind === "asset" && source.assetId === assetId))
      throw new ProjectError(404, "Audio asset not found");
    return { url: `/api/projects/${projectId}/assets/${assetId}/file`, contentType: asset.contentType, fileName: asset.fileName };
  }

  async file(projectId, assetId) {
    const metadata = await this.download(projectId, assetId);
    const object = await this.bucket.get(`${projectId}/${assetId}`);
    if (!object) throw new ProjectError(404, "Audio asset not found");
    return new Response(object.body, { headers: { "Content-Type": metadata.contentType,
      "Content-Length": String(object.size), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  }

  async cancelUpload(projectId, capability, assetId) {
    const owner = await this.projects.ownerRecord(projectId, capability);
    const asset = await this.store.getAsset(projectId, assetId);
    if (!asset) throw new ProjectError(404, "Audio upload not found");
    if (!await this.store.removeAsset(projectId, assetId, owner.ownerHash))
      throw new ProjectError(409, "Remove this audio source from the project before deleting it");
    await this.bucket.delete(`${asset.objectKey}.upload`);
    await this.bucket.delete(asset.objectKey);
  }

  async cleanupExpired(now = new Date()) {
    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    let afterAsset = null;
    while (true) {
      const page = await this.store.listAssetsCreatedBefore(cutoff.toISOString(), afterAsset);
      if (!page.length) break;
      afterAsset = page.at(-1);
      for (const asset of page) {
        try {
          if (await this.store.removeUnusedAsset(asset.projectId, asset.assetId, cutoff.toISOString())) {
            await this.bucket.delete(`${asset.objectKey}.upload`);
            await this.bucket.delete(asset.objectKey);
          }
        } catch (error) { console.error("Expired project asset cleanup failed", error); }
      }
    }
    let afterGrant = "";
    while (true) {
      const page = await this.store.listExpiredUploadGrants(now, afterGrant);
      if (!page.length) break;
      afterGrant = page.at(-1);
      for (const key of page) {
        try {
          // Retain a published key's grant until metadata is removed. A later
          // tick then cleans orphaned objects even after FK cascade deletion.
          if (!key.endsWith(".upload")) {
            const [projectId, assetId] = key.split("/");
            if (await this.store.getAsset(projectId, assetId)) continue;
          }
          await this.bucket.delete(key);
          await this.store.removeUploadGrant(key);
        } catch (error) { console.error("Expired project upload cleanup failed", error); }
      }
    }
  }
}
