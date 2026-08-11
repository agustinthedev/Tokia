import crypto from 'node:crypto';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { pinterestImageCandidates } from '@tokia/shared';
import { ContentValidationError, DEFAULT_CONFIGURATION, assertContentType, defaultFrameDuration, effectiveFrameDuration, effectiveFrameTrim, frameRoles, isMotionMedia, mergeConfiguration, slugify, type ContentConfiguration, type ContentType } from './content-model.js';
import { contentDirectory, createThumbnail, downloadSource, MediaProcessingError, normalizeImage, renderSlideshow, sha256File, type SlideshowScene } from './content-media.js';
import { convertHeicToJpeg, isHeicImageUrl } from './image-conversion.js';
import { generateNarrative, validateNarrative, type Narrative } from './narrative.js';

type Row = Record<string, any>;
type JobType = 'narrative_generation' | 'caption_regeneration' | 'frame_regeneration' | 'image_normalization' | 'preview_render' | 'final_render' | 'package_generation';
type Settings = { contentStorageDirectory: string; ffmpegPath: string; ffprobePath: string; modelProvider: string; modelName: string };

function now(): string { return new Date().toISOString(); }
function id(): string { return crypto.randomUUID(); }
function parseJson<T>(value: unknown, fallback: T): T { if (typeof value !== 'string') return fallback; try { return JSON.parse(value) as T; } catch { return fallback; } }
function normalizedSourceMediaType(value: unknown, hasSource: boolean): string | null {
  if (!hasSource) return null;
  return isMotionMedia(value) ? String(value) : 'image';
}

