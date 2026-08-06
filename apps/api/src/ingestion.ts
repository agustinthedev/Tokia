import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  envelopeShapeSchema,
  pinSchema,
  normalizePin,
  normalizePinterestBoardUrl,
  chooseBestImageUrl,
  pinterestImageQuality,
  isPlayableVideoUrl,
  cleanOptionalText,
  type NormalizedPin,
  type ImportResponse,
  type ImportSummary,
  type ImportWarning
} from '@tokia/shared';

type CollectionRow = {
  id: string;
  provider: string;
  external_id: string | null;
  canonical_source_url: string;
  name: string;
  description: string | null;
  status: string;
  last_imported_at: string | null;
  last_successful_import_at: string | null;
  created_at: string;
  updated_at: string;
};

type AssetRow = {
  id: string;
  provider: string;
  external_asset_id: string | null;
  canonical_asset_url: string | null;
  remote_image_url: string;
  remote_media_url: string | null;
  remote_preview_url: string | null;
  media_type: string;
  duration_seconds: number | null;
  normalized_image_key: string | null;
  title: string | null;
  description: string | null;
  alt_text: string | null;
  source_link: string | null;
  width: number | null;
  height: number | null;
  mime_type: string | null;
  status: string;
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
};

export class IngestionError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
    public readonly code = 'INVALID_INGESTION_PAYLOAD',
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'IngestionError';
  }
}

const PROVIDER = 'pinterest';

