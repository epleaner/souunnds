PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS share_projects (
  id TEXT PRIMARY KEY,
  owner_hash BLOB NOT NULL CHECK (length(owner_hash) = 32),
  revision INTEGER NOT NULL CHECK (revision > 0),
  manifest TEXT NOT NULL CHECK (json_valid(manifest)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS share_project_assets (
  project_id TEXT NOT NULL REFERENCES share_projects(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 26214400),
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, asset_id)
);
CREATE TABLE IF NOT EXISTS share_project_upload_grants (
  object_key TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS share_assets_created ON share_project_assets(created_at);
CREATE INDEX IF NOT EXISTS share_grants_expiry ON share_project_upload_grants(expires_at);
