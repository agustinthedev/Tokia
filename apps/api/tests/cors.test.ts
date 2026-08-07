import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { createDatabase } from '../src/db.js';

describe('API CORS policy', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let db: Database.Database | undefined;

  afterEach(async () => {
    if (app) await app.close();
    if (db?.open) db.close();
    app = undefined;
    db = undefined;
  });

  it('allows the PUT used to manually assign content to a frame', async () => {
    db = createDatabase(':memory:');
    app = await buildApp({
      db,
      settings: {
        ...config,
        corsAllowedOrigins: ['http://127.0.0.1:5173'],
      },
    });

    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/content/content-id/frames/frame-id/image',
      headers: {
        origin: 'http://127.0.0.1:5173',
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'content-type,x-local-integration-token',
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5173');
    expect(response.headers['access-control-allow-methods']).toContain('PUT');
  });
});
