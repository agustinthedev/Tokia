import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { createDatabase } from '../src/db.js';
import type Database from 'better-sqlite3';

const token = 'test-local-token';

function settings() {
  return { ...config, localIntegrationToken: token, maxPinsPerImport: 2_000, maxRequestBytes: 10 * 1024 * 1024 };
}

function pin(id: string, overrides: Record<string, unknown> = {}) {
  return {
    externalId: id,
    pinUrl: `https://www.pinterest.com/pin/${id}/?utm_source=test`,
    imageUrl: `https://i.pinimg.com/736x/aa/bb/cc/${id}.jpg`,
    previewUrl: `https://i.pinimg.com/236x/aa/bb/cc/${id}.jpg`,
    imageVariants: [{ url: `https://i.pinimg.com/236x/aa/bb/cc/${id}.jpg`, width: 236 }, { url: `https://i.pinimg.com/736x/aa/bb/cc/${id}.jpg`, width: 736 }],
    title: `Title ${id}`,
    description: `Description ${id}`,
    altText: `Alt ${id}`,
    width: 736,
    height: 1104,
    ...overrides
  };
}

function payload(boardOverrides: Record<string, unknown> = {}, pins = [pin('1001'), pin('1002')]) {
  return {
    schemaVersion: 1,
    source: 'pinterest-browser-extension',
    exportedAt: new Date().toISOString(),
    board: {
      externalId: 'board-1',
      name: 'Luxury Lifestyle',
      url: 'https://www.pinterest.com/demo/luxury/?utm_source=test',
      description: null,
      ...boardOverrides
    },
    pins
  };
}

async function setup() {
  const db = createDatabase(':memory:');
  const app = await buildApp({ db, settings: settings() });
  return { db, app };
}

async function importPayload(app: Awaited<ReturnType<typeof buildApp>>, body: unknown) {
  return app.inject({
    method: 'POST',
    url: '/api/imports/pinterest-board',
    headers: { 'x-local-integration-token': token },
    payload: body
  });
}

