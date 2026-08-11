import crypto from "node:crypto";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type Database from "better-sqlite3";
import {
  assetStatusSchema,
  collectionStatusSchema,
  isPlayableVideoUrl,
  pinterestImageCandidates,
  promoteToLargestPinterestImage,
} from "@tokia/shared";
import {
  config as defaultConfig,
  defaultRuntimeSettings,
  saveRuntimeSettings,
  type RuntimeLogLevel,
  type RuntimeSettings,
} from "./config.js";
import { createDatabase } from "./db.js";
import {
  getCollection,
  getImportRun,
  IngestionError,
  ingestPinterestBoard,
} from "./ingestion.js";
import {
  contentSnapshot,
  createContentDraft,
  enqueueJob,
  startContentWorker,
  updateContent,
  updateContentWizardStep,
  validateSourceCollections,
} from "./content-service.js";
import { contentDirectory } from "./content-media.js";
import { createZip } from "./zip.js";
import {
  CONTENT_TYPES,
  DEFAULT_CONFIGURATION,
  ContentValidationError,
  contentFrameCount,
  defaultFrameDuration,
  effectiveFrameTrim,
  frameRoles,
  isMotionMedia,
  mergeConfiguration,
  normalizeFrameTrim,
  normalizeFrameDuration,
  slugify,
  type ContentConfiguration,
} from "./content-model.js";
import { resolvePinterestVideo } from "./pinterest-media.js";
import {
  assignmentSnapshot,
  insertProvider,
  markProviderValidation,
  preflight,
  providerCapabilities,
  providerSafe,
  validateProvider,
} from "./ai-providers.js";
import {
  applySettingsToAll,
  clippingPreflight,
  clippingSnapshot,
  jobSnapshot,
  queueClippingJob,
  setSubtopicSelection,
  setTopicSelection,
  startAnalysis,
  startClippingWorker,
  startRenderBatch,
  updateSelectionSettings,
  updateWizardStep,
  uploadSource,
} from "./clipping-service.js";
import { MediaProcessingError } from "./content-media.js";
import { renderPreviewSegment } from "./clipping-media.js";
import { convertHeicToJpeg, isHeicImageUrl } from "./image-conversion.js";

type AppSettings = typeof defaultConfig;
type QueryRecord = Record<string, string | undefined>;
type Row = Record<string, any>;
const BROWSER_EXTENSION_SETTING_KEY = "browser_extension_id";
const LOCAL_INTEGRATION_TOKEN_SETTING_KEY = "local_integration_token";
const RUNTIME_LOG_LEVELS: RuntimeLogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal", "silent"];

function positiveInt(
  value: string | undefined,
  fallback: number,
  maximum: number,
): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0
    ? Math.min(parsed, maximum)
    : fallback;
}

