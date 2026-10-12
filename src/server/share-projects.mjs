import { videoUrl } from "../../youtube-audio.mjs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const MANIFEST_VERSION = 1;
export const MAX_MANIFEST_BYTES = 1_048_576;

export class ProjectError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function digest(capability) {
  return createHash("sha256").update(capability).digest();
}

function validCapability(capability) {
  return typeof capability === "string" && /^[A-Za-z0-9_-]{43}$/.test(capability);
}

function isManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.version !== MANIFEST_VERSION || !value.state || typeof value.state !== "object" || Array.isArray(value.state)) return false;
  if (!Array.isArray(value.sources) || value.sources.length > 256) return false;
  const ids = new Set();
  for (const source of value.sources) {
    if (!source || typeof source !== "object"
      || typeof source.id !== "string" || source.id.length > 128 || ids.has(source.id)
      || typeof source.name !== "string" || source.name.length > 1024
      || typeof source.duration !== "number" || !Number.isFinite(source.duration) || source.duration < 0
      || !["asset", "youtube", "missing"].includes(source.kind)) return false;
    ids.add(source.id);
    if (source.kind === "asset" && (typeof source.assetId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(source.assetId))) return false;
    if (source.kind === "youtube" && (typeof source.url !== "string" || source.url.length > 512 || !videoUrl(source.url))) return false;
  }
  return true;
}

function normalizeManifest(manifest) {
  if (!isManifest(manifest)) throw new ProjectError(400, "Invalid project manifest");
  if (Buffer.byteLength(JSON.stringify(manifest)) > MAX_MANIFEST_BYTES) throw new ProjectError(413, "Project manifest is too large");
  return structuredClone(manifest);
}

