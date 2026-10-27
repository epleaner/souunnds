import { videoUrl } from "../../youtube-url.mjs";

export const MANIFEST_VERSION = 1;
export const MAX_MANIFEST_BYTES = 1_048_576;

export class ProjectError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function digest(capability) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(capability)));
}

function token(bytes) {
  const random = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...random)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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
    const id = token(18);
    const capability = token(32);
    const now = new Date().toISOString();
    const record = {
      id,
      ownerHash: await digest(capability),
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
    const record = await this.#authorized(id, capability);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new ProjectError(400, "A valid project revision is required");
    if (record.revision !== expectedRevision) throw new ProjectError(409, "Project has changed; reload before saving");
    const normalized = normalizeManifest(manifest);
    // D1 checks all referenced completed assets inside the conditional revision
    // update; an earlier read would race deletion of an asset.
    const updated = {
      ...record,
      revision: record.revision + 1,
      manifest: normalized,
      updatedAt: new Date().toISOString(),
    };
    if (!await this.store.replace(id, expectedRevision, updated)) throw new ProjectError(409, "Project has changed; reload before saving");
    // Object cleanup runs on the scheduled job after the metadata commit. Never
    // delete a live object based on a manifest snapshot outside the CAS.
    return publicProject(updated);
  }

  async delete(id, capability) {
    const record = await this.#authorized(id, capability);
    if (!await this.store.remove(id, record.ownerHash, record.revision)) throw new ProjectError(409, "Project has changed; reload before deleting");
  }


  async ownerRecord(id, capability) {
    return this.#authorized(id, capability);
  }

  async #authorized(id, capability) {
    if (!validCapability(capability)) throw new ProjectError(401, "Edit capability required");
    const record = await this.store.get(id);
    if (!record) throw new ProjectError(404, "Project not found");
    const candidate = await digest(capability);
    let mismatch = candidate.length ^ record.ownerHash.length;
    for (let index = 0; index < candidate.length; index++) mismatch |= candidate[index] ^ record.ownerHash[index];
    if (mismatch) throw new ProjectError(403, "Invalid edit capability");
    return record;
  }
}

// Test adapter only. Production must inject durable storage.
export class MemoryProjectStore {
  #records = new Map();
  #assets = new Map();
  #uploadGrants = new Map();


  async recordUploadGrant(key, expiresAt) {
    this.#uploadGrants.set(key, expiresAt);
  }
  async uploadGrant(key) {
    const expires_at = this.#uploadGrants.get(key);
    return expires_at ? { expires_at } : null;
  }

  async listExpiredUploadGrants(cutoff, after = "") {
    return [...this.#uploadGrants].filter(([key, expiresAt]) => key > after && Date.parse(expiresAt) < cutoff.getTime())
      .map(([key]) => key).sort().slice(0, 100);
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
    for (const source of next.manifest.sources) {
      if (source.kind === "asset" && !this.#assets.get(`${id}:${source.assetId}`)?.completed)
        throw new ProjectError(400, "Project manifest references an unavailable audio asset");
    }
    this.#records.set(id, structuredClone(next));
    return true;
  }

  async createAsset(asset) {
    this.#assets.set(`${asset.projectId}:${asset.assetId}`, structuredClone(asset));
    this.#uploadGrants.set(`${asset.objectKey}.upload`, new Date(Date.now() + 300_000).toISOString());
    this.#uploadGrants.set(asset.objectKey, new Date(Date.now() + 86_400_000).toISOString());
  }

  async getAsset(projectId, assetId) {
    const asset = this.#assets.get(`${projectId}:${assetId}`);
    return asset ? structuredClone(asset) : null;
  }

  async listAssets(projectId) {
    return [...this.#assets.values()].filter((asset) => asset.projectId === projectId).map((asset) => structuredClone(asset));
  }

  async listAssetsCreatedBefore(cutoff, after = null) {
    return [...this.#assets.values()]
      .filter((asset) => asset.createdAt < cutoff && (!after ||
        [asset.createdAt, asset.projectId, asset.assetId].join(":") >
        [after.createdAt, after.projectId, after.assetId].join(":")))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)
        || a.projectId.localeCompare(b.projectId) || a.assetId.localeCompare(b.assetId))
      .slice(0, 100).map((asset) => structuredClone(asset));
  }

  async hasCompleteAsset(projectId, assetId) {
    const asset = this.#assets.get(`${projectId}:${assetId}`);
    return asset?.completed === true;
  }

  async completeAsset(projectId, assetId) {
    const asset = this.#assets.get(`${projectId}:${assetId}`);
    if (!asset || asset.completed || !this.#records.has(projectId)) return false;
    asset.completed = true;
    return true;
  }

  async removeAsset(projectId, assetId) {
    return this.#assets.delete(`${projectId}:${assetId}`);
  }
  async removeUnusedAsset(projectId, assetId, cutoff) {
    const asset = this.#assets.get(`${projectId}:${assetId}`);
    if (!asset || asset.createdAt >= cutoff || this.#records.get(projectId)?.manifest.sources
      .some((source) => source.kind === "asset" && source.assetId === assetId)) return false;
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
