import { ProjectError } from "./share-projects.mjs";

const assetFields = `project_id, asset_id, object_key, file_name, content_type, byte_size, completed, created_at`;
const assetFromRow = (row) => row && ({ projectId: row.project_id, assetId: row.asset_id,
  objectKey: row.object_key, fileName: row.file_name, contentType: row.content_type,
  size: row.byte_size, completed: row.completed === 1, createdAt: row.created_at });

export class D1ProjectStore {
  constructor(db) { this.db = db; }

  async insert(record) {
    await this.db.prepare(`INSERT INTO share_projects (id, owner_hash, revision, manifest, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`).bind(record.id, record.ownerHash, record.revision,
      JSON.stringify(record.manifest), record.createdAt, record.updatedAt).run();
  }

  async get(id) {
    const row = await this.db.prepare(`SELECT * FROM share_projects WHERE id = ?`).bind(id).first();
    return row && { id: row.id, ownerHash: new Uint8Array(row.owner_hash), revision: row.revision,
      manifest: JSON.parse(row.manifest), createdAt: row.created_at, updatedAt: row.updated_at };
  }

  // The revision, owner and every referenced completed asset are checked by one SQLite
  // statement. No read/await/write lock or D1.batch snapshot assumption is involved.
  async replace(id, expectedRevision, next) {
    const result = await this.db.prepare(`UPDATE share_projects
      SET revision = ?, manifest = ?, updated_at = ?
      WHERE id = ? AND revision = ? AND owner_hash = ?
      AND NOT EXISTS (
        SELECT 1 FROM json_each(?, '$.sources') AS source
        WHERE json_extract(source.value, '$.kind') = 'asset'
        AND NOT EXISTS (SELECT 1 FROM share_project_assets AS asset
          WHERE asset.project_id = share_projects.id
          AND asset.asset_id = json_extract(source.value, '$.assetId') AND asset.completed = 1)
      )`).bind(next.revision, JSON.stringify(next.manifest), next.updatedAt,
      id, expectedRevision, next.ownerHash, JSON.stringify(next.manifest)).run();
    if (result.meta.changes) return true;
    const current = await this.get(id);
    if (current?.revision === expectedRevision) throw new ProjectError(400, "Project manifest references an unavailable audio asset");
    return false;
  }

  async remove(id, ownerHash, revision) {
    const result = await this.db.prepare(`DELETE FROM share_projects WHERE id = ? AND owner_hash = ? AND revision = ?`)
      .bind(id, ownerHash, revision).run();
    return result.meta.changes === 1;
  }
  async createAsset(asset) {
    const inserts = await this.db.batch([
      this.db.prepare(`INSERT INTO share_project_assets
        (project_id, asset_id, object_key, file_name, content_type, byte_size, completed, created_at)
        SELECT ?, ?, ?, ?, ?, ?, 0, ? FROM share_projects WHERE id = ? AND owner_hash = ?`)
        .bind(asset.projectId, asset.assetId, asset.objectKey, asset.fileName, asset.contentType,
          asset.size, asset.createdAt, asset.projectId, asset.ownerHash),
      this.db.prepare(`INSERT INTO share_project_upload_grants (object_key, expires_at) VALUES (?, ?)`)
        .bind(`${asset.objectKey}.upload`, new Date(Date.now() + 5 * 60_000).toISOString()),
      this.db.prepare(`INSERT INTO share_project_upload_grants (object_key, expires_at) VALUES (?, ?)`)
        .bind(asset.objectKey, new Date(Date.now() + 24 * 60 * 60_000).toISOString()),
    ]);
    if (!inserts[0].meta.changes) throw new ProjectError(404, "Project not found");
  }
  async getAsset(projectId, assetId) {
    return assetFromRow(await this.db.prepare(`SELECT ${assetFields} FROM share_project_assets WHERE project_id = ? AND asset_id = ?`)
      .bind(projectId, assetId).first());
  }
  async listAssets(projectId) {
    const rows = await this.db.prepare(`SELECT ${assetFields} FROM share_project_assets WHERE project_id = ?`).bind(projectId).all();
    return rows.results.map(assetFromRow);
  }
  async listAssetsCreatedBefore(cutoff, after = null) {
    const rows = await this.db.prepare(`SELECT ${assetFields} FROM share_project_assets
      WHERE created_at < ? AND (created_at, project_id, asset_id) > (?, ?, ?)
      ORDER BY created_at, project_id, asset_id LIMIT 100`)
      .bind(cutoff, after?.createdAt ?? "", after?.projectId ?? "", after?.assetId ?? "").all();
    return rows.results.map(assetFromRow);
  }
  async hasCompleteAsset(projectId, assetId) {
    return !!await this.db.prepare(`SELECT 1 FROM share_project_assets WHERE project_id = ? AND asset_id = ? AND completed = 1`)
      .bind(projectId, assetId).first();
  }
  async completeAsset(projectId, assetId, ownerHash) {
    const result = await this.db.prepare(`UPDATE share_project_assets SET completed = 1
      WHERE project_id = ? AND asset_id = ? AND completed = 0 AND EXISTS
      (SELECT 1 FROM share_projects WHERE id = ? AND owner_hash = ?)`)
      .bind(projectId, assetId, projectId, ownerHash).run();
    return result.meta.changes === 1;
  }
  async removeAsset(projectId, assetId, ownerHash) {
    const result = await this.db.prepare(`DELETE FROM share_project_assets WHERE project_id = ? AND asset_id = ?
      AND NOT EXISTS (SELECT 1 FROM share_projects, json_each(share_projects.manifest, '$.sources') source
        WHERE share_projects.id = ? AND json_extract(source.value, '$.kind') = 'asset'
        AND json_extract(source.value, '$.assetId') = ?)
      AND EXISTS (SELECT 1 FROM share_projects WHERE id = ? AND owner_hash = ?)`)
      .bind(projectId, assetId, projectId, assetId, projectId, ownerHash).run();
    return result.meta.changes === 1;
  }
  async recordUploadGrant(key, expiresAt) {
    await this.db.prepare(`INSERT INTO share_project_upload_grants (object_key, expires_at) VALUES (?, ?)`).bind(key, expiresAt).run();
  }
  async listExpiredUploadGrants(cutoff, after = "") {
    const rows = await this.db.prepare(`SELECT object_key FROM share_project_upload_grants
      WHERE expires_at < ? AND object_key > ? ORDER BY object_key LIMIT 100`)
      .bind(cutoff.toISOString(), after).all();
    return rows.results.map((row) => row.object_key);
  }
  async removeUploadGrant(key) {
    await this.db.prepare(`DELETE FROM share_project_upload_grants WHERE object_key = ?`).bind(key).run();
  }
  async uploadGrant(key) {
    return this.db.prepare(`SELECT expires_at FROM share_project_upload_grants WHERE object_key = ?`)
      .bind(key).first();
  }

  async removeUnusedAsset(projectId, assetId, cutoff) {
    const result = await this.db.prepare(`DELETE FROM share_project_assets WHERE project_id = ? AND asset_id = ?
      AND created_at < ? AND NOT EXISTS (
        SELECT 1 FROM share_projects, json_each(share_projects.manifest, '$.sources') source
        WHERE share_projects.id = ? AND json_extract(source.value, '$.kind') = 'asset'
        AND json_extract(source.value, '$.assetId') = ?)`)
      .bind(projectId, assetId, cutoff, projectId, assetId).run();
    return result.meta.changes === 1;
  }
}
