import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { createDatabase } from '../src/db.js';
import type Database from 'better-sqlite3';

const token = 'phase2-test-token';

function settings() {
  return { ...config, localIntegrationToken: token, maxPinsPerImport: 2_000, maxRequestBytes: 10 * 1024 * 1024 };
}

function pin(id: string, overrides: Record<string, unknown> = {}) {
  return {
    externalId: id,
    pinUrl: `https://www.pinterest.com/pin/${id}/`,
    imageUrl: `https://i.pinimg.com/736x/${id}.jpg`,
    previewUrl: `https://i.pinimg.com/236x/${id}.jpg`,
    title: `Asset ${id}`,
    width: 736,
    height: 1104,
    ...overrides
  };
}

async function setup() {
  const db = createDatabase(':memory:');
  const app = await buildApp({ db, settings: settings() });
  return { db, app };
}

async function importBoard(app: Awaited<ReturnType<typeof buildApp>>) {
  return app.inject({
    method: 'POST',
    url: '/api/imports/pinterest-board',
    headers: { 'x-local-integration-token': token },
    payload: {
      schemaVersion: 1,
      source: 'pinterest-browser-extension',
      exportedAt: new Date().toISOString(),
      board: {
        externalId: 'phase2-board',
        name: 'Phase 2 Board',
        url: 'https://www.pinterest.com/demo/phase2/'
      },
      pins: [
        pin('image-1'),
        pin('video-1', {
          imageUrl: 'https://i.pinimg.com/posters/video-1.jpg',
          mediaUrl: 'https://v.pinimg.com/videos/video-1.mp4',
          mediaType: 'video',
          mimeType: 'video/mp4',
          durationSeconds: 12.5,
          width: 1080,
          height: 1920
        })
      ]
    }
  });
}

describe('Phase 2 management API', () => {
  let db: Database.Database | undefined;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;

  afterEach(async () => {
    if (app) await app.close();
    if (db?.open) db.close();
    app = undefined;
    db = undefined;
  });

  it('reports dashboard, media-aware asset, and collection data after an import', async () => {
    ({ db, app } = await setup());
    const imported = await importBoard(app);
    expect(imported.statusCode).toBe(200);
    const collectionId = imported.json().collection.id as string;

    const dashboard = await app.inject({ method: 'GET', url: '/api/dashboard' });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().stats).toMatchObject({ totalCollections: 1, totalAssets: 2, totalVideos: 1 });

    const videos = await app.inject({ method: 'GET', url: '/api/assets?mediaType=video' });
    expect(videos.statusCode).toBe(200);
    expect(videos.json().pagination.total).toBe(1);
    expect(videos.json().items[0]).toMatchObject({ mediaType: 'video', durationSeconds: 12.5 });

    const collections = await app.inject({ method: 'GET', url: '/api/collections?hasVideos=true' });
    expect(collections.statusCode).toBe(200);
    expect(collections.json().pagination.total).toBe(1);
    expect(collections.json().items[0].id).toBe(collectionId);
    expect(db!.prepare('SELECT media_type, remote_media_url FROM assets WHERE external_asset_id = ?').get('video-1')).toMatchObject({ media_type: 'video', remote_media_url: 'https://v.pinimg.com/videos/video-1.mp4' });
  });

  it('creates a project, links collections without copying assets, and supports search/archive', async () => {
    ({ db, app } = await setup());
    const imported = await importBoard(app);
    const collectionId = imported.json().collection.id as string;

    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { 'x-local-integration-token': token },
      payload: { name: 'Launch Plan', description: 'Reusable source mix', collectionIds: [collectionId] }
    });
    expect(created.statusCode).toBe(201);
    const project = created.json();
    expect(project).toMatchObject({ name: 'Launch Plan', collectionCount: 1, totalAssets: 2 });
    expect(db!.prepare('SELECT COUNT(*) AS count FROM assets').get()).toMatchObject({ count: 2 });
    expect(db!.prepare('SELECT COUNT(*) AS count FROM project_collections').get()).toMatchObject({ count: 1 });

    const detail = await app.inject({ method: 'GET', url: `/api/projects/${project.id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().collections[0].id).toBe(collectionId);

    const search = await app.inject({ method: 'GET', url: '/api/search?q=Launch' });
    expect(search.statusCode).toBe(200);
    expect(search.json().projects[0].name).toBe('Launch Plan');

    const archived = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${project.id}`,
      headers: { 'x-local-integration-token': token },
      payload: { status: 'archived' }
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().status).toBe('archived');
  });

  it('resolves a deferred Pinterest video source on demand', async () => {
    ({ db, app } = await setup());
    const imported = await app.inject({
      method: 'POST',
      url: '/api/imports/pinterest-board',
      headers: { 'x-local-integration-token': token },
      payload: {
        schemaVersion: 1,
        source: 'pinterest-browser-extension',
        exportedAt: new Date().toISOString(),
        board: { name: 'Deferred video board', url: 'https://www.pinterest.com/demo/deferred/' },
        pins: [pin('deferred-video', { mediaType: 'video' })]
      }
    });
    expect(imported.statusCode).toBe(200);
    const assetId = (db!.prepare('SELECT id FROM assets WHERE external_asset_id = ?').get('deferred-video') as { id: string }).id;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"videoList720P":{"v720P":{"url":"https:\\/\\/v1.pinimg.com\\/videos\\/clip_720w.mp4"}},"duration":"PT13S"}', { status: 200 })));
    const resolved = await app.inject({ method: 'POST', url: `/api/assets/${assetId}/resolve-media`, headers: { 'x-local-integration-token': token } });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({ mediaType: 'video', mediaUrl: 'https://v1.pinimg.com/videos/clip_720w.mp4', mimeType: 'video/mp4' });
    vi.unstubAllGlobals();
  });
});
