import crypto from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { ContentValidationError } from "./content-model.js";
import { contentDirectory } from "./content-media.js";
import {
  assignmentSnapshot,
  hasRequiredCapability,
  normalizeProviderError,
  OPENAI_TRANSCRIPTION_CHUNK_DURATION_MS,
  OPENAI_TRANSCRIPTION_MAX_BYTES,
  preflight,
  structuredAnalysis,
  touchRequest,
  transcribe,
  transcriptionModelForClipping,
  type NormalizedTranscript,
  type NormalizedTranscriptSegment,
  type NormalizedTranscriptWord,
} from "./ai-providers.js";
import {
  extractAudioSegment,
  fileMetadata,
  extractAudio,
  probeMedia,
  renderClip,
} from "./clipping-media.js";
import {
  DEFAULT_CLIP_SETTINGS,
  normalizeClipSettings,
  settingsFingerprint,
  validateClipBounds,
  type ClipSettings,
} from "./clipping-model.js";

type Row = Record<string, any>;
export type ClippingSettings = {
  contentStorageDirectory: string;
  ffmpegPath: string;
  ffprobePath: string;
  secretsEncryptionKey: string;
  maxUploadBytes: number;
};
type ClipJobType =
  | "audio_extraction"
  | "transcription"
  | "topic_detection"
  | "subtopic_detection"
  | "render_batch";
const CLIPPING_AUDIO_FILENAME = "audio-16k.mp3";
const MIN_CLIP_DURATION_MS = 120_000;
const TARGET_CLIP_DURATION_MS = 120_000;
const MAX_CLIP_DURATION_MS = 180_000;
const MIN_TOPIC_DURATION_MS = 5 * 60_000;
const MAX_TOPIC_DURATION_MS = 15 * 60_000;
const TOPIC_ANALYSIS_VERSION = "topic-v2";
const TOPIC_PROMPT_VERSION = "clip-analysis-v3";

function offsetTranscript(transcript: NormalizedTranscript, offsetMs: number): NormalizedTranscript {
  const offsetWord = (word: NormalizedTranscriptWord): NormalizedTranscriptWord => ({
    ...word,
    startMs: word.startMs + offsetMs,
    endMs: word.endMs + offsetMs,
  });
  const segments: NormalizedTranscriptSegment[] = transcript.segments.map((segment) => ({
    ...segment,
    startMs: segment.startMs + offsetMs,
    endMs: segment.endMs + offsetMs,
    words: segment.words.map(offsetWord),
  }));
  return {
    ...transcript,
    segments,
    words: transcript.words.map(offsetWord),
  };
}

function mergeTranscripts(transcripts: NormalizedTranscript[]): NormalizedTranscript {
  return {
    text: transcripts.map((transcript) => transcript.text).filter(Boolean).join(" ").trim(),
    language: transcripts.find((transcript) => transcript.language)?.language,
    segments: transcripts.flatMap((transcript) => transcript.segments).sort((left, right) => left.startMs - right.startMs),
    words: transcripts.flatMap((transcript) => transcript.words).sort((left, right) => left.startMs - right.startMs),
    wordTimestamps: transcripts.some((transcript) => transcript.wordTimestamps),
  };
}

async function transcribeAudio(
  provider: Row,
  masterSecret: string,
  audioPath: string,
  audioDurationMs: number,
  ffmpegPath: string,
  workingDirectory: string,
  onProgress: (progress: number) => void,
): Promise<NormalizedTranscript> {
  const meta = await fileMetadata(audioPath);
  if (provider.provider_type !== "openai" || meta.size <= OPENAI_TRANSCRIPTION_MAX_BYTES) {
    return transcribe(provider, masterSecret, audioPath, audioDurationMs);
  }

  const durationMs = Math.max(1, audioDurationMs);
  const chunkCount = Math.ceil(durationMs / OPENAI_TRANSCRIPTION_CHUNK_DURATION_MS);
  const chunkDirectory = path.join(workingDirectory, "transcription-chunks");
  await fsp.rm(chunkDirectory, { recursive: true, force: true });
  await fsp.mkdir(chunkDirectory, { recursive: true });
  const transcripts: NormalizedTranscript[] = [];
  try {
    for (let index = 0; index < chunkCount; index += 1) {
      const startMs = index * OPENAI_TRANSCRIPTION_CHUNK_DURATION_MS;
      const chunkDurationMs = Math.min(OPENAI_TRANSCRIPTION_CHUNK_DURATION_MS, durationMs - startMs);
      const chunkPath = path.join(chunkDirectory, `chunk-${String(index + 1).padStart(4, "0")}.mp3`);
      await extractAudioSegment(ffmpegPath, audioPath, chunkPath, startMs, chunkDurationMs);
      const chunk = await transcribe(provider, masterSecret, chunkPath, chunkDurationMs);
      transcripts.push(offsetTranscript(chunk, startMs));
      onProgress(35 + Math.round(((index + 1) / chunkCount) * 20));
    }
    return mergeTranscripts(transcripts);
  } finally {
    await fsp.rm(chunkDirectory, { recursive: true, force: true });
  }
}