describe('Pinterest ingestion', () => {
  let db: Database.Database | undefined;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;

  afterEach(async () => {
    if (app) await app.close();
    if (db?.open) db.close();
    app = undefined;
    db = undefined;
  });

  it('creates a collection, assets, memberships, and skips duplicate records in one payload', async () => {
    ({ db, app } = await setup());
    const response = await importPayload(app, payload({}, [pin('1001'), pin('1001'), pin('1002')]));
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.summary).toMatchObject({ received: 3, valid: 3, invalid: 0, assetsCreated: 2, membershipsCreated: 2, duplicatesSkipped: 1 });
    expect(db!.prepare('SELECT COUNT(*) AS count FROM collections').get()).toMatchObject({ count: 1 });
    expect(db!.prepare('SELECT COUNT(*) AS count FROM assets').get()).toMatchObject({ count: 2 });
    expect(db!.prepare('SELECT COUNT(*) AS count FROM collection_assets').get()).toMatchObject({ count: 2 });
  });

  it('reimports without duplicate rows, updates a renamed board, and preserves good metadata', async () => {
    ({ db, app } = await setup());
    await importPayload(app, payload());
    const response = await importPayload(app, payload({
      name: 'Luxury Lifestyle Renamed',
      url: 'https://www.pinterest.com/demo/luxury-new/?locale=en'
    }, [pin('1001', { description: null, title: 'Short' }), pin('1002')]));
    expect(response.statusCode).toBe(200);
    expect(response.json().collection.created).toBe(false);
    expect(db!.prepare('SELECT name, canonical_source_url FROM collections').get()).toMatchObject({
      name: 'Luxury Lifestyle Renamed',
      canonical_source_url: 'https://www.pinterest.com/demo/luxury-new/'
    });
    expect(db!.prepare('SELECT description, title FROM assets WHERE external_asset_id = ?').get('1001')).toMatchObject({
      description: 'Description 1001',
      title: 'Title 1001'
    });
    expect(db!.prepare('SELECT COUNT(*) AS count FROM collections').get()).toMatchObject({ count: 1 });
    expect(db!.prepare('SELECT COUNT(*) AS count FROM assets').get()).toMatchObject({ count: 2 });
    expect(db!.prepare('SELECT COUNT(*) AS count FROM collection_assets').get()).toMatchObject({ count: 2 });
  });

  it('reuses one asset across two collections while creating two memberships', async () => {
    ({ db, app } = await setup());
    await importPayload(app, payload());
    const second = await importPayload(app, payload({ externalId: 'board-2', name: 'Travel', url: 'https://pinterest.com/other/travel/' }, [pin('1001')]));
    expect(second.statusCode).toBe(200);
    expect(second.json().summary).toMatchObject({ assetsCreated: 0, assetsUpdated: 1, membershipsCreated: 1 });
    expect(db!.prepare('SELECT COUNT(*) AS count FROM collections').get()).toMatchObject({ count: 2 });
    expect(db!.prepare('SELECT COUNT(*) AS count FROM assets').get()).toMatchObject({ count: 2 });
    expect(db!.prepare('SELECT COUNT(*) AS count FROM collection_assets').get()).toMatchObject({ count: 3 });
  });

  it('does not collapse distinct Pin identities just because they share an image path', async () => {
    ({ db, app } = await setup());
    const sameImage = [
      pin('2001', { pinUrl: 'https://www.pinterest.com/pin/2001/', imageUrl: 'https://i.pinimg.com/736x/aa/bb/cc/shared.jpg' }),
      pin('2002', { pinUrl: 'https://www.pinterest.com/pin/2002/', imageUrl: 'https://i.pinimg.com/236x/aa/bb/cc/shared.jpg' })
    ];
    const response = await importPayload(app, payload({}, sameImage));
    expect(response.statusCode).toBe(200);
    expect(response.json().summary.assetsCreated).toBe(2);
    expect(db!.prepare('SELECT COUNT(*) AS count FROM assets').get()).toMatchObject({ count: 2 });
  });

  it('accepts partial success and records invalid pins as warnings', async () => {
    ({ db, app } = await setup());
    const response = await importPayload(app, payload({}, [pin('1001'), { externalId: 'bad-no-image' }]));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ summary: { received: 2, valid: 1, invalid: 1 }, warnings: [{ index: 1 }] });
    expect(db!.prepare('SELECT status, records_invalid FROM import_runs').get()).toMatchObject({ status: 'completed_with_warnings', records_invalid: 1 });
  });

  it('rejects unsupported schema versions and oversized imports cleanly', async () => {
    ({ db, app } = await setup());
    const unsupported = await importPayload(app, { ...payload(), schemaVersion: 2 });
    expect(unsupported.statusCode).toBe(400);
    expect(unsupported.json().error.code).toBe('UNSUPPORTED_SCHEMA_VERSION');
    const smallApp = await buildApp({ db: createDatabase(':memory:'), settings: { ...settings(), maxPinsPerImport: 1 } });
    const oversized = await importPayload(smallApp, payload());
    expect(oversized.statusCode).toBe(413);
    await smallApp.close();
  });

  it('rolls back collection and assets on a fatal database failure but preserves the failed run', async () => {
    ({ db, app } = await setup());
    db!.exec("CREATE TRIGGER fail_asset_insert BEFORE INSERT ON assets BEGIN SELECT RAISE(ABORT, 'forced failure'); END");
    const response = await importPayload(app, payload());
    expect(response.statusCode).toBe(500);
    expect(db!.prepare('SELECT COUNT(*) AS count FROM collections').get()).toMatchObject({ count: 0 });
    expect(db!.prepare('SELECT COUNT(*) AS count FROM assets').get()).toMatchObject({ count: 0 });
    expect(db!.prepare('SELECT status, error_message FROM import_runs').get()).toMatchObject({ status: 'failed', error_message: 'forced failure' });
  });

  it('supports management queries and soft status changes', async () => {
    ({ db, app } = await setup());
    const imported = await importPayload(app, payload());
    const collectionId = imported.json().collection.id as string;
    const collection = await app.inject({ method: 'GET', url: '/api/collections?search=luxury&sort=name' });
    expect(collection.statusCode).toBe(200);
    expect(collection.json().pagination.total).toBe(1);
    const assets = await app.inject({ method: 'GET', url: `/api/collections/${collectionId}/assets?orientation=portrait&minWidth=700` });
    expect(assets.statusCode).toBe(200);
    expect(assets.json().pagination.total).toBe(2);
    const assetId = assets.json().items[0].id as string;
    const updated = await app.inject({ method: 'PATCH', url: `/api/assets/${assetId}`, headers: { 'x-local-integration-token': token }, payload: { status: 'disabled' } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().status).toBe('disabled');
    const disabled = await app.inject({ method: 'PATCH', url: `/api/collections/${collectionId}`, headers: { 'x-local-integration-token': token }, payload: { status: 'disabled' } });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().status).toBe('disabled');
  });
});
