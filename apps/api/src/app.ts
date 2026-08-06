import crypto from 'node:crypto';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type Database from 'better-sqlite3';
import { assetStatusSchema, collectionStatusSchema, isPlayableVideoUrl } from '@tokia/shared';
import { config as defaultConfig } from './config.js';
import { createDatabase } from './db.js';
import { getCollection, getImportRun, IngestionError, ingestPinterestBoard } from './ingestion.js';
import { resolvePinterestVideo } from './pinterest-media.js';

type AppSettings = typeof defaultConfig;
type QueryRecord = Record<string, string | undefined>;
type Row = Record<string, unknown>;

function positiveInt(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function queryOf(request: FastifyRequest): QueryRecord { return request.query as QueryRecord; }
function bodyOf(request: FastifyRequest): Record<string, unknown> { return (request.body ?? {}) as Record<string, unknown>; }
function now(): string { return new Date().toISOString(); }
function newId(): string { return crypto.randomUUID(); }
function text(value: unknown, max = 10_000): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}
function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function mediaType(row: Row): string {
  if (row.media_type === 'video' || row.media_type === 'animated') return row.media_type;
  if (typeof row.mime_type === 'string' && row.mime_type.toLowerCase().startsWith('video/')) return 'video';
  return 'image';
}
function orientation(row: Row): string {
  const width = numberValue(row.width);
  const height = numberValue(row.height);
  if (!width || !height) return 'unknown';
  const ratio = width / height;
  if (ratio >= 0.88 && ratio <= 1.12) return 'square';
  return ratio > 1 ? 'landscape' : 'portrait';
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
    updatedAt: row.updated_at
  };
}

function toAsset(row: Row): Row {
  const kind = mediaType(row);
  const imageUrl = row.remote_image_url;
  const mediaUrl = kind === 'video'
    ? (isPlayableVideoUrl(typeof row.remote_media_url === 'string' ? row.remote_media_url : null) ? row.remote_media_url : null)
    : row.remote_media_url ?? imageUrl;
  return {
    id: row.id,
    provider: row.provider,
    externalId: row.external_asset_id,
    canonicalUrl: row.canonical_asset_url,
    mediaUrl,
    remoteImageUrl: imageUrl,
    remotePreviewUrl: row.remote_preview_url,
    thumbnailUrl: row.remote_preview_url ?? (kind === 'image' ? imageUrl : null),
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
    aspectRatio: row.width && row.height ? Number(row.width) / Number(row.height) : null,
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
    updatedAt: row.updated_at
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
    createdAt: row.created_at
  };
}

function toProject(row: Row): Row {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    coverAssetId: row.cover_asset_id,
    config: row.config_json ? JSON.parse(String(row.config_json)) : null,
    collectionCount: Number(row.collection_count ?? 0),
    totalAssets: Number(row.total_assets ?? 0),
    imageCount: Number(row.image_count ?? 0),
    videoCount: Number(row.video_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at
  };
}

function integrationGuard(settings: AppSettings, request: FastifyRequest, reply: FastifyReply): boolean {
  const provided = request.headers['x-local-integration-token'];
  if (typeof provided !== 'string' || provided !== settings.localIntegrationToken) {
    reply.code(401).send({ error: { code: 'INVALID_INTEGRATION_TOKEN', message: 'A valid local integration token is required' } });
    return false;
  }
  return true;
}

function collectionWhere(query: QueryRecord): { clauses: string[]; params: unknown[] } {
  const clauses = ['c.provider = ?'];
  const params: unknown[] = [query.provider?.trim() || 'pinterest'];
  if (query.search?.trim()) {
    const value = `%${query.search.trim()}%`;
    clauses.push('(LOWER(COALESCE(c.local_title, c.name)) LIKE LOWER(?) OR LOWER(COALESCE(c.local_description, c.description, \'\')) LIKE LOWER(?))');
    params.push(value, value);
  }
  if (query.status?.trim()) { clauses.push('c.status = ?'); params.push(query.status.trim()); }
  if (query.hasImages === 'true') clauses.push("EXISTS (SELECT 1 FROM collection_assets ca_filter JOIN assets a_filter ON a_filter.id = ca_filter.asset_id WHERE ca_filter.collection_id = c.id AND a_filter.media_type IN ('image', 'animated'))");
  if (query.hasVideos === 'true') clauses.push("EXISTS (SELECT 1 FROM collection_assets ca_filter JOIN assets a_filter ON a_filter.id = ca_filter.asset_id WHERE ca_filter.collection_id = c.id AND a_filter.media_type = 'video')");
  return { clauses, params };
}