function id(): string {
  return crypto.randomUUID();
}
function now(): string {
  return new Date().toISOString();
}
function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return typeof value === "string"
      ? (JSON.parse(value) as T)
      : ((value as T) ?? fallback);
  } catch {
    return fallback;
  }
}
function sourceRow(db: Database.Database, contentId: string): Row {
  const row = db
    .prepare("SELECT * FROM long_video_sources WHERE content_id = ?")
    .get(contentId) as Row | undefined;
  if (!row)
    throw new ContentValidationError(
      "SOURCE_NOT_FOUND",
      "Upload a source video before continuing.",
    );
  return row;
}
function contentRow(db: Database.Database, contentId: string): Row {
  const row = db
    .prepare("SELECT * FROM content_items WHERE id = ?")
    .get(contentId) as Row | undefined;
  if (!row)
    throw new ContentValidationError(
      "CONTENT_NOT_FOUND",
      "Content item not found.",
    );
  if (row.type !== "video_clipping")
    throw new ContentValidationError(
      "NOT_CLIPPING_CONTENT",
      "This content item is not a clipping workflow.",
    );
  return row;
}
export function jobSnapshot(row: Row): Row {
  return {
    id: row.id,
    jobType: row.job_type,
    status: row.status,
    progress: row.progress,
    attempt: row.attempt,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
  };
}
function publicSource(row: Row): Row {
  return {
    id: row.id,
    contentId: row.content_id,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    sourceHash: row.source_hash,
    durationMs: row.duration_ms,
    width: row.width,
    height: row.height,
    title: row.title,
    notes: row.notes,
    status: row.status,
    processingStage: row.processing_stage,
    processingProgress: row.processing_progress,
    wizardStep: row.wizard_step,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function providerForTask(
  db: Database.Database,
  task: "TRANSCRIPTION" | "TOPIC_DETECTION",
): Row {
  const row = db
    .prepare(
      `SELECT p.* FROM ai_task_assignments a JOIN ai_provider_connections p ON p.id = a.provider_connection_id WHERE a.owner_scope = 'local' AND a.task_type = ?`,
    )
    .get(task) as Row | undefined;
  if (!row || !hasRequiredCapability(row, task))
    throw new ContentValidationError(
      task === "TRANSCRIPTION"
        ? "TRANSCRIPTION_PROVIDER_UNAVAILABLE"
        : "ANALYSIS_PROVIDER_UNAVAILABLE",
      task === "TRANSCRIPTION"
        ? "Configure a connected transcription provider with timestamped segments in Settings."
        : "Configure a connected text-analysis provider with JSON output in Settings.",
    );
  return row;
}

export function clippingPreflight(db: Database.Database): Row {
  return preflight(db);
}

export async function uploadSource(
  db: Database.Database,
  settings: ClippingSettings,
  contentId: string,
  buffer: Buffer,
  filename: string | undefined,
  mimeType: string | undefined,
  title?: unknown,
  notes?: unknown,
): Promise<Row> {
  const content = contentRow(db, contentId);
  if (buffer.byteLength > settings.maxUploadBytes)
    throw new ContentValidationError(
      "UPLOAD_TOO_LARGE",
      "The source video exceeds the configured upload limit.",
    );
  if (!buffer.byteLength)
    throw new ContentValidationError(
      "EMPTY_UPLOAD",
      "The source video is empty.",
    );
  const directory = contentDirectory(
    settings.contentStorageDirectory,
    contentId,
  );
  const sourceId = id();
  const extension =
    path
      .extname(filename ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9.]/g, "")
      .slice(0, 8) || ".mp4";
  const sourcePath = path.join(directory, `source-${sourceId}${extension}`);
  await fsp.writeFile(sourcePath, buffer);
  let info: Awaited<ReturnType<typeof probeMedia>>;
  try {
    info = await probeMedia(settings.ffprobePath, sourcePath);
  } catch (error) {
    await fsp.rm(sourcePath, { force: true });
    throw error;
  }
  if (!info.hasAudio) {
    await fsp.rm(sourcePath, { force: true });
    throw new ContentValidationError(
      "MISSING_AUDIO",
      "The source video must contain an audio track.",
    );
  }
  const metadata = await fileMetadata(sourcePath);
  const timestamp = now();
  const previous = db
    .prepare("SELECT id FROM long_video_sources WHERE content_id = ?")
    .get(contentId) as Row | undefined;
  db.transaction(() => {
    if (previous)
      db.prepare("DELETE FROM long_video_sources WHERE id = ?").run(
        previous.id,
      );
    db.prepare(
      `INSERT INTO long_video_sources(id, content_id, source_path, original_filename, mime_type, source_hash, duration_ms, width, height, title, notes, status, processing_stage, processing_progress, wizard_step, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploaded', 'uploaded', 0, 2, ?, ?, ?)`,
    ).run(
      sourceId,
      contentId,
      sourcePath,
      String(filename ?? "source-video").slice(0, 240),
      String(mimeType ?? "video/mp4").slice(0, 100),
      metadata.sha256,
      info.durationMs,
      info.width,
      info.height,
      typeof title === "string" ? title.trim().slice(0, 200) || null : null,
      typeof notes === "string" ? notes.trim().slice(0, 2000) || null : null,
      JSON.stringify({ format: info.format, size: metadata.size }),
      timestamp,
      timestamp,
    );
    db.prepare(
      "UPDATE content_items SET status = 'draft', error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ?",
    ).run(timestamp, contentId);
  })();
  return publicSource(sourceRow(db, contentId));
}

export function queueClippingJob(
  db: Database.Database,
  contentId: string,
  jobType: ClipJobType,
  input: Row = {},
): Row {
  const source = sourceRow(db, contentId);
  const existing = db
    .prepare(
      "SELECT * FROM clipping_jobs WHERE content_id = ? AND job_type = ? AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1",
    )
    .get(contentId, jobType) as Row | undefined;
  if (existing) return existing;
  const timestamp = now();
  const jobId = id();
  db.prepare(
    "INSERT INTO clipping_jobs(id, content_id, source_id, job_type, status, progress, input_json, created_at) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?)",
  ).run(jobId, contentId, source.id, jobType, JSON.stringify(input), timestamp);
  db.prepare(
    "UPDATE long_video_sources SET status = 'processing', processing_stage = ?, processing_progress = 0, error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ?",
  ).run(jobType, timestamp, source.id);
  db.prepare(
    "UPDATE content_items SET status = 'generating', error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ?",
  ).run(timestamp, contentId);
  return db
    .prepare("SELECT * FROM clipping_jobs WHERE id = ?")
    .get(jobId) as Row;
}

function selectionRows(db: Database.Database, contentId: string): Row[] {
  return db
    .prepare(
      `SELECT cs.*, ss.title AS subtopic_title, ss.summary AS subtopic_summary, ss.start_ms, ss.end_ms, ss.topic_id, t.title AS topic_title, t.summary AS topic_summary, t.position AS topic_position, s.duration_ms FROM clip_selections cs JOIN video_subtopics ss ON ss.id = cs.subtopic_id JOIN video_topics t ON t.id = ss.topic_id JOIN long_video_sources s ON s.id = t.source_id WHERE cs.content_id = ? ORDER BY t.position, ss.position`,
    )
    .all(contentId) as Row[];
}

function settingsForSelection(
  db: Database.Database,
  selectionId: string,
): ClipSettings {
  const row = db
    .prepare(
      "SELECT settings_json FROM clip_render_settings WHERE clip_selection_id = ? ORDER BY version DESC LIMIT 1",
    )
    .get(selectionId) as Row | undefined;
  return normalizeClipSettings(
    parseJson(row?.settings_json, DEFAULT_CLIP_SETTINGS),
  );
}

export function clippingSnapshot(
  db: Database.Database,
  contentId: string,
): Row {
  const content = contentRow(db, contentId);
  const source = db
    .prepare("SELECT * FROM long_video_sources WHERE content_id = ?")
    .get(contentId) as Row | undefined;
  const transcript = source
    ? (db
        .prepare("SELECT * FROM transcripts WHERE source_id = ?")
        .get(source.id) as Row | undefined)
    : undefined;
  const topics = source
    ? (
        db
          .prepare(
            "SELECT * FROM video_topics WHERE source_id = ? ORDER BY position",
          )
          .all(source.id) as Row[]
      ).map((topic) => ({
        id: topic.id,
        position: topic.position,
        title: topic.title,
        summary: topic.summary,
        startMs: topic.start_ms,
        endMs: topic.end_ms,
        confidence: topic.confidence,
        selectionState: "unselected",
        subtopics: (
          db
            .prepare(
              `SELECT ss.*, COALESCE(cs.selected, 0) AS selected FROM video_subtopics ss LEFT JOIN clip_selections cs ON cs.subtopic_id = ss.id AND cs.content_id = ? WHERE ss.topic_id = ? ORDER BY ss.position`,
            )
            .all(contentId, topic.id) as Row[]
        ).map((subtopic) => ({
          id: subtopic.id,
          position: subtopic.position,
          title: subtopic.title,
          summary: subtopic.summary,
          startMs: subtopic.start_ms,
          endMs: subtopic.end_ms,
          confidence: subtopic.confidence,
          selected: Boolean(subtopic.selected),
          previewStatus: subtopic.preview_status,
        })),
      }))
    : [];
  for (const topic of topics) {
    const selected = topic.subtopics.map((child: Row) => child.selected);
    topic.selectionState =
      selected.length && selected.every(Boolean)
        ? "selected"
        : selected.some(Boolean)
          ? "partial"
          : "unselected";
  }
  const selections = selectionRows(db, contentId).map((row) => ({
    id: row.id,
    subtopicId: row.subtopic_id,
    selected: Boolean(row.selected),
    topicId: row.topic_id,
    topicTitle: row.topic_title,
    subtopicTitle: row.subtopic_title,
    startMs: row.start_ms,
    endMs: row.end_ms,
    settings: settingsForSelection(db, row.id),
  }));
  const jobs = (
    db
      .prepare(
        "SELECT * FROM clipping_jobs WHERE content_id = ? ORDER BY created_at DESC LIMIT 20",
      )
      .all(contentId) as Row[]
  ).map(jobSnapshot);
  const batches = (
    db
      .prepare(
        "SELECT * FROM clip_render_batches WHERE content_id = ? ORDER BY created_at DESC LIMIT 10",
      )
      .all(contentId) as Row[]
  ).map((batch) => ({
    id: batch.id,
    status: batch.status,
    totalCount: batch.total_count,
    completedCount: batch.completed_count,
    failedCount: batch.failed_count,
    createdAt: batch.created_at,
    updatedAt: batch.updated_at,
    clips: (
      db
        .prepare(
          "SELECT * FROM rendered_clips WHERE render_batch_id = ? ORDER BY created_at",
        )
        .all(batch.id) as Row[]
    ).map((clip) => ({
      id: clip.id,
      status: clip.status,
      subtopicId: clip.subtopic_id,
      topicId: clip.topic_id,
      originalStartMs: clip.original_start_ms,
      originalEndMs: clip.original_end_ms,
      finalDurationMs: clip.final_duration_ms,
      fileSizeBytes: clip.file_size_bytes,
      width: clip.width,
      height: clip.height,
      mimeType: clip.mime_type,
      errorCode: clip.error_code,
      errorMessage: clip.error_message,
      previewUrl:
        clip.status === "completed"
          ? `/api/clipping/rendered/${clip.id}/preview`
          : null,
      downloadUrl:
        clip.status === "completed"
          ? `/api/clipping/rendered/${clip.id}/download`
          : null,
    })),
  }));
  return {
    contentId: content.id,
    status: content.status,
    title: content.title,
    source: source ? publicSource(source) : null,
    transcript: transcript
      ? {
          id: transcript.id,
          language: transcript.language,
          text: transcript.text,
          wordTimestamps: Boolean(transcript.word_timestamps),
          providerType: transcript.provider_type,
          modelName: transcript.model_name,
          createdAt: transcript.created_at,
        }
      : null,
    topics,
    selections,
    jobs,
    batches,
    preflight: clippingPreflight(db),
    assignments: assignmentSnapshot(db),
  };
}

export function updateWizardStep(
  db: Database.Database,
  contentId: string,
  step: number,
): Row {
  const source = sourceRow(db, contentId);
  const next = Math.max(1, Math.min(7, Math.round(step)));
  db.prepare(
    "UPDATE long_video_sources SET wizard_step = ?, updated_at = ? WHERE id = ?",
  ).run(next, now(), source.id);
  return clippingSnapshot(db, contentId);
}

export function setTopicSelection(
  db: Database.Database,
  contentId: string,
  topicId: string,
  selected: boolean,
): Row {
  contentRow(db, contentId);
  const topic = db
    .prepare(
      "SELECT id FROM video_topics WHERE id = ? AND source_id = (SELECT id FROM long_video_sources WHERE content_id = ?)",
    )
    .get(topicId, contentId) as Row | undefined;
  if (!topic)
    throw new ContentValidationError(
      "TOPIC_NOT_FOUND",
      "Topic not found for this clipping source.",
    );
  const children = db
    .prepare("SELECT id FROM video_subtopics WHERE topic_id = ?")
    .all(topicId) as Row[];
  const timestamp = now();
  db.transaction(() => {
    for (const child of children)
      db.prepare(
        `INSERT INTO clip_selections(id, content_id, subtopic_id, selected, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(content_id, subtopic_id) DO UPDATE SET selected = excluded.selected, updated_at = excluded.updated_at`,
      ).run(id(), contentId, child.id, selected ? 1 : 0, timestamp, timestamp);
    db.prepare(
      "UPDATE long_video_sources SET wizard_step = 4, updated_at = ? WHERE content_id = ?",
    ).run(timestamp, contentId);
  })();
  return clippingSnapshot(db, contentId);
}

export function setSubtopicSelection(
  db: Database.Database,
  contentId: string,
  subtopicId: string,
  selected: boolean,
): Row {
  contentRow(db, contentId);
  const child = db
    .prepare(
      "SELECT ss.id FROM video_subtopics ss JOIN video_topics t ON t.id = ss.topic_id JOIN long_video_sources s ON s.id = t.source_id WHERE ss.id = ? AND s.content_id = ?",
    )
    .get(subtopicId, contentId) as Row | undefined;
  if (!child)
    throw new ContentValidationError(
      "SUBTOPIC_NOT_FOUND",
      "Clip candidate not found for this clipping source.",
    );
  const timestamp = now();
  db.prepare(
    `INSERT INTO clip_selections(id, content_id, subtopic_id, selected, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(content_id, subtopic_id) DO UPDATE SET selected = excluded.selected, updated_at = excluded.updated_at`,
  ).run(id(), contentId, subtopicId, selected ? 1 : 0, timestamp, timestamp);
  return clippingSnapshot(db, contentId);
}

export function updateSelectionSettings(
  db: Database.Database,
  contentId: string,
  subtopicId: string,
  input: unknown,
): Row {
  contentRow(db, contentId);
  const selection = db
    .prepare(
      "SELECT id FROM clip_selections WHERE content_id = ? AND subtopic_id = ?",
    )
    .get(contentId, subtopicId) as Row | undefined;
  if (!selection)
    throw new ContentValidationError(
      "SELECTION_NOT_FOUND",
      "Select this clip candidate before editing its settings.",
    );
  const current = settingsForSelection(db, selection.id);
  const settings = normalizeClipSettings(input, current);
  const timestamp = now();
  const latest = db
    .prepare(
      "SELECT COALESCE(MAX(version), 0) AS version FROM clip_render_settings WHERE clip_selection_id = ?",
    )
    .get(selection.id) as Row;
  db.prepare(
    "INSERT INTO clip_render_settings(id, clip_selection_id, version, settings_json, fingerprint, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id(),
    selection.id,
    Number(latest.version) + 1,
    JSON.stringify(settings),
    settingsFingerprint(settings),
    timestamp,
    timestamp,
  );
  db.prepare(
    "UPDATE long_video_sources SET wizard_step = 5, updated_at = ? WHERE content_id = ?",
  ).run(timestamp, contentId);
  return clippingSnapshot(db, contentId);
}

export function applySettingsToAll(
  db: Database.Database,
  contentId: string,
  subtopicId: string,
): Row {
  const selection = db
    .prepare(
      "SELECT id FROM clip_selections WHERE content_id = ? AND subtopic_id = ?",
    )
    .get(contentId, subtopicId) as Row | undefined;
  if (!selection)
    throw new ContentValidationError(
      "SELECTION_NOT_FOUND",
      "Select a source clip before applying settings.",
    );
  const settings = settingsForSelection(db, selection.id);
  const selected = selectionRows(db, contentId).filter((row) => row.selected);
  const timestamp = now();
  db.transaction(() => {
    for (const row of selected) {
      const latest = db
        .prepare(
          "SELECT COALESCE(MAX(version), 0) AS version FROM clip_render_settings WHERE clip_selection_id = ?",
        )
        .get(row.id) as Row;
      db.prepare(
        "INSERT INTO clip_render_settings(id, clip_selection_id, version, settings_json, fingerprint, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        id(),
        row.id,
        Number(latest.version) + 1,
        JSON.stringify(settings),
        settingsFingerprint(settings),
        timestamp,
        timestamp,
      );
    }
  })();
  return clippingSnapshot(db, contentId);
}

export function startAnalysis(
  db: Database.Database,
  contentId: string,
  force = false,
): Row {
  contentRow(db, contentId);
  const source = sourceRow(db, contentId);
  if (!force) {
    const active = db
      .prepare(
        "SELECT * FROM clipping_jobs WHERE content_id = ? AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1",
      )
      .get(contentId) as Row | undefined;
    if (active) return active;
    const completedAnalysis = db
      .prepare(
        "SELECT j.* FROM clipping_jobs j WHERE j.content_id = ? AND j.job_type = 'subtopic_detection' AND j.status = 'completed' AND EXISTS (SELECT 1 FROM transcripts t WHERE t.source_id = j.source_id) AND EXISTS (SELECT 1 FROM video_topics vt WHERE vt.source_id = j.source_id AND vt.analysis_version = ? AND vt.prompt_version = ?) ORDER BY j.created_at DESC LIMIT 1",
      )
      .get(contentId, TOPIC_ANALYSIS_VERSION, TOPIC_PROMPT_VERSION) as
      | Row
      | undefined;
    if (source.status === "ready" && completedAnalysis)
      return completedAnalysis;
  }
  providerForTask(db, "TRANSCRIPTION");
  const transcript = db
    .prepare("SELECT id FROM transcripts WHERE source_id = ?")
    .get(source.id) as Row | undefined;
  providerForTask(db, "TOPIC_DETECTION");
  if (source.status === "ready" && transcript)
    return queueClippingJob(db, contentId, "topic_detection");
  return queueClippingJob(db, contentId, "audio_extraction");
}

export function startRenderBatch(
  db: Database.Database,
  contentId: string,
  settings: { onlySelectionIds?: string[] } = {},
): Row {
  const source = sourceRow(db, contentId);
  const filter =
    Array.isArray(settings.onlySelectionIds) && settings.onlySelectionIds.length
      ? settings.onlySelectionIds
      : null;
  const selected = selectionRows(db, contentId).filter(
    (row) =>
      row.selected && (!filter || settings.onlySelectionIds!.includes(row.id)),
  );
  if (!selected.length)
    throw new ContentValidationError(
      "NO_SELECTED_CLIPS",
      "Select at least one clip candidate to render.",
    );
  const batchId = id();
  const timestamp = now();
  db.prepare(
    "INSERT INTO clip_render_batches(id, content_id, status, total_count, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?, ?)",
  ).run(batchId, contentId, selected.length, timestamp, timestamp);
  const job = queueClippingJob(db, contentId, "render_batch", {
    batchId,
    selectionIds: selected.map((row) => row.id),
  });
  return { ...job, batchId, totalCount: selected.length, sourceId: source.id };
}

async function persistTranscript(
  db: Database.Database,
  source: Row,
  provider: Row,
  result: Awaited<ReturnType<typeof transcribe>>,
  audioHash: string,
): Promise<void> {
  const transcriptId = id();
  const timestamp = now();
  const fingerprint = crypto
    .createHash("sha256")
    .update(
      `${audioHash}:${provider.id}:${provider.model_name ?? provider.transcription_model ?? ""}:transcript-v1`,
    )
    .digest("hex");
  db.transaction(() => {
    db.prepare("DELETE FROM transcripts WHERE source_id = ?").run(source.id);
    db.prepare(
      "INSERT INTO transcripts(id, source_id, provider_connection_id, provider_type, model_name, language, text, word_timestamps, source_audio_hash, fingerprint, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      transcriptId,
      source.id,
      provider.id,
      provider.provider_type,
      provider.transcription_model,
      result.language ?? null,
      result.text,
      result.wordTimestamps ? 1 : 0,
      audioHash,
      fingerprint,
      timestamp,
      timestamp,
    );
    const insertSegment = db.prepare(
      "INSERT INTO transcript_segments(id, transcript_id, position, start_ms, end_ms, text) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const insertWord = db.prepare(
      "INSERT INTO transcript_words(id, transcript_id, segment_id, position, start_ms, end_ms, text) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    let wordPosition = 0;
    result.segments.forEach((segment, segmentIndex) => {
      const segmentId = id();
      insertSegment.run(
        segmentId,
        transcriptId,
        segmentIndex,
        segment.startMs,
        segment.endMs,
        segment.text,
      );
      for (const word of segment.words)
        insertWord.run(
          id(),
          transcriptId,
          segmentId,
          wordPosition++,
          word.startMs,
          word.endMs,
          word.text,
        );
    });
  })();
}

interface AnalysisResponse {
  topics?: Array<{
    title: string;
    summary?: string;
    startMs?: number;
    endMs?: number;
    confidence?: number;
    subtopics?: Array<{
      title: string;
      summary?: string;
      startMs?: number;
      endMs?: number;
      confidence?: number;
    }>;
  }>;
}

function finiteMilliseconds(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : undefined;
}

function readableAnalysisText(value: unknown): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (
    !text ||
    /^(topic|clip|additional discussion)(?:\s+\d+)?$/i.test(text) ||
    /^additional discussion from the source transcript\.?$/i.test(text)
  )
    return "";
  return text.slice(0, 200);
}

function truncateAnalysisText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const shortened = value.slice(0, Math.max(1, maxLength - 1));
  const boundary = shortened.lastIndexOf(" ");
  return `${shortened.slice(0, boundary > maxLength * 0.55 ? boundary : shortened.length)}…`;
}