function publicProject(record) {
  return {
    id: record.id,
    revision: record.revision,
    manifest: structuredClone(record.manifest),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export class ProjectService {
  constructor(store, { bucket = null } = {}) {
    this.store = store;
    this.bucket = bucket;
  }

  async create(manifest) {
    const normalized = normalizeManifest(manifest);
    if (normalized.sources.some((source) => source.kind === "asset")) {
      throw new ProjectError(400, "Audio assets must be uploaded before adding them to a project");
    }
    const id = randomBytes(18).toString("base64url");
    const capability = randomBytes(32).toString("base64url");
    const now = new Date().toISOString();
    const record = {
      id,
      ownerHash: digest(capability),
      revision: 1,
      manifest: normalized,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.insert(record);
    return { project: publicProject(record), capability };
  }

  async read(id) {
    const record = await this.store.get(id);
    if (!record) throw new ProjectError(404, "Project not found");
    return publicProject(record);
  }

  async update(id, capability, expectedRevision, manifest) {
    return this.store.withProjectLock(id, (store) =>
      new ProjectService(store, { bucket: this.bucket }).updateLocked(id, capability, expectedRevision, manifest));
  }

  async updateLocked(id, capability, expectedRevision, manifest) {
    const record = await this.#authorized(id, capability);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new ProjectError(400, "A valid project revision is required");
    if (record.revision !== expectedRevision) throw new ProjectError(409, "Project has changed; reload before saving");
    const normalized = normalizeManifest(manifest);
    const assetChecks = await Promise.all(normalized.sources
      .filter((source) => source.kind === "asset")
      .map((source) => this.store.hasCompleteAsset(id, source.assetId)));
    if (assetChecks.some((exists) => !exists)) {
      throw new ProjectError(400, "Project manifest references an unavailable audio asset");
    }
    const updated = {
      ...record,
      revision: record.revision + 1,
      manifest: normalized,
      updatedAt: new Date().toISOString(),
    };
    if (!await this.store.replace(id, expectedRevision, updated)) throw new ProjectError(409, "Project has changed; reload before saving");
    if (this.bucket) {
      const retainedAssets = new Set(normalized.sources
        .filter((source) => source.kind === "asset")
        .map((source) => source.assetId));
      const removedAssets = record.manifest.sources
        .filter((source) => source.kind === "asset" && !retainedAssets.has(source.assetId));
      await Promise.all(removedAssets.map(async (source) => {
        const asset = await this.store.getAsset(id, source.assetId);
        if (!asset) return;
        try {
          await this.bucket.deleteObject(`${asset.objectKey}.upload`);
          await this.bucket.deleteObject(asset.objectKey);
          await this.store.removeAsset(id, source.assetId);
        } catch {
          // Keep failed cleanup records so the owner can retry through the asset DELETE route.
        }
      }));
    }
    return publicProject(updated);
  }

  async delete(id, capability) {
    return this.store.withProjectLock(id, (store) =>
      new ProjectService(store, { bucket: this.bucket }).deleteLocked(id, capability));
  }

  async deleteLocked(id, capability) {
    await this.#authorized(id, capability);
    const assets = await this.store.listAssets(id);
    if (assets.length && !this.bucket) throw new ProjectError(503, "Project audio storage is not configured");
    if (this.bucket) await Promise.all(assets.flatMap((asset) => [
      this.bucket.deleteObject(asset.objectKey),
      this.bucket.deleteObject(`${asset.objectKey}.upload`),
    ]));
    if (!await this.store.remove(id)) throw new ProjectError(404, "Project not found");
  }

  async authorizeOwner(id, capability) {
    await this.#authorized(id, capability);
  }

  async #authorized(id, capability) {
    if (!validCapability(capability)) throw new ProjectError(401, "Edit capability required");
    const record = await this.store.get(id);
    if (!record) throw new ProjectError(404, "Project not found");
    const candidate = digest(capability);
    if (!timingSafeEqual(record.ownerHash, candidate)) throw new ProjectError(403, "Invalid edit capability");
    return record;
  }
}

// Test adapter only. Production must inject durable storage.
export class MemoryProjectStore {
  #records = new Map();
  #assets = new Map();
  #uploadGrants = new Map();
  #locks = new Map();

  async withProjectLock(projectId, work) {
    const previous = this.#locks.get(projectId);
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    this.#locks.set(projectId, pending);
    if (previous) await previous;
    try {
      return await work(this);
    } finally {
      if (this.#locks.get(projectId) === pending) this.#locks.delete(projectId);
      release();
    }
  }


  async recordUploadGrant(key, expiresAt) {
    this.#uploadGrants.set(key, expiresAt);
  }

  async listExpiredUploadGrants(cutoff) {
    return [...this.#uploadGrants].filter(([, expiresAt]) => Date.parse(expiresAt) < cutoff.getTime())
      .map(([key]) => key);
  }

  async removeUploadGrant(key) {
    this.#uploadGrants.delete(key);
  }

  async insert(record) {
    this.#records.set(record.id, structuredClone(record));
  }

  async get(id) {
    const record = this.#records.get(id);
    return record ? structuredClone(record) : null;
  }

  async replace(id, expectedRevision, next) {
    const current = this.#records.get(id);
    if (!current || current.revision !== expectedRevision) return false;
    this.#records.set(id, structuredClone(next));
    return true;
  }

  async createAsset(asset) {
    this.#assets.set(`${asset.projectId}:${asset.assetId}`, structuredClone(asset));
  }

  async getAsset(projectId, assetId) {
    const asset = this.#assets.get(`${projectId}:${assetId}`);
    return asset ? structuredClone(asset) : null;
  }

  async listAssets(projectId) {
    return [...this.#assets.values()].filter((asset) => asset.projectId === projectId).map((asset) => structuredClone(asset));
  }

  async listAssetsCreatedBefore(cutoff) {
    const before = new Date(cutoff).getTime();
    return [...this.#assets.values()]
      .filter((asset) => Date.parse(asset.createdAt) < before)
      .map((asset) => structuredClone(asset));
  }

  async hasCompleteAsset(projectId, assetId) {
    const asset = this.#assets.get(`${projectId}:${assetId}`);
    return asset?.completed === true;
  }

  async completeAsset(projectId, assetId) {
    const key = `${projectId}:${assetId}`;
    const asset = this.#assets.get(key);
    if (!asset) return false;
    asset.completed = true;
    return true;
  }

  async removeAsset(projectId, assetId) {
    return this.#assets.delete(`${projectId}:${assetId}`);
  }

  async remove(id) {
    const removed = this.#records.delete(id);
    for (const [key, asset] of this.#assets) {
      if (asset.projectId === id) this.#assets.delete(key);
    }
    return removed;
}
}
