-- Extend the existing content model with the first useful version of long-form
-- video clipping. Existing rows are copied without changing their identifiers.
ALTER TABLE content_items RENAME TO content_items_legacy;
ALTER TABLE content_frames RENAME TO content_frames_legacy;
ALTER TABLE content_assets RENAME TO content_assets_legacy;
ALTER TABLE generation_jobs RENAME TO generation_jobs_legacy;

CREATE TABLE content_items (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('single_image', 'carousel', 'video_slideshow', 'video_clipping')),
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

INSERT INTO content_items SELECT * FROM content_items_legacy;

CREATE TABLE content_frames (
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
INSERT INTO content_frames SELECT * FROM content_frames_legacy;

CREATE TABLE content_assets (
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
INSERT INTO content_assets SELECT * FROM content_assets_legacy;

CREATE TABLE generation_jobs (
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
INSERT INTO generation_jobs SELECT * FROM generation_jobs_legacy;

DROP TABLE generation_jobs_legacy;
DROP TABLE content_assets_legacy;
DROP TABLE content_frames_legacy;
DROP TABLE content_items_legacy;

CREATE INDEX IF NOT EXISTS idx_content_project_status ON content_items(project_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_frames_content ON content_frames(content_id, position);
CREATE INDEX IF NOT EXISTS idx_content_assets_content_variant ON content_assets(content_id, variant, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_queue ON generation_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_content ON generation_jobs(content_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_provider_connections (
  id TEXT PRIMARY KEY NOT NULL,
  owner_scope TEXT NOT NULL DEFAULT 'local',
  provider_type TEXT NOT NULL CHECK (provider_type IN ('openai', 'openai_compatible', 'local_whisper')),
  display_name TEXT NOT NULL,
  base_url TEXT,
  model_name TEXT,
  transcription_model TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  encrypted_secret TEXT,
  encryption_version INTEGER,
  secret_suffix TEXT,
  status TEXT NOT NULL DEFAULT 'configured' CHECK (status IN ('configured', 'connected', 'connection_failed', 'unavailable', 'disabled')),
  last_error_code TEXT,
  last_error_message TEXT,
  last_validated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_provider_scope_status ON ai_provider_connections(owner_scope, status);
CREATE INDEX IF NOT EXISTS idx_ai_provider_type ON ai_provider_connections(provider_type);

CREATE TABLE IF NOT EXISTS ai_task_assignments (
  owner_scope TEXT NOT NULL DEFAULT 'local',
  task_type TEXT NOT NULL CHECK (task_type IN ('TRANSCRIPTION', 'TOPIC_DETECTION', 'SUBTOPIC_DETECTION')),
  provider_connection_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_scope, task_type),
  FOREIGN KEY (provider_connection_id) REFERENCES ai_provider_connections(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS ai_provider_requests (
  id TEXT PRIMARY KEY NOT NULL,
  provider_connection_id TEXT NOT NULL,
  task_type TEXT NOT NULL,
  model_name TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  audio_duration_ms INTEGER,
  estimated_cost REAL,
  provider_request_id TEXT,
  latency_ms INTEGER,
  retry_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (provider_connection_id) REFERENCES ai_provider_connections(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_provider_requests_provider_created ON ai_provider_requests(provider_connection_id, created_at DESC);

CREATE TABLE IF NOT EXISTS long_video_sources (
  id TEXT PRIMARY KEY NOT NULL,
  content_id TEXT NOT NULL UNIQUE,
  source_path TEXT NOT NULL,
  original_filename TEXT,
  mime_type TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  audio_hash TEXT,
  duration_ms INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  title TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'processing', 'ready', 'failed')),
  processing_stage TEXT NOT NULL DEFAULT 'uploaded',
  processing_progress INTEGER NOT NULL DEFAULT 0 CHECK (processing_progress >= 0 AND processing_progress <= 100),
  wizard_step INTEGER NOT NULL DEFAULT 2,
  error_code TEXT,
  error_message TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (content_id) REFERENCES content_items(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_long_video_sources_content_stage ON long_video_sources(content_id, processing_stage);

CREATE TABLE IF NOT EXISTS clipping_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  content_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  job_type TEXT NOT NULL CHECK (job_type IN ('audio_extraction', 'transcription', 'topic_detection', 'subtopic_detection', 'render_batch')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  attempt INTEGER NOT NULL DEFAULT 0,
  input_json TEXT NOT NULL DEFAULT '{}',
  output_json TEXT,
  error_code TEXT,
  error_message TEXT,
  claimed_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (content_id) REFERENCES content_items(id) ON DELETE CASCADE,
  FOREIGN KEY (source_id) REFERENCES long_video_sources(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_clipping_jobs_queue ON clipping_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_clipping_jobs_content ON clipping_jobs(content_id, created_at DESC);

CREATE TABLE IF NOT EXISTS transcripts (
  id TEXT PRIMARY KEY NOT NULL,
  source_id TEXT NOT NULL UNIQUE,
  provider_connection_id TEXT,
  provider_type TEXT,
  model_name TEXT,
  language TEXT,
  text TEXT NOT NULL,
  word_timestamps INTEGER NOT NULL DEFAULT 0 CHECK (word_timestamps IN (0, 1)),
  source_audio_hash TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (source_id) REFERENCES long_video_sources(id) ON DELETE CASCADE,
  FOREIGN KEY (provider_connection_id) REFERENCES ai_provider_connections(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS transcript_segments (
  id TEXT PRIMARY KEY NOT NULL,
  transcript_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  text TEXT NOT NULL,
  FOREIGN KEY (transcript_id) REFERENCES transcripts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_transcript_segments_transcript ON transcript_segments(transcript_id, position);

CREATE TABLE IF NOT EXISTS transcript_words (
  id TEXT PRIMARY KEY NOT NULL,
  transcript_id TEXT NOT NULL,
  segment_id TEXT,
  position INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  text TEXT NOT NULL,
  FOREIGN KEY (transcript_id) REFERENCES transcripts(id) ON DELETE CASCADE,
  FOREIGN KEY (segment_id) REFERENCES transcript_segments(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_transcript_words_transcript ON transcript_words(transcript_id, position);

CREATE TABLE IF NOT EXISTS video_topics (
  id TEXT PRIMARY KEY NOT NULL,
  source_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  confidence REAL,
  analysis_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  FOREIGN KEY (source_id) REFERENCES long_video_sources(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_video_topics_source_position ON video_topics(source_id, position);

CREATE TABLE IF NOT EXISTS video_subtopics (
  id TEXT PRIMARY KEY NOT NULL,
  topic_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  confidence REAL,
  preview_status TEXT NOT NULL DEFAULT 'available',
  FOREIGN KEY (topic_id) REFERENCES video_topics(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_video_subtopics_topic_position ON video_subtopics(topic_id, position);

CREATE TABLE IF NOT EXISTS clip_selections (
  id TEXT PRIMARY KEY NOT NULL,
  content_id TEXT NOT NULL,
  subtopic_id TEXT NOT NULL,
  selected INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (content_id, subtopic_id),
  FOREIGN KEY (content_id) REFERENCES content_items(id) ON DELETE CASCADE,
  FOREIGN KEY (subtopic_id) REFERENCES video_subtopics(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_clip_selections_content_selected ON clip_selections(content_id, selected);

CREATE TABLE IF NOT EXISTS clip_render_settings (
  id TEXT PRIMARY KEY NOT NULL,
  clip_selection_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  settings_json TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (clip_selection_id, version),
  FOREIGN KEY (clip_selection_id) REFERENCES clip_selections(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS clip_render_batches (
  id TEXT PRIMARY KEY NOT NULL,
  content_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed')),
  total_count INTEGER NOT NULL DEFAULT 0,
  completed_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (content_id) REFERENCES content_items(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_clip_render_batches_content ON clip_render_batches(content_id, created_at DESC);

CREATE TABLE IF NOT EXISTS rendered_clips (
  id TEXT PRIMARY KEY NOT NULL,
  render_batch_id TEXT NOT NULL,
  content_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  subtopic_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'rendering', 'completed', 'failed')),
  output_path TEXT,
  original_start_ms INTEGER NOT NULL,
  original_end_ms INTEGER NOT NULL,
  final_duration_ms INTEGER,
  file_size_bytes INTEGER,
  width INTEGER,
  height INTEGER,
  mime_type TEXT,
  settings_fingerprint TEXT,
  render_plan_version TEXT,
  processing_duration_ms INTEGER,
  retry_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (render_batch_id) REFERENCES clip_render_batches(id) ON DELETE CASCADE,
  FOREIGN KEY (content_id) REFERENCES content_items(id) ON DELETE CASCADE,
  FOREIGN KEY (source_id) REFERENCES long_video_sources(id) ON DELETE CASCADE,
  FOREIGN KEY (topic_id) REFERENCES video_topics(id) ON DELETE CASCADE,
  FOREIGN KEY (subtopic_id) REFERENCES video_subtopics(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_rendered_clips_batch_status ON rendered_clips(render_batch_id, status);
CREATE INDEX IF NOT EXISTS idx_rendered_clips_content_created ON rendered_clips(content_id, created_at DESC);

CREATE TABLE IF NOT EXISTS branding_assets (
  id TEXT PRIMARY KEY NOT NULL,
  content_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  asset_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (content_id) REFERENCES content_items(id) ON DELETE CASCADE
);
