-- Source assets must keep the largest usable Pinterest image URL only.
-- Older imports stored small CDN previews separately and sometimes used them
-- as the source dimensions in the content wizard.
UPDATE assets
SET width = CASE WHEN width IS NOT NULL AND width < 736 THEN 736 ELSE width END,
    height = CASE WHEN width IS NOT NULL AND width > 0 AND height IS NOT NULL AND width < 736 THEN CAST(ROUND(height * 736.0 / width) AS INTEGER) ELSE height END
WHERE remote_image_url LIKE '%/236x/%'
   OR remote_image_url LIKE '%/270x/%'
   OR remote_image_url LIKE '%/290x/%'
   OR remote_image_url LIKE '%/300x/%'
   OR remote_image_url LIKE '%/320x/%'
   OR remote_image_url LIKE '%/350x/%'
   OR remote_image_url LIKE '%/400x/%'
   OR remote_image_url LIKE '%/474x/%'
   OR remote_image_url LIKE '%/500x/%'
   OR remote_image_url LIKE '%/564x/%'
   OR remote_image_url LIKE '%/600x/%';

UPDATE assets SET remote_image_url = REPLACE(remote_image_url, '/236x/', '/736x/') WHERE remote_image_url LIKE '%/236x/%';
UPDATE assets SET remote_image_url = REPLACE(remote_image_url, '/270x/', '/736x/') WHERE remote_image_url LIKE '%/270x/%';
UPDATE assets SET remote_image_url = REPLACE(remote_image_url, '/290x/', '/736x/') WHERE remote_image_url LIKE '%/290x/%';
UPDATE assets SET remote_image_url = REPLACE(remote_image_url, '/300x/', '/736x/') WHERE remote_image_url LIKE '%/300x/%';
UPDATE assets SET remote_image_url = REPLACE(remote_image_url, '/320x/', '/736x/') WHERE remote_image_url LIKE '%/320x/%';
UPDATE assets SET remote_image_url = REPLACE(remote_image_url, '/350x/', '/736x/') WHERE remote_image_url LIKE '%/350x/%';
UPDATE assets SET remote_image_url = REPLACE(remote_image_url, '/400x/', '/736x/') WHERE remote_image_url LIKE '%/400x/%';
UPDATE assets SET remote_image_url = REPLACE(remote_image_url, '/474x/', '/736x/') WHERE remote_image_url LIKE '%/474x/%';
UPDATE assets SET remote_image_url = REPLACE(remote_image_url, '/500x/', '/736x/') WHERE remote_image_url LIKE '%/500x/%';
UPDATE assets SET remote_image_url = REPLACE(remote_image_url, '/564x/', '/736x/') WHERE remote_image_url LIKE '%/564x/%';
UPDATE assets SET remote_image_url = REPLACE(remote_image_url, '/600x/', '/736x/') WHERE remote_image_url LIKE '%/600x/%';

-- Thumbnails are rendered from the large source on demand; do not persist a
-- smaller Pinterest URL that can leak back into collection/content views.
UPDATE assets SET remote_preview_url = NULL;

-- Also normalize legacy records whose source URL is already originals but
-- whose imported dimensions still came from a small Pinterest preview.
UPDATE assets
SET width = 736,
    height = CASE
      WHEN width > 0 AND height IS NOT NULL THEN CAST(ROUND(height * 736.0 / width) AS INTEGER)
      ELSE height
    END
WHERE width IS NOT NULL
  AND width > 0
  AND width < 736;
