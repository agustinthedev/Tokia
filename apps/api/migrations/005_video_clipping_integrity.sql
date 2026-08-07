-- Keep provider request history after a connection is deleted. The provider
-- metadata and model are still retained on each historical request.
ALTER TABLE ai_provider_requests RENAME TO ai_provider_requests_legacy;
DROP INDEX IF EXISTS idx_ai_provider_requests_provider_created;

CREATE TABLE ai_provider_requests (
  id TEXT PRIMARY KEY NOT NULL,
  provider_connection_id TEXT,
  provider_type TEXT,
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

INSERT INTO ai_provider_requests
SELECT id, provider_connection_id, NULL, task_type, model_name, input_tokens,
  output_tokens, audio_duration_ms, estimated_cost, provider_request_id,
  latency_ms, retry_count, status, error_code, created_at
FROM ai_provider_requests_legacy;

DROP TABLE ai_provider_requests_legacy;

CREATE INDEX IF NOT EXISTS idx_ai_provider_requests_provider_created
  ON ai_provider_requests(provider_connection_id, created_at DESC);
