-- Prefer Pinterest originals for every persisted source image. Numeric CDN
-- variants remain only as runtime fallbacks when originals are unavailable.
UPDATE assets SET remote_image_url = REPLACE(remote_image_url, '/60x60/', '/originals/') WHERE remote_image_url LIKE '%/60x60/%';
UPDATE assets SET remote_image_url = REPLACE(remote_image_url, '/75x75/', '/originals/') WHERE remote_image_url LIKE '%/75x75/%';
UPDATE assets SET remote_image_url = REPLACE(remote_image_url, '/170x/', '/originals/') WHERE remote_image_url LIKE '%/170x/%';
UPDATE assets SET remote_image_url = REPLACE(remote_image_url, '/222x/', '/originals/') WHERE remote_image_url LIKE '%/222x/%';
UPDATE assets SET remote_image_url = REPLACE(remote_image_url, '/236x/', '/originals/') WHERE remote_image_url LIKE '%/236x/%';
UPDATE assets SET remote_image_url = REPLACE(remote_image_url, '/270x/', '/originals/') WHERE remote_image_url LIKE '%/270x/%';
UPDATE assets SET remote_image_url = REPLACE(remote_image_url, '/290x/', '/originals/') WHERE remote_image_url LIKE '%/290x/%';
UPDATE assets SET remote_image_url = REPLACE(remote_image_url, '/300x/', '/originals/') WHERE remote_image_url LIKE '%/300x/%';
UPDATE assets SET remote_image_url = REPLACE(remote_image_url, '/320x/', '/originals/') WHERE remote_image_url LIKE '%/320x/%';
UPDATE assets SET remote_image_url = REPLACE(remote_image_url, '/350x/', '/originals/') WHERE remote_image_url LIKE '%/350x/%';
UPDATE assets SET remote_image_url = REPLACE(remote_image_url, '/400x/', '/originals/') WHERE remote_image_url LIKE '%/400x/%';
UPDATE assets SET remote_image_url = REPLACE(remote_image_url, '/474x/', '/originals/') WHERE remote_image_url LIKE '%/474x/%';
UPDATE assets SET remote_image_url = REPLACE(remote_image_url, '/500x/', '/originals/') WHERE remote_image_url LIKE '%/500x/%';
UPDATE assets SET remote_image_url = REPLACE(remote_image_url, '/564x/', '/originals/') WHERE remote_image_url LIKE '%/564x/%';
UPDATE assets SET remote_image_url = REPLACE(remote_image_url, '/600x/', '/originals/') WHERE remote_image_url LIKE '%/600x/%';
UPDATE assets SET remote_image_url = REPLACE(remote_image_url, '/736x/', '/originals/') WHERE remote_image_url LIKE '%/736x/%';
UPDATE assets SET remote_image_url = REPLACE(remote_image_url, '/750x/', '/originals/') WHERE remote_image_url LIKE '%/750x/%';
UPDATE assets SET remote_image_url = REPLACE(remote_image_url, '/1000x/', '/originals/') WHERE remote_image_url LIKE '%/1000x/%';
UPDATE assets SET remote_image_url = REPLACE(remote_image_url, '/1200x/', '/originals/') WHERE remote_image_url LIKE '%/1200x/%';

UPDATE assets SET remote_media_url = REPLACE(remote_media_url, '/60x60/', '/originals/') WHERE media_type <> 'video' AND remote_media_url LIKE '%/60x60/%';
UPDATE assets SET remote_media_url = REPLACE(remote_media_url, '/75x75/', '/originals/') WHERE media_type <> 'video' AND remote_media_url LIKE '%/75x75/%';
UPDATE assets SET remote_media_url = REPLACE(remote_media_url, '/170x/', '/originals/') WHERE media_type <> 'video' AND remote_media_url LIKE '%/170x/%';
UPDATE assets SET remote_media_url = REPLACE(remote_media_url, '/222x/', '/originals/') WHERE media_type <> 'video' AND remote_media_url LIKE '%/222x/%';
UPDATE assets SET remote_media_url = REPLACE(remote_media_url, '/236x/', '/originals/') WHERE media_type <> 'video' AND remote_media_url LIKE '%/236x/%';
UPDATE assets SET remote_media_url = REPLACE(remote_media_url, '/270x/', '/originals/') WHERE media_type <> 'video' AND remote_media_url LIKE '%/270x/%';
UPDATE assets SET remote_media_url = REPLACE(remote_media_url, '/290x/', '/originals/') WHERE media_type <> 'video' AND remote_media_url LIKE '%/290x/%';
UPDATE assets SET remote_media_url = REPLACE(remote_media_url, '/300x/', '/originals/') WHERE media_type <> 'video' AND remote_media_url LIKE '%/300x/%';
UPDATE assets SET remote_media_url = REPLACE(remote_media_url, '/320x/', '/originals/') WHERE media_type <> 'video' AND remote_media_url LIKE '%/320x/%';
UPDATE assets SET remote_media_url = REPLACE(remote_media_url, '/350x/', '/originals/') WHERE media_type <> 'video' AND remote_media_url LIKE '%/350x/%';
UPDATE assets SET remote_media_url = REPLACE(remote_media_url, '/400x/', '/originals/') WHERE media_type <> 'video' AND remote_media_url LIKE '%/400x/%';
UPDATE assets SET remote_media_url = REPLACE(remote_media_url, '/474x/', '/originals/') WHERE media_type <> 'video' AND remote_media_url LIKE '%/474x/%';
UPDATE assets SET remote_media_url = REPLACE(remote_media_url, '/500x/', '/originals/') WHERE media_type <> 'video' AND remote_media_url LIKE '%/500x/%';
UPDATE assets SET remote_media_url = REPLACE(remote_media_url, '/564x/', '/originals/') WHERE media_type <> 'video' AND remote_media_url LIKE '%/564x/%';
UPDATE assets SET remote_media_url = REPLACE(remote_media_url, '/600x/', '/originals/') WHERE media_type <> 'video' AND remote_media_url LIKE '%/600x/%';
UPDATE assets SET remote_media_url = REPLACE(remote_media_url, '/736x/', '/originals/') WHERE media_type <> 'video' AND remote_media_url LIKE '%/736x/%';
UPDATE assets SET remote_media_url = REPLACE(remote_media_url, '/750x/', '/originals/') WHERE media_type <> 'video' AND remote_media_url LIKE '%/750x/%';
UPDATE assets SET remote_media_url = REPLACE(remote_media_url, '/1000x/', '/originals/') WHERE media_type <> 'video' AND remote_media_url LIKE '%/1000x/%';
UPDATE assets SET remote_media_url = REPLACE(remote_media_url, '/1200x/', '/originals/') WHERE media_type <> 'video' AND remote_media_url LIKE '%/1200x/%';

UPDATE assets SET remote_preview_url = NULL;