function buildCollectionsQuery(query: QueryRecord): { sql: string; params: unknown[]; page: number; pageSize: number; where: string; whereParams: unknown[] } {
  const page = positiveInt(query.page, 1, 1_000_000);
  const pageSize = positiveInt(query.pageSize, 24, 100);
  const built = collectionWhere(query);
  const sortMap: Record<string, string> = {
    name: 'COALESCE(c.local_title, c.name) COLLATE NOCASE',
    createdAt: 'c.created_at',
    updatedAt: 'c.updated_at',
    lastImportedAt: 'c.last_imported_at',
    assetCount: 'asset_count',
    imageCount: 'image_count',
    videoCount: 'video_count'
  };
  const sort = sortMap[query.sort ?? ''] ?? 'c.updated_at';
  const order = query.order?.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const where = built.clauses.join(' AND ');
  return {
    sql: `FROM collections c LEFT JOIN collection_assets ca ON ca.collection_id = c.id LEFT JOIN assets a ON a.id = ca.asset_id WHERE ${where} GROUP BY c.id ORDER BY ${sort} ${order} LIMIT ? OFFSET ?`,
    params: [...built.params, pageSize, (page - 1) * pageSize],
    page,
    pageSize,
    where,
    whereParams: built.params
  };
}

function assetWhere(query: QueryRecord): { clauses: string[]; params: unknown[] } {
  const clauses = ['a.provider = ?'];
  const params: unknown[] = [query.provider?.trim() || 'pinterest'];
  if (query.collectionId) { clauses.push('ca.collection_id = ?'); params.push(query.collectionId); }
  if (query.search?.trim()) {
    const value = `%${query.search.trim()}%`;
    clauses.push(`(LOWER(COALESCE(a.title, '')) LIKE LOWER(?) OR LOWER(COALESCE(a.description, '')) LIKE LOWER(?) OR LOWER(COALESCE(a.alt_text, '')) LIKE LOWER(?) OR LOWER(COALESCE(a.external_asset_id, '')) LIKE LOWER(?))`);
    params.push(value, value, value, value);
  }
  if (query.mediaType && ['image', 'video', 'animated'].includes(query.mediaType)) { clauses.push('a.media_type = ?'); params.push(query.mediaType); }
  if (query.status) { clauses.push('a.status = ?'); params.push(query.status); }
  if (query.orientation === 'portrait') clauses.push('a.height > a.width');
  if (query.orientation === 'landscape') clauses.push('a.width > a.height');
  if (query.orientation === 'square') clauses.push('a.width IS NOT NULL AND a.height IS NOT NULL AND ABS((1.0 * a.width / a.height) - 1) <= 0.12');
  const minWidth = Number(query.minWidth); if (Number.isInteger(minWidth) && minWidth > 0) { clauses.push('a.width >= ?'); params.push(minWidth); }
  const minHeight = Number(query.minHeight); if (Number.isInteger(minHeight) && minHeight > 0) { clauses.push('a.height >= ?'); params.push(minHeight); }
  const minDuration = Number(query.minDuration); if (Number.isFinite(minDuration) && minDuration >= 0) { clauses.push('a.duration_seconds >= ?'); params.push(minDuration); }
  const maxDuration = Number(query.maxDuration); if (Number.isFinite(maxDuration) && maxDuration >= 0) { clauses.push('a.duration_seconds <= ?'); params.push(maxDuration); }
  if (query.dateFrom) { clauses.push('a.created_at >= ?'); params.push(query.dateFrom); }
  if (query.dateTo) { clauses.push('a.created_at <= ?'); params.push(query.dateTo); }
  if (query.includeArchived !== 'true') clauses.push('a.archived_at IS NULL');
  return { clauses, params };
}

function buildAssetsQuery(query: QueryRecord): { sql: string; params: unknown[]; page: number; pageSize: number; where: string; whereParams: unknown[] } {
  const page = positiveInt(query.page, 1, 1_000_000);
  const pageSize = positiveInt(query.pageSize, 48, 100);
  const built = assetWhere(query);
  const sortMap: Record<string, string> = { newest: 'a.created_at', seen: 'a.last_seen_at', dimensions: 'COALESCE(a.width, 0) * COALESCE(a.height, 0)', duration: 'COALESCE(a.duration_seconds, 0)', title: 'a.title COLLATE NOCASE' };
  const sort = sortMap[query.sort ?? ''] ?? 'a.last_seen_at';
  const order = query.order?.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const where = built.clauses.join(' AND ');
  return {
    sql: `FROM assets a LEFT JOIN collection_assets ca ON ca.asset_id = a.id LEFT JOIN collections c ON c.id = ca.collection_id WHERE ${where} GROUP BY a.id ORDER BY ${sort} ${order} LIMIT ? OFFSET ?`,
    params: [...built.params, pageSize, (page - 1) * pageSize],
    page,
    pageSize,
    where,
    whereParams: built.params
  };
}

function pagination(page: number, pageSize: number, total: number): Row { return { page, pageSize, total, totalPages: Math.ceil(total / pageSize) }; }