function normalizedWords(value: string): string[] {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function isLikelyTranscriptCopy(value: string, excerpt: string): boolean {
  if (value.length < 80 || !excerpt) return false;
  const candidateWords = normalizedWords(value);
  const excerptWords = normalizedWords(excerpt);
  if (candidateWords.length < 10 || excerptWords.length < 10) return false;
  const excerptSet = new Set(excerptWords);
  const overlap = candidateWords.filter((word) => excerptSet.has(word)).length;
  return (
    excerpt.includes(value) ||
    value.includes(excerpt) ||
    overlap / candidateWords.length >= 0.8
  );
}

function meaningfulAnalysisText(
  value: unknown,
  transcriptExcerptText: string,
  maxLength: number,
): string {
  const text = readableAnalysisText(value);
  if (!text || isLikelyTranscriptCopy(text, transcriptExcerptText)) return "";
  return truncateAnalysisText(text, maxLength);
}

function transcriptTitle(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return "";
  return truncateAnalysisText(text.split(/(?<=[.!?])\s+/)[0] || text, 100);
}

function shortExcerptTitle(value: string): string {
  const words = value.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length) return "";
  return `${words.slice(0, 8).join(" ")}${words.length > 8 ? "…" : ""}`;
}

function transcriptExcerpt(
  segments: Row[],
  startMs: number,
  endMs: number,
): string {
  return segments
    .filter(
      (segment) =>
        Number(segment.end_ms) > startMs && Number(segment.start_ms) < endMs,
    )
    .map((segment) => String(segment.text ?? "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

type AnalysisTopic = NonNullable<AnalysisResponse["topics"]>[number];
type AnalysisChild = NonNullable<AnalysisTopic["subtopics"]>[number];
type ClipRange = { startMs: number; endMs: number };
type TopicPart = {
  topic: AnalysisTopic;
  children: AnalysisChild[];
  startMs: number;
  endMs: number;
  partNumber: number;
  partCount: number;
};

function normalizeClipRangeWithin(
  startMs: number,
  endMs: number,
  lowerBoundMs: number,
  upperBoundMs: number,
): ClipRange {
  const lowerBound = Math.max(0, Math.round(lowerBoundMs));
  const upperBound = Math.max(lowerBound + 1, Math.round(upperBoundMs));
  let start = Math.max(lowerBound, Math.min(upperBound, Math.round(startMs)));
  let end = Math.max(lowerBound, Math.min(upperBound, Math.round(endMs)));
  if (end <= start) end = Math.min(upperBound, start + MIN_CLIP_DURATION_MS);
  if (end <= start) start = Math.max(lowerBound, end - MIN_CLIP_DURATION_MS);
  const availableDuration = upperBound - lowerBound;
  if (availableDuration <= MIN_CLIP_DURATION_MS)
    return { startMs: lowerBound, endMs: upperBound };
  const targetDuration = Math.min(
    availableDuration,
    Math.max(MIN_CLIP_DURATION_MS, Math.min(MAX_CLIP_DURATION_MS, end - start)),
  );
  const center = (start + end) / 2;
  const normalizedStart = Math.max(
    lowerBound,
    Math.min(
      upperBound - targetDuration,
      Math.round(center - targetDuration / 2),
    ),
  );
  return {
    startMs: normalizedStart,
    endMs: normalizedStart + targetDuration,
  };
}

function fallbackClipRanges(startMs: number, endMs: number): ClipRange[] {
  const duration = Math.max(0, endMs - startMs);
  if (!duration) return [];
  if (duration <= MIN_CLIP_DURATION_MS)
    return [{ startMs, endMs }];
  const minimumCount = Math.max(1, Math.ceil(duration / MAX_CLIP_DURATION_MS));
  const maximumCount = Math.max(1, Math.floor(duration / MIN_CLIP_DURATION_MS));
  const count = Math.min(
    maximumCount,
    Math.max(minimumCount, Math.round(duration / TARGET_CLIP_DURATION_MS)),
  );
  return Array.from({ length: count }, (_, index) => ({
    startMs: startMs + Math.round((duration * index) / count),
    endMs: startMs + Math.round((duration * (index + 1)) / count),
  })).filter((range) => range.endMs > range.startMs);
}

function fallbackChild(range: ClipRange): AnalysisChild {
  return {
    title: "",
    summary: "",
    startMs: range.startMs,
    endMs: range.endMs,
    confidence: 0.35,
  };
}

function fillClipGaps(
  startMs: number,
  endMs: number,
  candidates: Array<{ child: AnalysisChild; range: ClipRange }>,
): Array<{ child: AnalysisChild; range: ClipRange }> {
  const sorted = candidates
    .slice()
    .sort((left, right) => left.range.startMs - right.range.startMs);
  if (!sorted.length)
    return fallbackClipRanges(startMs, endMs).map((range) => ({
      child: fallbackChild(range),
      range,
    }));
  const result: Array<{ child: AnalysisChild; range: ClipRange }> = [];
  let cursor = startMs;
  for (const candidate of sorted) {
    if (candidate.range.startMs - cursor >= 15_000)
      for (const range of fallbackClipRanges(cursor, candidate.range.startMs))
        result.push({ child: fallbackChild(range), range });
    result.push(candidate);
    cursor = Math.max(cursor, candidate.range.endMs);
  }
  if (endMs - cursor >= 15_000)
    for (const range of fallbackClipRanges(cursor, endMs))
      result.push({ child: fallbackChild(range), range });
  return result.slice(0, 30);
}

function buildTopicParts(
  topics: AnalysisTopic[],
  sourceDurationMs: number,
): TopicPart[] {
  const parts: TopicPart[] = [];
  const minimumTopicDuration = Math.min(sourceDurationMs, MIN_TOPIC_DURATION_MS);
  let cursor = 0;
  const appendParts = (
    topic: AnalysisTopic,
    children: AnalysisChild[],
    startMs: number,
    endMs: number,
  ): void => {
    const duration = Math.max(1, endMs - startMs);
    const partCount = Math.max(1, Math.ceil(duration / MAX_TOPIC_DURATION_MS));
    for (let index = 0; index < partCount; index += 1) {
      parts.push({
        topic,
        children,
        startMs: startMs + Math.round((duration * index) / partCount),
        endMs: startMs + Math.round((duration * (index + 1)) / partCount),
        partNumber: index + 1,
        partCount,
      });
    }
  };
  for (const topic of topics.slice(0, 50)) {
    const rawStart = finiteMilliseconds(topic.startMs);
    const rawEnd = finiteMilliseconds(topic.endMs);
    let startMs = Math.max(
      cursor,
      Math.min(sourceDurationMs, rawStart ?? cursor),
    );
    let endMs = Math.max(
      startMs,
      Math.min(sourceDurationMs, rawEnd ?? startMs + minimumTopicDuration),
    );
    if (endMs - startMs < minimumTopicDuration)
      endMs = Math.min(sourceDurationMs, startMs + minimumTopicDuration);
    if (endMs <= startMs) continue;
    const children = Array.isArray(topic.subtopics)
      ? topic.subtopics
      : [];
    appendParts(topic, children, startMs, endMs);
    cursor = endMs;
    if (cursor >= sourceDurationMs) break;
  }
  return parts.filter((part) => part.endMs > part.startMs);
}

async function persistAnalysis(
  db: Database.Database,
  source: Row,
  response: AnalysisResponse,
  provider: Row,
): Promise<void> {
  const transcript = db
    .prepare("SELECT * FROM transcripts WHERE source_id = ?")
    .get(source.id) as Row | undefined;
  if (!transcript)
    throw new ContentValidationError(
      "TRANSCRIPT_NOT_FOUND",
      "A transcript is required before topic analysis.",
    );
  const topics = Array.isArray(response.topics) ? response.topics : [];
  if (!topics.length)
    throw new ContentValidationError(
      "INVALID_ANALYSIS_RESULT",
      "The analysis provider returned no valid topics.",
    );
  const transcriptSegments = db
    .prepare(
      "SELECT start_ms, end_ms, text FROM transcript_segments WHERE transcript_id = ? ORDER BY position",
    )
    .all(transcript.id) as Row[];
  const sourceDurationMs = Math.max(1, Number(source.duration_ms));
  const timestamp = now();
  const topicParts = buildTopicParts(topics, sourceDurationMs);
  db.transaction(() => {
    db.prepare("DELETE FROM video_topics WHERE source_id = ?").run(source.id);
    const insertTopic = db.prepare(
      "INSERT INTO video_topics(id, source_id, position, title, summary, start_ms, end_ms, confidence, analysis_version, prompt_version, fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const insertSubtopic = db.prepare(
      "INSERT INTO video_subtopics(id, topic_id, position, title, summary, start_ms, end_ms, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const insertSelection = db.prepare(
      "INSERT INTO clip_selections(id, content_id, subtopic_id, selected, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
    );
    topicParts.forEach((part, topicIndex) => {
      const topic = part.topic;
      const startMs = part.startMs;
      const endMs = part.endMs;
      const sourceChildren = part.children.length
        ? part.children
        : [
            {
              title: topic.title,
              summary: topic.summary,
              startMs: topic.startMs,
              endMs: topic.endMs,
              confidence: topic.confidence,
            },
          ];
      const candidates = sourceChildren.slice(0, 30).flatMap((child) => {
        const rawChildStart =
          finiteMilliseconds(child.startMs) ?? startMs;
        const rawChildEnd = finiteMilliseconds(child.endMs) ?? endMs;
        if (rawChildEnd <= startMs || rawChildStart >= endMs) return [];
        const range = normalizeClipRangeWithin(
          rawChildStart,
          rawChildEnd,
          startMs,
          endMs,
        );
        return [{ child, range }];
      });
      const normalizedChildren = fillClipGaps(startMs, endMs, candidates).filter(
        ({ child, range }) => {
          const hasMeaningfulLabel = Boolean(
            readableAnalysisText(child.title) ||
              readableAnalysisText(child.summary),
          );
          if (hasMeaningfulLabel) return true;
          const excerpt = transcriptExcerpt(
            transcriptSegments,
            range.startMs,
            range.endMs,
          );
          return excerpt.split(/\s+/).filter(Boolean).length >= 4;
        },
      );
      validateClipBounds(startMs, endMs, source.duration_ms);
      const topicId = id();
      const topicExcerpt = transcriptExcerpt(
        transcriptSegments,
        startMs,
        endMs,
      );
      const topicTitle =
        meaningfulAnalysisText(topic.title, topicExcerpt, 100) ||
        meaningfulAnalysisText(topic.summary, topicExcerpt, 100) ||
        shortExcerptTitle(topicExcerpt) ||
        "Key discussion";
      const displayedTopicTitle =
        part.partCount > 1
          ? `${topicTitle} · Part ${part.partNumber}`
          : topicTitle;
      const topicSummary =
        meaningfulAnalysisText(topic.summary, topicExcerpt, 220) ||
        (topicTitle === "Key discussion"
          ? null
          : `Discussion focused on ${topicTitle}.`);
      insertTopic.run(
        topicId,
        source.id,
        topicIndex,
        displayedTopicTitle,
        topicSummary,
        startMs,
        endMs,
        Number.isFinite(Number(topic.confidence))
          ? Number(topic.confidence)
          : null,
        TOPIC_ANALYSIS_VERSION,
        TOPIC_PROMPT_VERSION,
        crypto
          .createHash("sha256")
          .update(`${source.source_hash}:${topicId}`)
          .digest("hex"),
      );
      normalizedChildren.forEach(({ child, range }, childIndex) => {
        const childStart = range.startMs;
        const childEnd = range.endMs;
        validateClipBounds(childStart, childEnd, source.duration_ms);
        const subtopicId = id();
        const childExcerpt = transcriptExcerpt(
          transcriptSegments,
          childStart,
          childEnd,
        );
        const childTitle =
          meaningfulAnalysisText(child.title, childExcerpt, 100) ||
          transcriptTitle(childExcerpt) ||
          `Key point from ${displayedTopicTitle}`;
        const childSummary =
          meaningfulAnalysisText(child.summary, childExcerpt, 220) ||
          topicSummary ||
          `A highlight from ${displayedTopicTitle}.`;
        insertSubtopic.run(
          subtopicId,
          topicId,
          childIndex,
          childTitle,
          childSummary,
          childStart,
          childEnd,
          Number.isFinite(Number(child.confidence))
            ? Number(child.confidence)
            : null,
        );
        insertSelection.run(
          id(),
          source.content_id,
          subtopicId,
          timestamp,
          timestamp,
        );
      });
    });
  })();
}

async function runJob(
  db: Database.Database,
  job: Row,
  settings: ClippingSettings,
): Promise<Row> {
  const source = sourceRow(db, job.content_id);
  const directory = contentDirectory(
    settings.contentStorageDirectory,
    job.content_id,
  );
  const update = (stage: string, progress: number) =>
    db
      .prepare(
        "UPDATE long_video_sources SET processing_stage = ?, processing_progress = ?, updated_at = ? WHERE id = ?",
      )
      .run(stage, progress, now(), source.id);
  if (job.job_type === "audio_extraction") {
    const audioPath = path.join(directory, CLIPPING_AUDIO_FILENAME);
    await extractAudio(settings.ffmpegPath, source.source_path, audioPath);
    await fsp.rm(path.join(directory, "audio-16k.wav"), { force: true });
    const meta = await fileMetadata(audioPath);
    db.prepare(
      "UPDATE long_video_sources SET audio_hash = ?, processing_stage = 'audio_extracted', processing_progress = 20, updated_at = ? WHERE id = ?",
    ).run(meta.sha256, now(), source.id);
    queueClippingJob(db, job.content_id, "transcription");
    return { audioHash: meta.sha256 };
  }
  if (job.job_type === "transcription") {
    update("transcribing", 35);
    const provider = providerForTask(db, "TRANSCRIPTION");
    const audioPath = path.join(directory, CLIPPING_AUDIO_FILENAME);
    const started = Date.now();
    try {
      const result = await transcribeAudio(
        provider,
        settings.secretsEncryptionKey,
        audioPath,
        source.duration_ms,
        settings.ffmpegPath,
        directory,
        (progress) => update("transcribing", progress),
      );
      const meta = await fileMetadata(audioPath);
      await persistTranscript(db, source, provider, result, meta.sha256);
      touchRequest(db, provider.id, "TRANSCRIPTION", "completed", {
        modelName: transcriptionModelForClipping(provider),
        audioDurationMs: source.duration_ms,
        latencyMs: Date.now() - started,
      });
      queueClippingJob(db, job.content_id, "topic_detection");
      return {
        segmentCount: result.segments.length,
        wordCount: result.words.length,
      };
    } catch (error) {
      const safe = normalizeProviderError(error);
      touchRequest(db, provider.id, "TRANSCRIPTION", "failed", {
        modelName: transcriptionModelForClipping(provider),
        errorCode: safe.code,
        latencyMs: Date.now() - started,
      });
      throw new ContentValidationError(safe.code, safe.message);
    }
  }
  if (job.job_type === "topic_detection") {
    update("detecting_topics", 60);
    const provider = providerForTask(db, "TOPIC_DETECTION");
    const transcript = db
      .prepare("SELECT * FROM transcripts WHERE source_id = ?")
      .get(source.id) as Row | undefined;
    if (!transcript)
      throw new ContentValidationError(
        "TRANSCRIPT_NOT_FOUND",
        "Transcription must complete before topic detection.",
      );
    const segments = db
      .prepare(
        "SELECT start_ms, end_ms, text FROM transcript_segments WHERE transcript_id = ? ORDER BY position",
      )
      .all(transcript.id) as Row[];
    const prompt = segments
      .map(
        (segment) => `[${segment.start_ms}-${segment.end_ms}] ${segment.text}`,
      )
      .join("\n")
      .slice(0, 180_000);
    const started = Date.now();
    try {
      const response = await structuredAnalysis<AnalysisResponse>(
        provider,
        settings.secretsEncryptionKey,
        {
          schemaName: "video_topic_tree",
          system:
            "Return JSON matching the requested schema. Identify broad semantic main topics and clip-worthy subtopics from the timestamped spoken transcript. A topic is a meaningful section of the discussion, not a single sentence or a few-second fragment; when the transcript supports it, make topics roughly 5 to 15 minutes long and avoid topics that span unrelated parts of the video. Every topic needs a concise editorial title (3 to 100 characters) and a brief 1-2 sentence summary (no more than 220 characters), plus startMs and endMs. Every clip needs its own concise editorial title and brief summary of the idea, not a transcript quotation. Never copy a sentence or paragraph verbatim from the transcript into a title or summary. Every clip must be completely inside its parent topic range; set each topic range to contain all of its clips. Prefer coherent clips of at least 2 minutes and about 2 minutes when possible, never return isolated 1 to 4 second fragments. Within a topic, return enough distinct clips to cover the meaningful discussion instead of only the first and last sentence; do not leave very large unexplained gaps. Use transcript timestamps, keep all ranges inside the source duration, and do not use generic labels such as Topic 1, Clip 1, or Additional discussion. Do not invent unsupported claims.",
          user: `Source duration: ${source.duration_ms}ms\nTranscript:\n${prompt}`,
        },
      );
      await persistAnalysis(db, source, response, provider);
      touchRequest(db, provider.id, "TOPIC_DETECTION", "completed", {
        modelName: provider.model_name,
        latencyMs: Date.now() - started,
      });
      queueClippingJob(db, job.content_id, "subtopic_detection");
      return { topicCount: response.topics?.length ?? 0 };
    } catch (error) {
      const safe = normalizeProviderError(error);
      touchRequest(db, provider.id, "TOPIC_DETECTION", "failed", {
        modelName: provider.model_name,
        errorCode: safe.code,
        latencyMs: Date.now() - started,
      });
      throw new ContentValidationError(safe.code, safe.message);
    }
  }
  if (job.job_type === "subtopic_detection") {
    update("ready", 100);
    db.prepare(
      "UPDATE long_video_sources SET status = 'ready', processing_stage = 'ready', processing_progress = 100, wizard_step = 4, updated_at = ? WHERE id = ?",
    ).run(now(), source.id);
    db.prepare(
      "UPDATE content_items SET status = 'draft', updated_at = ? WHERE id = ?",
    ).run(now(), job.content_id);
    return {
      subtopicCount: (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM video_subtopics WHERE topic_id IN (SELECT id FROM video_topics WHERE source_id = ?)",
          )
          .get(source.id) as Row
      ).count,
    };
  }
  if (job.job_type === "render_batch")
    return runRenderBatch(db, settings, job, source);
  throw new ContentValidationError(
    "UNSUPPORTED_CLIPPING_JOB",
    "Unsupported clipping job.",
  );
}

async function runRenderBatch(
  db: Database.Database,
  settings: ClippingSettings,
  job: Row,
  source: Row,
): Promise<Row> {
  const input = parseJson<{ batchId: string; selectionIds?: string[] }>(
    job.input_json,
    { batchId: "" },
  );
  const batch = db
    .prepare(
      "SELECT * FROM clip_render_batches WHERE id = ? AND content_id = ?",
    )
    .get(input.batchId, job.content_id) as Row | undefined;
  if (!batch)
    throw new ContentValidationError(
      "RENDER_BATCH_NOT_FOUND",
      "Render batch not found.",
    );
  const rows = selectionRows(db, job.content_id).filter(
    (row) =>
      row.selected &&
      (!input.selectionIds?.length || input.selectionIds.includes(row.id)),
  );
  const transcript = db
    .prepare("SELECT id FROM transcripts WHERE source_id = ?")
    .get(source.id) as Row | undefined;
  const words = transcript
    ? (
        db
          .prepare(
            "SELECT start_ms, end_ms, text FROM transcript_words WHERE transcript_id = ? ORDER BY position",
          )
          .all(transcript.id) as Row[]
      ).map((row) => ({
        startMs: row.start_ms,
        endMs: row.end_ms,
        text: row.text,
      }))
    : [];
  db.prepare(
    "UPDATE clip_render_batches SET status = 'running', updated_at = ? WHERE id = ?",
  ).run(now(), batch.id);
  let completed = 0;
  let failed = 0;
  for (const row of rows) {
    const settingsForClip = settingsForSelection(db, row.id);
    const renderId = id();
    const outputPath = path.join(
      contentDirectory(settings.contentStorageDirectory, job.content_id),
      `render-${batch.id}-${renderId}.mp4`,
    );
    const started = Date.now();
    db.prepare(
      "INSERT INTO rendered_clips(id, render_batch_id, content_id, source_id, topic_id, subtopic_id, status, original_start_ms, original_end_ms, settings_fingerprint, render_plan_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'rendering', ?, ?, ?, 'clip-render-v1', ?, ?)",
    ).run(
      renderId,
      batch.id,
      job.content_id,
      source.id,
      row.topic_id,
      row.subtopic_id,
      row.start_ms,
      row.end_ms,
      settingsFingerprint(settingsForClip),
      now(),
      now(),
    );
    try {
      const result = await renderClip({
        ffmpegPath: settings.ffmpegPath,
        ffprobePath: settings.ffprobePath,
        sourcePath: source.source_path,
        outputPath,
        startMs: row.start_ms,
        endMs: row.end_ms,
        sourceDurationMs: source.duration_ms,
        settings: settingsForClip,
        words,
        workDirectory: contentDirectory(
          settings.contentStorageDirectory,
          job.content_id,
        ),
      });
      const stat = await fsp.stat(outputPath);
      db.prepare(
        "UPDATE rendered_clips SET status = 'completed', output_path = ?, final_duration_ms = ?, file_size_bytes = ?, width = ?, height = ?, mime_type = 'video/mp4', processing_duration_ms = ?, metadata_json = ?, updated_at = ? WHERE id = ?",
      ).run(
        outputPath,
        result.info.durationMs,
        stat.size,
        result.info.width,
        result.info.height,
        Date.now() - started,
        JSON.stringify(result.plan),
        now(),
        renderId,
      );
      completed++;
    } catch (error) {
      const safe =
        error instanceof Error ? error : new Error("Clip rendering failed.");
      db.prepare(
        "UPDATE rendered_clips SET status = 'failed', error_code = ?, error_message = ?, processing_duration_ms = ?, updated_at = ? WHERE id = ?",
      ).run(
        (safe as any).code ?? "RENDER_FAILED",
        safe.message.slice(0, 500),
        Date.now() - started,
        now(),
        renderId,
      );
      failed++;
    }
    db.prepare(
      "UPDATE clip_render_batches SET completed_count = ?, failed_count = ?, updated_at = ? WHERE id = ?",
    ).run(completed, failed, now(), batch.id);
  }
  const status =
    completed && !failed ? "completed" : completed ? "partial" : "failed";
  db.prepare(
    "UPDATE clip_render_batches SET status = ?, updated_at = ? WHERE id = ?",
  ).run(status, now(), batch.id);
  db.prepare(
    "UPDATE content_items SET status = ?, updated_at = ? WHERE id = ?",
  ).run(completed ? "ready" : "failed", now(), job.content_id);
  return { batchId: batch.id, completed, failed };
}

export function startClippingWorker(
  db: Database.Database,
  settings: ClippingSettings,
): () => void {
  db.prepare(
    "UPDATE clipping_jobs SET status = 'queued', claimed_at = NULL, started_at = NULL WHERE status = 'running'",
  ).run();
  let stopped = false;
  let running = false;
  const drain = async (): Promise<void> => {
    if (stopped || running || !db.open) return;
    running = true;
    try {
      while (!stopped && db.open) {
        const job = db.transaction(() => {
          const next = db
            .prepare(
              "SELECT * FROM clipping_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1",
            )
            .get() as Row | undefined;
          if (!next) return undefined;
          db.prepare(
            "UPDATE clipping_jobs SET status = 'running', progress = 5, attempt = attempt + 1, claimed_at = ?, started_at = ? WHERE id = ? AND status = 'queued'",
          ).run(now(), now(), next.id);
          return db
            .prepare("SELECT * FROM clipping_jobs WHERE id = ?")
            .get(next.id) as Row;
        })();
        if (!job) break;
        try {
          const output = await runJob(db, job, settings);
          db.prepare(
            "UPDATE clipping_jobs SET status = 'completed', progress = 100, output_json = ?, finished_at = ? WHERE id = ?",
          ).run(JSON.stringify(output), now(), job.id);
        } catch (error) {
          const safe =
            error instanceof Error ? error : new Error("Clipping job failed.");
          const canRetry = Number(job.attempt) < 2;
          db.prepare(
            "UPDATE clipping_jobs SET status = ?, progress = 0, error_code = ?, error_message = ?, finished_at = ? WHERE id = ?",
          ).run(
            canRetry ? "queued" : "failed",
            (safe as any).code ?? "CLIPPING_FAILED",
            safe.message.slice(0, 500),
            now(),
            job.id,
          );
          if (!canRetry) {
            db.prepare(
              "UPDATE long_video_sources SET status = 'failed', error_code = ?, error_message = ?, updated_at = ? WHERE id = ?",
            ).run(
              (safe as any).code ?? "CLIPPING_FAILED",
              safe.message.slice(0, 500),
              now(),
              job.source_id,
            );
            db.prepare(
              "UPDATE content_items SET status = 'failed', error_code = ?, error_message = ?, updated_at = ? WHERE id = ?",
            ).run(
              (safe as any).code ?? "CLIPPING_FAILED",
              safe.message.slice(0, 500),
              now(),
              job.content_id,
            );
          }
        }
      }
    } catch {
      // App shutdown can close the SQLite handle while a poll is waking up.
      // The persisted job remains recoverable on the next application start.
    } finally {
      running = false;
    }
  };
  const interval = setInterval(() => {
    void drain();
  }, 200);
  interval.unref();
  void drain();
  return () => {
    stopped = true;
    clearInterval(interval);
  };
}