function projectRow(db: Database.Database, projectId: string): Row | undefined { return db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Row | undefined; }
function contentRow(db: Database.Database, contentId: string): Row | undefined { return db.prepare('SELECT c.*, p.name AS project_name, p.niche AS project_niche, p.description AS project_description, p.default_language AS project_language FROM content_items c JOIN projects p ON p.id = c.project_id WHERE c.id = ?').get(contentId) as Row | undefined; }
function contentConfiguration(row: Row): ContentConfiguration { return mergeConfiguration(parseJson(row.configuration_json, {})); }
function sourceCacheKey(value: string): string { return crypto.createHash('sha1').update(value).digest('hex').slice(0, 12); }
async function downloadBestSource(url: string, destination: string): Promise<void> {
  let lastError: unknown;
  for (const candidate of pinterestImageCandidates(url)) {
    try {
      await downloadSource(candidate, destination);
      if (isHeicImageUrl(candidate)) {
        const converted = await convertHeicToJpeg(await fsp.readFile(destination));
        await fsp.writeFile(destination, converted);
      }
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new MediaProcessingError('SOURCE_DOWNLOAD_FAILED', 'The source image could not be downloaded.');
}
function attachedCollectionIds(db: Database.Database, projectId: string): string[] { return (db.prepare('SELECT collection_id FROM project_collections WHERE project_id = ? AND enabled = 1').all(projectId) as Row[]).map((row) => String(row.collection_id)); }

export function validateSourceCollections(db: Database.Database, projectId: string, sourceCollectionIds: string[]): void {
  const unique = [...new Set(sourceCollectionIds)];
  if (!unique.length) throw new ContentValidationError('NO_SOURCE_COLLECTIONS', 'Select at least one source collection.');
  const attached = new Set(attachedCollectionIds(db, projectId));
  if (unique.some((collectionId) => !attached.has(collectionId))) throw new ContentValidationError('INVALID_SOURCE_COLLECTION', 'Every source collection must be connected to the project.');
}

export function contentSnapshot(db: Database.Database, contentId: string): Row | undefined {
  const row = contentRow(db, contentId);
  if (!row) return undefined;
  const configuration = contentConfiguration(row);
  const frames = (db.prepare(`SELECT f.*, a.external_asset_id, a.remote_image_url, a.remote_preview_url, a.remote_media_url, a.width AS source_width, a.height AS source_height, a.duration_seconds AS source_duration_seconds, a.media_type AS source_media_type, a.title AS source_title, a.alt_text AS source_alt_text,
    COALESCE(c.local_title, c.name) AS source_collection_name
    FROM content_frames f LEFT JOIN assets a ON a.id = f.source_media_id
    LEFT JOIN collection_assets ca ON ca.asset_id = a.id LEFT JOIN collections c ON c.id = ca.collection_id
    WHERE f.content_id = ? GROUP BY f.id ORDER BY f.position`).all(contentId) as Row[]).map((frame) => {
      const settings = parseJson<Row>(frame.settings_json, {});
      const sourceMediaType = normalizedSourceMediaType(frame.source_media_type, Boolean(frame.source_media_id));
      const motionSource = isMotionMedia(sourceMediaType);
      const trim = row.type === 'video_slideshow' && motionSource ? effectiveFrameTrim(settings, configuration, sourceMediaType, frame.source_duration_seconds) : null;
      const configuredDuration = settings.durationCustomized ? settings.durationSeconds : configuration.video.secondsPerImage;
      const durationSeconds = row.type === 'video_slideshow'
        ? trim?.durationSeconds ?? effectiveFrameDuration(configuredDuration, configuration, sourceMediaType, frame.source_duration_seconds)
        : null;
      return {
        id: frame.id, position: frame.position, role: frame.role, headline: frame.headline, body: frame.body,
        durationSeconds, startSeconds: trim ? trim.startSeconds : null, endSeconds: trim ? trim.endSeconds : null,
        textLocked: Boolean(frame.text_locked), imageLocked: Boolean(frame.image_locked), muted: settings.muted === true, settings,
        sourceMedia: frame.source_media_id ? { id: frame.source_media_id, externalId: frame.external_asset_id, imageUrl: frame.remote_image_url ?? frame.remote_preview_url ?? frame.remote_media_url, previewUrl: frame.remote_preview_url, mediaUrl: frame.remote_media_url ?? frame.remote_preview_url ?? frame.remote_image_url, width: frame.source_width, height: frame.source_height, durationSeconds: frame.source_duration_seconds, mediaType: sourceMediaType, title: frame.source_title, altText: frame.source_alt_text, collectionName: frame.source_collection_name } : null
      };
    });
  const assets = (db.prepare('SELECT id, frame_id, asset_type, variant, status, mime_type, width, height, duration_ms, sha256, metadata_json, created_at FROM content_assets WHERE content_id = ? ORDER BY created_at DESC').all(contentId) as Row[]).map((asset) => ({
    id: asset.id, frameId: asset.frame_id, assetType: asset.asset_type, variant: asset.variant, status: asset.status, mimeType: asset.mime_type,
    width: asset.width, height: asset.height, durationMs: asset.duration_ms, sha256: asset.sha256, metadata: parseJson(asset.metadata_json, {}), createdAt: asset.created_at,
    previewUrl: `/api/content/${contentId}/assets/${asset.id}/preview`, downloadUrl: `/api/content/${contentId}/assets/${asset.id}/download`
  }));
  const jobs = (db.prepare('SELECT id, job_type, status, progress, attempt, error_code, error_message, started_at, finished_at, created_at FROM generation_jobs WHERE content_id = ? ORDER BY created_at DESC LIMIT 20').all(contentId) as Row[]).map((job) => ({ id: job.id, jobType: job.job_type, status: job.status, progress: job.progress, attempt: job.attempt, errorCode: job.error_code, errorMessage: job.error_message, startedAt: job.started_at, finishedAt: job.finished_at, createdAt: job.created_at }));
  return { id: row.id, projectId: row.project_id, projectName: row.project_name, type: row.type, title: row.title, status: row.status, language: row.language, topic: row.topic,
    configuration, narrative: parseJson<Narrative | null>(row.narrative_json, null), wizardStep: row.wizard_step, previewVersion: row.preview_version, acceptedVersion: row.accepted_version, version: row.version,
    errorCode: row.error_code, errorMessage: row.error_message, createdAt: row.created_at, updatedAt: row.updated_at, archivedAt: row.archived_at, frameCount: frames.length,
    contentFrameCount: frames.filter((frame) => frame.role === 'content').length, frames, assets, jobs };
}

export function updateContentWizardStep(
  db: Database.Database,
  contentId: string,
  step: unknown,
): Row {
  const row = contentRow(db, contentId);
  if (!row || row.status === 'archived')
    throw new ContentValidationError('CONTENT_NOT_FOUND', 'Content item not found.');
  const parsed = Number(step);
  const next = Number.isFinite(parsed)
    ? Math.max(1, Math.min(7, Math.round(parsed)))
    : 1;
  db.prepare('UPDATE content_items SET wizard_step = ?, updated_at = ? WHERE id = ?').run(next, now(), contentId);
  return contentSnapshot(db, contentId)!;
}

export function createContentDraft(db: Database.Database, options: { projectId: string; type: unknown; title?: unknown; language?: unknown; configuration?: unknown }): Row {
  const project = projectRow(db, options.projectId);
  if (!project || project.status === 'archived') throw new ContentValidationError('PROJECT_NOT_FOUND', 'Project not found or archived.');
  const type = assertContentType(options.type);
  const projectDefaults = parseJson(project.config_json, {});
  const configuration = mergeConfiguration(options.configuration, projectDefaults);
  const projectCollections = attachedCollectionIds(db, options.projectId);
  if (!configuration.sourceCollectionIds.length) configuration.sourceCollectionIds = projectCollections;
  if (type !== 'video_clipping') validateSourceCollections(db, options.projectId, configuration.sourceCollectionIds);
  const roles = frameRoles(type, configuration);
  const contentId = id(); const timestamp = now(); const title = typeof options.title === 'string' && options.title.trim() ? options.title.trim().slice(0, 200) : null;
  const language = typeof options.language === 'string' && options.language.trim() ? options.language.trim().slice(0, 80) : String(project.default_language ?? 'English');
  db.transaction(() => {
    db.prepare(`INSERT INTO content_items(id, project_id, type, title, status, language, topic, configuration_json, narrative_json, preview_version, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, NULL, 0, 1, ?, ?)`).run(contentId, options.projectId, type, title, language, configuration.topic || null, JSON.stringify(configuration), timestamp, timestamp);
    const insert = db.prepare('INSERT INTO content_frames(id, content_id, position, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
    for (const role of roles) insert.run(id(), contentId, role.position, role.role, timestamp, timestamp);
    db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(timestamp, options.projectId);
  })();
  return contentSnapshot(db, contentId)!;
}

export function updateContent(db: Database.Database, contentId: string, body: Row): Row {
  const row = contentRow(db, contentId);
  if (!row) throw new ContentValidationError('CONTENT_NOT_FOUND', 'Content item not found.');
  if (row.status === 'archived') throw new ContentValidationError('CONTENT_NOT_FOUND', 'Content item not found.');
  if (['generation_queued', 'generating'].includes(String(row.status))) throw new ContentValidationError('CONTENT_BUSY', 'Final generation is running; wait for it to finish before editing.');
  const current = contentConfiguration(row);
  const next = body.configuration === undefined ? current : mergeConfiguration(body.configuration, current);
  if (body.configuration?.sourceCollectionIds !== undefined) validateSourceCollections(db, row.project_id, next.sourceCollectionIds);
  const type = body.type === undefined ? row.type as ContentType : assertContentType(body.type);
  const roles = frameRoles(type, next);
  const oldFrames = db.prepare('SELECT id, position, role FROM content_frames WHERE content_id = ? ORDER BY position').all(contentId) as Row[];
  const timestamp = now();
  db.transaction(() => {
    db.prepare('UPDATE content_items SET type = ?, title = ?, language = ?, topic = ?, configuration_json = ?, version = version + 1, updated_at = ?, error_code = NULL, error_message = NULL WHERE id = ?').run(type, body.title === undefined ? row.title : (typeof body.title === 'string' ? body.title.trim().slice(0, 200) || null : null), body.language === undefined ? row.language : String(body.language).slice(0, 80), next.topic || null, JSON.stringify(next), timestamp, contentId);
    if (oldFrames.length !== roles.length || oldFrames.some((frame, index) => frame.role !== roles[index]?.role)) {
      db.prepare('DELETE FROM content_frames WHERE content_id = ?').run(contentId);
      const insert = db.prepare('INSERT INTO content_frames(id, content_id, position, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
      for (const role of roles) insert.run(id(), contentId, role.position, role.role, timestamp, timestamp);
    }
    if (type === 'video_slideshow' && current.video.secondsPerImage !== next.video.secondsPerImage) {
      const frames = db.prepare(`SELECT f.id, f.settings_json, a.media_type, a.duration_seconds FROM content_frames f LEFT JOIN assets a ON a.id = f.source_media_id WHERE f.content_id = ?`).all(contentId) as Row[];
      for (const frame of frames) {
        const frameSettings = parseJson<Row>(frame.settings_json, {});
        if (frameSettings.durationCustomized) continue;
        frameSettings.durationSeconds = defaultFrameDuration(next, frame.media_type, frame.duration_seconds);
        db.prepare('UPDATE content_frames SET settings_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(frameSettings), timestamp, frame.id);
      }
    }
  })();
  return contentSnapshot(db, contentId)!;
}

export function enqueueJob(db: Database.Database, contentId: string, jobType: JobType, input: Row = {}): Row {
  const row = contentRow(db, contentId); if (!row) throw new ContentValidationError('CONTENT_NOT_FOUND', 'Content item not found.');
  const existing = db.prepare(`SELECT * FROM generation_jobs WHERE content_id = ? AND job_type = ? AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1`).get(contentId, jobType) as Row | undefined;
  if (existing) return existing;
  const jobId = id(); const timestamp = now();
  db.transaction(() => {
    db.prepare('INSERT INTO generation_jobs(id, content_id, job_type, status, progress, attempt, input_json, created_at) VALUES (?, ?, ?, \'queued\', 0, 0, ?, ?)').run(jobId, contentId, jobType, JSON.stringify(input), timestamp);
    const nextStatus = jobType === 'preview_render' ? 'preview_generating' : jobType === 'final_render' ? 'generation_queued' : row.status === 'failed' ? 'draft' : row.status;
    db.prepare('UPDATE content_items SET status = ?, error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ?').run(nextStatus, timestamp, contentId);
  })();
  return db.prepare('SELECT * FROM generation_jobs WHERE id = ?').get(jobId) as Row;
}

function narrativeInput(db: Database.Database, row: Row, configuration: ContentConfiguration): { roles: ReturnType<typeof frameRoles>; input: Parameters<typeof generateNarrative>[0] } {
  const project = projectRow(db, row.project_id) ?? {};
  return { roles: frameRoles(row.type as ContentType, configuration), input: {
    type: row.type, language: row.language, niche: String(project.niche ?? 'your niche'), projectDescription: String(project.description ?? ''), topic: configuration.topic || String(row.topic ?? ''), tone: configuration.tone, audience: configuration.audience,
    customInstructions: configuration.customInstructions, ctaMode: configuration.ctaMode, ctaText: configuration.ctaText, textMode: configuration.textMode, roles: frameRoles(row.type as ContentType, configuration)
  } };
}

async function runNarrativeJob(db: Database.Database, job: Row, settings: Settings): Promise<Row> {
  const row = contentRow(db, job.content_id); if (!row) throw new ContentValidationError('CONTENT_NOT_FOUND', 'Content item not found.');
  const configuration = contentConfiguration(row); const { roles, input } = narrativeInput(db, row, configuration);
  const generated = validateNarrative(generateNarrative(input), roles, configuration);
  const preserveLocked = true;
  const frames = db.prepare('SELECT * FROM content_frames WHERE content_id = ? ORDER BY position').all(row.id) as Row[];
  const requestedFrame = parseJson<Row>(job.input_json, {}).frameId as string | undefined;
  db.transaction(() => {
    const narrative = parseJson<Narrative | null>(row.narrative_json, null);
    if (job.job_type !== 'caption_regeneration') {
      for (const frame of frames) {
        const next = generated.frames[Number(frame.position) - 1]; if (!next) continue;
        if (requestedFrame && frame.id !== requestedFrame) continue;
        if (preserveLocked && frame.text_locked) continue;
        db.prepare('UPDATE content_frames SET headline = ?, body = ?, updated_at = ? WHERE id = ?').run(next.headline, next.body, now(), frame.id);
      }
    }
    const merged = { ...(narrative ?? generated), topic: job.job_type === 'caption_regeneration' && narrative ? narrative.topic : generated.topic, title: job.job_type === 'caption_regeneration' && narrative ? narrative.title : generated.title, caption: generated.caption, hashtags: generated.hashtags,
      frames: generated.frames.map((frame) => { const existing = frames.find((item) => item.position === frame.index); const currentFrame = narrative?.frames?.[frame.index - 1]; if (job.job_type === 'caption_regeneration' || (requestedFrame && existing?.id !== requestedFrame)) return currentFrame ?? frame; return existing && existing.text_locked && currentFrame ? currentFrame : frame; }) };
    db.prepare('UPDATE content_items SET title = COALESCE(title, ?), topic = ?, narrative_json = ?, status = \'draft\', error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ?').run(merged.title, merged.topic, JSON.stringify(merged), now(), row.id);
  })();
  return { provider: settings.modelProvider, model: settings.modelName, narrative: generated };
}

async function renderContent(db: Database.Database, contentId: string, variant: 'preview' | 'final', settings: Settings): Promise<Row> {
  const row = contentRow(db, contentId); if (!row) throw new ContentValidationError('CONTENT_NOT_FOUND', 'Content item not found.');
  const configuration = contentConfiguration(row); const directory = contentDirectory(settings.contentStorageDirectory, contentId);
  const frames = db.prepare('SELECT f.*, a.remote_image_url, a.remote_media_url, a.remote_preview_url, a.media_type AS source_media_type, a.duration_seconds AS source_duration_seconds FROM content_frames f LEFT JOIN assets a ON a.id = f.source_media_id WHERE f.content_id = ? ORDER BY f.position').all(contentId) as Row[];
  if (frames.some((frame) => !frame.source_media_id)) throw new ContentValidationError('MISSING_SOURCE_IMAGE', 'Select an image for every frame before generating a preview.');
  if (variant === 'preview') db.prepare('DELETE FROM content_assets WHERE content_id = ? AND variant = \'preview\'').run(contentId);
  if (variant === 'final') db.prepare('DELETE FROM content_assets WHERE content_id = ? AND variant = \'final\'').run(contentId);
  const renderedPaths: string[] = [];
  const scenes: SlideshowScene[] = [];
  const timestamp = now();
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index]!; const sourceMediaType = normalizedSourceMediaType(frame.source_media_type, Boolean(frame.source_media_id)); const motionUrl = row.type === 'video_slideshow' && isMotionMedia(sourceMediaType) && frame.remote_media_url;
    const sourceUrl = String(motionUrl ? frame.remote_media_url : frame.remote_image_url ?? frame.remote_preview_url ?? frame.remote_media_url ?? '');
    if (!sourceUrl) throw new MediaProcessingError('SOURCE_MEDIA_MISSING', `Source media is missing for frame ${index + 1}.`);
    const sourceKey = String(frame.source_media_id).replace(/[^a-zA-Z0-9_-]/g, '');
    const frameSettings = parseJson<Row>(frame.settings_json, {});
    const motionFrame = isMotionMedia(sourceMediaType);
    const trim = row.type === 'video_slideshow' && motionFrame ? effectiveFrameTrim(frameSettings, configuration, sourceMediaType, frame.source_duration_seconds) : null;
    const configuredDuration = frameSettings.durationCustomized ? frameSettings.durationSeconds : configuration.video.secondsPerImage;
    const durationSeconds = row.type === 'video_slideshow'
      ? trim?.durationSeconds ?? effectiveFrameDuration(configuredDuration, configuration, sourceMediaType, frame.source_duration_seconds)
      : null;
    const sourcePath = motionUrl ? path.join(directory, `motion-${String(index + 1).padStart(2, '0')}-${sourceKey}-${sourceCacheKey(sourceUrl)}.media`) : null;
    if (sourcePath && !fs.existsSync(sourcePath)) await downloadSource(sourceUrl, sourcePath);
    const normalizedPath = path.join(directory, `source-${String(index + 1).padStart(2, '0')}-${sourceKey}-${sourceCacheKey(sourceUrl)}.png`);
    if (!fs.existsSync(normalizedPath)) {
      const downloadPath = path.join(directory, `download-${String(index + 1).padStart(2, '0')}`);
      if (sourcePath) await fsp.copyFile(sourcePath, downloadPath);
      else await downloadBestSource(sourceUrl, downloadPath);
      await normalizeImage({ ffmpegPath: settings.ffmpegPath, sourcePath: downloadPath, outputPath: normalizedPath, configuration });
      await fsp.rm(downloadPath, { force: true });
      const sourceHash = await sha256File(normalizedPath);
      db.prepare(`INSERT INTO content_assets(id, content_id, frame_id, asset_type, variant, status, file_path, mime_type, width, height, sha256, metadata_json, created_at)
        VALUES (?, ?, ?, 'image', 'source_normalized', 'ready', ?, 'image/png', ?, ?, ?, ?, ?)`).run(id(), contentId, frame.id, normalizedPath, ratioFor(configuration).width, ratioFor(configuration).height, sourceHash, JSON.stringify({ sourceMediaId: frame.source_media_id }), timestamp);
    }
    const text = configuration.textMode === 'none' ? null : { headline: frame.headline, body: frame.body };
    const outputPath = path.join(directory, `${variant}-${String(index + 1).padStart(2, '0')}.png`);
    const dimensions = await normalizeImage({ ffmpegPath: settings.ffmpegPath, sourcePath: normalizedPath, outputPath, configuration, text });
    renderedPaths.push(outputPath);
    if (row.type === 'video_slideshow') {
      scenes.push({ path: sourcePath ?? outputPath, mediaType: sourcePath ? 'video' : 'image', durationSeconds: durationSeconds ?? configuration.video.secondsPerImage, startSeconds: sourcePath ? trim?.startSeconds : undefined, endSeconds: sourcePath ? trim?.endSeconds : undefined, muted: sourcePath ? frameSettings.muted === true : false, text: sourcePath ? text : null });
    }
    const hash = await sha256File(outputPath);
    db.prepare(`INSERT INTO content_assets(id, content_id, frame_id, asset_type, variant, status, file_path, mime_type, width, height, sha256, metadata_json, created_at)
      VALUES (?, ?, ?, 'image', ?, 'ready', ?, 'image/png', ?, ?, ?, ?, ?)`).run(id(), contentId, frame.id, variant, outputPath, dimensions.width, dimensions.height, hash, JSON.stringify({ position: index + 1, role: frame.role }), timestamp);
  }
  let videoPath: string | null = null;
  let video: { width: number; height: number; durationMs: number } | null = null;
  if (row.type === 'video_slideshow') {
    videoPath = path.join(directory, `${variant}.mp4`);
    video = await renderSlideshow({ ffmpegPath: settings.ffmpegPath, ffprobePath: settings.ffprobePath, scenes, outputPath: videoPath, configuration });
    db.prepare(`INSERT INTO content_assets(id, content_id, frame_id, asset_type, variant, status, file_path, mime_type, width, height, duration_ms, sha256, metadata_json, created_at)
      VALUES (?, ?, NULL, 'video', ?, 'ready', ?, 'video/mp4', ?, ?, ?, ?, ?, ?)`).run(id(), contentId, variant, videoPath, video.width, video.height, video.durationMs, await sha256File(videoPath), JSON.stringify({ fps: configuration.video.fps, secondsPerImage: configuration.video.secondsPerImage, sceneDurations: scenes.map((scene) => scene.durationSeconds), sourceTypes: scenes.map((scene) => scene.mediaType), mutedScenes: scenes.map((scene) => scene.muted === true) }), timestamp);
  }
  const first = videoPath ?? renderedPaths[0]; if (!first) throw new MediaProcessingError('NO_RENDERED_ASSET', 'No rendered frame was created.');
  const thumbnailPath = path.join(directory, `${variant}-thumbnail.webp`);
  await createThumbnail({ ffmpegPath: settings.ffmpegPath, sourcePath: first, outputPath: thumbnailPath });
  db.prepare(`INSERT INTO content_assets(id, content_id, frame_id, asset_type, variant, status, file_path, mime_type, width, height, sha256, metadata_json, created_at)
    VALUES (?, ?, NULL, 'thumbnail', ?, 'ready', ?, 'image/webp', 320, 320, ?, ?, ?)`).run(id(), contentId, variant, thumbnailPath, await sha256File(thumbnailPath), JSON.stringify({}), timestamp);
  if (variant === 'preview') db.prepare('UPDATE content_items SET preview_version = preview_version + 1, status = \'preview_ready\', error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ?').run(now(), contentId);
  return { variant, frameCount: frames.length, files: renderedPaths.length };
}

function ratioFor(configuration: ContentConfiguration): { width: number; height: number } { const { width, height } = configuration.video.outputResolution === '1080p' ? { width: 608, height: 1080 } : { width: 405, height: 720 }; if (configuration.aspectRatio === '1:1') return { width: 720, height: 720 }; if (configuration.aspectRatio === '4:5') return { width: 576, height: 720 }; if (configuration.aspectRatio === '16:9') return { width: 720, height: 405 }; return { width, height }; }

async function runJob(db: Database.Database, job: Row, settings: Settings): Promise<Row> {
  if (job.job_type === 'narrative_generation' || job.job_type === 'caption_regeneration' || job.job_type === 'frame_regeneration') return runNarrativeJob(db, job, settings);
  if (job.job_type === 'preview_render') return renderContent(db, job.content_id, 'preview', settings);
  if (job.job_type === 'final_render') return renderContent(db, job.content_id, 'final', settings);
  throw new ContentValidationError('UNSUPPORTED_JOB', `Unsupported job type ${job.job_type}.`);
}

export function startContentWorker(db: Database.Database, settings: Settings): () => void {
  db.prepare("UPDATE generation_jobs SET status = 'queued', claimed_at = NULL, started_at = NULL WHERE status = 'running'").run();
  let stopped = false; let running = false;
  const drain = async (): Promise<void> => {
    if (stopped || running) return; running = true;
    try {
      while (!stopped) {
        const job = db.transaction(() => {
          const next = db.prepare("SELECT * FROM generation_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1").get() as Row | undefined;
          if (!next) return undefined;
          db.prepare("UPDATE generation_jobs SET status = 'running', progress = 5, attempt = attempt + 1, claimed_at = ?, started_at = ? WHERE id = ? AND status = 'queued'").run(now(), now(), next.id);
          return db.prepare('SELECT * FROM generation_jobs WHERE id = ?').get(next.id) as Row;
        })();
        if (!job) break;
        try {
          const output = await runJob(db, job, settings);
          db.prepare("UPDATE generation_jobs SET status = 'completed', progress = 100, output_json = ?, finished_at = ? WHERE id = ?").run(JSON.stringify(output), now(), job.id);
          if (job.job_type === 'final_render') db.prepare("UPDATE content_items SET accepted_version = preview_version, status = 'ready', error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ?").run(now(), job.content_id);
        } catch (error) {
          const code = error instanceof ContentValidationError || error instanceof MediaProcessingError ? error.code : 'GENERATION_FAILED';
          const message = error instanceof Error ? error.message : 'Generation failed.';
          const canRetry = Number(job.attempt) < 2;
          db.prepare(`UPDATE generation_jobs SET status = ?, progress = 0, error_code = ?, error_message = ?, finished_at = ? WHERE id = ?`).run(canRetry ? 'queued' : 'failed', code, message, now(), job.id);
          if (!canRetry) db.prepare("UPDATE content_items SET status = 'failed', error_code = ?, error_message = ?, updated_at = ? WHERE id = ?").run(code, message, now(), job.content_id);
        }
      }
    } finally { running = false; }
  };
  const interval = setInterval(() => { void drain(); }, 150); interval.unref(); void drain();
  return () => { stopped = true; clearInterval(interval); };
}
