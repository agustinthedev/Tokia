-- Some older imports kept an originals URL while retaining the small preview
-- dimensions in the asset metadata. Normalize those records as well so every
-- source-media consumer sees the large baseline size.
UPDATE assets
SET width = 736,
    height = CASE
      WHEN width > 0 AND height IS NOT NULL THEN CAST(ROUND(height * 736.0 / width) AS INTEGER)
      ELSE height
    END
WHERE width IS NOT NULL
  AND width > 0
  AND width < 736;
