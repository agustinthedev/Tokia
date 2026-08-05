CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL,
  external_id TEXT,
  canonical_source_url TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'error')),
  last_imported_at TEXT,
  last_successful_import_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, external_id),
  UNIQUE (provider, canonical_source_url)
);

CREATE INDEX IF NOT EXISTS idx_collections_provider_status ON collections(provider, status);
CREATE INDEX IF NOT EXISTS idx_collections_name ON collections(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL,
  external_asset_id TEXT,
  canonical_asset_url TEXT,
  remote_image_url TEXT NOT NULL,
  remote_preview_url TEXT,
  normalized_image_key TEXT,
  title TEXT,
  description TEXT,
  alt_text TEXT,
  source_link TEXT,
  width INTEGER,
  height INTEGER,
  mime_type TEXT,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'unavailable', 'invalid', 'disabled')),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_assets_provider_external_id
  ON assets(provider, external_asset_id) WHERE external_asset_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_assets_provider_canonical_url
  ON assets(provider, canonical_asset_url) WHERE canonical_asset_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_assets_provider_image_key ON assets(provider, normalized_image_key);
CREATE INDEX IF NOT EXISTS idx_assets_status ON assets(status);

CREATE TABLE IF NOT EXISTS collection_assets (
  collection_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (collection_id, asset_id),
  FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
  FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_collection_assets_asset ON collection_assets(asset_id);

CREATE TABLE IF NOT EXISTS import_runs (
  id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL,
  collection_id TEXT,
  source_url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'completed_with_warnings', 'failed')),
  records_received INTEGER NOT NULL DEFAULT 0,
  records_valid INTEGER NOT NULL DEFAULT 0,
  records_invalid INTEGER NOT NULL DEFAULT 0,
  assets_created INTEGER NOT NULL DEFAULT 0,
  assets_updated INTEGER NOT NULL DEFAULT 0,
  memberships_created INTEGER NOT NULL DEFAULT 0,
  duplicates_skipped INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_import_runs_created ON import_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_import_runs_collection ON import_runs(collection_id, created_at DESC);
