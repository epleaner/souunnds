import { randomBytes } from "node:crypto";
import { ProjectError, ProjectService } from "./share-projects.mjs";
import { audioAssetLimits, isValidAudioContent, SUPPORTED_AUDIO_CONTENT_TYPES } from "./railway-bucket.mjs";


export class ProjectAssetService {
  constructor(store, projects, bucket) {
    this.store = store;
    this.projects = projects;
    this.bucket = bucket;
  }

  async beginUpload(projectId, ownerCapability, input) {
    return this.store.withProjectLock(projectId, (store) =>
      new ProjectAssetService(store, new ProjectService(store, { bucket: this.bucket }), this.bucket)
        .beginUploadLocked(projectId, ownerCapability, input));
  }

  async beginUploadLocked(projectId, ownerCapability, input) {
    await this.projects.authorizeOwner(projectId, ownerCapability);
    if (!input || typeof input !== "object" || Array.isArray(input)
      || typeof input.fileName !== "string" || !input.fileName.trim() || input.fileName.length > 255 || /[\u0000-\u001f\u007f]/.test(input.fileName)
      || typeof input.contentType !== "string" || !SUPPORTED_AUDIO_CONTENT_TYPES.has(input.contentType.toLowerCase())
      || !Number.isSafeInteger(input.size) || input.size < 1 || input.size > audioAssetLimits.maxBytes) {
      throw new ProjectError(400, "Audio file must be a supported WAV or MP3 file no larger than 25 MiB");
    }

    const assetId = randomBytes(18).toString("base64url");
    const objectKey = `${projectId}/${assetId}`;
    const asset = {
      projectId,
      assetId,
      objectKey,
      fileName: input.fileName.trim(),
      contentType: input.contentType.toLowerCase(),
      size: input.size,
      completed: false,
      createdAt: new Date().toISOString(),
    };
    let upload;
    try {
      upload = this.bucket.presignPost(`${objectKey}.upload`, asset.contentType, asset.size);
    } catch {
      throw new ProjectError(503, "Audio uploads are unavailable");
    }
    await this.store.createAsset(asset);
    await this.store.recordUploadGrant(`${objectKey}.upload`, new Date(Date.now() + upload.expiresIn * 1000).toISOString());
    return { assetId, uploadUrl: upload.url, fields: upload.fields, expiresIn: upload.expiresIn };
  }

  async completeUpload(projectId, ownerCapability, assetId) {
    const result = await this.store.withProjectLock(projectId, (store) =>
      new ProjectAssetService(store, new ProjectService(store, { bucket: this.bucket }), this.bucket)
        .completeUploadLocked(projectId, ownerCapability, assetId));
    if (result.invalid) throw new ProjectError(400, "Uploaded file content does not match its declared audio type and size");
    return result;
  }

  async completeUploadLocked(projectId, ownerCapability, assetId) {
    await this.projects.authorizeOwner(projectId, ownerCapability);
    const asset = await this.store.getAsset(projectId, assetId);
    if (!asset) throw new ProjectError(404, "Audio upload not found");
    if (asset.completed) return { assetId };

    let received;
    try {
      received = await this.bucket.readObject(`${asset.objectKey}.upload`, asset.size);
    } catch (error) {
      if (!error.invalidUpload) throw new ProjectError(400, "Audio upload is missing or could not be verified");
      await this.bucket.deleteObject(`${asset.objectKey}.upload`);
      await this.bucket.deleteObject(asset.objectKey);
      await this.store.removeAsset(projectId, assetId);
      return { invalid: true };
    }
    const valid = received.size === asset.size
      && received.contentType === asset.contentType
      && isValidAudioContent(received.contentType, received.bytes, received.size);
    if (!valid) {
      await this.bucket.deleteObject(`${asset.objectKey}.upload`);
      await this.bucket.deleteObject(asset.objectKey);
      await this.store.removeAsset(projectId, assetId);
      return { invalid: true };
    }
    await this.bucket.publishObject(asset.objectKey, received.bytes, asset.contentType);
    if (!await this.store.completeAsset(projectId, assetId)) throw new ProjectError(409, "Audio upload could not be finalized");
    // A replay can recreate staging during its five-minute lifetime; retention cleans it again.
    await this.bucket.deleteObject(`${asset.objectKey}.upload`).catch(() => {});
    return { assetId };
  }

  async download(projectId, assetId) {
    const project = await this.projects.read(projectId);
    const asset = await this.store.getAsset(projectId, assetId);
    const referenced = project.manifest.sources.some((source) => source.kind === "asset" && source.assetId === assetId);
    if (!asset?.completed || !referenced) throw new ProjectError(404, "Audio asset not found");
    const signed = this.bucket.presignGet(asset.objectKey);
    return { url: signed.url, expiresIn: signed.expiresIn, contentType: asset.contentType, fileName: asset.fileName };
  }

  async cancelUpload(projectId, ownerCapability, assetId) {
    return this.store.withProjectLock(projectId, (store) =>
      new ProjectAssetService(store, new ProjectService(store, { bucket: this.bucket }), this.bucket)
        .cancelUploadLocked(projectId, ownerCapability, assetId));
  }

  async cancelUploadLocked(projectId, ownerCapability, assetId) {
    await this.projects.authorizeOwner(projectId, ownerCapability);
    const asset = await this.store.getAsset(projectId, assetId);
    if (!asset) throw new ProjectError(404, "Audio upload not found");
    const project = await this.projects.read(projectId);
    if (project.manifest.sources.some((source) => source.kind === "asset" && source.assetId === assetId)) {
      throw new ProjectError(409, "Remove this audio source from the project before deleting it");
    }
    await this.bucket.deleteObject(`${asset.objectKey}.upload`);
    await this.bucket.deleteObject(asset.objectKey);
    await this.store.removeAsset(projectId, assetId);
  }

  async cleanupExpired(now = new Date()) {
    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    // Retain revoked form keys beyond expiry so replays after cancellation or deletion
    // are removed even when their asset and project rows no longer exist.
    const grants = await this.store.listExpiredUploadGrants(cutoff);
    await Promise.all(grants.map(async (key) => {
      try {
        await this.bucket.deleteObject(key);
        await this.store.removeUploadGrant(key);
      } catch {
        // A failed delete stays scheduled for the next cleanup.
      }
    }));
    const assets = await this.store.listAssetsCreatedBefore(cutoff);
    await Promise.all(assets.map(async (asset) => {
      try {
        await this.store.withProjectLock(asset.projectId, async (store) => {
          const current = await store.getAsset(asset.projectId, asset.assetId);
          if (!current || Date.parse(current.createdAt) >= cutoff.getTime()) return;
          const project = await new ProjectService(store, { bucket: this.bucket }).read(asset.projectId);
          await this.bucket.deleteObject(`${asset.objectKey}.upload`);
          if (project.manifest.sources.some((source) => source.kind === "asset" && source.assetId === asset.assetId)) return;
          await this.bucket.deleteObject(asset.objectKey);
          await store.removeAsset(asset.projectId, asset.assetId);
        });
      } catch {
        // Failed cleanup remains in the store for the next scheduled attempt.
      }
    }));
  }

}
