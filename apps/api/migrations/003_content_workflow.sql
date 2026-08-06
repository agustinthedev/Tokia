ALTER TABLE projects ADD COLUMN niche TEXT;
ALTER TABLE projects ADD COLUMN default_language TEXT NOT NULL DEFAULT 'English';
ALTER TABLE projects ADD COLUMN internal_notes TEXT;
ALTER TABLE projects ADD COLUMN color TEXT;
ALTER TABLE projects ADD COLUMN slug TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_name_active
  ON projects(name COLLATE NOCASE) WHERE status != 'archived';
CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_slug ON projects(slug) WHERE slug IS NOT NULL;

CREATE TABLE IF NOT EXISTS content_items (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('single_image', 'carousel', 'video_slideshow')),
  title TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'preview_generating', 'preview_ready', 'generation_queued', 'generating', 'ready', 'failed', 'archived')),
  language TEXT NOT NULL DEFAULT 'English',
  topic TEXT,
  configuration_json TEXT NOT NULL,
  narrative_json TEXT,
  preview_version INTEGER NOT NULL DEFAULT 0,
  accepted_version INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_content_project_status ON content_items(project_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS content_frames (
  id TEXT PRIMARY KEY NOT NULL,
  content_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('cover', 'content', 'cta', 'title_and_summary')),
  headline TEXT,
  body TEXT,
  source_media_id TEXT,
  text_locked INTEGER NOT NULL DEFAULT 0 CHECK (text_locked IN (0, 1)),
  image_locked INTEGER NOT NULL DEFAULT 0 CHECK (image_locked IN (0, 1)),
  settings_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (content_id, position),
  FOREIGN KEY (content_id) REFERENCES content_items(id) ON DELETE CASCADE,
  FOREIGN KEY (source_media_id) REFERENCES assets(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_content_frames_content ON content_frames(content_id, position);

CREATE TABLE IF NOT EXISTS content_assets (
  id TEXT PRIMARY KEY NOT NULL,
  content_id TEXT NOT NULL,
  frame_id TEXT,
  asset_type TEXT NOT NULL CHECK (asset_type IN ('image', 'video', 'thumbnail', 'package')),
  variant TEXT NOT NULL CHECK (variant IN ('source_normalized', 'preview', 'final', 'thumbnail', 'package')),
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('queued', 'processing', 'ready', 'failed')),
  file_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  sha256 TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (content_id) REFERENCES content_items(id) ON DELETE CASCADE,
  FOREIGN KEY (frame_id) REFERENCES content_frames(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_content_assets_content_variant ON content_assets(content_id, variant, created_at DESC);

CREATE TABLE IF NOT EXISTS generation_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  content_id TEXT NOT NULL,
  job_type TEXT NOT NULL CHECK (job_type IN ('narrative_generation', 'caption_regeneration', 'frame_regeneration', 'image_normalization', 'preview_render', 'final_render', 'package_generation')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  attempt INTEGER NOT NULL DEFAULT 0,
  input_json TEXT NOT NULL,
  output_json TEXT,
  error_code TEXT,
  error_message TEXT,
  claimed_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (content_id) REFERENCES content_items(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_generation_jobs_queue ON generation_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_content ON generation_jobs(content_id, created_at DESC);
