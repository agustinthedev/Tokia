ALTER TABLE content_items
  ADD COLUMN wizard_step INTEGER NOT NULL DEFAULT 1
  CHECK (wizard_step BETWEEN 1 AND 7);

UPDATE content_items
SET wizard_step = CASE
  WHEN status IN ('preview_ready', 'ready') THEN 7
  WHEN narrative_json IS NOT NULL
    OR EXISTS (
      SELECT 1
      FROM content_frames
      WHERE content_frames.content_id = content_items.id
        AND content_frames.source_media_id IS NOT NULL
    ) THEN 4
  ELSE 1
END;