function projectSnapshot(db: Database.Database, id: string): Row | undefined {
  const row = db.prepare(`SELECT p.*, COUNT(DISTINCT pc.collection_id) AS collection_count,
    COUNT(DISTINCT ca.asset_id) AS total_assets,
    COUNT(DISTINCT CASE WHEN a.media_type IN ('image', 'animated') THEN a.id END) AS image_count,
    COUNT(DISTINCT CASE WHEN a.media_type = 'video' THEN a.id END) AS video_count
    FROM projects p
    LEFT JOIN project_collections pc ON pc.project_id = p.id
    LEFT JOIN collection_assets ca ON ca.collection_id = pc.collection_id
    LEFT JOIN assets a ON a.id = ca.asset_id AND a.archived_at IS NULL
    WHERE p.id = ? GROUP BY p.id`).get(id) as Row | undefined;
  if (!row) return undefined;
  const collections = db.prepare(`SELECT c.*, COUNT(ca.asset_id) AS asset_count,
    SUM(CASE WHEN a.media_type IN ('image', 'animated') THEN 1 ELSE 0 END) AS image_count,
    SUM(CASE WHEN a.media_type = 'video' THEN 1 ELSE 0 END) AS video_count,
    pc.weight, pc.enabled, pc.allowed_media_types, pc.selection_priority
    FROM project_collections pc JOIN collections c ON c.id = pc.collection_id
    LEFT JOIN collection_assets ca ON ca.collection_id = c.id LEFT JOIN assets a ON a.id = ca.asset_id
    WHERE pc.project_id = ? GROUP BY c.id ORDER BY c.updated_at DESC`).all(id) as Row[];
  const recentAssets = db.prepare(`SELECT a.*, GROUP_CONCAT(DISTINCT COALESCE(c.local_title, c.name)) AS collection_name
    FROM project_collections pc JOIN collection_assets ca ON ca.collection_id = pc.collection_id
    JOIN assets a ON a.id = ca.asset_id LEFT JOIN collections c ON c.id = ca.collection_id
    WHERE pc.project_id = ? AND a.archived_at IS NULL GROUP BY a.id ORDER BY a.last_seen_at DESC LIMIT 8`).all(id) as Row[];
  return { ...toProject(row), collections: collections.map(toCollection), recentAssets: recentAssets.map(toAsset) };
}

