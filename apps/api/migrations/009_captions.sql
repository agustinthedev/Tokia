CREATE TABLE IF NOT EXISTS caption_folders (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT,
  color TEXT NOT NULL DEFAULT '#2468ec',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS captions (
  id TEXT PRIMARY KEY NOT NULL,
  folder_id TEXT NOT NULL,
  body TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#f59e0b',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (folder_id) REFERENCES caption_folders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_caption_folders_active_updated
  ON caption_folders(archived_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_captions_folder_updated
  ON captions(folder_id, updated_at DESC);
