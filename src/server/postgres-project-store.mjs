export class PostgresProjectStore {
  constructor(pool) {
    this.pool = pool;
  }
  async withProjectLock(projectId, work) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [projectId]);
      const result = await work(new PostgresProjectStore(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }


  async initialize() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS share_projects (
        id text PRIMARY KEY,
        owner_hash bytea NOT NULL,
        revision integer NOT NULL CHECK (revision > 0),
        manifest jsonb NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS share_project_assets (
        project_id text NOT NULL REFERENCES share_projects(id) ON DELETE CASCADE,
        asset_id text NOT NULL,
        object_key text NOT NULL UNIQUE,
        file_name text NOT NULL,
        content_type text NOT NULL,
        byte_size bigint NOT NULL CHECK (byte_size > 0),
        completed boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL,
        PRIMARY KEY (project_id, asset_id)
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS share_project_upload_grants (
        object_key text PRIMARY KEY,
        expires_at timestamptz NOT NULL
      )
    `);
  }

  async insert(record) {
    await this.pool.query(
      `INSERT INTO share_projects (id, owner_hash, revision, manifest, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
      [record.id, record.ownerHash, record.revision, JSON.stringify(record.manifest), record.createdAt, record.updatedAt],
    );
  }

  async get(id) {
    const { rows } = await this.pool.query(
      `SELECT id, owner_hash, revision, manifest, created_at, updated_at FROM share_projects WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    return row ? {
      id: row.id,
      ownerHash: row.owner_hash,
      revision: row.revision,
      manifest: row.manifest,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    } : null;
  }

  async replace(id, expectedRevision, next) {
    const { rowCount } = await this.pool.query(
      `UPDATE share_projects
       SET revision = $3, manifest = $4::jsonb, updated_at = $5
       WHERE id = $1 AND revision = $2`,
      [id, expectedRevision, next.revision, JSON.stringify(next.manifest), next.updatedAt],
    );
    return rowCount === 1;
  }

  async remove(id) {
    const { rowCount } = await this.pool.query(`DELETE FROM share_projects WHERE id = $1`, [id]);
    return rowCount === 1;
  }
  async createAsset(asset) {
    await this.pool.query(
      `INSERT INTO share_project_assets
       (project_id, asset_id, object_key, file_name, content_type, byte_size, completed, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, false, $7)`,
      [asset.projectId, asset.assetId, asset.objectKey, asset.fileName, asset.contentType, asset.size, asset.createdAt],
    );
  }

  async getAsset(projectId, assetId) {
    const { rows } = await this.pool.query(
      `SELECT project_id, asset_id, object_key, file_name, content_type, byte_size, completed, created_at
       FROM share_project_assets WHERE project_id = $1 AND asset_id = $2`,
      [projectId, assetId],
    );
    const row = rows[0];
    return row ? {
      projectId: row.project_id,
      assetId: row.asset_id,
      objectKey: row.object_key,
      fileName: row.file_name,
      contentType: row.content_type,
      size: Number(row.byte_size),
      completed: row.completed,
      createdAt: row.created_at.toISOString(),
    } : null;
  }

  async listAssets(projectId) {
    const { rows } = await this.pool.query(
      `SELECT project_id, asset_id, object_key, file_name, content_type, byte_size, completed, created_at
       FROM share_project_assets WHERE project_id = $1`,
      [projectId],
    );
    return rows.map((row) => ({
      projectId: row.project_id,
      assetId: row.asset_id,
      objectKey: row.object_key,
      fileName: row.file_name,
      contentType: row.content_type,
      size: Number(row.byte_size),
      completed: row.completed,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async listAssetsCreatedBefore(cutoff) {
    const { rows } = await this.pool.query(
      `SELECT project_id, asset_id, object_key, file_name, content_type, byte_size, completed, created_at
       FROM share_project_assets WHERE created_at < $1`,
      [cutoff],
    );
    return rows.map((row) => ({
      projectId: row.project_id,
      assetId: row.asset_id,
      objectKey: row.object_key,
      fileName: row.file_name,
      contentType: row.content_type,
      size: Number(row.byte_size),
      completed: row.completed,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async hasCompleteAsset(projectId, assetId) {
    const { rowCount } = await this.pool.query(
      `SELECT 1 FROM share_project_assets WHERE project_id = $1 AND asset_id = $2 AND completed`,
      [projectId, assetId],
    );
    return rowCount === 1;
  }

  async completeAsset(projectId, assetId) {
    const { rowCount } = await this.pool.query(
      `UPDATE share_project_assets SET completed = true WHERE project_id = $1 AND asset_id = $2`,
      [projectId, assetId],
    );
    return rowCount === 1;
  }

  async removeAsset(projectId, assetId) {
    const { rowCount } = await this.pool.query(
      `DELETE FROM share_project_assets WHERE project_id = $1 AND asset_id = $2`,
      [projectId, assetId],
    );
    return rowCount === 1;
  }

  async recordUploadGrant(key, expiresAt) {
    await this.pool.query(
      `INSERT INTO share_project_upload_grants (object_key, expires_at) VALUES ($1, $2)`,
      [key, expiresAt],
    );
  }

  async listExpiredUploadGrants(cutoff) {
    const { rows } = await this.pool.query(
      `SELECT object_key FROM share_project_upload_grants WHERE expires_at < $1`,
      [cutoff],
    );
    return rows.map((row) => row.object_key);
  }

  async removeUploadGrant(key) {
    await this.pool.query(`DELETE FROM share_project_upload_grants WHERE object_key = $1`, [key]);
  }

}
