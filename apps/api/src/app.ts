import crypto from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type Database from 'better-sqlite3';
import { assetStatusSchema, collectionStatusSchema } from '@tokia/shared';
import { config as defaultConfig } from './config.js';
import { createDatabase } from './db.js';
import { getCollection, getImportRun, IngestionError, ingestPinterestBoard } from './ingestion.js';

type AppSettings = typeof defaultConfig;

type QueryRecord = Record<string, string | undefined>;

function positiveInt(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function queryOf(request: FastifyRequest): QueryRecord {
  return request.query as QueryRecord;
}

function toCollection(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    provider: row.provider,
    externalId: row.external_id,
    canonicalSourceUrl: row.canonical_source_url,
    name: row.name,
    description: row.description,
    status: row.status,
    assetCount: Number(row.asset_count ?? 0),
    lastImportedAt: row.last_imported_at,
    lastSuccessfulImportAt: row.last_successful_import_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toAsset(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    provider: row.provider,
    externalId: row.external_asset_id,
    canonicalUrl: row.canonical_asset_url,
    remoteImageUrl: row.remote_image_url,
    remotePreviewUrl: row.remote_preview_url,
    normalizedImageKey: row.normalized_image_key,
    title: row.title,
    description: row.description,
    altText: row.alt_text,
    sourceLink: row.source_link,
    width: row.width,
    height: row.height,
    mimeType: row.mime_type,
    status: row.status,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toImportRun(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    provider: row.provider,
    collectionId: row.collection_id,
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

function integrationGuard(settings: AppSettings, request: FastifyRequest, reply: FastifyReply): boolean {
  const provided = request.headers['x-local-integration-token'];
  if (typeof provided !== 'string' || provided !== settings.localIntegrationToken) {
    reply.code(401).send({ error: { code: 'INVALID_INTEGRATION_TOKEN', message: 'A valid local integration token is required' } });
    return false;
  }
  return true;
}

function buildCollectionsQuery(query: QueryRecord): { sql: string; params: unknown[]; page: number; pageSize: number } {
  const page = positiveInt(query.page, 1, 1_000_000);
  const pageSize = positiveInt(query.pageSize, 50, 100);
  const clauses = ['c.provider = ?'];
  const params: unknown[] = ['pinterest'];
  if (query.search?.trim()) {
    clauses.push('(LOWER(c.name) LIKE LOWER(?) OR LOWER(COALESCE(c.description, \'\')) LIKE LOWER(?))');
    const value = `%${query.search.trim()}%`;
    params.push(value, value);
  }
  if (query.provider?.trim()) {
    clauses[0] = 'c.provider = ?';
    params[0] = query.provider.trim();
  }
  if (query.status?.trim()) {
    clauses.push('c.status = ?');
    params.push(query.status.trim());
  }
  const sortMap: Record<string, string> = {
    name: 'c.name COLLATE NOCASE',
    createdAt: 'c.created_at',
    updatedAt: 'c.updated_at',
    lastImportedAt: 'c.last_imported_at'
  };
  const sort = sortMap[query.sort ?? ''] ?? 'c.updated_at';
  const order = query.order?.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const offset = (page - 1) * pageSize;
  return {
    sql: `FROM collections c LEFT JOIN collection_assets ca ON ca.collection_id = c.id
      WHERE ${clauses.join(' AND ')} GROUP BY c.id ORDER BY ${sort} ${order} LIMIT ? OFFSET ?`,
    params: [...params, pageSize, offset],
    page,
    pageSize
  };
}

function buildAssetsQuery(collectionId: string, query: QueryRecord): { sql: string; params: unknown[]; page: number; pageSize: number } {
  const page = positiveInt(query.page, 1, 1_000_000);
  const pageSize = positiveInt(query.pageSize, 50, 100);
  const clauses = ['ca.collection_id = ?'];
  const params: unknown[] = [collectionId];
  if (query.status?.trim()) {
    clauses.push('a.status = ?');
    params.push(query.status.trim());
  }
  const minWidth = Number(query.minWidth);
  if (Number.isInteger(minWidth) && minWidth > 0) {
    clauses.push('a.width >= ?');
    params.push(minWidth);
  }
  const minHeight = Number(query.minHeight);
  if (Number.isInteger(minHeight) && minHeight > 0) {
    clauses.push('a.height >= ?');
    params.push(minHeight);
  }
  if (query.orientation && ['portrait', 'landscape', 'square'].includes(query.orientation)) {
    const orientation = query.orientation;
    if (orientation === 'portrait') clauses.push('a.height > a.width');
    if (orientation === 'landscape') clauses.push('a.width > a.height');
    if (orientation === 'square') clauses.push('a.width = a.height');
  }
  if (query.search?.trim()) {
    clauses.push(`(LOWER(COALESCE(a.title, '')) LIKE LOWER(?) OR
      LOWER(COALESCE(a.description, '')) LIKE LOWER(?) OR
      LOWER(COALESCE(a.alt_text, '')) LIKE LOWER(?))`);
    const value = `%${query.search.trim()}%`;
    params.push(value, value, value);
  }
  const sortMap: Record<string, string> = {
    firstSeen: 'ca.first_seen_at',
    lastSeen: 'ca.last_seen_at',
    dimensions: 'COALESCE(a.width, 0) * COALESCE(a.height, 0)'
  };
  const sort = sortMap[query.sort ?? ''] ?? 'ca.last_seen_at';
  const order = query.order?.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const offset = (page - 1) * pageSize;
  return {
    sql: `FROM assets a INNER JOIN collection_assets ca ON ca.asset_id = a.id
      WHERE ${clauses.join(' AND ')} ORDER BY ${sort} ${order} LIMIT ? OFFSET ?`,
    params: [...params, pageSize, offset],
    page,
    pageSize
  };
}

export async function buildApp(options: { db?: Database.Database; settings?: AppSettings } = {}): Promise<FastifyInstance> {
  const settings = options.settings ?? defaultConfig;
  const db = options.db ?? createDatabase(settings.databasePath);
  const ownsDatabase = !options.db;
  const app = Fastify({
    logger: { level: settings.logLevel },
    bodyLimit: settings.maxRequestBytes,
    requestIdHeader: 'x-request-id',
    genReqId: () => crypto.randomUUID()
  });

  await app.register(cors, {
    origin: (origin, callback) => callback(null, !origin || settings.corsAllowedOrigins.includes(origin)),
    methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Local-Integration-Token', 'X-Request-Id']
  });
  await app.register(swagger, {
    openapi: {
      info: { title: 'Tokia Local Ingestion API', version: '0.1.0', description: 'Local-first Pinterest board ingestion foundation.' },
      servers: [{ url: `http://${settings.host}:${settings.port}` }],
      tags: [{ name: 'diagnostics' }, { name: 'collections' }, { name: 'assets' }, { name: 'imports' }]
    }
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.get('/api/health', { schema: { tags: ['diagnostics'], summary: 'Health check' } }, async () => ({
    status: 'ok',
    service: 'tokia-api',
    database: 'sqlite',
    integrationTokenConfigured: Boolean(settings.localIntegrationToken),
    timestamp: new Date().toISOString()
  }));

  app.post('/api/imports/pinterest-board', { schema: { tags: ['imports'], summary: 'Import a versioned Pinterest board payload' } }, async (request, reply) => {
    if (!integrationGuard(settings, request, reply)) return;
    try {
      const response = ingestPinterestBoard(db, request.body, settings.maxPinsPerImport);
      return reply.code(200).send(response);
    } catch (error) {
      throw error;
    }
  });

  app.get('/api/collections', { schema: { tags: ['collections'], summary: 'List collections' } }, async (request) => {
    const query = queryOf(request);
    const built = buildCollectionsQuery(query);
    const countClauses = built.sql.slice(built.sql.indexOf('WHERE'), built.sql.indexOf('GROUP BY'));
    const countParams = built.params.slice(0, built.params.length - 2);
    const total = (db.prepare(`SELECT COUNT(*) AS count FROM collections c WHERE ${countClauses.replace(/^WHERE\s+/, '')}`)
      .get(...countParams) as { count: number }).count;
    const rows = db.prepare(`SELECT c.*, COUNT(ca.asset_id) AS asset_count ${built.sql}`).all(...built.params) as Array<Record<string, unknown>>;
    return {
      items: rows.map(toCollection),
      pagination: { page: built.page, pageSize: built.pageSize, total, totalPages: Math.ceil(total / built.pageSize) }
    };
  });

  app.get('/api/collections/:id', { schema: { tags: ['collections'], summary: 'Get a collection' } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = getCollection(db, id);
    if (!row) return reply.code(404).send({ error: { code: 'COLLECTION_NOT_FOUND', message: 'Collection not found' } });
    return toCollection(row);
  });

  app.get('/api/collections/:id/assets', { schema: { tags: ['assets'], summary: 'List collection assets' } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!getCollection(db, id)) return reply.code(404).send({ error: { code: 'COLLECTION_NOT_FOUND', message: 'Collection not found' } });
    const query = queryOf(request);
    const built = buildAssetsQuery(id, query);
    const countClauses = built.sql.slice(built.sql.indexOf('WHERE'), built.sql.indexOf('ORDER BY'));
    const countParams = built.params.slice(0, built.params.length - 2);
    const total = (db.prepare(`SELECT COUNT(*) AS count FROM assets a INNER JOIN collection_assets ca ON ca.asset_id = a.id ${countClauses}`)
      .get(...countParams) as { count: number }).count;
    const rows = db.prepare(`SELECT a.*, ca.first_seen_at AS membership_first_seen_at, ca.last_seen_at AS membership_last_seen_at ${built.sql}`)
      .all(...built.params) as Array<Record<string, unknown>>;
    return {
      items: rows.map(toAsset),
      pagination: { page: built.page, pageSize: built.pageSize, total, totalPages: Math.ceil(total / built.pageSize) }
    };
  });

  app.get('/api/import-runs', { schema: { tags: ['imports'], summary: 'List import runs' } }, async (request) => {
    const query = queryOf(request);
    const page = positiveInt(query.page, 1, 1_000_000);
    const pageSize = positiveInt(query.pageSize, 50, 100);
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (query.collectionId) { clauses.push('collection_id = ?'); params.push(query.collectionId); }
    if (query.status) { clauses.push('status = ?'); params.push(query.status); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = (db.prepare(`SELECT COUNT(*) AS count FROM import_runs ${where}`).get(...params) as { count: number }).count;
    const rows = db.prepare(`SELECT * FROM import_runs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize) as Array<Record<string, unknown>>;
    return { items: rows.map(toImportRun), pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
  });

  app.get('/api/import-runs/:id', { schema: { tags: ['imports'], summary: 'Get an import run' } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = getImportRun(db, id);
    if (!row) return reply.code(404).send({ error: { code: 'IMPORT_RUN_NOT_FOUND', message: 'Import run not found' } });
    return toImportRun(row);
  });

  app.patch('/api/assets/:id', { schema: { tags: ['assets'], summary: 'Disable or re-enable an asset' } }, async (request, reply) => {
    if (!integrationGuard(settings, request, reply)) return;
    const { id } = request.params as { id: string };
    const body = request.body as { status?: unknown };
    const parsed = assetStatusSchema.safeParse(body?.status);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'INVALID_ASSET_STATUS', message: 'status must be available, unavailable, invalid, or disabled' } });
    const result = db.prepare('UPDATE assets SET status = ?, updated_at = ? WHERE id = ?').run(parsed.data, new Date().toISOString(), id);
    if (result.changes === 0) return reply.code(404).send({ error: { code: 'ASSET_NOT_FOUND', message: 'Asset not found' } });
    return toAsset(db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as Record<string, unknown>);
  });

  app.patch('/api/collections/:id', { schema: { tags: ['collections'], summary: 'Disable or re-enable a collection' } }, async (request, reply) => {
    if (!integrationGuard(settings, request, reply)) return;
    const { id } = request.params as { id: string };
    const body = request.body as { status?: unknown };
    const parsed = collectionStatusSchema.safeParse(body?.status);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'INVALID_COLLECTION_STATUS', message: 'status must be active, disabled, or error' } });
    const result = db.prepare('UPDATE collections SET status = ?, updated_at = ? WHERE id = ?').run(parsed.data, new Date().toISOString(), id);
    if (result.changes === 0) return reply.code(404).send({ error: { code: 'COLLECTION_NOT_FOUND', message: 'Collection not found' } });
    return toCollection(getCollection(db, id)!);
  });

  app.addHook('onClose', async () => {
    if (ownsDatabase) db.close();
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof IngestionError) {
      request.log.warn({ requestId: request.id, code: error.code }, error.message);
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details, requestId: request.id } });
    }
    if ((error as { code?: string }).code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send({ error: { code: 'REQUEST_TOO_LARGE', message: 'Request body exceeds the configured limit', requestId: request.id } });
    }
    request.log.error({ requestId: request.id, err: error }, 'Unhandled request error');
    return reply.code(500).send({ error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error', requestId: request.id } });
  });

  return app;
}