export async function buildApp(options: { db?: Database.Database; settings?: AppSettings } = {}): Promise<FastifyInstance> {
  const settings = options.settings ?? defaultConfig;
  const db = options.db ?? createDatabase(settings.databasePath);
  const ownsDatabase = !options.db;
  const app = Fastify({ logger: { level: settings.logLevel }, bodyLimit: settings.maxRequestBytes, requestIdHeader: 'x-request-id', genReqId: () => crypto.randomUUID() });

  await app.register(cors, { origin: (origin, callback) => callback(null, !origin || settings.corsAllowedOrigins.includes(origin)), methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'X-Local-Integration-Token', 'X-Request-Id'] });
  await app.register(swagger, { openapi: { info: { title: 'Tokia Local Media API', version: '0.2.0', description: 'Local-first media library, imports, and project API.' }, servers: [{ url: `http://${settings.host}:${settings.port}` }], tags: [{ name: 'diagnostics' }, { name: 'dashboard' }, { name: 'collections' }, { name: 'assets' }, { name: 'projects' }, { name: 'imports' }, { name: 'search' }] } });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.get('/api/health', { schema: { tags: ['diagnostics'], summary: 'Health check' } }, async () => ({ status: 'ok', service: 'tokia-api', database: 'sqlite', integrationTokenConfigured: Boolean(settings.localIntegrationToken), timestamp: now() }));
  app.get('/api/settings', { schema: { tags: ['diagnostics'], summary: 'Non-sensitive local runtime settings' } }, async () => ({ applicationVersion: '0.2.0', backendVersion: '0.2.0', database: 'sqlite', databaseFile: path.basename(settings.databasePath), backendBaseUrl: `http://${settings.host}:${settings.port}`, integrationTokenConfigured: Boolean(settings.localIntegrationToken), maxPinsPerImport: settings.maxPinsPerImport }));

  app.get('/api/dashboard', { schema: { tags: ['dashboard'], summary: 'Dashboard overview' } }, async () => {
    const stats = db.prepare(`SELECT
      (SELECT COUNT(*) FROM collections) AS total_collections,
      (SELECT COUNT(*) FROM assets) AS total_assets,
      (SELECT COUNT(*) FROM assets WHERE media_type IN ('image', 'animated')) AS total_images,
      (SELECT COUNT(*) FROM assets WHERE media_type = 'video') AS total_videos,
      (SELECT COUNT(*) FROM projects WHERE status != 'archived') AS total_projects,
      (SELECT COUNT(*) FROM import_runs WHERE status IN ('failed', 'completed_with_warnings')) AS attention_imports`).get() as Row;
    const recentCollections = db.prepare(`SELECT c.*, COUNT(ca.asset_id) AS asset_count, SUM(CASE WHEN a.media_type IN ('image','animated') THEN 1 ELSE 0 END) AS image_count, SUM(CASE WHEN a.media_type = 'video' THEN 1 ELSE 0 END) AS video_count FROM collections c LEFT JOIN collection_assets ca ON ca.collection_id = c.id LEFT JOIN assets a ON a.id = ca.asset_id GROUP BY c.id ORDER BY c.updated_at DESC LIMIT 5`).all() as Row[];
    const recentAssets = db.prepare(`SELECT a.*, COALESCE(c.local_title, c.name) AS collection_name FROM assets a LEFT JOIN collection_assets ca ON ca.asset_id = a.id LEFT JOIN collections c ON c.id = ca.collection_id GROUP BY a.id ORDER BY a.created_at DESC LIMIT 8`).all() as Row[];
    const recentImports = db.prepare(`SELECT r.*, COALESCE(c.local_title, c.name) AS collection_name FROM import_runs r LEFT JOIN collections c ON c.id = r.collection_id ORDER BY r.created_at DESC LIMIT 6`).all() as Row[];
    const distribution = db.prepare(`SELECT media_type, COUNT(*) AS count FROM assets GROUP BY media_type`).all() as Row[];
    const topCollections = db.prepare(`SELECT c.*, COUNT(ca.asset_id) AS asset_count, SUM(CASE WHEN a.media_type IN ('image','animated') THEN 1 ELSE 0 END) AS image_count, SUM(CASE WHEN a.media_type = 'video' THEN 1 ELSE 0 END) AS video_count FROM collections c LEFT JOIN collection_assets ca ON ca.collection_id = c.id LEFT JOIN assets a ON a.id = ca.asset_id GROUP BY c.id ORDER BY asset_count DESC LIMIT 5`).all() as Row[];
    return { stats: { totalCollections: Number(stats.total_collections), totalAssets: Number(stats.total_assets), totalImages: Number(stats.total_images), totalVideos: Number(stats.total_videos), totalProjects: Number(stats.total_projects), attentionImports: Number(stats.attention_imports) }, recentCollections: recentCollections.map(toCollection), recentAssets: recentAssets.map(toAsset), recentImports: recentImports.map(toImportRun), topCollections: topCollections.map(toCollection), mediaDistribution: distribution.map((row) => ({ mediaType: row.media_type, count: Number(row.count) })) };
  });

  app.post('/api/imports/pinterest-board', { schema: { tags: ['imports'], summary: 'Import a versioned Pinterest board payload' } }, async (request, reply) => {
    if (!integrationGuard(settings, request, reply)) return;
    return reply.code(200).send(ingestPinterestBoard(db, request.body, settings.maxPinsPerImport));
  });

  app.get('/api/collections', { schema: { tags: ['collections'], summary: 'List collections' } }, async (request) => {
    const built = buildCollectionsQuery(queryOf(request));
    const total = (db.prepare(`SELECT COUNT(DISTINCT c.id) AS count FROM collections c LEFT JOIN collection_assets ca ON ca.collection_id = c.id LEFT JOIN assets a ON a.id = ca.asset_id WHERE ${built.where}`).get(...built.whereParams) as { count: number }).count;
    const rows = db.prepare(`SELECT c.*, COUNT(ca.asset_id) AS asset_count, SUM(CASE WHEN a.media_type IN ('image','animated') THEN 1 ELSE 0 END) AS image_count, SUM(CASE WHEN a.media_type = 'video' THEN 1 ELSE 0 END) AS video_count,
      (SELECT CASE WHEN a2.media_type IN ('image', 'animated') THEN COALESCE(a2.remote_media_url, a2.remote_image_url, a2.remote_preview_url) ELSE COALESCE(a2.remote_image_url, a2.remote_preview_url) END FROM collection_assets ca2 JOIN assets a2 ON a2.id = ca2.asset_id WHERE ca2.collection_id = c.id ORDER BY ca2.last_seen_at DESC LIMIT 1) AS cover_preview_url,
      (SELECT a2.media_type FROM collection_assets ca2 JOIN assets a2 ON a2.id = ca2.asset_id WHERE ca2.collection_id = c.id ORDER BY ca2.last_seen_at DESC LIMIT 1) AS cover_media_type
      ${built.sql}`).all(...built.params) as Row[];
    return { items: rows.map(toCollection), pagination: pagination(built.page, built.pageSize, total) };
  });

  app.get('/api/collections/:id', { schema: { tags: ['collections'], summary: 'Get collection details' } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = getCollection(db, id);
    if (!row) return reply.code(404).send({ error: { code: 'COLLECTION_NOT_FOUND', message: 'Collection not found' } });
    const counts = db.prepare(`SELECT COUNT(*) AS asset_count, SUM(CASE WHEN a.media_type IN ('image','animated') THEN 1 ELSE 0 END) AS image_count, SUM(CASE WHEN a.media_type = 'video' THEN 1 ELSE 0 END) AS video_count FROM collection_assets ca JOIN assets a ON a.id = ca.asset_id WHERE ca.collection_id = ?`).get(id) as Row;
    const cover = row.cover_asset_id
      ? db.prepare('SELECT * FROM assets WHERE id = ?').get(row.cover_asset_id) as Row | undefined
      : db.prepare('SELECT a.* FROM collection_assets ca JOIN assets a ON a.id = ca.asset_id WHERE ca.collection_id = ? ORDER BY ca.last_seen_at DESC LIMIT 1').get(id) as Row | undefined;
    return { ...toCollection({ ...row, ...counts }), cover: cover ? toAsset(cover) : null };
  });

  app.get('/api/collections/:id/assets', { schema: { tags: ['assets'], summary: 'List assets in a collection' } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!getCollection(db, id)) return reply.code(404).send({ error: { code: 'COLLECTION_NOT_FOUND', message: 'Collection not found' } });
    const query = { ...queryOf(request), collectionId: id };
    const built = buildAssetsQuery(query);
    const total = (db.prepare(`SELECT COUNT(DISTINCT a.id) AS count FROM assets a LEFT JOIN collection_assets ca ON ca.asset_id = a.id LEFT JOIN collections c ON c.id = ca.collection_id WHERE ${built.where}`).get(...built.whereParams) as { count: number }).count;
    const rows = db.prepare(`SELECT a.*, ca.first_seen_at AS membership_first_seen_at, ca.last_seen_at AS membership_last_seen_at, COALESCE(c.local_title, c.name) AS collection_name ${built.sql}`).all(...built.params) as Row[];
    return { items: rows.map(toAsset), pagination: pagination(built.page, built.pageSize, total) };
  });

  app.get('/api/collections/:id/import-runs', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!getCollection(db, id)) return reply.code(404).send({ error: { code: 'COLLECTION_NOT_FOUND', message: 'Collection not found' } });
    const rows = db.prepare(`SELECT r.*, COALESCE(c.local_title, c.name) AS collection_name FROM import_runs r LEFT JOIN collections c ON c.id = r.collection_id WHERE r.collection_id = ? ORDER BY r.created_at DESC`).all(id) as Row[];
    return { items: rows.map(toImportRun) };
  });

  app.get('/api/assets', { schema: { tags: ['assets'], summary: 'List and filter assets across collections' } }, async (request) => {
    const built = buildAssetsQuery(queryOf(request));
    const total = (db.prepare(`SELECT COUNT(DISTINCT a.id) AS count FROM assets a LEFT JOIN collection_assets ca ON ca.asset_id = a.id LEFT JOIN collections c ON c.id = ca.collection_id WHERE ${built.where}`).get(...built.whereParams) as { count: number }).count;
    const rows = db.prepare(`SELECT a.*, GROUP_CONCAT(DISTINCT COALESCE(c.local_title, c.name)) AS collection_name ${built.sql}`).all(...built.params) as Row[];
    return { items: rows.map(toAsset), pagination: pagination(built.page, built.pageSize, total) };
  });

  app.get('/api/assets/:id', { schema: { tags: ['assets'], summary: 'Get asset detail' } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as Row | undefined;
    if (!row) return reply.code(404).send({ error: { code: 'ASSET_NOT_FOUND', message: 'Asset not found' } });
    const collections = db.prepare(`SELECT c.*, COUNT(ca2.asset_id) AS asset_count FROM collection_assets ca JOIN collections c ON c.id = ca.collection_id LEFT JOIN collection_assets ca2 ON ca2.collection_id = c.id WHERE ca.asset_id = ? GROUP BY c.id`).all(id) as Row[];
    return { ...toAsset(row), collections: collections.map(toCollection) };
  });

  app.post('/api/assets/:id/resolve-media', { schema: { tags: ['assets'], summary: 'Resolve deferred Pinterest video media' } }, async (request, reply) => {
    if (!integrationGuard(settings, request, reply)) return;
    const { id } = request.params as { id: string };
    const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as Row | undefined;
    if (!row) return reply.code(404).send({ error: { code: 'ASSET_NOT_FOUND', message: 'Asset not found' } });
    if (mediaType(row) !== 'video') return reply.code(422).send({ error: { code: 'ASSET_IS_NOT_VIDEO', message: 'Only video assets can resolve media' } });
    if (isPlayableVideoUrl(typeof row.remote_media_url === 'string' ? row.remote_media_url : null)) return toAsset(row);
    if (typeof row.canonical_asset_url !== 'string' || !row.canonical_asset_url) return reply.code(422).send({ error: { code: 'VIDEO_SOURCE_UNAVAILABLE', message: 'This video has no Pinterest source URL' } });
    const resolved = await resolvePinterestVideo(row.canonical_asset_url);
    if (!resolved.mediaUrl) return reply.code(422).send({ error: { code: 'VIDEO_SOURCE_UNAVAILABLE', message: 'Pinterest did not expose a playable video URL for this Pin' } });
    db.prepare(`UPDATE assets SET
      remote_media_url = ?,
      remote_preview_url = COALESCE(?, remote_preview_url),
      mime_type = COALESCE(?, mime_type),
      duration_seconds = COALESCE(?, duration_seconds),
      updated_at = ?
      WHERE id = ?`).run(resolved.mediaUrl, resolved.posterUrl, resolved.mimeType, resolved.durationSeconds, now(), id);
    return toAsset(db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as Row);
  });

  app.get('/api/import-runs', { schema: { tags: ['imports'], summary: 'List import runs' } }, async (request) => {
    const query = queryOf(request); const page = positiveInt(query.page, 1, 1_000_000); const pageSize = positiveInt(query.pageSize, 30, 100);
    const clauses: string[] = []; const params: unknown[] = [];
    if (query.collectionId) { clauses.push('r.collection_id = ?'); params.push(query.collectionId); }
    if (query.status) { clauses.push('r.status = ?'); params.push(query.status); }
    if (query.search?.trim()) { clauses.push('(LOWER(COALESCE(c.name, \'\')) LIKE LOWER(?) OR LOWER(r.source_url) LIKE LOWER(?))'); const value = `%${query.search.trim()}%`; params.push(value, value); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = (db.prepare(`SELECT COUNT(*) AS count FROM import_runs r LEFT JOIN collections c ON c.id = r.collection_id ${where}`).get(...params) as { count: number }).count;
    const rows = db.prepare(`SELECT r.*, COALESCE(c.local_title, c.name) AS collection_name FROM import_runs r LEFT JOIN collections c ON c.id = r.collection_id ${where} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize) as Row[];
    return { items: rows.map(toImportRun), pagination: pagination(page, pageSize, total) };
  });

  app.get('/api/import-runs/:id', { schema: { tags: ['imports'], summary: 'Get an import run' } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = getImportRun(db, id);
    if (!row) return reply.code(404).send({ error: { code: 'IMPORT_RUN_NOT_FOUND', message: 'Import run not found' } });
    return toImportRun({ ...row, collection_name: row.collection_id ? (db.prepare('SELECT COALESCE(local_title, name) AS name FROM collections WHERE id = ?').get(row.collection_id) as Row | undefined)?.name : null });
  });

  app.patch('/api/assets/:id', { schema: { tags: ['assets'], summary: 'Update asset lifecycle and local metadata' } }, async (request, reply) => {
    if (!integrationGuard(settings, request, reply)) return;
    const { id } = request.params as { id: string }; const body = bodyOf(request);
    const parsed = body.status === undefined ? null : assetStatusSchema.safeParse(body.status);
    if (parsed && !parsed.success) return reply.code(400).send({ error: { code: 'INVALID_ASSET_STATUS', message: 'Invalid asset status' } });
    const existing = db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as Row | undefined;
    if (!existing) return reply.code(404).send({ error: { code: 'ASSET_NOT_FOUND', message: 'Asset not found' } });
    const nextStatus = parsed?.success ? parsed.data : existing.status;
    const notes = body.localNotes === undefined ? existing.local_notes : text(body.localNotes);
    const tags = body.localTags === undefined ? existing.local_tags : text(body.localTags, 2_000);
    const archivedAt = body.archived === true ? now() : body.archived === false ? null : existing.archived_at;
    db.prepare('UPDATE assets SET status = ?, local_notes = ?, local_tags = ?, archived_at = ?, updated_at = ? WHERE id = ?').run(nextStatus, notes, tags, archivedAt, now(), id);
    return toAsset(db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as Row);
  });

  app.patch('/api/collections/:id', { schema: { tags: ['collections'], summary: 'Update collection metadata or lifecycle' } }, async (request, reply) => {
    if (!integrationGuard(settings, request, reply)) return;
    const { id } = request.params as { id: string }; const body = bodyOf(request);
    const existing = getCollection(db, id);
    if (!existing) return reply.code(404).send({ error: { code: 'COLLECTION_NOT_FOUND', message: 'Collection not found' } });
    const parsed = body.status === undefined ? null : collectionStatusSchema.safeParse(body.status);
    if (parsed && !parsed.success) return reply.code(400).send({ error: { code: 'INVALID_COLLECTION_STATUS', message: 'Invalid collection status' } });
    const localTitle = body.localTitle === undefined ? existing.local_title : text(body.localTitle, 500);
    if (body.localTitle !== undefined && !localTitle) return reply.code(400).send({ error: { code: 'INVALID_COLLECTION_TITLE', message: 'A local title is required when provided' } });
    const localDescription = body.localDescription === undefined ? existing.local_description : text(body.localDescription);
    const coverAssetId = body.coverAssetId === undefined ? existing.cover_asset_id : text(body.coverAssetId, 100);
    if (coverAssetId && !db.prepare('SELECT 1 FROM collection_assets WHERE collection_id = ? AND asset_id = ?').get(id, coverAssetId)) return reply.code(400).send({ error: { code: 'INVALID_COLLECTION_COVER', message: 'Cover asset must belong to the collection' } });
    const status = parsed?.success ? parsed.data : existing.status;
    const archivedAt = status === 'disabled' ? (existing.archived_at ?? now()) : null;
    db.prepare('UPDATE collections SET status = ?, local_title = ?, local_description = ?, cover_asset_id = ?, archived_at = ?, updated_at = ? WHERE id = ?').run(status, localTitle, localDescription, coverAssetId, archivedAt, now(), id);
    const row = getCollection(db, id)!;
    return toCollection(row);
  });

  app.get('/api/projects', { schema: { tags: ['projects'], summary: 'List projects' } }, async (request) => {
    const query = queryOf(request); const page = positiveInt(query.page, 1, 100_000); const pageSize = positiveInt(query.pageSize, 24, 100);
    const clauses = ['1 = 1']; const params: unknown[] = [];
    if (query.search?.trim()) { clauses.push('LOWER(p.name) LIKE LOWER(?)'); params.push(`%${query.search.trim()}%`); }
    if (query.status) { clauses.push('p.status = ?'); params.push(query.status); }
    const where = clauses.join(' AND ');
    const total = (db.prepare(`SELECT COUNT(*) AS count FROM projects p WHERE ${where}`).get(...params) as { count: number }).count;
    const rows = db.prepare(`SELECT p.*, COUNT(DISTINCT pc.collection_id) AS collection_count, COUNT(DISTINCT ca.asset_id) AS total_assets, COUNT(DISTINCT CASE WHEN a.media_type IN ('image','animated') THEN a.id END) AS image_count, COUNT(DISTINCT CASE WHEN a.media_type = 'video' THEN a.id END) AS video_count FROM projects p LEFT JOIN project_collections pc ON pc.project_id = p.id LEFT JOIN collection_assets ca ON ca.collection_id = pc.collection_id LEFT JOIN assets a ON a.id = ca.asset_id AND a.archived_at IS NULL WHERE ${where} GROUP BY p.id ORDER BY p.updated_at DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize) as Row[];
    return { items: rows.map(toProject), pagination: pagination(page, pageSize, total) };
  });

  app.get('/api/projects/:id', { schema: { tags: ['projects'], summary: 'Get project details' } }, async (request, reply) => {
    const { id } = request.params as { id: string }; const project = projectSnapshot(db, id);
    if (!project) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' } });
    return project;
  });

  function collectionIdsFrom(body: Row): string[] {
    return Array.isArray(body.collectionIds) ? body.collectionIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0) : [];
  }
  function validateCollections(ids: string[]): void {
    const unique = [...new Set(ids)];
    if (unique.length !== ids.length) throw new IngestionError('Duplicate collection associations are not allowed', 400, 'DUPLICATE_PROJECT_COLLECTION');
    const found = db.prepare(`SELECT COUNT(*) AS count FROM collections WHERE id IN (${unique.map(() => '?').join(',') || "''"})`).get(...unique) as { count: number };
    if (found.count !== unique.length) throw new IngestionError('One or more collections do not exist', 400, 'COLLECTION_NOT_FOUND');
  }

  app.post('/api/projects', { schema: { tags: ['projects'], summary: 'Create a project' } }, async (request, reply) => {
    if (!integrationGuard(settings, request, reply)) return;
    const body = bodyOf(request); const name = text(body.name, 200); if (!name) return reply.code(400).send({ error: { code: 'INVALID_PROJECT_NAME', message: 'Project name is required' } });
    const ids = collectionIdsFrom(body); validateCollections(ids);
    const status = body.status === 'active' || body.status === 'archived' ? body.status : 'draft'; const timestamp = now(); const id = newId();
    const configJson = body.config && typeof body.config === 'object' ? JSON.stringify(body.config) : null;
    db.transaction(() => {
      db.prepare('INSERT INTO projects(id, name, description, status, cover_asset_id, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, name, text(body.description), status, text(body.coverAssetId, 100), configJson, timestamp, timestamp);
      const insert = db.prepare('INSERT INTO project_collections(project_id, collection_id, created_at) VALUES (?, ?, ?)'); for (const collectionId of ids) insert.run(id, collectionId, timestamp);
    })();
    return reply.code(201).send(projectSnapshot(db, id));
  });

  app.patch('/api/projects/:id', { schema: { tags: ['projects'], summary: 'Update a project' } }, async (request, reply) => {
    if (!integrationGuard(settings, request, reply)) return;
    const { id } = request.params as { id: string }; const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined; if (!existing) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' } });
    const body = bodyOf(request); const name = body.name === undefined ? existing.name : text(body.name, 200); if (!name) return reply.code(400).send({ error: { code: 'INVALID_PROJECT_NAME', message: 'Project name is required' } });
    const status = body.status === 'active' || body.status === 'archived' || body.status === 'draft' ? body.status : existing.status; const ids = body.collectionIds === undefined ? null : collectionIdsFrom(body); if (ids) validateCollections(ids);
    const timestamp = now(); db.transaction(() => { db.prepare('UPDATE projects SET name = ?, description = ?, status = ?, cover_asset_id = ?, config_json = ?, updated_at = ?, archived_at = ? WHERE id = ?').run(name, body.description === undefined ? existing.description : text(body.description), status, body.coverAssetId === undefined ? existing.cover_asset_id : text(body.coverAssetId, 100), body.config === undefined ? existing.config_json : JSON.stringify(body.config), timestamp, status === 'archived' ? (existing.archived_at ?? timestamp) : null, id); if (ids) { db.prepare('DELETE FROM project_collections WHERE project_id = ?').run(id); const insert = db.prepare('INSERT INTO project_collections(project_id, collection_id, created_at) VALUES (?, ?, ?)'); for (const collectionId of ids) insert.run(id, collectionId, timestamp); } })();
    return projectSnapshot(db, id);
  });

  app.post('/api/projects/:id/collections', { schema: { tags: ['projects'], summary: 'Associate collections with a project' } }, async (request, reply) => {
    if (!integrationGuard(settings, request, reply)) return;
    const { id } = request.params as { id: string }; if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id)) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' } });
    const ids = collectionIdsFrom(bodyOf(request)); validateCollections(ids); const insert = db.prepare('INSERT OR IGNORE INTO project_collections(project_id, collection_id, created_at) VALUES (?, ?, ?)'); const timestamp = now(); db.transaction(() => { for (const collectionId of ids) insert.run(id, collectionId, timestamp); })(); return projectSnapshot(db, id);
  });

  app.delete('/api/projects/:id/collections/:collectionId', { schema: { tags: ['projects'], summary: 'Remove a collection from a project' } }, async (request, reply) => {
    if (!integrationGuard(settings, request, reply)) return;
    const { id, collectionId } = request.params as { id: string; collectionId: string }; if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id)) return reply.code(404).send({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' } }); db.prepare('DELETE FROM project_collections WHERE project_id = ? AND collection_id = ?').run(id, collectionId); db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now(), id); return projectSnapshot(db, id);
  });

  app.get('/api/search', { schema: { tags: ['search'], summary: 'Search collections, assets, and projects' } }, async (request) => {
    const q = queryOf(request).q?.trim() ?? ''; if (!q) return { query: '', collections: [], assets: [], projects: [] }; const value = `%${q}%`;
    const collections = db.prepare(`SELECT c.*, COUNT(ca.asset_id) AS asset_count FROM collections c LEFT JOIN collection_assets ca ON ca.collection_id = c.id WHERE LOWER(COALESCE(c.local_title, c.name)) LIKE LOWER(?) OR LOWER(COALESCE(c.local_description, c.description, '')) LIKE LOWER(?) GROUP BY c.id ORDER BY c.updated_at DESC LIMIT 8`).all(value, value) as Row[];
    const assets = db.prepare(`SELECT a.*, GROUP_CONCAT(DISTINCT COALESCE(c.local_title, c.name)) AS collection_name FROM assets a LEFT JOIN collection_assets ca ON ca.asset_id = a.id LEFT JOIN collections c ON c.id = ca.collection_id WHERE LOWER(COALESCE(a.title,'')) LIKE LOWER(?) OR LOWER(COALESCE(a.description,'')) LIKE LOWER(?) OR LOWER(COALESCE(a.external_asset_id,'')) LIKE LOWER(?) GROUP BY a.id ORDER BY a.last_seen_at DESC LIMIT 8`).all(value, value, value) as Row[];
    const projects = db.prepare('SELECT * FROM projects WHERE LOWER(name) LIKE LOWER(?) OR LOWER(COALESCE(description, \'\')) LIKE LOWER(?) ORDER BY updated_at DESC LIMIT 8').all(value, value) as Row[];
    return { query: q, collections: collections.map(toCollection), assets: assets.map(toAsset), projects: projects.map(toProject) };
  });

  app.addHook('onClose', async () => { if (ownsDatabase) db.close(); });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof IngestionError) { request.log.warn({ requestId: request.id, code: error.code }, error.message); return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details, requestId: request.id } }); }
    if ((error as { code?: string }).code === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.code(413).send({ error: { code: 'REQUEST_TOO_LARGE', message: 'Request body exceeds the configured limit', requestId: request.id } });
    request.log.error({ requestId: request.id, err: error }, 'Unhandled request error'); return reply.code(500).send({ error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error', requestId: request.id } });
  });
  return app;
}
