ALTER TABLE collections ADD COLUMN local_title TEXT;
ALTER TABLE collections ADD COLUMN local_description TEXT;
ALTER TABLE collections ADD COLUMN cover_asset_id TEXT;
ALTER TABLE collections ADD COLUMN archived_at TEXT;

ALTER TABLE assets ADD COLUMN media_type TEXT NOT NULL DEFAULT 'image';
ALTER TABLE assets ADD COLUMN remote_media_url TEXT;
ALTER TABLE assets ADD COLUMN duration_seconds REAL;
ALTER TABLE assets ADD COLUMN local_notes TEXT;
ALTER TABLE assets ADD COLUMN local_tags TEXT;
ALTER TABLE assets ADD COLUMN archived_at TEXT;

CREATE INDEX IF NOT EXISTS idx_assets_media_type_status ON assets(media_type, status);
CREATE INDEX IF NOT EXISTS idx_assets_dimensions ON assets(width, height);
CREATE INDEX IF NOT EXISTS idx_collection_assets_last_seen ON collection_assets(last_seen_at DESC);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  cover_asset_id TEXT,
  config_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_projects_status_updated ON projects(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS project_collections (
  project_id TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1 CHECK (weight > 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  allowed_media_types TEXT,
  selection_priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, collection_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_project_collections_collection ON project_collections(collection_id);