function queryOf(request: FastifyRequest): QueryRecord {
  return request.query as QueryRecord;
}
function bodyOf(request: FastifyRequest): Record<string, unknown> {
  return (request.body ?? {}) as Record<string, unknown>;
}
function now(): string {
  return new Date().toISOString();
}
function remoteVideoRequestHeaders(request: FastifyRequest, referer: string | null): Headers {
  const headers = new Headers({
    Accept: "video/mp4,video/webm,video/*;q=0.9,*/*;q=0.8",
    "User-Agent": "Mozilla/5.0 Tokia local media proxy",
  });
  const range = request.headers.range;
  if (typeof range === "string" && range) headers.set("Range", range);
  headers.set("Referer", referer ?? "https://www.pinterest.com/");
  return headers;
}
function isPinterestCdnUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "pinimg.com" || hostname.endsWith(".pinimg.com");
  } catch {
    return false;
  }
}
function isHeicImage(contentType: string | null, url: string): boolean {
  return /image\/hei[cf]/i.test(contentType ?? "") || isHeicImageUrl(url);
}
async function fetchRemoteVideo(url: string, request: FastifyRequest, referer: string | null): Promise<Response> {
  return fetch(url, { headers: remoteVideoRequestHeaders(request, referer) });
}
function remoteImageRequestHeaders(referer: string | null): Headers {
  return new Headers({
    Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    "User-Agent": "Mozilla/5.0 Tokia local media proxy",
    Referer: referer ?? "https://www.pinterest.com/",
  });
}
async function fetchRemoteImage(url: string, referer: string | null): Promise<Response> {
  return fetch(url, { headers: remoteImageRequestHeaders(referer) });
}
function persistResolvedVideo(db: Database.Database, assetId: string, resolved: { mediaUrl: string; posterUrl: string | null; mimeType: string | null; durationSeconds: number | null }): void {
  db.prepare(
    `UPDATE assets SET
      remote_media_url = ?,
      remote_preview_url = COALESCE(?, remote_preview_url),
      mime_type = COALESCE(?, mime_type),
      duration_seconds = COALESCE(?, duration_seconds),
      updated_at = ?
      WHERE id = ?`,
  ).run(
    resolved.mediaUrl,
    resolved.posterUrl ? promoteToLargestPinterestImage(resolved.posterUrl) : null,
    resolved.mimeType,
    resolved.durationSeconds,
    now(),
    assetId,
  );
}
async function hydrateVideoAsset(db: Database.Database, asset: Row): Promise<Row> {
  if (mediaType(asset) !== "video" || Number(asset.duration_seconds) > 0) return asset;
  const canonicalUrl = typeof asset.canonical_asset_url === "string" ? asset.canonical_asset_url : "";
  if (!canonicalUrl) return asset;
  const resolved = await resolvePinterestVideo(canonicalUrl);
  const mediaUrl = resolved.mediaUrl ?? (isPlayableVideoUrl(asset.remote_media_url) ? asset.remote_media_url : null);
  if (mediaUrl) {
    persistResolvedVideo(db, String(asset.id), {
      mediaUrl,
      posterUrl: resolved.posterUrl,
      mimeType: resolved.mimeType,
      durationSeconds: resolved.durationSeconds,
    });
  } else if (resolved.durationSeconds != null) {
    db.prepare("UPDATE assets SET duration_seconds = ?, updated_at = ? WHERE id = ?").run(resolved.durationSeconds, now(), asset.id);
  }
  return db.prepare("SELECT * FROM assets WHERE id = ?").get(asset.id) as Row;
}
function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
function frameSettingsForSource(existingSettings: unknown, configuration: ContentConfiguration, asset: Row): Row {
  const { startSeconds: _startSeconds, endSeconds: _endSeconds, ...preservedSettings } = parseJson<Row>(existingSettings, {});
  return {
    ...preservedSettings,
    durationSeconds: defaultFrameDuration(configuration, asset.media_type, asset.duration_seconds),
    durationCustomized: false,
  };
}
function newId(): string {
  return crypto.randomUUID();
}
function text(value: unknown, max = 10_000): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}
function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function browserExtensionIdFromOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  const match = /^chrome-extension:\/\/([a-p]{32})$/i.exec(origin.trim());
  return match?.[1]?.toLowerCase() ?? null;
}
function applicationSetting(db: Database.Database, key: string): string | null {
  const stored = db
    .prepare("SELECT setting_value FROM application_settings WHERE setting_key = ?")
    .get(key) as { setting_value?: string } | undefined;
  return stored?.setting_value?.trim() || null;
}
function saveApplicationSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO application_settings(setting_key, setting_value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at`,
  ).run(key, value, now());
}
function ensureLocalIntegrationToken(db: Database.Database, fallback: string): string {
  const stored = applicationSetting(db, LOCAL_INTEGRATION_TOKEN_SETTING_KEY);
  if (stored) return stored;
  saveApplicationSetting(db, LOCAL_INTEGRATION_TOKEN_SETTING_KEY, fallback);
  return fallback;
}
function runtimeSettingsSnapshot(settings: AppSettings): RuntimeSettings {
  return {
    host: settings.host,
    port: settings.port,
    databasePath: settings.databasePath,
    contentStorageDirectory: settings.contentStorageDirectory,
    ffmpegPath: settings.ffmpegPath,
    ffprobePath: settings.ffprobePath,
    maxUploadBytes: settings.maxUploadBytes,
    modelProvider: settings.modelProvider,
    modelName: settings.modelName,
    maxPinsPerImport: settings.maxPinsPerImport,
    maxRequestBytes: settings.maxRequestBytes,
    corsAllowedOrigins: [...settings.corsAllowedOrigins],
    logLevel: settings.logLevel,
  };
}
function runtimeSettingsFromBody(current: RuntimeSettings, body: Row): RuntimeSettings | string {
  const next = { ...current };
  const textFields: Array<keyof Pick<RuntimeSettings, "host" | "databasePath" | "contentStorageDirectory" | "ffmpegPath" | "ffprobePath" | "modelProvider" | "modelName">> = [
    "host",
    "databasePath",
    "contentStorageDirectory",
    "ffmpegPath",
    "ffprobePath",
    "modelProvider",
    "modelName",
  ];
  for (const field of textFields) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== "string" || !body[field].trim()) return `${field} must be a non-empty string.`;
    next[field] = body[field].trim();
  }
  if (body.port !== undefined) {
    if (!Number.isInteger(body.port) || body.port < 1 || body.port > 65_535) return "port must be an integer between 1 and 65535.";
    next.port = body.port;
  }
  const boundedNumbers: Array<{ field: keyof Pick<RuntimeSettings, "maxUploadBytes" | "maxRequestBytes">; maximum?: number }> = [
    { field: "maxUploadBytes", maximum: 4 * 1024 * 1024 * 1024 },
    { field: "maxRequestBytes", maximum: 4 * 1024 * 1024 * 1024 },
  ];
  for (const { field, maximum } of boundedNumbers) {
    if (body[field] === undefined) continue;
    if (!Number.isInteger(body[field]) || body[field] <= 0 || (maximum && body[field] > maximum)) return `${field} must be a positive integer.`;
    next[field] = body[field];
  }
  if (body.maxPinsPerImport !== undefined) {
    if (!Number.isInteger(body.maxPinsPerImport) || body.maxPinsPerImport < 1 || body.maxPinsPerImport > 10_000) return "maxPinsPerImport must be an integer between 1 and 10000.";
    next.maxPinsPerImport = body.maxPinsPerImport;
  }
  if (body.logLevel !== undefined) {
    if (typeof body.logLevel !== "string" || !RUNTIME_LOG_LEVELS.includes(body.logLevel as RuntimeLogLevel)) return "logLevel is not supported.";
    next.logLevel = body.logLevel as RuntimeLogLevel;
  }
  if (body.corsAllowedOrigins !== undefined) {
    if (!Array.isArray(body.corsAllowedOrigins)) return "corsAllowedOrigins must be an array of origins.";
    const origins = body.corsAllowedOrigins.filter((origin): origin is string => typeof origin === "string").map((origin) => origin.trim()).filter(Boolean);
    if (!origins.length) return "corsAllowedOrigins must contain at least one origin.";
    next.corsAllowedOrigins = origins;
  }
  return next;
}
function browserExtensionId(db: Database.Database, settings: AppSettings): string | null {
  const stored = applicationSetting(db, BROWSER_EXTENSION_SETTING_KEY);
  if (stored) return stored;
  return settings.corsAllowedOrigins
    .map((origin) => browserExtensionIdFromOrigin(origin))
    .find((value): value is string => Boolean(value)) ?? null;
}
function browserExtensionOrigin(db: Database.Database, settings: AppSettings): string | null {
  const id = browserExtensionId(db, settings);
  return id ? `chrome-extension://${id}` : null;
}
function normalizeBrowserExtensionId(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const candidate = value.trim().replace(/^chrome-extension:\/\//i, "").replace(/\/$/, "");
  return /^[a-p]{32}$/i.test(candidate) ? candidate.toLowerCase() : undefined;
}
function mediaType(row: Row): string {
  if (row.media_type === "video" || row.media_type === "animated")
    return row.media_type;
  if (
    typeof row.mime_type === "string" &&
    row.mime_type.toLowerCase().startsWith("video/")
  )
    return "video";
  return "image";
}
function orientation(row: Row): string {
  const width = numberValue(row.width);
  const height = numberValue(row.height);
  if (!width || !height) return "unknown";
  const ratio = width / height;
  if (ratio >= 0.88 && ratio <= 1.12) return "square";
  return ratio > 1 ? "landscape" : "portrait";
}

function toCollection(row: Row): Row {
  return {
    id: row.id,
    provider: row.provider,
    externalId: row.external_id,
    canonicalSourceUrl: row.canonical_source_url,
    name: row.local_title ?? row.name,
    sourceName: row.name,
    description: row.local_description ?? row.description,
    sourceDescription: row.description,
    localTitle: row.local_title,
    localDescription: row.local_description,
    coverAssetId: row.cover_asset_id,
    coverPreviewUrl: row.cover_preview_url,
    coverMediaType: row.cover_media_type,
    status: row.status,
    archivedAt: row.archived_at,
    assetCount: Number(row.asset_count ?? 0),
    imageCount: Number(row.image_count ?? 0),
    videoCount: Number(row.video_count ?? 0),
    lastImportedAt: row.last_imported_at,
    lastSuccessfulImportAt: row.last_successful_import_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAsset(row: Row): Row {
  const kind = mediaType(row);
  const imageUrl = row.remote_image_url;
  const mediaUrl =
    kind === "video"
      ? isPlayableVideoUrl(row.remote_media_url)
        ? row.remote_media_url
        : null
      : (row.remote_media_url ?? imageUrl);
  return {
    id: row.id,
    provider: row.provider,
    externalId: row.external_asset_id,
    canonicalUrl: row.canonical_asset_url,
    mediaUrl,
    remoteImageUrl: imageUrl,
    remotePreviewUrl: row.remote_preview_url,
    thumbnailUrl: row.remote_preview_url ?? imageUrl,
    normalizedImageKey: row.normalized_image_key,
    mediaType: kind,
    mimeType: row.mime_type,
    durationSeconds: row.duration_seconds,
    title: row.title,
    description: row.description,
    altText: row.alt_text,
    sourceLink: row.source_link,
    width: row.width,
    height: row.height,
    aspectRatio:
      row.width && row.height ? Number(row.width) / Number(row.height) : null,
    orientation: orientation(row),
    status: row.status,
    archivedAt: row.archived_at,
    localNotes: row.local_notes,
    localTags: row.local_tags,
    collectionId: row.collection_id,
    collectionName: row.collection_name,
    firstSeenAt: row.membership_first_seen_at ?? row.first_seen_at,
    lastSeenAt: row.membership_last_seen_at ?? row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toImportRun(row: Row): Row {
  return {
    id: row.id,
    provider: row.provider,
    collectionId: row.collection_id,
    collectionName: row.collection_name,
    sourceUrl: row.source_url,
    status: row.status,
    recordsReceived: row.records_received,
    recordsValid: row.records_valid,
    recordsInvalid: row.records_invalid,
    assetsCreated: row.assets_created,
    assetsUpdated: row.assets_updated,
    membershipsCreated: row.memberships_created,
    duplicatesSkipped: row.duplicates_skipped,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    errorMessage: row.error_message,
    createdAt: row.created_at,
  };
}

function toProject(row: Row): Row {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    niche: row.niche,
    defaultLanguage: row.default_language ?? "English",
    internalNotes: row.internal_notes,
    color: row.color,
    slug: row.slug,
    status: row.status,
    coverAssetId: row.cover_asset_id,
    config: row.config_json ? JSON.parse(String(row.config_json)) : null,
    collectionCount: Number(row.collection_count ?? 0),
    totalAssets: Number(row.total_assets ?? 0),
    imageCount: Number(row.image_count ?? 0),
    videoCount: Number(row.video_count ?? 0),
    contentCount: Number(row.content_count ?? 0),
    draftCount: Number(row.draft_count ?? 0),
    generatingCount: Number(row.generating_count ?? 0),
    readyCount: Number(row.ready_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function integrationGuard(
  settings: AppSettings,
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  const provided = request.headers["x-local-integration-token"];
  if (
    typeof provided !== "string" ||
    provided !== settings.localIntegrationToken
  ) {
    reply.code(401).send({
      error: {
        code: "INVALID_INTEGRATION_TOKEN",
        message: "A valid local integration token is required",
      },
    });
    return false;
  }
  return true;
}

function collectionWhere(query: QueryRecord): {
  clauses: string[];
  params: unknown[];
} {
  const clauses = ["c.provider = ?"];
  const params: unknown[] = [query.provider?.trim() || "pinterest"];
  if (query.search?.trim()) {
    const value = `%${query.search.trim()}%`;
    clauses.push(
      "(LOWER(COALESCE(c.local_title, c.name)) LIKE LOWER(?) OR LOWER(COALESCE(c.local_description, c.description, '')) LIKE LOWER(?))",
    );
    params.push(value, value);
  }
  if (query.status?.trim()) {
    clauses.push("c.status = ?");
    params.push(query.status.trim());
  }
  if (query.hasImages === "true")
    clauses.push(
      "EXISTS (SELECT 1 FROM collection_assets ca_filter JOIN assets a_filter ON a_filter.id = ca_filter.asset_id WHERE ca_filter.collection_id = c.id AND a_filter.media_type IN ('image', 'animated'))",
    );
  if (query.hasVideos === "true")
    clauses.push(
      "EXISTS (SELECT 1 FROM collection_assets ca_filter JOIN assets a_filter ON a_filter.id = ca_filter.asset_id WHERE ca_filter.collection_id = c.id AND a_filter.media_type = 'video')",
    );
  return { clauses, params };
}

function buildCollectionsQuery(query: QueryRecord): {
  sql: string;
  params: unknown[];
  page: number;
  pageSize: number;
  where: string;
  whereParams: unknown[];
} {
  const page = positiveInt(query.page, 1, 1_000_000);
  const pageSize = positiveInt(query.pageSize, 24, 100);
  const built = collectionWhere(query);
  const sortMap: Record<string, string> = {
    name: "COALESCE(c.local_title, c.name) COLLATE NOCASE",
    createdAt: "c.created_at",
    updatedAt: "c.updated_at",
    lastImportedAt: "c.last_imported_at",
    assetCount: "asset_count",
    imageCount: "image_count",
    videoCount: "video_count",
  };
  const sort = sortMap[query.sort ?? ""] ?? "c.updated_at";
  const order = query.order?.toLowerCase() === "asc" ? "ASC" : "DESC";
  const where = built.clauses.join(" AND ");
  return {
    sql: `FROM collections c LEFT JOIN collection_assets ca ON ca.collection_id = c.id LEFT JOIN assets a ON a.id = ca.asset_id WHERE ${where} GROUP BY c.id ORDER BY ${sort} ${order} LIMIT ? OFFSET ?`,
    params: [...built.params, pageSize, (page - 1) * pageSize],
    page,
    pageSize,
    where,
    whereParams: built.params,
  };
}

function assetWhere(query: QueryRecord): {
  clauses: string[];
  params: unknown[];
} {
  const clauses = ["a.provider = ?"];
  const params: unknown[] = [query.provider?.trim() || "pinterest"];
  const collectionIds = query.collectionIds
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (collectionIds?.length) {
    clauses.push(`ca.collection_id IN (${collectionIds.map(() => "?").join(",")})`);
    params.push(...collectionIds);
  } else if (query.collectionId) {
    clauses.push("ca.collection_id = ?");
    params.push(query.collectionId);
  }
  if (query.search?.trim()) {
    const value = `%${query.search.trim()}%`;
    clauses.push(
      `(LOWER(COALESCE(a.title, '')) LIKE LOWER(?) OR LOWER(COALESCE(a.description, '')) LIKE LOWER(?) OR LOWER(COALESCE(a.alt_text, '')) LIKE LOWER(?) OR LOWER(COALESCE(a.external_asset_id, '')) LIKE LOWER(?))`,
    );
    params.push(value, value, value, value);
  }
  if (query.mediaType === "source") {
    clauses.push("a.media_type IN ('image', 'video', 'animated')");
  } else if (
    query.mediaType &&
    ["image", "video", "animated"].includes(query.mediaType)
  ) {
    clauses.push("a.media_type = ?");
    params.push(query.mediaType);
  }
  if (query.status) {
    clauses.push("a.status = ?");
    params.push(query.status);
  }
  if (query.orientation === "portrait") clauses.push("a.height > a.width");
  if (query.orientation === "landscape") clauses.push("a.width > a.height");
  if (query.orientation === "square")
    clauses.push(
      "a.width IS NOT NULL AND a.height IS NOT NULL AND ABS((1.0 * a.width / a.height) - 1) <= 0.12",
    );
  const minWidth = Number(query.minWidth);
  if (Number.isInteger(minWidth) && minWidth > 0) {
    clauses.push("a.width >= ?");
    params.push(minWidth);
  }
  const minHeight = Number(query.minHeight);
  if (Number.isInteger(minHeight) && minHeight > 0) {
    clauses.push("a.height >= ?");
    params.push(minHeight);
  }
  const minDuration = Number(query.minDuration);
  if (Number.isFinite(minDuration) && minDuration >= 0) {
    clauses.push("a.duration_seconds >= ?");
    params.push(minDuration);
  }
  const maxDuration = Number(query.maxDuration);
  if (Number.isFinite(maxDuration) && maxDuration >= 0) {
    clauses.push("a.duration_seconds <= ?");
    params.push(maxDuration);
  }
  if (query.dateFrom) {
    clauses.push("a.created_at >= ?");
    params.push(query.dateFrom);
  }
  if (query.dateTo) {
    clauses.push("a.created_at <= ?");
    params.push(query.dateTo);
  }
  if (query.includeArchived !== "true") clauses.push("a.archived_at IS NULL");
  return { clauses, params };
}

function buildAssetsQuery(query: QueryRecord): {
  sql: string;
  params: unknown[];
  page: number;
  pageSize: number;
  where: string;
  whereParams: unknown[];
} {
  const page = positiveInt(query.page, 1, 1_000_000);
  const pageSize = positiveInt(query.pageSize, 48, 100);
  const built = assetWhere(query);
  const sortMap: Record<string, string> = {
    newest: "a.created_at",
    seen: "a.last_seen_at",
    dimensions: "COALESCE(a.width, 0) * COALESCE(a.height, 0)",
    duration: "COALESCE(a.duration_seconds, 0)",
    title: "a.title COLLATE NOCASE",
  };
  const sort = sortMap[query.sort ?? ""] ?? "a.last_seen_at";
  const order = query.order?.toLowerCase() === "asc" ? "ASC" : "DESC";
  const where = built.clauses.join(" AND ");
  return {
    sql: `FROM assets a LEFT JOIN collection_assets ca ON ca.asset_id = a.id LEFT JOIN collections c ON c.id = ca.collection_id WHERE ${where} GROUP BY a.id ORDER BY ${sort} ${order} LIMIT ? OFFSET ?`,
    params: [...built.params, pageSize, (page - 1) * pageSize],
    page,
    pageSize,
    where,
    whereParams: built.params,
  };
}

function pagination(page: number, pageSize: number, total: number): Row {
  return { page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
}

function projectSnapshot(db: Database.Database, id: string): Row | undefined {
  const row = db
    .prepare(
      `SELECT p.*, COUNT(DISTINCT pc.collection_id) AS collection_count,
    COUNT(DISTINCT ca.asset_id) AS total_assets,
    COUNT(DISTINCT CASE WHEN a.media_type IN ('image', 'animated') THEN a.id END) AS image_count,
    COUNT(DISTINCT CASE WHEN a.media_type = 'video' THEN a.id END) AS video_count,
    (SELECT COUNT(*) FROM content_items ci WHERE ci.project_id = p.id AND ci.status != 'archived') AS content_count,
    (SELECT COUNT(*) FROM content_items ci WHERE ci.project_id = p.id AND ci.status = 'draft') AS draft_count,
    (SELECT COUNT(*) FROM content_items ci WHERE ci.project_id = p.id AND ci.status IN ('preview_generating', 'generation_queued', 'generating')) AS generating_count,
    (SELECT COUNT(*) FROM content_items ci WHERE ci.project_id = p.id AND ci.status = 'ready') AS ready_count
    FROM projects p
    LEFT JOIN project_collections pc ON pc.project_id = p.id
    LEFT JOIN collection_assets ca ON ca.collection_id = pc.collection_id
    LEFT JOIN assets a ON a.id = ca.asset_id AND a.archived_at IS NULL
    WHERE p.id = ? GROUP BY p.id`,
    )
    .get(id) as Row | undefined;
  if (!row) return undefined;
  const collections = db
    .prepare(
      `SELECT c.*, COUNT(ca.asset_id) AS asset_count,
    SUM(CASE WHEN a.media_type IN ('image', 'animated') THEN 1 ELSE 0 END) AS image_count,
    SUM(CASE WHEN a.media_type = 'video' THEN 1 ELSE 0 END) AS video_count,
    pc.weight, pc.enabled, pc.allowed_media_types, pc.selection_priority
    FROM project_collections pc JOIN collections c ON c.id = pc.collection_id
    LEFT JOIN collection_assets ca ON ca.collection_id = c.id LEFT JOIN assets a ON a.id = ca.asset_id
    WHERE pc.project_id = ? GROUP BY c.id ORDER BY c.updated_at DESC`,
    )
    .all(id) as Row[];
  const recentAssets = db
    .prepare(
      `SELECT a.*, GROUP_CONCAT(DISTINCT COALESCE(c.local_title, c.name)) AS collection_name
    FROM project_collections pc JOIN collection_assets ca ON ca.collection_id = pc.collection_id
    JOIN assets a ON a.id = ca.asset_id LEFT JOIN collections c ON c.id = ca.collection_id
    WHERE pc.project_id = ? AND a.archived_at IS NULL GROUP BY a.id ORDER BY a.last_seen_at DESC LIMIT 8`,
    )
    .all(id) as Row[];
  return {
    ...toProject(row),
    collections: collections.map(toCollection),
    recentAssets: recentAssets.map(toAsset),
  };
}

export async function buildApp(
  options: { db?: Database.Database; settings?: AppSettings } = {},
): Promise<any> {
  const baseSettings = options.settings ?? defaultConfig;
  const db = options.db ?? createDatabase(baseSettings.databasePath);
  const settings = {
    ...baseSettings,
    localIntegrationToken: ensureLocalIntegrationToken(db, baseSettings.localIntegrationToken),
  };
  const ownsDatabase = !options.db;
  const app = Fastify({
    logger: { level: settings.logLevel },
    bodyLimit: Math.max(settings.maxRequestBytes, settings.maxUploadBytes),
    requestIdHeader: "x-request-id",
    genReqId: () => crypto.randomUUID(),
  });
  const convertedImageCache = new Map<string, Promise<Buffer>>();
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );
  app.addContentTypeParser(
    /^video\/.*$/,
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );

  await app.register(cors, {
    origin: (origin, callback) =>
      callback(
        null,
        !origin ||
          settings.corsAllowedOrigins.includes(origin) ||
          origin === browserExtensionOrigin(db, settings),
      ),
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "X-Local-Integration-Token",
      "X-Request-Id",
    ],
  });
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Tokia Local Media API",
        version: "0.2.0",
        description:
          "Local-first media library, imports, projects, and content generation API.",
      },
      servers: [{ url: `http://${settings.host}:${settings.port}` }],
      tags: [
        { name: "diagnostics" },
        { name: "dashboard" },
        { name: "collections" },
        { name: "assets" },
        { name: "projects" },
        { name: "content" },
        { name: "imports" },
        { name: "search" },
      ],
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });
  const stopContentWorker = startContentWorker(db, settings);
  const stopClippingWorker = startClippingWorker(db, settings);

  app.get(
    "/api/health",
    { schema: { tags: ["diagnostics"], summary: "Health check" } },
    async () => ({
      status: "ok",
      service: "tokia-api",
      database: "sqlite",
      integrationTokenConfigured: Boolean(settings.localIntegrationToken),
      timestamp: now(),
    }),
  );
  app.get(
    "/api/settings/bootstrap",
    {
      schema: {
        tags: ["diagnostics"],
        summary: "Bootstrap the local web client without environment configuration",
      },
    },
    async () => ({
      integrationToken: settings.localIntegrationToken,
      backendBaseUrl: `http://${settings.host}:${settings.port}`,
    }),
  );
  app.get(
    "/api/settings",
    {
      schema: {
        tags: ["diagnostics"],
        summary: "Non-sensitive local runtime settings",
      },
    },
    async () => ({
      applicationVersion: "0.2.0",
      backendVersion: "0.2.0",
      database: "sqlite",
      databaseFile: path.basename(settings.databasePath),
      backendBaseUrl: `http://${settings.host}:${settings.port}`,
      integrationTokenConfigured: Boolean(settings.localIntegrationToken),
      browserExtensionConfigured: Boolean(browserExtensionId(db, settings)),
      browserExtensionId: browserExtensionId(db, settings),
      browserExtensionOrigin: browserExtensionOrigin(db, settings),
      maxPinsPerImport: settings.maxPinsPerImport,
      advanced: runtimeSettingsSnapshot(settings),
      advancedDefaults: defaultRuntimeSettings,
    }),
  );
  app.patch(
    "/api/settings/advanced",
    {
      schema: {
        tags: ["diagnostics"],
        summary: "Save non-sensitive advanced runtime settings",
      },
    },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const next = runtimeSettingsFromBody(runtimeSettingsSnapshot(settings), bodyOf(request));
      if (typeof next === "string") return reply.code(400).send({ error: { code: "INVALID_RUNTIME_SETTINGS", message: next } });
      const previous = runtimeSettingsSnapshot(settings);
      saveRuntimeSettings(next);
      Object.assign(settings, next);
      const changed = JSON.stringify(previous) !== JSON.stringify(next);
      return {
        advanced: runtimeSettingsSnapshot(settings),
        advancedDefaults: defaultRuntimeSettings,
        backendBaseUrl: `http://${settings.host}:${settings.port}`,
        restartRequired: changed,
        message: changed ? "Advanced settings saved. Restart the API to apply all changes." : "Advanced settings are unchanged.",
      };
    },
  );
  app.post(
    "/api/settings/integration-token",
    {
      schema: {
        tags: ["diagnostics"],
        summary: "Generate a new local integration token",
      },
    },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const token = crypto.randomBytes(24).toString("hex");
      saveApplicationSetting(db, LOCAL_INTEGRATION_TOKEN_SETTING_KEY, token);
      settings.localIntegrationToken = token;
      return { integrationTokenConfigured: true, integrationToken: token };
    },
  );
  app.patch(
    "/api/settings/browser-extension",
    {
      schema: {
        tags: ["diagnostics"],
        summary: "Configure the browser extension origin",
        body: {
          type: "object",
          properties: { extensionId: { type: "string", maxLength: 80 } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const body = bodyOf(request);
      const rawExtensionId = body.extensionId;
      const extensionId = normalizeBrowserExtensionId(rawExtensionId);
      if (rawExtensionId !== undefined && extensionId === undefined) {
        return reply.code(400).send({
          error: {
            code: "INVALID_BROWSER_EXTENSION_ID",
            message: "Enter the 32-character ID copied from the browser extension page.",
          },
        });
      }

      if (extensionId) {
        db.prepare(
          `INSERT INTO application_settings(setting_key, setting_value, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at`,
        ).run(BROWSER_EXTENSION_SETTING_KEY, extensionId, now());
      } else if (rawExtensionId !== undefined) {
        db.prepare("DELETE FROM application_settings WHERE setting_key = ?").run(
          BROWSER_EXTENSION_SETTING_KEY,
        );
      }

      const savedId = browserExtensionId(db, settings);
      return {
        browserExtensionConfigured: Boolean(savedId),
        browserExtensionId: savedId,
        browserExtensionOrigin: browserExtensionOrigin(db, settings),
      };
    },
  );

  app.get(
    "/api/ai/providers",
    { schema: { tags: ["ai"], summary: "List safe AI provider metadata" } },
    async () => {
      const providers = (
        db
          .prepare(
            "SELECT * FROM ai_provider_connections WHERE owner_scope = 'local' ORDER BY created_at",
          )
          .all() as Row[]
      ).map(providerSafe);
      return {
        providers,
        assignments: assignmentSnapshot(db),
        preflight: preflight(db),
      };
    },
  );
  app.post(
    "/api/ai/providers",
    { schema: { tags: ["ai"], summary: "Create an AI provider connection" } },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const row = insertProvider(
        db,
        bodyOf(request),
        settings.secretsEncryptionKey,
      );
      return reply.code(201).send(providerSafe(row));
    },
  );
  app.patch(
    "/api/ai/providers/:id",
    { schema: { tags: ["ai"], summary: "Update an AI provider connection" } },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const { id } = request.params as { id: string };
      const existing = db
        .prepare(
          "SELECT * FROM ai_provider_connections WHERE id = ? AND owner_scope = 'local'",
        )
        .get(id) as Row | undefined;
      if (!existing)
        return reply.code(404).send({
          error: {
            code: "AI_PROVIDER_NOT_FOUND",
            message: "AI provider not found.",
          },
        });
      const row = insertProvider(
        db,
        { ...bodyOf(request), id },
        settings.secretsEncryptionKey,
        existing,
      );
      return providerSafe(row);
    },
  );
  app.post(
    "/api/ai/providers/:id/credential",
    {
      schema: { tags: ["ai"], summary: "Replace a remote provider credential" },
    },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const { id } = request.params as { id: string };
      const existing = db
        .prepare(
          "SELECT * FROM ai_provider_connections WHERE id = ? AND owner_scope = 'local'",
        )
        .get(id) as Row | undefined;
      if (!existing)
        return reply.code(404).send({
          error: {
            code: "AI_PROVIDER_NOT_FOUND",
            message: "AI provider not found.",
          },
        });
      const body = bodyOf(request);
      if (typeof body.apiKey !== "string" || !body.apiKey.trim())
        throw new ContentValidationError(
          "INVALID_CREDENTIAL",
          "A full replacement API key is required.",
        );
      const row = insertProvider(
        db,
        {
          ...existing,
          ...body,
          providerType: existing.provider_type,
          displayName: existing.display_name,
          baseUrl: existing.base_url,
          modelName: existing.model_name,
          transcriptionModel: existing.transcription_model,
          config: JSON.parse(existing.config_json ?? "{}"),
          capabilities: JSON.parse(existing.capabilities_json ?? "{}"),
          id,
        },
        settings.secretsEncryptionKey,
        existing,
      );
      return providerSafe(row);
    },
  );
  app.post(
    "/api/ai/providers/:id/validate",
    { schema: { tags: ["ai"], summary: "Validate an AI provider connection" } },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const { id } = request.params as { id: string };
      const existing = db
        .prepare(
          "SELECT * FROM ai_provider_connections WHERE id = ? AND owner_scope = 'local'",
        )
        .get(id) as Row | undefined;
      if (!existing)
        return reply.code(404).send({
          error: {
            code: "AI_PROVIDER_NOT_FOUND",
            message: "AI provider not found.",
          },
        });
      const result = await validateProvider(
        existing,
        settings.secretsEncryptionKey,
      );
      return providerSafe(markProviderValidation(db, id, result));
    },
  );
  app.post(
    "/api/ai/providers/:id/enable",
    { schema: { tags: ["ai"], summary: "Enable an AI provider" } },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const { id } = request.params as { id: string };
      db.prepare(
        "UPDATE ai_provider_connections SET status = CASE WHEN last_validated_at IS NULL THEN 'configured' ELSE 'connected' END, updated_at = ? WHERE id = ? AND owner_scope = 'local'",
      ).run(now(), id);
      const row = db
        .prepare(
          "SELECT * FROM ai_provider_connections WHERE id = ? AND owner_scope = 'local'",
        )
        .get(id) as Row;
      if (!row)
        return reply.code(404).send({
          error: {
            code: "AI_PROVIDER_NOT_FOUND",
            message: "AI provider not found.",
          },
        });
      return providerSafe(row);
    },
  );
  app.post(
    "/api/ai/providers/:id/disable",
    { schema: { tags: ["ai"], summary: "Disable an AI provider" } },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const { id } = request.params as { id: string };
      db.prepare(
        "UPDATE ai_provider_connections SET status = 'disabled', updated_at = ? WHERE id = ? AND owner_scope = 'local'",
      ).run(now(), id);
      const row = db
        .prepare(
          "SELECT * FROM ai_provider_connections WHERE id = ? AND owner_scope = 'local'",
        )
        .get(id) as Row;
      if (!row)
        return reply.code(404).send({
          error: {
            code: "AI_PROVIDER_NOT_FOUND",
            message: "AI provider not found.",
          },
        });
      return providerSafe(row);
    },
  );
  app.delete(
    "/api/ai/providers/:id",
    { schema: { tags: ["ai"], summary: "Delete an AI provider" } },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const { id } = request.params as { id: string };
      db.prepare(
        "DELETE FROM ai_task_assignments WHERE provider_connection_id = ? AND owner_scope = 'local'",
      ).run(id);
      db.prepare(
        "DELETE FROM ai_provider_connections WHERE id = ? AND owner_scope = 'local'",
      ).run(id);
      return reply.code(204).send();
    },
  );
  app.put(
    "/api/ai/assignments",
    { schema: { tags: ["ai"], summary: "Assign providers to clipping tasks" } },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const body = bodyOf(request);
      const assignments: Array<{
        taskType: "TRANSCRIPTION" | "TOPIC_DETECTION" | "SUBTOPIC_DETECTION";
        providerId: unknown;
      }> = [
        { taskType: "TRANSCRIPTION", providerId: body.transcriptionProviderId },
        { taskType: "TOPIC_DETECTION", providerId: body.analysisProviderId },
        { taskType: "SUBTOPIC_DETECTION", providerId: body.analysisProviderId },
      ];
      const timestamp = now();
      db.transaction(() => {
        for (const assignment of assignments) {
          if (
            typeof assignment.providerId !== "string" ||
            !assignment.providerId
          ) {
            db.prepare(
              "DELETE FROM ai_task_assignments WHERE owner_scope = 'local' AND task_type = ?",
            ).run(assignment.taskType);
            continue;
          }
          const provider = db
            .prepare(
              "SELECT * FROM ai_provider_connections WHERE id = ? AND owner_scope = 'local'",
            )
            .get(assignment.providerId) as Row | undefined;
          if (!provider)
            throw new ContentValidationError(
              "AI_PROVIDER_NOT_FOUND",
              "The selected AI provider was not found.",
            );
          const caps = providerCapabilities(provider);
          const valid =
            assignment.taskType === "TRANSCRIPTION"
              ? caps.audioTranscription && caps.timestampedSegments
              : caps.textGeneration && (caps.structuredOutput || caps.jsonMode);
          if (!valid)
            throw new ContentValidationError(
              "UNSUPPORTED_CAPABILITY",
              "The selected provider does not support the assigned capability.",
            );
          db.prepare(
            `INSERT INTO ai_task_assignments(owner_scope, task_type, provider_connection_id, updated_at) VALUES ('local', ?, ?, ?) ON CONFLICT(owner_scope, task_type) DO UPDATE SET provider_connection_id = excluded.provider_connection_id, updated_at = excluded.updated_at`,
          ).run(assignment.taskType, assignment.providerId, timestamp);
        }
      })();
      return { assignments: assignmentSnapshot(db), preflight: preflight(db) };
    },
  );
  app.get(
    "/api/ai/preflight",
    {
      schema: {
        tags: ["ai"],
        summary: "Read clipping AI capability preflight",
      },
    },
    async () => preflight(db),
  );

  app.get(
    "/api/dashboard",
    { schema: { tags: ["dashboard"], summary: "Dashboard overview" } },
    async () => {
      const stats = db
        .prepare(
          `SELECT
      (SELECT COUNT(*) FROM collections) AS total_collections,
      (SELECT COUNT(*) FROM assets) AS total_assets,
      (SELECT COUNT(*) FROM assets WHERE media_type IN ('image', 'animated')) AS total_images,
      (SELECT COUNT(*) FROM assets WHERE media_type = 'video') AS total_videos,
      (SELECT COUNT(*) FROM projects WHERE status != 'archived') AS total_projects,
      (SELECT COUNT(*) FROM import_runs WHERE status IN ('failed', 'completed_with_warnings')) AS attention_imports`,
        )
        .get() as Row;
      const recentCollections = db
        .prepare(
          `SELECT c.*, COUNT(ca.asset_id) AS asset_count, SUM(CASE WHEN a.media_type IN ('image','animated') THEN 1 ELSE 0 END) AS image_count, SUM(CASE WHEN a.media_type = 'video' THEN 1 ELSE 0 END) AS video_count FROM collections c LEFT JOIN collection_assets ca ON ca.collection_id = c.id LEFT JOIN assets a ON a.id = ca.asset_id GROUP BY c.id ORDER BY c.updated_at DESC LIMIT 5`,
        )
        .all() as Row[];
      const recentAssets = db
        .prepare(
          `SELECT a.*, COALESCE(c.local_title, c.name) AS collection_name FROM assets a LEFT JOIN collection_assets ca ON ca.asset_id = a.id LEFT JOIN collections c ON c.id = ca.collection_id GROUP BY a.id ORDER BY a.created_at DESC LIMIT 8`,
        )
        .all() as Row[];
      const recentImports = db
        .prepare(
          `SELECT r.*, COALESCE(c.local_title, c.name) AS collection_name FROM import_runs r LEFT JOIN collections c ON c.id = r.collection_id ORDER BY r.created_at DESC LIMIT 6`,
        )
        .all() as Row[];
      const distribution = db
        .prepare(
          `SELECT media_type, COUNT(*) AS count FROM assets GROUP BY media_type`,
        )
        .all() as Row[];
      const topCollections = db
        .prepare(
          `SELECT c.*, COUNT(ca.asset_id) AS asset_count, SUM(CASE WHEN a.media_type IN ('image','animated') THEN 1 ELSE 0 END) AS image_count, SUM(CASE WHEN a.media_type = 'video' THEN 1 ELSE 0 END) AS video_count FROM collections c LEFT JOIN collection_assets ca ON ca.collection_id = c.id LEFT JOIN assets a ON a.id = ca.asset_id GROUP BY c.id ORDER BY asset_count DESC LIMIT 5`,
        )
        .all() as Row[];
      return {
        stats: {
          totalCollections: Number(stats.total_collections),
          totalAssets: Number(stats.total_assets),
          totalImages: Number(stats.total_images),
          totalVideos: Number(stats.total_videos),
          totalProjects: Number(stats.total_projects),
          attentionImports: Number(stats.attention_imports),
        },
        recentCollections: recentCollections.map(toCollection),
        recentAssets: recentAssets.map(toAsset),
        recentImports: recentImports.map(toImportRun),
        topCollections: topCollections.map(toCollection),
        mediaDistribution: distribution.map((row) => ({
          mediaType: row.media_type,
          count: Number(row.count),
        })),
      };
    },
  );

  app.post(
    "/api/imports/pinterest-board",
    {
      schema: {
        tags: ["imports"],
        summary: "Import a versioned Pinterest board payload",
      },
    },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      return reply
        .code(200)
        .send(
          ingestPinterestBoard(db, request.body, settings.maxPinsPerImport),
        );
    },
  );

  app.get(
    "/api/collections",
    { schema: { tags: ["collections"], summary: "List collections" } },
    async (request) => {
      const built = buildCollectionsQuery(queryOf(request));
      const total = (
        db
          .prepare(
            `SELECT COUNT(DISTINCT c.id) AS count FROM collections c LEFT JOIN collection_assets ca ON ca.collection_id = c.id LEFT JOIN assets a ON a.id = ca.asset_id WHERE ${built.where}`,
          )
          .get(...built.whereParams) as { count: number }
      ).count;
      const rows = db
        .prepare(
          `SELECT c.*, COUNT(ca.asset_id) AS asset_count, SUM(CASE WHEN a.media_type IN ('image','animated') THEN 1 ELSE 0 END) AS image_count, SUM(CASE WHEN a.media_type = 'video' THEN 1 ELSE 0 END) AS video_count,
      (SELECT COALESCE(a2.remote_preview_url, CASE WHEN a2.media_type = 'image' THEN a2.remote_image_url END) FROM collection_assets ca2 JOIN assets a2 ON a2.id = ca2.asset_id WHERE ca2.collection_id = c.id ORDER BY ca2.last_seen_at DESC LIMIT 1) AS cover_preview_url,
      (SELECT a2.media_type FROM collection_assets ca2 JOIN assets a2 ON a2.id = ca2.asset_id WHERE ca2.collection_id = c.id ORDER BY ca2.last_seen_at DESC LIMIT 1) AS cover_media_type
      ${built.sql}`,
        )
        .all(...built.params) as Row[];
      return {
        items: rows.map(toCollection),
        pagination: pagination(built.page, built.pageSize, total),
      };
    },
  );

  app.get(
    "/api/collections/:id",
    { schema: { tags: ["collections"], summary: "Get collection details" } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const row = getCollection(db, id);
      if (!row)
        return reply.code(404).send({
          error: {
            code: "COLLECTION_NOT_FOUND",
            message: "Collection not found",
          },
        });
      const counts = db
        .prepare(
          `SELECT COUNT(*) AS asset_count, SUM(CASE WHEN a.media_type IN ('image','animated') THEN 1 ELSE 0 END) AS image_count, SUM(CASE WHEN a.media_type = 'video' THEN 1 ELSE 0 END) AS video_count FROM collection_assets ca JOIN assets a ON a.id = ca.asset_id WHERE ca.collection_id = ?`,
        )
        .get(id) as Row;
      const cover = row.cover_asset_id
        ? (db
            .prepare("SELECT * FROM assets WHERE id = ?")
            .get(row.cover_asset_id) as Row | undefined)
        : (db
            .prepare(
              "SELECT a.* FROM collection_assets ca JOIN assets a ON a.id = ca.asset_id WHERE ca.collection_id = ? ORDER BY ca.last_seen_at DESC LIMIT 1",
            )
            .get(id) as Row | undefined);
      return {
        ...toCollection({ ...row, ...counts }),
        cover: cover ? toAsset(cover) : null,
      };
    },
  );

  app.get(
    "/api/collections/:id/assets",
    { schema: { tags: ["assets"], summary: "List assets in a collection" } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!getCollection(db, id))
        return reply.code(404).send({
          error: {
            code: "COLLECTION_NOT_FOUND",
            message: "Collection not found",
          },
        });
      const query = { ...queryOf(request), collectionId: id };
      const built = buildAssetsQuery(query);
      const total = (
        db
          .prepare(
            `SELECT COUNT(DISTINCT a.id) AS count FROM assets a LEFT JOIN collection_assets ca ON ca.asset_id = a.id LEFT JOIN collections c ON c.id = ca.collection_id WHERE ${built.where}`,
          )
          .get(...built.whereParams) as { count: number }
      ).count;
      const rows = db
        .prepare(
          `SELECT a.*, ca.first_seen_at AS membership_first_seen_at, ca.last_seen_at AS membership_last_seen_at, COALESCE(c.local_title, c.name) AS collection_name ${built.sql}`,
        )
        .all(...built.params) as Row[];
      return {
        items: rows.map(toAsset),
        pagination: pagination(built.page, built.pageSize, total),
      };
    },
  );

  app.get("/api/collections/:id/import-runs", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!getCollection(db, id))
      return reply.code(404).send({
        error: {
          code: "COLLECTION_NOT_FOUND",
          message: "Collection not found",
        },
      });
    const rows = db
      .prepare(
        `SELECT r.*, COALESCE(c.local_title, c.name) AS collection_name FROM import_runs r LEFT JOIN collections c ON c.id = r.collection_id WHERE r.collection_id = ? ORDER BY r.created_at DESC`,
      )
      .all(id) as Row[];
    return { items: rows.map(toImportRun) };
  });

  app.get(
    "/api/assets",
    {
      schema: {
        tags: ["assets"],
        summary: "List and filter assets across collections",
      },
    },
    async (request) => {
      const built = buildAssetsQuery(queryOf(request));
      const total = (
        db
          .prepare(
            `SELECT COUNT(DISTINCT a.id) AS count FROM assets a LEFT JOIN collection_assets ca ON ca.asset_id = a.id LEFT JOIN collections c ON c.id = ca.collection_id WHERE ${built.where}`,
          )
          .get(...built.whereParams) as { count: number }
      ).count;
      const rows = db
        .prepare(
          `SELECT a.*, GROUP_CONCAT(DISTINCT COALESCE(c.local_title, c.name)) AS collection_name ${built.sql}`,
        )
        .all(...built.params) as Row[];
      return {
        items: rows.map(toAsset),
        pagination: pagination(built.page, built.pageSize, total),
      };
    },
  );

  app.get(
    "/api/assets/:id",
    { schema: { tags: ["assets"], summary: "Get asset detail" } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const row = db.prepare("SELECT * FROM assets WHERE id = ?").get(id) as
        | Row
        | undefined;
      if (!row)
        return reply.code(404).send({
          error: { code: "ASSET_NOT_FOUND", message: "Asset not found" },
        });
      const collections = db
        .prepare(
          `SELECT c.*, COUNT(ca2.asset_id) AS asset_count FROM collection_assets ca JOIN collections c ON c.id = ca.collection_id LEFT JOIN collection_assets ca2 ON ca2.collection_id = c.id WHERE ca.asset_id = ? GROUP BY c.id`,
        )
        .all(id) as Row[];
      return { ...toAsset(row), collections: collections.map(toCollection) };
    },
  );

  app.post(
    "/api/assets/:id/resolve-media",
    {
      schema: {
        tags: ["assets"],
        summary: "Resolve deferred Pinterest video media",
      },
    },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const { id } = request.params as { id: string };
      const row = db.prepare("SELECT * FROM assets WHERE id = ?").get(id) as
        | Row
        | undefined;
      if (!row)
        return reply.code(404).send({
          error: { code: "ASSET_NOT_FOUND", message: "Asset not found" },
        });
      if (mediaType(row) !== "video")
        return reply.code(422).send({
          error: {
            code: "ASSET_IS_NOT_VIDEO",
            message: "Only video assets can resolve media",
          },
        });
      if (isPlayableVideoUrl(row.remote_media_url) && Number(row.duration_seconds) > 0) return toAsset(row);
      if (
        typeof row.canonical_asset_url !== "string" ||
        !row.canonical_asset_url
      )
        return toAsset(row);
      const resolved = await resolvePinterestVideo(row.canonical_asset_url);
      if (!resolved.mediaUrl)
        return reply.code(422).send({
          error: {
            code: "VIDEO_SOURCE_UNAVAILABLE",
            message:
              "Pinterest did not expose a playable video URL for this Pin",
          },
        });
      persistResolvedVideo(db, id, {
        mediaUrl: resolved.mediaUrl,
        posterUrl: resolved.posterUrl,
        mimeType: resolved.mimeType,
        durationSeconds: resolved.durationSeconds,
      });
      return toAsset(
        db.prepare("SELECT * FROM assets WHERE id = ?").get(id) as Row,
      );
    },
  );

  app.get(
    "/api/assets/:id/media",
    { schema: { tags: ["assets"], summary: "Stream a Pinterest video through the local API" } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      let row = db.prepare("SELECT * FROM assets WHERE id = ?").get(id) as Row | undefined;
      if (!row)
        return reply.code(404).send({
          error: { code: "ASSET_NOT_FOUND", message: "Asset not found" },
        });
      if (mediaType(row) !== "video")
        return reply.code(422).send({
          error: { code: "ASSET_IS_NOT_VIDEO", message: "Only video assets can be streamed" },
        });

      const referer = typeof row.canonical_asset_url === "string" ? row.canonical_asset_url : null;
      let mediaUrl = isPlayableVideoUrl(row.remote_media_url) && isPinterestCdnUrl(row.remote_media_url) ? row.remote_media_url : null;
      let upstream = mediaUrl ? await fetchRemoteVideo(mediaUrl, request, referer) : null;
      const shouldRefresh = !upstream || [401, 403, 404].includes(upstream.status);
      if (shouldRefresh && typeof row.canonical_asset_url === "string" && row.canonical_asset_url) {
        const resolved = await resolvePinterestVideo(row.canonical_asset_url);
        if (resolved.mediaUrl && isPlayableVideoUrl(resolved.mediaUrl) && isPinterestCdnUrl(resolved.mediaUrl)) {
          persistResolvedVideo(db, id, {
            mediaUrl: resolved.mediaUrl,
            posterUrl: resolved.posterUrl,
            mimeType: resolved.mimeType,
            durationSeconds: resolved.durationSeconds,
          });
          mediaUrl = resolved.mediaUrl;
          row = db.prepare("SELECT * FROM assets WHERE id = ?").get(id) as Row;
          upstream = await fetchRemoteVideo(mediaUrl, request, referer);
        }
      }
      if (!upstream || !upstream.ok || !upstream.body)
        return reply.code(upstream?.status && upstream.status >= 400 ? upstream.status : 404).send({
          error: { code: "VIDEO_SOURCE_UNAVAILABLE", message: "The Pinterest video could not be streamed" },
        });

      const contentType = upstream.headers.get("content-type") ?? row.mime_type ?? "video/mp4";
      const contentLength = upstream.headers.get("content-length");
      const contentRange = upstream.headers.get("content-range");
      const acceptRanges = upstream.headers.get("accept-ranges");
      const response = reply.code(upstream.status).type(contentType).header("Cache-Control", "no-store");
      if (contentLength) response.header("Content-Length", contentLength);
      if (contentRange) response.header("Content-Range", contentRange);
      if (acceptRanges) response.header("Accept-Ranges", acceptRanges);
      return response.send(Readable.fromWeb(upstream.body as any));
    },
  );

  app.get(
    "/api/assets/:id/image",
    { schema: { tags: ["assets"], summary: "Stream a Pinterest image through the local API" } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const row = db.prepare("SELECT * FROM assets WHERE id = ?").get(id) as Row | undefined;
      if (!row)
        return reply.code(404).send({
          error: { code: "ASSET_NOT_FOUND", message: "Asset not found" },
        });
      if (mediaType(row) === "video" && !row.remote_preview_url && !row.remote_image_url)
        return reply.code(422).send({
          error: { code: "IMAGE_SOURCE_UNAVAILABLE", message: "This asset has no image source" },
        });

      const referer = typeof row.canonical_asset_url === "string" ? row.canonical_asset_url : null;
      const sourceUrls = [row.remote_preview_url, row.remote_image_url, row.remote_media_url]
        .filter((value): value is string => isPinterestCdnUrl(value));
      const candidates = Array.from(new Set(sourceUrls.flatMap((url) => pinterestImageCandidates(url))));
      let upstream: Response | null = null;
      let upstreamUrl: string | null = null;
      for (const candidate of candidates) {
        try {
          const response = await fetchRemoteImage(candidate, referer);
          const contentType = response.headers.get("content-type");
          if (response.ok && response.body && (!contentType || /^image\//i.test(contentType))) {
            if (isHeicImage(contentType, candidate)) {
              const cacheKey = `${id}:${candidate}`;
              let conversion = convertedImageCache.get(cacheKey);
              if (!conversion) {
                conversion = convertHeicToJpeg(new Uint8Array(await response.arrayBuffer()));
                convertedImageCache.set(cacheKey, conversion);
              }
              try {
                const jpeg = await conversion;
                return reply.code(200).type("image/jpeg").header("Cache-Control", "no-store").send(jpeg);
              } catch {
                convertedImageCache.delete(cacheKey);
                continue;
              }
            }
            upstream = response;
            upstreamUrl = candidate;
            break;
          }
          await response.body?.cancel();
        } catch {
          // Try the next Pinterest CDN variant when a source is unavailable.
        }
      }
      if (!upstream || !upstream.body || !upstreamUrl)
        return reply.code(404).send({
          error: { code: "IMAGE_SOURCE_UNAVAILABLE", message: "The Pinterest image could not be loaded" },
        });

      const contentType = upstream.headers.get("content-type") ?? row.mime_type ?? "image/jpeg";
      const contentLength = upstream.headers.get("content-length");
      const response = reply.code(upstream.status).type(contentType).header("Cache-Control", "no-store");
      if (contentLength) response.header("Content-Length", contentLength);
      return response.send(Readable.fromWeb(upstream.body as any));
    },
  );

  app.get(
    "/api/import-runs",
    { schema: { tags: ["imports"], summary: "List import runs" } },
    async (request) => {
      const query = queryOf(request);
      const page = positiveInt(query.page, 1, 1_000_000);
      const pageSize = positiveInt(query.pageSize, 30, 100);
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (query.collectionId) {
        clauses.push("r.collection_id = ?");
        params.push(query.collectionId);
      }
      if (query.status) {
        clauses.push("r.status = ?");
        params.push(query.status);
      }
      if (query.search?.trim()) {
        clauses.push(
          "(LOWER(COALESCE(c.name, '')) LIKE LOWER(?) OR LOWER(r.source_url) LIKE LOWER(?))",
        );
        const value = `%${query.search.trim()}%`;
        params.push(value, value);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const total = (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM import_runs r LEFT JOIN collections c ON c.id = r.collection_id ${where}`,
          )
          .get(...params) as { count: number }
      ).count;
      const rows = db
        .prepare(
          `SELECT r.*, COALESCE(c.local_title, c.name) AS collection_name FROM import_runs r LEFT JOIN collections c ON c.id = r.collection_id ${where} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
        )
        .all(...params, pageSize, (page - 1) * pageSize) as Row[];
      return {
        items: rows.map(toImportRun),
        pagination: pagination(page, pageSize, total),
      };
    },
  );

  app.get(
    "/api/import-runs/:id",
    { schema: { tags: ["imports"], summary: "Get an import run" } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const row = getImportRun(db, id);
      if (!row)
        return reply.code(404).send({
          error: {
            code: "IMPORT_RUN_NOT_FOUND",
            message: "Import run not found",
          },
        });
      return toImportRun({
        ...row,
        collection_name: row.collection_id
          ? (
              db
                .prepare(
                  "SELECT COALESCE(local_title, name) AS name FROM collections WHERE id = ?",
                )
                .get(row.collection_id) as Row | undefined
            )?.name
          : null,
      });
    },
  );

  app.patch(
    "/api/assets/:id",
    {
      schema: {
        tags: ["assets"],
        summary: "Update asset lifecycle and local metadata",
      },
    },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const { id } = request.params as { id: string };
      const body = bodyOf(request);
      const parsed =
        body.status === undefined
          ? null
          : assetStatusSchema.safeParse(body.status);
      if (parsed && !parsed.success)
        return reply.code(400).send({
          error: {
            code: "INVALID_ASSET_STATUS",
            message: "Invalid asset status",
          },
        });
      const existing = db
        .prepare("SELECT * FROM assets WHERE id = ?")
        .get(id) as Row | undefined;
      if (!existing)
        return reply.code(404).send({
          error: { code: "ASSET_NOT_FOUND", message: "Asset not found" },
        });
      const nextDuration =
        body.durationSeconds === undefined
          ? existing.duration_seconds
          : Number(body.durationSeconds);
      if (
        body.durationSeconds !== undefined &&
        (mediaType(existing) !== "video" ||
          !Number.isFinite(nextDuration) ||
          nextDuration <= 0 ||
          nextDuration > 86_400)
      )
        return reply.code(400).send({
          error: {
            code: "INVALID_ASSET_DURATION",
            message: "Video duration must be greater than 0 and no more than 86400 seconds.",
          },
        });
      const nextStatus = parsed?.success ? parsed.data : existing.status;
      const notes =
        body.localNotes === undefined
          ? existing.local_notes
          : text(body.localNotes);
      const tags =
        body.localTags === undefined
          ? existing.local_tags
          : text(body.localTags, 2_000);
      const archivedAt =
        body.archived === true
          ? now()
          : body.archived === false
            ? null
            : existing.archived_at;
      db.prepare(
        "UPDATE assets SET status = ?, local_notes = ?, local_tags = ?, archived_at = ?, duration_seconds = ?, updated_at = ? WHERE id = ?",
      ).run(nextStatus, notes, tags, archivedAt, nextDuration, now(), id);
      return toAsset(
        db.prepare("SELECT * FROM assets WHERE id = ?").get(id) as Row,
      );
    },
  );

  app.patch(
    "/api/collections/:id",
    {
      schema: {
        tags: ["collections"],
        summary: "Update collection metadata or lifecycle",
      },
    },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const { id } = request.params as { id: string };
      const body = bodyOf(request);
      const existing = getCollection(db, id);
      if (!existing)
        return reply.code(404).send({
          error: {
            code: "COLLECTION_NOT_FOUND",
            message: "Collection not found",
          },
        });
      const parsed =
        body.status === undefined
          ? null
          : collectionStatusSchema.safeParse(body.status);
      if (parsed && !parsed.success)
        return reply.code(400).send({
          error: {
            code: "INVALID_COLLECTION_STATUS",
            message: "Invalid collection status",
          },
        });
      const localTitle =
        body.localTitle === undefined
          ? existing.local_title
          : text(body.localTitle, 500);
      if (body.localTitle !== undefined && !localTitle)
        return reply.code(400).send({
          error: {
            code: "INVALID_COLLECTION_TITLE",
            message: "A local title is required when provided",
          },
        });
      const localDescription =
        body.localDescription === undefined
          ? existing.local_description
          : text(body.localDescription);
      const coverAssetId =
        body.coverAssetId === undefined
          ? existing.cover_asset_id
          : text(body.coverAssetId, 100);
      if (
        coverAssetId &&
        !db
          .prepare(
            "SELECT 1 FROM collection_assets WHERE collection_id = ? AND asset_id = ?",
          )
          .get(id, coverAssetId)
      )
        return reply.code(400).send({
          error: {
            code: "INVALID_COLLECTION_COVER",
            message: "Cover asset must belong to the collection",
          },
        });
      const status = parsed?.success ? parsed.data : existing.status;
      const archivedAt =
        status === "disabled" ? (existing.archived_at ?? now()) : null;
      db.prepare(
        "UPDATE collections SET status = ?, local_title = ?, local_description = ?, cover_asset_id = ?, archived_at = ?, updated_at = ? WHERE id = ?",
      ).run(
        status,
        localTitle,
        localDescription,
        coverAssetId,
        archivedAt,
        now(),
        id,
      );
      const row = getCollection(db, id)!;
      return toCollection(row);
    },
  );

  app.get(
    "/api/projects",
    { schema: { tags: ["projects"], summary: "List projects" } },
    async (request) => {
      const query = queryOf(request);
      const page = positiveInt(query.page, 1, 100_000);
      const pageSize = positiveInt(query.pageSize, 24, 100);
      const clauses = [
        query.includeArchived === "true" || query.status === "archived"
          ? "1 = 1"
          : "p.status != 'archived'",
      ];
      const params: unknown[] = [];
      if (query.search?.trim()) {
        clauses.push("LOWER(p.name) LIKE LOWER(?)");
        params.push(`%${query.search.trim()}%`);
      }
      if (query.status) {
        clauses.push("p.status = ?");
        params.push(query.status);
      }
      const where = clauses.join(" AND ");
      const total = (
        db
          .prepare(`SELECT COUNT(*) AS count FROM projects p WHERE ${where}`)
          .get(...params) as { count: number }
      ).count;
      const rows = db
        .prepare(
          `SELECT p.*, COUNT(DISTINCT pc.collection_id) AS collection_count, COUNT(DISTINCT ca.asset_id) AS total_assets, COUNT(DISTINCT CASE WHEN a.media_type IN ('image','animated') THEN a.id END) AS image_count, COUNT(DISTINCT CASE WHEN a.media_type = 'video' THEN a.id END) AS video_count,
      (SELECT COUNT(*) FROM content_items ci WHERE ci.project_id = p.id AND ci.status != 'archived') AS content_count,
      (SELECT COUNT(*) FROM content_items ci WHERE ci.project_id = p.id AND ci.status = 'draft') AS draft_count,
      (SELECT COUNT(*) FROM content_items ci WHERE ci.project_id = p.id AND ci.status IN ('preview_generating','generation_queued','generating')) AS generating_count,
      (SELECT COUNT(*) FROM content_items ci WHERE ci.project_id = p.id AND ci.status = 'ready') AS ready_count
      FROM projects p LEFT JOIN project_collections pc ON pc.project_id = p.id LEFT JOIN collection_assets ca ON ca.collection_id = pc.collection_id LEFT JOIN assets a ON a.id = ca.asset_id AND a.archived_at IS NULL WHERE ${where} GROUP BY p.id ORDER BY p.updated_at DESC LIMIT ? OFFSET ?`,
        )
        .all(...params, pageSize, (page - 1) * pageSize) as Row[];
      return {
        items: rows.map(toProject),
        pagination: pagination(page, pageSize, total),
      };
    },
  );

  app.get(
    "/api/projects/:id",
    { schema: { tags: ["projects"], summary: "Get project details" } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const project = projectSnapshot(db, id);
      if (!project || project.status === "archived")
        return reply.code(404).send({
          error: { code: "PROJECT_NOT_FOUND", message: "Project not found" },
        });
      return project;
    },
  );

  function collectionIdsFrom(body: Row): string[] {
    return Array.isArray(body.collectionIds)
      ? body.collectionIds.filter(
          (value): value is string =>
            typeof value === "string" && value.trim().length > 0,
        )
      : [];
  }
  function validateCollections(ids: string[]): void {
    const unique = [...new Set(ids)];
    if (unique.length !== ids.length)
      throw new IngestionError(
        "Duplicate collection associations are not allowed",
        400,
        "DUPLICATE_PROJECT_COLLECTION",
      );
    const found = db
      .prepare(
        `SELECT COUNT(*) AS count FROM collections WHERE id IN (${unique.map(() => "?").join(",") || "''"})`,
      )
      .get(...unique) as { count: number };
    if (found.count !== unique.length)
      throw new IngestionError(
        "One or more collections do not exist",
        400,
        "COLLECTION_NOT_FOUND",
      );
  }

  app.post(
    "/api/projects",
    { schema: { tags: ["projects"], summary: "Create a project" } },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const body = bodyOf(request);
      const name = text(body.name, 200);
      if (!name)
        return reply.code(400).send({
          error: {
            code: "INVALID_PROJECT_NAME",
            message: "Project name is required",
          },
        });
      const niche = text(body.niche, 200);
      const duplicate = db
        .prepare(
          "SELECT id FROM projects WHERE LOWER(name) = LOWER(?) AND status != 'archived'",
        )
        .get(name);
      if (duplicate)
        return reply.code(409).send({
          error: {
            code: "DUPLICATE_PROJECT_NAME",
            message: "An active project with this name already exists.",
          },
        });
      const ids = collectionIdsFrom(body);
      if (!ids.length)
        return reply.code(400).send({
          error: {
            code: "NO_PROJECT_COLLECTIONS",
            message: "Select at least one source collection.",
          },
        });
      validateCollections(ids);
      const status = body.status === "archived" ? "archived" : "active";
      const timestamp = now();
      const id = newId();
      const configJson =
        body.defaultSettings && typeof body.defaultSettings === "object"
          ? JSON.stringify(body.defaultSettings)
          : body.config && typeof body.config === "object"
            ? JSON.stringify(body.config)
            : JSON.stringify(DEFAULT_CONFIGURATION);
      const slug = `${slugify(name)}-${id.slice(0, 8)}`;
      db.transaction(() => {
        db.prepare(
          "INSERT INTO projects(id, name, description, niche, default_language, internal_notes, color, slug, status, cover_asset_id, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          id,
          name,
          text(body.description),
          niche,
          text(body.defaultLanguage, 80) ?? "English",
          text(body.internalNotes),
          text(body.color, 30),
          slug,
          status,
          text(body.coverAssetId, 100),
          configJson,
          timestamp,
          timestamp,
        );
        const insert = db.prepare(
          "INSERT INTO project_collections(project_id, collection_id, created_at) VALUES (?, ?, ?)",
        );
        for (const collectionId of ids) insert.run(id, collectionId, timestamp);
      })();
      return reply.code(201).send(projectSnapshot(db, id));
    },
  );

  app.patch(
    "/api/projects/:id",
    { schema: { tags: ["projects"], summary: "Update a project" } },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const { id } = request.params as { id: string };
      const existing = db
        .prepare("SELECT * FROM projects WHERE id = ?")
        .get(id) as Row | undefined;
      if (!existing)
        return reply.code(404).send({
          error: { code: "PROJECT_NOT_FOUND", message: "Project not found" },
        });
      const body = bodyOf(request);
      const name =
        body.name === undefined ? existing.name : text(body.name, 200);
      if (!name)
        return reply.code(400).send({
          error: {
            code: "INVALID_PROJECT_NAME",
            message: "Project name is required",
          },
        });
      const niche =
        body.niche === undefined ? existing.niche : text(body.niche, 200);
      const duplicate = db
        .prepare(
          "SELECT id FROM projects WHERE LOWER(name) = LOWER(?) AND id != ? AND status != 'archived'",
        )
        .get(name, id);
      if (duplicate)
        return reply.code(409).send({
          error: {
            code: "DUPLICATE_PROJECT_NAME",
            message: "An active project with this name already exists.",
          },
        });
      const status =
        body.status === "active" ||
        body.status === "archived" ||
        body.status === "draft"
          ? body.status
          : existing.status;
      const ids =
        body.collectionIds === undefined ? null : collectionIdsFrom(body);
      if (ids) {
        if (!ids.length)
          return reply.code(400).send({
            error: {
              code: "NO_PROJECT_COLLECTIONS",
              message: "A project needs at least one source collection.",
            },
          });
        validateCollections(ids);
      }
      const timestamp = now();
      db.transaction(() => {
        db.prepare(
          "UPDATE projects SET name = ?, description = ?, niche = ?, default_language = ?, internal_notes = ?, color = ?, status = ?, cover_asset_id = ?, config_json = ?, updated_at = ?, archived_at = ? WHERE id = ?",
        ).run(
          name,
          body.description === undefined
            ? existing.description
            : text(body.description),
          niche,
          body.defaultLanguage === undefined
            ? existing.default_language
            : (text(body.defaultLanguage, 80) ?? "English"),
          body.internalNotes === undefined
            ? existing.internal_notes
            : text(body.internalNotes),
          body.color === undefined ? existing.color : text(body.color, 30),
          status,
          body.coverAssetId === undefined
            ? existing.cover_asset_id
            : text(body.coverAssetId, 100),
          body.defaultSettings === undefined && body.config === undefined
            ? existing.config_json
            : JSON.stringify(body.defaultSettings ?? body.config),
          timestamp,
          status === "archived" ? (existing.archived_at ?? timestamp) : null,
          id,
        );
        if (ids) {
          db.prepare(
            "DELETE FROM project_collections WHERE project_id = ?",
          ).run(id);
          const insert = db.prepare(
            "INSERT INTO project_collections(project_id, collection_id, created_at) VALUES (?, ?, ?)",
          );
          for (const collectionId of ids)
            insert.run(id, collectionId, timestamp);
        }
      })();
      return projectSnapshot(db, id);
    },
  );

  app.post(
    "/api/projects/:id/collections",
    {
      schema: {
        tags: ["projects"],
        summary: "Associate collections with a project",
      },
    },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const { id } = request.params as { id: string };
      if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(id))
        return reply.code(404).send({
          error: { code: "PROJECT_NOT_FOUND", message: "Project not found" },
        });
      const ids = collectionIdsFrom(bodyOf(request));
      validateCollections(ids);
      const insert = db.prepare(
        "INSERT OR IGNORE INTO project_collections(project_id, collection_id, created_at) VALUES (?, ?, ?)",
      );
      const timestamp = now();
      db.transaction(() => {
        for (const collectionId of ids) insert.run(id, collectionId, timestamp);
      })();
      return projectSnapshot(db, id);
    },
  );

  app.delete(
    "/api/projects/:id/collections/:collectionId",
    {
      schema: {
        tags: ["projects"],
        summary: "Remove a collection from a project",
      },
    },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const { id, collectionId } = request.params as {
        id: string;
        collectionId: string;
      };
      if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(id))
        return reply.code(404).send({
          error: { code: "PROJECT_NOT_FOUND", message: "Project not found" },
        });
      db.prepare(
        "DELETE FROM project_collections WHERE project_id = ? AND collection_id = ?",
      ).run(id, collectionId);
      db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(
        now(),
        id,
      );
      return projectSnapshot(db, id);
    },
  );

  app.patch(
    "/api/projects/:id/archive",
    { schema: { tags: ["projects"], summary: "Archive a project" } },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const { id } = request.params as { id: string };
      const existing = db
        .prepare("SELECT id FROM projects WHERE id = ?")
        .get(id);
      if (!existing)
        return reply.code(404).send({
          error: { code: "PROJECT_NOT_FOUND", message: "Project not found" },
        });
      db.prepare(
        "UPDATE projects SET status = 'archived', archived_at = COALESCE(archived_at, ?), updated_at = ? WHERE id = ?",
      ).run(now(), now(), id);
      return projectSnapshot(db, id);
    },
  );

  app.delete(
    "/api/projects/:id",
    {
      schema: {
        tags: ["projects"],
        summary: "Archive a project without deleting its sources",
      },
    },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const { id } = request.params as { id: string };
      const existing = db
        .prepare("SELECT id FROM projects WHERE id = ?")
        .get(id);
      if (!existing)
        return reply.code(404).send({
          error: { code: "PROJECT_NOT_FOUND", message: "Project not found" },
        });
      db.prepare(
        "UPDATE projects SET status = 'archived', archived_at = COALESCE(archived_at, ?), updated_at = ? WHERE id = ?",
      ).run(now(), now(), id);
      return projectSnapshot(db, id);
    },
  );

  app.get(
    "/api/projects/:id/summary",
    { schema: { tags: ["projects"], summary: "Get project summary" } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const project = projectSnapshot(db, id);
      if (!project || project.status === "archived")
        return reply.code(404).send({
          error: { code: "PROJECT_NOT_FOUND", message: "Project not found" },
        });
      return project;
    },
  );

  function projectExists(projectId: string): Row {
    const project = db
      .prepare("SELECT * FROM projects WHERE id = ?")
      .get(projectId) as Row | undefined;
    if (!project || project.status === "archived")
      throw new ContentValidationError(
        "PROJECT_NOT_FOUND",
        "Project not found or archived.",
      );
    return project;
  }
  function contentExists(contentId: string): Row {
    const content = contentSnapshot(db, contentId);
    if (!content || content.status === "archived")
      throw new ContentValidationError(
        "CONTENT_NOT_FOUND",
        "Content item not found.",
      );
    return content;
  }
  function assertContentEditable(content: Row): void {
    if (
      content.status === "generation_queued" ||
      content.status === "generating"
    )
      throw new ContentValidationError(
        "CONTENT_BUSY",
        "Final generation is running; wait for it to finish before editing.",
      );
  }
  function contentResult(contentId: string, job?: Row): Row {
    return {
      content: contentSnapshot(db, contentId),
      job: job
        ? {
            id: job.id,
            jobType: job.job_type,
            status: job.status,
            progress: job.progress,
            attempt: job.attempt,
          }
        : null,
    };
  }

  app.get(
    "/api/projects/:id/content",
    {
      schema: { tags: ["content"], summary: "List content items in a project" },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      projectExists(id);
      const query = queryOf(request);
      const page = positiveInt(query.page, 1, 100_000);
      const pageSize = positiveInt(query.pageSize, 24, 100);
      const clauses = ["c.project_id = ?", "c.status != 'archived'"];
      const params: unknown[] = [id];
      if (query.status) {
        clauses.push("c.status = ?");
        params.push(query.status);
      }
      if (query.search?.trim()) {
        clauses.push(
          "(LOWER(COALESCE(c.title, '')) LIKE LOWER(?) OR LOWER(COALESCE(c.topic, '')) LIKE LOWER(?))",
        );
        const value = `%${query.search.trim()}%`;
        params.push(value, value);
      }
      const where = clauses.join(" AND ");
      const total = (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM content_items c WHERE ${where}`,
          )
          .get(...params) as { count: number }
      ).count;
      const rows = db
        .prepare(
          `SELECT c.*, COUNT(DISTINCT f.id) AS frame_count, (SELECT ca.id FROM content_assets ca WHERE ca.content_id = c.id AND ca.variant IN ('final','preview') AND ca.asset_type IN ('thumbnail','video','image') ORDER BY CASE ca.variant WHEN 'final' THEN 0 ELSE 1 END, CASE ca.asset_type WHEN 'thumbnail' THEN 0 ELSE 1 END, ca.created_at DESC LIMIT 1) AS thumbnail_asset_id FROM content_items c LEFT JOIN content_frames f ON f.content_id = c.id WHERE ${where} GROUP BY c.id ORDER BY c.updated_at DESC LIMIT ? OFFSET ?`,
        )
        .all(...params, pageSize, (page - 1) * pageSize) as Row[];
      return {
        items: rows.map((row) => ({
          id: row.id,
          projectId: row.project_id,
          type: row.type,
          title: row.title,
          status: row.status,
          language: row.language,
          topic: row.topic,
          frameCount: row.frame_count,
          previewVersion: row.preview_version,
          errorCode: row.error_code,
          errorMessage: row.error_message,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          thumbnailUrl: row.thumbnail_asset_id
            ? `/api/content/${row.id}/assets/${row.thumbnail_asset_id}/preview`
            : null,
        })),
        pagination: pagination(page, pageSize, total),
      };
    },
  );

  app.post(
    "/api/projects/:id/content",
    { schema: { tags: ["content"], summary: "Create a content draft" } },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const { id } = request.params as { id: string };
      projectExists(id);
      const body = bodyOf(request);
      const draft = createContentDraft(db, {
        projectId: id,
        type: body.type,
        title: body.title,
        language: body.language,
        configuration: body.configuration ?? body.config,
      });
      if (body.autoSelect === true)
        await selectImagesForContent(id, String((draft as Row).id), undefined, false);
      return reply
        .code(201)
        .send(contentSnapshot(db, String((draft as Row).id)));
    },
  );

  app.get(
    "/api/content/:id",
    { schema: { tags: ["content"], summary: "Get content detail" } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const content = contentSnapshot(db, id);
      if (!content || content.status === "archived")
        return reply.code(404).send({
          error: {
            code: "CONTENT_NOT_FOUND",
            message: "Content item not found",
          },
        });
      return content;
    },
  );

  app.patch(
    "/api/content/:id",
    { schema: { tags: ["content"], summary: "Update content draft" } },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const { id } = request.params as { id: string };
      const updated = updateContent(db, id, bodyOf(request));
      return updated;
    },
  );

  app.patch(
    "/api/content/:id/wizard-step",
    { schema: { tags: ["content"], summary: "Save content wizard progress" } },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const { id } = request.params as { id: string };
      return updateContentWizardStep(db, id, bodyOf(request).step);
    },
  );

  app.delete(
    "/api/content/:id",
    { schema: { tags: ["content"], summary: "Archive a content draft" } },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const { id } = request.params as { id: string };
      contentExists(id);
      const archivedAt = now();
      db.prepare(
        "UPDATE content_items SET status = 'archived', archived_at = COALESCE(archived_at, ?), updated_at = ? WHERE id = ?",
      ).run(archivedAt, archivedAt, id);
      return { id, status: "archived", archivedAt };
    },
  );

  app.patch(
    "/api/content/:id/archive",
    { schema: { tags: ["content"], summary: "Archive content" } },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const { id } = request.params as { id: string };
      contentExists(id);
      const archivedAt = now();
      db.prepare(
        "UPDATE content_items SET status = 'archived', archived_at = COALESCE(archived_at, ?), updated_at = ? WHERE id = ?",
      ).run(archivedAt, archivedAt, id);
      return { id, status: "archived", archivedAt };
    },
  );

  function queueNarrative(
    contentId: string,
    jobType:
      | "narrative_generation"
      | "caption_regeneration"
      | "frame_regeneration",
    input: Row = {},
  ): Row {
    const content = contentExists(contentId);
    return enqueueJob(db, contentId, jobType, {
      promptVersion: "structured-narrative-v1",
      configuration: content.configuration,
      ...input,
    });
  }
  app.post(
    "/api/content/:id/narrative",
    {
      schema: {
        tags: ["content"],
        summary: "Generate structured narrative copy",
      },
    },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const { id } = request.params as { id: string };
      return reply
        .code(202)
        .send(contentResult(id, queueNarrative(id, "narrative_generation")));
    },
  );
  app.post(
    "/api/content/:id/narrative/regenerate",
    {
      schema: {
        tags: ["content"],
        summary: "Regenerate all unlocked narrative copy",
      },
    },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const { id } = request.params as { id: string };
      return reply
        .code(202)
        .send(
          contentResult(
            id,
            queueNarrative(id, "narrative_generation", { regenerate: true }),
          ),
        );
    },
  );
  app.post(
    "/api/content/:id/caption",
    { schema: { tags: ["content"], summary: "Regenerate caption" } },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const { id } = request.params as { id: string };
      return reply
        .code(202)
        .send(contentResult(id, queueNarrative(id, "caption_regeneration")));
    },
  );
  app.post(
    "/api/content/:id/frames/:frameId/regenerate",
    { schema: { tags: ["content"], summary: "Regenerate one frame" } },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const { id, frameId } = request.params as { id: string; frameId: string };
      if (
        !db
          .prepare(
            "SELECT 1 FROM content_frames WHERE id = ? AND content_id = ?",
          )
          .get(frameId, id)
      )
        return reply.code(404).send({
          error: { code: "FRAME_NOT_FOUND", message: "Frame not found" },
        });
      return reply
        .code(202)
        .send(
          contentResult(
            id,
            queueNarrative(id, "frame_regeneration", { frameId }),
          ),
        );
    },
  );

  app.patch(
    "/api/content/:id/frames/duration",
    {
      schema: {
        tags: ["content"],
        summary: "Set duration for unlocked image frames",
      },
    },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const { id } = request.params as { id: string };
      const content = contentExists(id);
      assertContentEditable(content);
      if (content.type !== "video_slideshow")
        throw new ContentValidationError(
          "DURATION_NOT_SUPPORTED",
          "Bulk frame duration is only available for video slideshows.",
        );
      const durationSeconds = normalizeFrameDuration(
        bodyOf(request).durationSeconds,
        content.configuration as ContentConfiguration,
        "image",
      );
      const frames = db
        .prepare(
          "SELECT f.id, f.image_locked, f.source_media_id, a.media_type FROM content_frames f LEFT JOIN assets a ON a.id = f.source_media_id WHERE f.content_id = ? ORDER BY f.position",
        )
        .all(id) as Row[];
      const timestamp = now();
      let updatedFrameCount = 0;
      db.transaction(() => {
        for (const frame of frames) {
          if (frame.image_locked || !frame.source_media_id || isMotionMedia(frame.media_type)) continue;
          const existing = db
            .prepare("SELECT settings_json FROM content_frames WHERE id = ?")
            .get(frame.id) as Row | undefined;
          const frameSettings = {
            ...parseJson<Row>(existing?.settings_json, {}),
            durationSeconds,
            durationCustomized: true,
          };
          db.prepare(
            "UPDATE content_frames SET settings_json = ?, updated_at = ? WHERE id = ?",
          ).run(JSON.stringify(frameSettings), timestamp, frame.id);
          updatedFrameCount += 1;
        }
        if (updatedFrameCount > 0) {
          db.prepare(
            "UPDATE content_items SET version = version + 1, updated_at = ? WHERE id = ?",
          ).run(timestamp, id);
        }
      })();
      return reply.send(contentSnapshot(db, id));
    },
  );

  app.patch(
    "/api/content/:id/frames/:frameId",
    {
      schema: { tags: ["content"], summary: "Edit or lock one content frame" },
    },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const { id, frameId } = request.params as { id: string; frameId: string };
      const content = contentExists(id);
      assertContentEditable(content);
      const body = bodyOf(request);
      const existing = db
        .prepare("SELECT * FROM content_frames WHERE id = ? AND content_id = ?")
        .get(frameId, id) as Row | undefined;
      if (!existing)
        return reply.code(404).send({
          error: { code: "FRAME_NOT_FOUND", message: "Frame not found" },
        });
      const headline =
        body.headline === undefined
          ? existing.headline
          : typeof body.headline === "string"
            ? body.headline.trim().slice(0, 120) || null
            : null;
      const bodyText =
        body.body === undefined
          ? existing.body
          : typeof body.body === "string"
            ? body.body.trim().slice(0, 240) || null
            : null;
      const textLocked =
        body.textLocked === undefined
          ? existing.text_locked
          : body.textLocked
            ? 1
            : 0;
      const imageLocked =
        body.imageLocked === undefined
          ? existing.image_locked
          : body.imageLocked
            ? 1
            : 0;
      let frameSettings = parseJson<Row>(existing.settings_json, {});
      if (body.durationSeconds !== undefined || body.startSeconds !== undefined || body.endSeconds !== undefined) {
        if (content.type !== "video_slideshow")
          throw new ContentValidationError(
            "DURATION_NOT_SUPPORTED",
            "Per-frame duration is only available for video slideshows.",
          );
        const source = existing.source_media_id
          ? (db
              .prepare(
                "SELECT media_type, duration_seconds FROM assets WHERE id = ?",
              )
              .get(existing.source_media_id) as Row | undefined)
          : undefined;
        if (body.startSeconds !== undefined || body.endSeconds !== undefined) {
          if (!isMotionMedia(source?.media_type))
            throw new ContentValidationError(
              "TRIM_NOT_SUPPORTED",
              "Video trim is only available for video sources.",
            );
          const currentTrim = effectiveFrameTrim(
            frameSettings,
            content.configuration as ContentConfiguration,
            source?.media_type,
            source?.duration_seconds,
          );
          const trim = normalizeFrameTrim(
            body.startSeconds === undefined ? currentTrim.startSeconds : body.startSeconds,
            body.endSeconds === undefined ? currentTrim.endSeconds : body.endSeconds,
            source?.media_type,
            source?.duration_seconds,
          );
          frameSettings = {
            ...frameSettings,
            ...trim,
            durationCustomized: true,
          };
        } else {
          const durationSeconds = normalizeFrameDuration(
            body.durationSeconds,
            content.configuration as ContentConfiguration,
            source?.media_type,
            source?.duration_seconds,
          );
          frameSettings = {
            ...frameSettings,
            durationSeconds,
            ...(isMotionMedia(source?.media_type) ? { startSeconds: 0, endSeconds: durationSeconds } : {}),
            durationCustomized: true,
          };
        }
      }
      db.prepare(
        "UPDATE content_frames SET headline = ?, body = ?, text_locked = ?, image_locked = ?, settings_json = ?, updated_at = ? WHERE id = ?",
      ).run(
        headline,
        bodyText,
        textLocked,
        imageLocked,
        JSON.stringify(frameSettings),
        now(),
        frameId,
      );
      db.prepare(
        "UPDATE content_items SET version = version + 1, updated_at = ? WHERE id = ?",
      ).run(now(), id);
      return contentSnapshot(db, id);
    },
  );

  async function selectImagesForContent(
    projectId: string,
    contentId: string,
    requestedIds?: string[],
    shuffle = false,
  ): Promise<Row> {
    const content = contentExists(contentId);
    if (content.projectId !== projectId)
      throw new ContentValidationError(
        "CONTENT_PROJECT_MISMATCH",
        "Content item does not belong to this project.",
      );
    const sourceIds = (
      content.configuration as { sourceCollectionIds: string[] }
    ).sourceCollectionIds;
    validateSourceCollections(db, projectId, sourceIds);
    const frames = db
      .prepare(
        "SELECT * FROM content_frames WHERE content_id = ? ORDER BY position",
      )
      .all(contentId) as Row[];
    const required = frames.length;
    const ids = requestedIds ?? [];
    if (
      requestedIds &&
      (ids.length !== required || new Set(ids).size !== ids.length)
    )
      throw new ContentValidationError(
        "INVALID_IMAGE_SELECTION",
        `Select exactly ${required} different images.`,
      );
    const placeholders = sourceIds.map(() => "?").join(",");
    const imageRows = requestedIds
      ? (db
          .prepare(
            `SELECT DISTINCT a.* FROM assets a JOIN collection_assets ca ON ca.asset_id = a.id WHERE ca.collection_id IN (${placeholders}) AND a.id IN (${ids.map(() => "?").join(",")}) AND a.media_type IN ('image','video','animated') AND a.status = 'available' AND a.archived_at IS NULL`,
          )
          .all(...sourceIds, ...ids) as Row[])
      : (db
          .prepare(
            `SELECT DISTINCT a.* FROM assets a JOIN collection_assets ca ON ca.asset_id = a.id WHERE ca.collection_id IN (${placeholders}) AND a.media_type IN ('image','video','animated') AND a.status = 'available' AND a.archived_at IS NULL ORDER BY ${shuffle ? "RANDOM()" : "a.last_seen_at DESC"} LIMIT ?`,
          )
          .all(...sourceIds, required) as Row[]);
    if (imageRows.length < required)
      throw new ContentValidationError(
        "INSUFFICIENT_MEDIA",
        `The selected sources contain ${imageRows.length} usable images; ${required} are required.`,
      );
    const selected = requestedIds
      ? ids
          .map(
            (requestedId) =>
              imageRows.find((image) => image.id === requestedId)!,
          )
          .filter(Boolean)
      : imageRows.slice(0, required);
    const hydratedSelected = await Promise.all(selected.map((asset) => hydrateVideoAsset(db, asset)));
    db.transaction(() => {
      const timestamp = now();
      const configuration = content.configuration as ContentConfiguration;
      for (let index = 0; index < frames.length; index += 1) {
        const frame = frames[index]!;
        const asset = hydratedSelected[index]!;
        const settings = frameSettingsForSource(frame.settings_json, configuration, asset);
        db.prepare(
          "UPDATE content_frames SET source_media_id = ?, settings_json = ?, updated_at = ? WHERE id = ?",
        ).run(asset.id, JSON.stringify(settings), timestamp, frame.id);
        db.prepare(
          "DELETE FROM content_assets WHERE frame_id = ? AND variant = 'source_normalized'",
        ).run(frame.id);
      }
      db.prepare(
        "UPDATE content_items SET status = 'draft', version = version + 1, updated_at = ?, error_code = NULL, error_message = NULL WHERE id = ?",
      ).run(timestamp, contentId);
    })();
    return contentSnapshot(db, contentId)!;
  }
  app.post(
    "/api/content/:id/images/select",
    {
      schema: {
        tags: ["content"],
        summary: "Select images for content frames",
      },
    },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const { id } = request.params as { id: string };
      const content = contentExists(id);
      return await selectImagesForContent(
        content.projectId as string,
        id,
        Array.isArray(bodyOf(request).mediaIds)
          ? (bodyOf(request).mediaIds as unknown[]).filter(
              (value): value is string => typeof value === "string",
            )
          : undefined,
        false,
      );
    },
  );
  app.post(
    "/api/content/:id/images/shuffle",
    { schema: { tags: ["content"], summary: "Shuffle unlocked images" } },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const { id } = request.params as { id: string };
      const content = contentExists(id);
      const frames = db
        .prepare(
          "SELECT * FROM content_frames WHERE content_id = ? ORDER BY position",
        )
        .all(id) as Row[];
      const locked = frames.filter((frame) => frame.image_locked);
      const unlocked = frames.filter((frame) => !frame.image_locked);
      const lockedIds = new Set(
        locked.map((frame) => frame.source_media_id).filter(Boolean),
      );
      const sourceIds = (
        content.configuration as { sourceCollectionIds: string[] }
      ).sourceCollectionIds;
      const placeholders = sourceIds.map(() => "?").join(",");
      const candidates = db
        .prepare(
          `SELECT DISTINCT a.* FROM assets a JOIN collection_assets ca ON ca.asset_id = a.id WHERE ca.collection_id IN (${placeholders}) AND a.media_type IN ('image','video','animated') AND a.status = 'available' AND a.archived_at IS NULL ORDER BY RANDOM() LIMIT ?`,
        )
        .all(...sourceIds, frames.length * 4) as Row[];
      const available = candidates.filter((asset) => !lockedIds.has(asset.id));
      if (available.length < unlocked.length)
        throw new ContentValidationError(
          "INSUFFICIENT_MEDIA",
          "There are not enough unlocked images to shuffle these frames.",
        );
      const selected = available.slice(0, unlocked.length);
      const hydratedSelected = await Promise.all(selected.map((asset) => hydrateVideoAsset(db, asset)));
      db.transaction(() => {
        const configuration = content.configuration as ContentConfiguration;
        for (let index = 0; index < unlocked.length; index += 1) {
          const frame = unlocked[index]!;
          const asset = hydratedSelected[index]!;
          const frameSettings = frameSettingsForSource(frame.settings_json, configuration, asset);
          db.prepare(
            "UPDATE content_frames SET source_media_id = ?, settings_json = ?, updated_at = ? WHERE id = ?",
          ).run(asset.id, JSON.stringify(frameSettings), now(), frame.id);
          db.prepare(
            "DELETE FROM content_assets WHERE frame_id = ? AND variant = 'source_normalized'",
          ).run(frame.id);
        }
        db.prepare(
          "UPDATE content_items SET status = 'draft', version = version + 1, updated_at = ? WHERE id = ?",
        ).run(now(), id);
      })();
      return contentSnapshot(db, id);
    },
  );
  app.put(
    "/api/content/:id/frames/:frameId/image",
    { schema: { tags: ["content"], summary: "Replace one frame image" } },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const { id, frameId } = request.params as { id: string; frameId: string };
      const content = contentExists(id);
      const mediaId = bodyOf(request).mediaId;
      if (typeof mediaId !== "string")
        throw new ContentValidationError(
          "INVALID_IMAGE_SELECTION",
          "mediaId is required.",
        );
      const frame = db
        .prepare(
          "SELECT position, settings_json FROM content_frames WHERE id = ? AND content_id = ?",
        )
        .get(frameId, id) as Row | undefined;
      if (!frame)
        throw new ContentValidationError("FRAME_NOT_FOUND", "Frame not found.");
      const sourceIds = content.configuration as {
        sourceCollectionIds: string[];
      };
      const placeholders = sourceIds.sourceCollectionIds
        .map(() => "?")
        .join(",");
      let candidate = db
        .prepare(
          `SELECT DISTINCT a.id, a.media_type, a.duration_seconds FROM assets a JOIN collection_assets ca ON ca.asset_id = a.id WHERE a.id = ? AND ca.collection_id IN (${placeholders}) AND a.media_type IN ('image','video','animated') AND a.status = 'available' AND a.archived_at IS NULL`,
        )
        .get(mediaId, ...sourceIds.sourceCollectionIds) as Row | undefined;
      if (!candidate)
        throw new ContentValidationError(
          "INVALID_IMAGE_SELECTION",
          "The replacement image is not available in the project sources.",
        );
      if (candidate.media_type === "video") candidate = await hydrateVideoAsset(db, candidate);
      if (
        db
          .prepare(
            "SELECT 1 FROM content_frames WHERE content_id = ? AND source_media_id = ? AND id != ?",
          )
          .get(id, mediaId, frameId)
      )
        throw new ContentValidationError(
          "DUPLICATE_IMAGE_SELECTION",
          "An image cannot be used twice in one content item.",
        );
      db.transaction(() => {
        const settings = frameSettingsForSource(frame.settings_json, content.configuration as ContentConfiguration, candidate);
        db.prepare(
          "UPDATE content_frames SET source_media_id = ?, image_locked = 1, settings_json = ?, updated_at = ? WHERE id = ?",
        ).run(mediaId, JSON.stringify(settings), now(), frameId);
        db.prepare(
          "DELETE FROM content_assets WHERE frame_id = ? AND variant = 'source_normalized'",
        ).run(frameId);
        db.prepare(
          "UPDATE content_items SET status = 'draft', version = version + 1, updated_at = ? WHERE id = ?",
        ).run(now(), id);
      })();
      return contentSnapshot(db, id);
    },
  );
  app.post(
    "/api/content/:id/frames/reorder",
    { schema: { tags: ["content"], summary: "Reorder content frames" } },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const { id } = request.params as { id: string };
      contentExists(id);
      const frameIds = Array.isArray(bodyOf(request).frameIds)
        ? (bodyOf(request).frameIds as unknown[]).filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      const existing = (
        db
          .prepare(
            "SELECT id FROM content_frames WHERE content_id = ? ORDER BY position",
          )
          .all(id) as Row[]
      ).map((row) => row.id as string);
      if (
        frameIds.length !== existing.length ||
        new Set(frameIds).size !== existing.length ||
        frameIds.some((value) => !existing.includes(value))
      )
        throw new ContentValidationError(
          "INVALID_FRAME_ORDER",
          "Frame order must include each frame exactly once.",
        );
      db.transaction(() => {
        for (let index = 0; index < frameIds.length; index += 1)
          db.prepare(
            "UPDATE content_frames SET position = ?, updated_at = ? WHERE id = ?",
          ).run(-(index + 1), now(), frameIds[index]);
        for (let index = 0; index < frameIds.length; index += 1)
          db.prepare(
            "UPDATE content_frames SET position = ?, updated_at = ? WHERE id = ?",
          ).run(index + 1, now(), frameIds[index]);
        db.prepare(
          "UPDATE content_items SET version = version + 1, updated_at = ? WHERE id = ?",
        ).run(now(), id);
      })();
      return contentSnapshot(db, id);
    },
  );

  app.post(
    "/api/content/:id/preview",
    { schema: { tags: ["content"], summary: "Queue a preview render" } },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const { id } = request.params as { id: string };
      const content = contentExists(id);
      const missing = (content.frames as Row[]).filter(
        (frame) => !frame.sourceMedia,
      );
      if (missing.length)
        throw new ContentValidationError(
          "MISSING_SOURCE_IMAGE",
          "Select an image for every frame before generating a preview.",
        );
      return reply.code(202).send(
        contentResult(
          id,
          enqueueJob(db, id, "preview_render", {
            configurationVersion: content.version,
          }),
        ),
      );
    },
  );
  app.get(
    "/api/content/:id/preview",
    { schema: { tags: ["content"], summary: "Get preview state" } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const content = contentSnapshot(db, id);
      if (!content)
        return reply.code(404).send({
          error: {
            code: "CONTENT_NOT_FOUND",
            message: "Content item not found",
          },
        });
      return content;
    },
  );
  app.post(
    "/api/content/:id/confirm",
    {
      schema: {
        tags: ["content"],
        summary: "Confirm preview and queue final generation",
      },
    },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const { id } = request.params as { id: string };
      const content = contentExists(id);
      if (content.status !== "preview_ready" || !content.previewVersion)
        throw new ContentValidationError(
          "PREVIEW_REQUIRED",
          "Generate and review a preview before final generation.",
        );
      db.prepare(
        "UPDATE content_items SET accepted_version = preview_version, updated_at = ? WHERE id = ?",
      ).run(now(), id);
      const job = enqueueJob(db, id, "final_render", {
        acceptedVersion: content.previewVersion,
      });
      return reply.code(202).send(contentResult(id, job));
    },
  );
  app.post(
    "/api/content/:id/retry",
    { schema: { tags: ["content"], summary: "Retry a failed content job" } },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const { id } = request.params as { id: string };
      const content = contentExists(id);
      const jobType =
        bodyOf(request).jobType === "preview_render" ||
        bodyOf(request).jobType === "final_render"
          ? (bodyOf(request).jobType as "preview_render" | "final_render")
          : content.previewVersion
            ? "final_render"
            : "preview_render";
      db.prepare(
        "UPDATE content_items SET status = 'draft', error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ?",
      ).run(now(), id);
      const job = enqueueJob(db, id, jobType, { retry: true });
      return reply.code(202).send(contentResult(id, job));
    },
  );

  function contentAsset(contentId: string, assetId: string): Row {
    const asset = db
      .prepare(
        "SELECT * FROM content_assets WHERE id = ? AND content_id = ? AND status = 'ready'",
      )
      .get(assetId, contentId) as Row | undefined;
    if (!asset || !fs.existsSync(String(asset.file_path)))
      throw new ContentValidationError(
        "CONTENT_ASSET_NOT_FOUND",
        "Generated asset is not available.",
      );
    return asset;
  }
  app.get(
    "/api/content/:id/assets/:assetId/preview",
    async (request, reply) => {
      const { id, assetId } = request.params as { id: string; assetId: string };
      const asset = contentAsset(id, assetId);
      return reply
        .type(String(asset.mime_type))
        .send(fs.createReadStream(String(asset.file_path)));
    },
  );
  app.get(
    "/api/content/:id/assets/:assetId/download",
    async (request, reply) => {
      const { id, assetId } = request.params as { id: string; assetId: string };
      const asset = contentAsset(id, assetId);
      const ext =
        asset.mime_type === "video/mp4"
          ? "mp4"
          : asset.mime_type === "image/webp"
            ? "webp"
            : "png";
      return reply
        .header(
          "Content-Disposition",
          `attachment; filename="tokia-${id}-${asset.variant}.${ext}"`,
        )
        .type(String(asset.mime_type))
        .send(fs.createReadStream(String(asset.file_path)));
    },
  );
  app.get("/api/content/:id/download", async (request, reply) => {
    const { id } = request.params as { id: string };
    const content = contentExists(id);
    if (content.type === "carousel") {
      const rows = db
        .prepare(
          `SELECT ca.* FROM content_assets ca LEFT JOIN content_frames f ON f.id = ca.frame_id WHERE ca.content_id = ? AND ca.variant = 'final' AND ca.asset_type = 'image' AND ca.status = 'ready' ORDER BY f.position, ca.created_at`,
        )
        .all(id) as Row[];
      const files = rows
        .filter((row) => fs.existsSync(String(row.file_path)))
        .map((row, index) => ({
          name: `slide-${String(index + 1).padStart(2, "0")}.png`,
          path: String(row.file_path),
        }));
      if (!files.length)
        throw new ContentValidationError(
          "FINAL_ASSET_NOT_READY",
          "The final carousel slides are not ready yet.",
        );
      const archive = await createZip(files);
      return reply
        .header(
          "Content-Disposition",
          `attachment; filename="${safeFileName(String(content.title ?? content.topic ?? "content"))}-slides.zip"`,
        )
        .type("application/zip")
        .send(archive);
    }
    const preferred =
      content.type === "video_slideshow"
        ? "video"
        : "image";
    const asset = db
      .prepare(
        `SELECT * FROM content_assets WHERE content_id = ? AND variant = 'final' AND asset_type = ? AND status = 'ready' ORDER BY created_at DESC LIMIT 1`,
      )
      .get(id, preferred) as Row | undefined;
    if (!asset)
      throw new ContentValidationError(
        "FINAL_ASSET_NOT_READY",
        "The final asset is not ready yet.",
      );
    const ext =
      asset.mime_type === "video/mp4"
        ? "mp4"
        : asset.mime_type === "image/webp"
          ? "webp"
          : "png";
    return reply
      .header(
        "Content-Disposition",
        `attachment; filename="${safeFileName(String(content.title ?? content.topic ?? "content"))}.${ext}"`,
      )
      .type(String(asset.mime_type))
      .send(fs.createReadStream(String(asset.file_path)));
  });
  app.get("/api/content/:id/package.zip", async (request, reply) => {
    const { id } = request.params as { id: string };
    const content = contentExists(id);
    if (content.status !== "ready")
      throw new ContentValidationError(
        "FINAL_ASSET_NOT_READY",
        "The final asset is not ready yet.",
      );
    const rows = db
      .prepare(
        "SELECT * FROM content_assets WHERE content_id = ? AND variant = 'final' AND status = 'ready' ORDER BY CASE asset_type WHEN 'image' THEN 0 ELSE 1 END, created_at",
      )
      .all(id) as Row[];
    const files = rows
      .filter((row) => fs.existsSync(String(row.file_path)))
      .map((row, index) => ({
        name:
          row.asset_type === "image"
            ? `slide-${String(index + 1).padStart(2, "0")}.png`
            : row.asset_type === "video"
              ? "video.mp4"
              : "thumbnail.webp",
        path: String(row.file_path),
      }));
    const directory = contentDirectory(settings.contentStorageDirectory, id);
    const metadataPath = path.join(directory, "metadata.json");
    const captionPath = path.join(directory, "caption.txt");
    fs.writeFileSync(
      metadataPath,
      JSON.stringify(
        {
          id: content.id,
          projectId: content.projectId,
          type: content.type,
          title: content.title,
          topic: content.topic,
          language: content.language,
          configuration: content.configuration,
          narrative: content.narrative,
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      captionPath,
      `${content.narrative?.caption ?? ""}\n\n${(content.narrative?.hashtags ?? []).join(" ")}`,
    );
    files.push(
      { name: "metadata.json", path: metadataPath },
      { name: "caption.txt", path: captionPath },
    );
    const archive = await createZip(files);
    return reply
      .header(
        "Content-Disposition",
        `attachment; filename="${safeFileName(String(content.title ?? "content"))}.zip"`,
      )
      .type("application/zip")
      .send(archive);
  });

  app.get(
    "/api/content/:id/clipping",
    {
      schema: {
        tags: ["content"],
        summary: "Read persisted clipping workflow state",
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        return clippingSnapshot(db, id);
      } catch (error) {
        if (
          error instanceof ContentValidationError &&
          error.code === "CONTENT_NOT_FOUND"
        )
          return reply
            .code(404)
            .send({ error: { code: error.code, message: error.message } });
        throw error;
      }
    },
  );
  app.post(
    "/api/content/:id/clipping/source",
    {
      schema: {
        tags: ["content"],
        summary: "Upload a long-form clipping source video",
      },
    },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const { id } = request.params as { id: string };
      const body = Buffer.isBuffer(request.body)
        ? request.body
        : Buffer.from(String(request.body ?? ""), "base64");
      const query = queryOf(request);
      const source = await uploadSource(
        db,
        settings,
        id,
        body,
        query.filename,
        request.headers["content-type"],
        query.title,
        query.notes,
      );
      return reply
        .code(201)
        .send({ source, clipping: clippingSnapshot(db, id) });
    },
  );
  app.patch(
    "/api/content/:id/clipping/source",
    { schema: { tags: ["content"], summary: "Update clipping source notes" } },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const { id } = request.params as { id: string };
      const body = bodyOf(request);
      const source = db
        .prepare("SELECT id FROM long_video_sources WHERE content_id = ?")
        .get(id) as Row | undefined;
      if (!source)
        throw new ContentValidationError(
          "SOURCE_NOT_FOUND",
          "Upload a source video before editing its details.",
        );
      db.prepare(
        "UPDATE long_video_sources SET title = ?, notes = ?, updated_at = ? WHERE id = ?",
      ).run(
        typeof body.title === "string"
          ? body.title.trim().slice(0, 200) || null
          : null,
        typeof body.notes === "string"
          ? body.notes.trim().slice(0, 2000) || null
          : null,
        now(),
        source.id,
      );
      return clippingSnapshot(db, id);
    },
  );
  app.post(
    "/api/content/:id/clipping/analyze",
    {
      schema: {
        tags: ["content"],
        summary: "Queue clipping extraction, transcription, and analysis",
      },
    },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const { id } = request.params as { id: string };
      const job = startAnalysis(db, id, bodyOf(request).force === true);
      return reply.code(202).send({
        job: { id: job.id, jobType: job.job_type, status: job.status },
        clipping: clippingSnapshot(db, id),
      });
    },
  );
  app.patch(
    "/api/content/:id/clipping/wizard-step",
    { schema: { tags: ["content"], summary: "Persist clipping wizard step" } },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const { id } = request.params as { id: string };
      const step = bodyOf(request).step;
      return updateWizardStep(db, id, Number(step));
    },
  );
  app.post(
    "/api/content/:id/clipping/topics/:topicId/selection",
    {
      schema: {
        tags: ["content"],
        summary: "Select or deselect a topic and all of its children",
      },
    },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const { id, topicId } = request.params as { id: string; topicId: string };
      return setTopicSelection(
        db,
        id,
        topicId,
        bodyOf(request).selected !== false,
      );
    },
  );
  app.post(
    "/api/content/:id/clipping/subtopics/:subtopicId/selection",
    {
      schema: {
        tags: ["content"],
        summary: "Select or deselect one clip candidate",
      },
    },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const { id, subtopicId } = request.params as {
        id: string;
        subtopicId: string;
      };
      return setSubtopicSelection(
        db,
        id,
        subtopicId,
        bodyOf(request).selected !== false,
      );
    },
  );
  app.patch(
    "/api/content/:id/clipping/selections/:subtopicId/settings",
    {
      schema: {
        tags: ["content"],
        summary: "Persist settings for one selected clip",
      },
    },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const { id, subtopicId } = request.params as {
        id: string;
        subtopicId: string;
      };
      return updateSelectionSettings(db, id, subtopicId, bodyOf(request));
    },
  );
  app.post(
    "/api/content/:id/clipping/selections/:subtopicId/apply-to-all",
    {
      schema: {
        tags: ["content"],
        summary: "Copy one clip configuration to all selected clips",
      },
    },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const { id, subtopicId } = request.params as {
        id: string;
        subtopicId: string;
      };
      return applySettingsToAll(db, id, subtopicId);
    },
  );
  app.post(
    "/api/content/:id/clipping/render",
    {
      schema: {
        tags: ["content"],
        summary: "Queue a persisted clipping render batch",
      },
    },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const { id } = request.params as { id: string };
      const body = bodyOf(request);
      const job = startRenderBatch(db, id, {
        onlySelectionIds: Array.isArray(body.onlySelectionIds)
          ? body.onlySelectionIds.filter(
              (value): value is string => typeof value === "string",
            )
          : undefined,
      });
      return reply.code(202).send({
        batchId: job.batchId,
        job: jobSnapshot(job),
        clipping: clippingSnapshot(db, id),
      });
    },
  );
  app.post(
    "/api/content/:id/clipping/rendered/:renderedId/retry",
    {
      schema: { tags: ["content"], summary: "Retry one failed rendered clip" },
    },
    async (request, reply) => {
      if (!integrationGuard(settings, request, reply)) return;
      const { id, renderedId } = request.params as {
        id: string;
        renderedId: string;
      };
      const rendered = db
        .prepare(
          "SELECT subtopic_id FROM rendered_clips WHERE id = ? AND content_id = ? AND status = 'failed'",
        )
        .get(renderedId, id) as Row | undefined;
      if (!rendered)
        throw new ContentValidationError(
          "RENDERED_CLIP_NOT_FOUND",
          "The failed rendered clip was not found.",
        );
      const job = startRenderBatch(db, id, {
        onlySelectionIds: [
          (
            db
              .prepare(
                "SELECT id FROM clip_selections WHERE content_id = ? AND subtopic_id = ?",
              )
              .get(id, rendered.subtopic_id) as Row
          ).id,
        ],
      });
      return reply.code(202).send({
        batchId: job.batchId,
        job: jobSnapshot(job),
        clipping: clippingSnapshot(db, id),
      });
    },
  );
  app.get("/api/clipping/source/:sourceId/preview", async (request, reply) => {
    const { sourceId } = request.params as { sourceId: string };
    const row = db
      .prepare("SELECT * FROM long_video_sources WHERE id = ?")
      .get(sourceId) as Row | undefined;
    if (!row || !fs.existsSync(String(row.source_path)))
      throw new ContentValidationError(
        "SOURCE_NOT_FOUND",
        "Source video is not available.",
      );
    const query = request.query as QueryRecord;
    const startMs = Number(query.startMs);
    const endMs = Number(query.endMs);
    if (
      Number.isFinite(startMs) &&
      Number.isFinite(endMs) &&
      startMs >= 0 &&
      endMs > startMs &&
      startMs < Number(row.duration_ms)
    ) {
      const boundedStartMs = Math.max(0, Math.round(startMs));
      const boundedEndMs = Math.min(
        Number(row.duration_ms),
        Math.round(endMs),
      );
      const previewDirectory = path.join(
        path.dirname(String(row.source_path)),
        ".previews",
      );
      const previewPath = path.join(
        previewDirectory,
        `${sourceId}-${boundedStartMs}-${boundedEndMs}.mp4`,
      );
      if (!fs.existsSync(previewPath)) {
        await fsp.mkdir(previewDirectory, { recursive: true });
        const temporaryPath = `${previewPath}.${process.pid}.tmp`;
        try {
          await renderPreviewSegment({
            ffmpegPath: settings.ffmpegPath,
            sourcePath: String(row.source_path),
            outputPath: temporaryPath,
            startMs: boundedStartMs,
            endMs: boundedEndMs,
          });
          await fsp.rename(temporaryPath, previewPath);
        } finally {
          await fsp.rm(temporaryPath, { force: true });
        }
      }
      return reply
        .type("video/mp4")
        .header("Cache-Control", "private, max-age=3600")
        .send(fs.createReadStream(previewPath));
    }
    return reply
      .type(String(row.mime_type))
      .send(fs.createReadStream(String(row.source_path)));
  });
  app.get(
    "/api/clipping/rendered/:renderedId/preview",
    async (request, reply) => {
      const { renderedId } = request.params as { renderedId: string };
      const row = db
        .prepare(
          "SELECT * FROM rendered_clips WHERE id = ? AND status = 'completed'",
        )
        .get(renderedId) as Row | undefined;
      if (!row || !row.output_path || !fs.existsSync(String(row.output_path)))
        throw new ContentValidationError(
          "RENDERED_CLIP_NOT_FOUND",
          "Rendered clip is not available.",
        );
      return reply
        .type(String(row.mime_type ?? "video/mp4"))
        .send(fs.createReadStream(String(row.output_path)));
    },
  );
  app.get(
    "/api/clipping/rendered/:renderedId/download",
    async (request, reply) => {
      const { renderedId } = request.params as { renderedId: string };
      const row = db
        .prepare(
          "SELECT * FROM rendered_clips WHERE id = ? AND status = 'completed'",
        )
        .get(renderedId) as Row | undefined;
      if (!row || !row.output_path || !fs.existsSync(String(row.output_path)))
        throw new ContentValidationError(
          "RENDERED_CLIP_NOT_FOUND",
          "Rendered clip is not available.",
        );
      return reply
        .header(
          "Content-Disposition",
          `attachment; filename="tokia-clip-${renderedId}.mp4"`,
        )
        .type("video/mp4")
        .send(fs.createReadStream(String(row.output_path)));
    },
  );
  app.get("/api/content/:id/clipping/download-all", async (request, reply) => {
    const { id } = request.params as { id: string };
    contentExists(id);
    const rows = (
      db
        .prepare(
          "SELECT * FROM rendered_clips WHERE content_id = ? AND status = 'completed' ORDER BY created_at",
        )
        .all(id) as Row[]
    ).filter(
      (row) => row.output_path && fs.existsSync(String(row.output_path)),
    );
    if (!rows.length)
      throw new ContentValidationError(
        "NO_RENDERED_CLIPS",
        "No successful rendered clips are available.",
      );
    const files = rows.map((row, index) => ({
      name: `clip-${String(index + 1).padStart(2, "0")}.mp4`,
      path: String(row.output_path),
    }));
    const archive = await createZip(files);
    return reply
      .header(
        "Content-Disposition",
        `attachment; filename="${safeFileName(`clipping-${id}`)}.zip"`,
      )
      .type("application/zip")
      .send(archive);
  });

  function safeFileName(value: string): string {
    return (
      value
        .normalize("NFKD")
        .replace(/[^a-zA-Z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase()
        .slice(0, 80) || "content"
    );
  }

  app.get(
    "/api/search",
    {
      schema: {
        tags: ["search"],
        summary: "Search collections, assets, and projects",
      },
    },
    async (request) => {
      const q = queryOf(request).q?.trim() ?? "";
      if (!q) return { query: "", collections: [], assets: [], projects: [] };
      const value = `%${q}%`;
      const collections = db
        .prepare(
          `SELECT c.*, COUNT(ca.asset_id) AS asset_count FROM collections c LEFT JOIN collection_assets ca ON ca.collection_id = c.id WHERE LOWER(COALESCE(c.local_title, c.name)) LIKE LOWER(?) OR LOWER(COALESCE(c.local_description, c.description, '')) LIKE LOWER(?) GROUP BY c.id ORDER BY c.updated_at DESC LIMIT 8`,
        )
        .all(value, value) as Row[];
      const assets = db
        .prepare(
          `SELECT a.*, GROUP_CONCAT(DISTINCT COALESCE(c.local_title, c.name)) AS collection_name FROM assets a LEFT JOIN collection_assets ca ON ca.asset_id = a.id LEFT JOIN collections c ON c.id = ca.collection_id WHERE LOWER(COALESCE(a.title,'')) LIKE LOWER(?) OR LOWER(COALESCE(a.description,'')) LIKE LOWER(?) OR LOWER(COALESCE(a.external_asset_id,'')) LIKE LOWER(?) GROUP BY a.id ORDER BY a.last_seen_at DESC LIMIT 8`,
        )
        .all(value, value, value) as Row[];
      const projects = db
        .prepare(
          "SELECT * FROM projects WHERE status != 'archived' AND (LOWER(name) LIKE LOWER(?) OR LOWER(COALESCE(description, '')) LIKE LOWER(?)) ORDER BY updated_at DESC LIMIT 8",
        )
        .all(value, value) as Row[];
      return {
        query: q,
        collections: collections.map(toCollection),
        assets: assets.map(toAsset),
        projects: projects.map(toProject),
      };
    },
  );

  app.addHook("onClose", async () => {
    stopContentWorker();
    stopClippingWorker();
    if (ownsDatabase) db.close();
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof IngestionError) {
      request.log.warn(
        { requestId: request.id, code: error.code },
        error.message,
      );
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
          requestId: request.id,
        },
      });
    }
    if (error instanceof ContentValidationError) {
      request.log.warn(
        { requestId: request.id, code: error.code },
        error.message,
      );
      return reply
        .code(
          error.code === "PROJECT_NOT_FOUND" ||
            error.code === "CONTENT_NOT_FOUND"
            ? 404
            : error.code === "CONTENT_BUSY"
              ? 409
              : 400,
        )
        .send({
          error: {
            code: error.code,
            message: error.message,
            requestId: request.id,
          },
        });
    }
    if ((error as { code?: string }).code === "FST_ERR_CTP_BODY_TOO_LARGE")
      return reply.code(413).send({
        error: {
          code: "REQUEST_TOO_LARGE",
          message: "Request body exceeds the configured limit",
          requestId: request.id,
        },
      });
    request.log.error(
      { requestId: request.id, err: error },
      "Unhandled request error",
    );
    return reply.code(500).send({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Internal server error",
        requestId: request.id,
      },
    });
  });
  return app;
}