function newId(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

function betterText(existing: string | null, incoming: string | null | undefined): string | null {
  const candidate = cleanOptionalText(incoming);
  if (!candidate) return existing;
  if (!existing || candidate.length > existing.length) return candidate;
  return existing;
}

function sameValue(a: unknown, b: unknown): boolean {
  return a === b;
}

function findCollection(db: Database.Database, externalId: string | null, canonicalUrl: string): CollectionRow | undefined {
  if (externalId) {
    const byExternal = db.prepare('SELECT * FROM collections WHERE provider = ? AND external_id = ?').get(PROVIDER, externalId) as CollectionRow | undefined;
    if (byExternal) return byExternal;
  }
  return db.prepare('SELECT * FROM collections WHERE provider = ? AND canonical_source_url = ?').get(PROVIDER, canonicalUrl) as CollectionRow | undefined;
}

function resolveCollection(db: Database.Database, board: { externalId?: string | null; name: string; url: string; description?: string | null }): { collection: CollectionRow; created: boolean } {
  const canonicalUrl = normalizePinterestBoardUrl(board.url);
  if (!canonicalUrl) throw new IngestionError('board.url must be a valid Pinterest board URL', 422, 'INVALID_BOARD_URL');
  const externalId = cleanOptionalText(board.externalId);
  const byExternal = externalId
    ? db.prepare('SELECT * FROM collections WHERE provider = ? AND external_id = ?').get(PROVIDER, externalId) as CollectionRow | undefined
    : undefined;
  const byUrl = db.prepare('SELECT * FROM collections WHERE provider = ? AND canonical_source_url = ?').get(PROVIDER, canonicalUrl) as CollectionRow | undefined;
  if (byExternal && byUrl && byExternal.id !== byUrl.id) {
    throw new IngestionError('Board identity conflicts with two existing collections', 409, 'COLLECTION_IDENTITY_CONFLICT');
  }
  const existing = byExternal ?? byUrl;
  const timestamp = now();
  if (!existing) {
    const collection: CollectionRow = {
      id: newId(),
      provider: PROVIDER,
      external_id: externalId,
      canonical_source_url: canonicalUrl,
      name: board.name.trim(),
      description: cleanOptionalText(board.description),
      status: 'active',
      last_imported_at: timestamp,
      last_successful_import_at: null,
      created_at: timestamp,
      updated_at: timestamp
    };
    db.prepare(`INSERT INTO collections(
      id, provider, external_id, canonical_source_url, name, description, status,
      last_imported_at, last_successful_import_at, created_at, updated_at
    ) VALUES (@id, @provider, @external_id, @canonical_source_url, @name, @description, @status,
      @last_imported_at, @last_successful_import_at, @created_at, @updated_at)`).run(collection);
    return { collection, created: true };
  }

  db.prepare(`UPDATE collections SET
    external_id = COALESCE(?, external_id),
    canonical_source_url = ?,
    name = ?,
    description = COALESCE(?, description),
    last_imported_at = ?,
    updated_at = ?
    WHERE id = ?`).run(
    externalId,
    canonicalUrl,
    board.name.trim(),
    cleanOptionalText(board.description),
    timestamp,
    timestamp,
    existing.id
  );
  return {
    collection: db.prepare('SELECT * FROM collections WHERE id = ?').get(existing.id) as CollectionRow,
    created: false
  };
}

function findAsset(db: Database.Database, pin: NormalizedPin): AssetRow | undefined {
  if (pin.externalId) {
    const row = db.prepare('SELECT * FROM assets WHERE provider = ? AND external_asset_id = ?').get(PROVIDER, pin.externalId) as AssetRow | undefined;
    if (row) return row;
    if (pin.canonicalUrl) {
      const byUrl = db.prepare('SELECT * FROM assets WHERE provider = ? AND canonical_asset_url = ?').get(PROVIDER, pin.canonicalUrl) as AssetRow | undefined;
      if (byUrl && (!byUrl.external_asset_id || byUrl.external_asset_id === pin.externalId)) return byUrl;
    }
    return undefined;
  }
  if (pin.canonicalUrl) {
    const row = db.prepare('SELECT * FROM assets WHERE provider = ? AND canonical_asset_url = ?').get(PROVIDER, pin.canonicalUrl) as AssetRow | undefined;
    if (row) return row;
  }
  if (!pin.externalId && !pin.canonicalUrl && pin.normalizedImageKey) {
    return db.prepare('SELECT * FROM assets WHERE provider = ? AND normalized_image_key = ?').get(PROVIDER, pin.normalizedImageKey) as AssetRow | undefined;
  }
  return undefined;
}

function updateAsset(db: Database.Database, existing: AssetRow, pin: NormalizedPin, timestamp: string): boolean {
  const best = chooseBestImageUrl(pin);
  const nextMediaType = pin.mediaType ?? existing.media_type;
  const existingMediaUrl = nextMediaType === 'video' && !isPlayableVideoUrl(existing.remote_media_url) ? null : existing.remote_media_url;
  const useIncomingImage = pinterestImageQuality(best.imageUrl) > pinterestImageQuality(existing.remote_image_url) ||
    (existing.width === null && best.width !== null) ||
    (best.width !== null && (existing.width === null || best.width > existing.width));
  const next = {
    remote_image_url: useIncomingImage ? best.imageUrl : existing.remote_image_url,
    remote_media_url: pin.mediaUrl ?? existingMediaUrl ?? (nextMediaType === 'video' ? null : best.imageUrl),
    remote_preview_url: null,
    media_type: nextMediaType,
    mime_type: pin.mimeType ?? existing.mime_type,
    duration_seconds: pin.durationSeconds ?? existing.duration_seconds,
    normalized_image_key: existing.normalized_image_key ?? pin.normalizedImageKey,
    external_asset_id: existing.external_asset_id ?? pin.externalId,
    canonical_asset_url: existing.canonical_asset_url ?? pin.canonicalUrl,
    title: betterText(existing.title, pin.title),
    description: betterText(existing.description, pin.description),
    alt_text: betterText(existing.alt_text, pin.altText),
    source_link: betterText(existing.source_link, pin.sourceLink),
    width: useIncomingImage ? best.width : existing.width,
    height: useIncomingImage ? best.height : existing.height,
    last_seen_at: timestamp,
    updated_at: timestamp,
    id: existing.id
  };
  const changed = Object.entries(next).some(([key, value]) => key !== 'id' && !sameValue(value, existing[key as keyof AssetRow]));
  if (changed) {
    db.prepare(`UPDATE assets SET
      remote_image_url = @remote_image_url,
      remote_media_url = @remote_media_url,
      remote_preview_url = @remote_preview_url,
      media_type = @media_type,
      mime_type = @mime_type,
      duration_seconds = @duration_seconds,
      normalized_image_key = @normalized_image_key,
      external_asset_id = @external_asset_id,
      canonical_asset_url = @canonical_asset_url,
      title = @title,
      description = @description,
      alt_text = @alt_text,
      source_link = @source_link,
      width = @width,
      height = @height,
      last_seen_at = @last_seen_at,
      updated_at = @updated_at
      WHERE id = @id`).run(next);
  } else {
    db.prepare('UPDATE assets SET last_seen_at = ?, updated_at = ? WHERE id = ?').run(timestamp, timestamp, existing.id);
  }
  return true;
}

function insertAsset(db: Database.Database, pin: NormalizedPin, timestamp: string): AssetRow {
  const best = chooseBestImageUrl(pin);
  const row: AssetRow = {
    id: newId(),
    provider: PROVIDER,
    external_asset_id: pin.externalId,
    canonical_asset_url: pin.canonicalUrl,
    remote_image_url: best.imageUrl,
    remote_media_url: pin.mediaUrl ?? (pin.mediaType === 'video' ? null : best.imageUrl),
    remote_preview_url: null,
    media_type: pin.mediaType,
    duration_seconds: pin.durationSeconds,
    normalized_image_key: pin.normalizedImageKey,
    title: pin.title ?? null,
    description: pin.description ?? null,
    alt_text: pin.altText ?? null,
    source_link: pin.sourceLink ?? null,
    width: best.width,
    height: best.height,
    mime_type: pin.mimeType,
    status: 'available',
    first_seen_at: timestamp,
    last_seen_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp
  };
  db.prepare(`INSERT INTO assets(
    id, provider, external_asset_id, canonical_asset_url, remote_image_url, remote_media_url, remote_preview_url,
    media_type, duration_seconds, normalized_image_key, title, description, alt_text, source_link, width, height, mime_type,
    status, first_seen_at, last_seen_at, created_at, updated_at
  ) VALUES (@id, @provider, @external_asset_id, @canonical_asset_url, @remote_image_url, @remote_media_url, @remote_preview_url,
    @media_type, @duration_seconds, @normalized_image_key, @title, @description, @alt_text, @source_link, @width, @height, @mime_type,
    @status, @first_seen_at, @last_seen_at, @created_at, @updated_at)`).run(row);
  return row;
}

function ensureMembership(db: Database.Database, collectionId: string, assetId: string, timestamp: string): boolean {
  const existing = db.prepare('SELECT collection_id FROM collection_assets WHERE collection_id = ? AND asset_id = ?')
    .get(collectionId, assetId) as { collection_id: string } | undefined;
  if (existing) {
    db.prepare('UPDATE collection_assets SET last_seen_at = ? WHERE collection_id = ? AND asset_id = ?')
      .run(timestamp, collectionId, assetId);
    return false;
  }
  db.prepare(`INSERT INTO collection_assets(collection_id, asset_id, first_seen_at, last_seen_at, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(collectionId, assetId, timestamp, timestamp, timestamp);
  return true;
}

function updateRun(db: Database.Database, runId: string, status: string, summary: ImportSummary, completedAt: string, errorMessage: string | null = null): void {
  db.prepare(`UPDATE import_runs SET status = ?, records_received = ?, records_valid = ?, records_invalid = ?,
    assets_created = ?, assets_updated = ?, memberships_created = ?, duplicates_skipped = ?, completed_at = ?, error_message = ?
    WHERE id = ?`).run(
    status,
    summary.received,
    summary.valid,
    summary.invalid,
    summary.assetsCreated,
    summary.assetsUpdated,
    summary.membershipsCreated,
    summary.duplicatesSkipped,
    completedAt,
    errorMessage,
    runId
  );
}

export function ingestPinterestBoard(db: Database.Database, body: unknown, maxPins: number): ImportResponse {
  const rawObject = body && typeof body === 'object' ? body as Record<string, unknown> : null;
  if (rawObject?.schemaVersion !== 1) {
    throw new IngestionError('Unsupported ingestion schema version', 400, 'UNSUPPORTED_SCHEMA_VERSION', {
      supportedVersions: [1],
      received: rawObject?.schemaVersion ?? null
    });
  }
  const envelope = envelopeShapeSchema.safeParse(body);
  if (!envelope.success) {
    throw new IngestionError('Invalid ingestion envelope', 400, 'INVALID_INGESTION_PAYLOAD', envelope.error.flatten());
  }
  if (envelope.data.pins.length > maxPins) {
    throw new IngestionError(`Import exceeds the maximum of ${maxPins} Pins`, 413, 'IMPORT_TOO_LARGE');
  }

  const runId = newId();
  const startedAt = now();
  const summary: ImportSummary = {
    received: envelope.data.pins.length,
    valid: 0,
    invalid: 0,
    assetsCreated: 0,
    assetsUpdated: 0,
    membershipsCreated: 0,
    duplicatesSkipped: 0
  };
  const warnings: ImportWarning[] = [];
  db.prepare(`INSERT INTO import_runs(
    id, provider, collection_id, source_url, status, records_received, started_at, created_at
  ) VALUES (?, ?, NULL, ?, 'processing', ?, ?, ?)`).run(
    runId, PROVIDER, envelope.data.board.url, summary.received, startedAt, startedAt
  );

  try {
    const result = db.transaction(() => {
      const resolved = resolveCollection(db, envelope.data.board);
      const uniquePins = new Map<string, NormalizedPin>();
      envelope.data.pins.forEach((rawPin, index) => {
        const parsed = pinSchema.safeParse(rawPin);
        if (!parsed.success) {
          summary.invalid += 1;
          warnings.push({ index, message: parsed.error.issues.map((issue) => issue.message).join('; ') });
          return;
        }
        try {
          const normalized = normalizePin(parsed.data);
          summary.valid += 1;
          if (uniquePins.has(normalized.identityKey)) summary.duplicatesSkipped += 1;
          else uniquePins.set(normalized.identityKey, normalized);
        } catch (error) {
          summary.invalid += 1;
          warnings.push({ index, message: error instanceof Error ? error.message : 'Pin normalization failed' });
        }
      });

      for (const pin of uniquePins.values()) {
        const timestamp = now();
        const existing = findAsset(db, pin);
        const asset = existing ? existing : insertAsset(db, pin, timestamp);
        if (existing) {
          updateAsset(db, existing, pin, timestamp);
          summary.assetsUpdated += 1;
        } else {
          summary.assetsCreated += 1;
        }
        const membershipCreated = ensureMembership(db, resolved.collection.id, asset.id, timestamp);
        if (membershipCreated) summary.membershipsCreated += 1;
        else summary.duplicatesSkipped += 1;
      }

      const completedAt = now();
      db.prepare(`UPDATE collections SET last_successful_import_at = ?, status = CASE WHEN status = 'error' THEN 'active' ELSE status END, updated_at = ? WHERE id = ?`)
        .run(completedAt, completedAt, resolved.collection.id);
      db.prepare('UPDATE import_runs SET collection_id = ? WHERE id = ?').run(resolved.collection.id, runId);
      updateRun(
        db,
        runId,
        warnings.length > 0 ? 'completed_with_warnings' : 'completed',
        summary,
        completedAt
      );
      return { collection: resolved.collection, created: resolved.created };
    })();

    return {
      success: true,
      collection: { id: result.collection.id, name: result.collection.name, created: result.created },
      importRunId: runId,
      summary,
      warnings
    };
  } catch (error) {
    const completedAt = now();
    const message = error instanceof Error ? error.message : 'Fatal import failure';
    updateRun(db, runId, 'failed', summary, completedAt, message);
    throw error;
  }
}

export function getImportRun(db: Database.Database, id: string): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM import_runs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
}

export function getCollection(db: Database.Database, id: string): Record<string, unknown> | undefined {
  return db.prepare(`SELECT c.*, COUNT(ca.asset_id) AS asset_count
    FROM collections c LEFT JOIN collection_assets ca ON ca.collection_id = c.id
    WHERE c.id = ? GROUP BY c.id`).get(id) as Record<string, unknown> | undefined;
}
