import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { createDatabase } from '../src/db.js';
import type Database from 'better-sqlite3';

const token = 'content-test-token';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

describe('project and content workflow', () => {
  let db: Database.Database | undefined;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let server: Server | undefined;
  let storage: string | undefined;

  afterEach(async () => {
    if (app) await app.close();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (db?.open) db.close();
    if (storage) await fsp.rm(storage, { recursive: true, force: true });
    app = undefined; db = undefined; server = undefined; storage = undefined;
  });

  it('creates a project, generates a five-frame carousel, renders final assets, and packages them', async () => {
    server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'image/png' }); response.end(png); });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Could not start fixture server');
    const imageUrl = `http://127.0.0.1:${address.port}/image.png`;
    storage = await fsp.mkdtemp(path.join(os.tmpdir(), 'tokia-content-'));
    db = createDatabase(':memory:'); app = await buildApp({ db, settings: { ...config, localIntegrationToken: token, contentStorageDirectory: storage, ffmpegPath: 'ffmpeg' } });
    const headers = { 'x-local-integration-token': token };
    const imported = await app.inject({ method: 'POST', url: '/api/imports/pinterest-board', headers, payload: { schemaVersion: 1, source: 'test', exportedAt: new Date().toISOString(), board: { externalId: 'content-board', name: 'Content board', url: 'https://www.pinterest.com/test/content-board/', description: null }, pins: Array.from({ length: 5 }, (_, index) => ({ externalId: `content-${index}`, pinUrl: `https://www.pinterest.com/pin/content-${index}/`, imageUrl, previewUrl: imageUrl, width: 800, height: 1200 })) } });
    expect(imported.statusCode).toBe(200);
    const collectionId = imported.json().collection.id as string;
    const createdProject = await app.inject({ method: 'POST', url: '/api/projects', headers, payload: { name: 'Fitness tips', niche: 'Fitness', description: 'Practical movement ideas', defaultLanguage: 'English', collectionIds: [collectionId], defaultSettings: { aspectRatio: '9:16', tone: 'educational' } } });
    expect(createdProject.statusCode).toBe(201);
    const projectId = createdProject.json().id as string;
    const draftResponse = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/content`, headers, payload: { type: 'carousel', configuration: { sourceCollectionIds: [collectionId], totalFrames: 5, includeCover: true, includeCta: true, textMode: 'headline_and_body', topic: 'A simple mobility routine' } } });
    expect(draftResponse.statusCode).toBe(201);
    const contentId = draftResponse.json().id as string;
    expect(draftResponse.json().frames.map((frame: { role: string }) => frame.role)).toEqual(['cover', 'content', 'content', 'content', 'cta']);
    const titleUpdate = await app.inject({ method: 'PATCH', url: `/api/content/${contentId}`, headers, payload: { title: 'Mobility routine' } });
    expect(titleUpdate.statusCode).toBe(200);
    expect(titleUpdate.json().title).toBe('Mobility routine');
    const selected = await app.inject({ method: 'POST', url: `/api/content/${contentId}/images/select`, headers, payload: {} });
    expect(selected.statusCode).toBe(200);
    expect(selected.json().frames.every((frame: { sourceMedia: unknown }) => Boolean(frame.sourceMedia))).toBe(true);
    await app.inject({ method: 'POST', url: `/api/content/${contentId}/narrative`, headers, payload: {} });
    await waitFor(async () => (await app!.inject({ method: 'GET', url: `/api/content/${contentId}` })).json().narrative?.frames?.length === 5);
    const narrative = (await app.inject({ method: 'GET', url: `/api/content/${contentId}` })).json();
    expect(narrative.title).toBe('Mobility routine');
    expect(narrative.narrative.frames).toHaveLength(5);
    expect(narrative.narrative.frames.map((frame: { role: string }) => frame.role)).toEqual(['cover', 'content', 'content', 'content', 'cta']);
    const preview = await app.inject({ method: 'POST', url: `/api/content/${contentId}/preview`, headers, payload: {} });
    expect(preview.statusCode).toBe(202);
    await waitFor(async () => (await app!.inject({ method: 'GET', url: `/api/content/${contentId}` })).json().status === 'preview_ready', 20_000);
    const readyPreview = (await app.inject({ method: 'GET', url: `/api/content/${contentId}` })).json();
    expect(readyPreview.assets.some((asset: { variant: string }) => asset.variant === 'preview')).toBe(true);
    const confirmed = await app.inject({ method: 'POST', url: `/api/content/${contentId}/confirm`, headers, payload: {} });
    expect(confirmed.statusCode).toBe(202);
    await waitFor(async () => (await app!.inject({ method: 'GET', url: `/api/content/${contentId}` })).json().status === 'ready', 20_000);
    const download = await app.inject({ method: 'GET', url: `/api/content/${contentId}/package.zip` });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toContain('application/zip');
    const finalDownload = await app.inject({ method: 'GET', url: `/api/content/${contentId}/download` });
    expect(finalDownload.statusCode).toBe(200);
    expect(finalDownload.headers['content-type']).toContain('application/zip');
    expect(finalDownload.headers['content-disposition']).toMatch(/filename="[^"]+-slides\.zip"/);
    expect(finalDownload.body).toContain('slide-01.png');
    expect(finalDownload.body).toContain('slide-05.png');
    const videoDraft = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/content`, headers, payload: { type: 'video_slideshow', configuration: { sourceCollectionIds: [collectionId], totalFrames: 3, includeCover: true, includeCta: false, textMode: 'none', video: { secondsPerImage: 0.5, fps: 24, outputResolution: '720p' } } } });
    const videoId = videoDraft.json().id as string;
    const videoSelectedResponse = await app.inject({ method: 'POST', url: `/api/content/${videoId}/images/select`, headers, payload: {} });
    expect(videoSelectedResponse.json().frames.map((frame: { durationSeconds: number }) => frame.durationSeconds)).toEqual([0.5, 0.5, 0.5]);
    const videoDurations = [0.2, 0.4, 0.6];
    for (let index = 0; index < videoSelectedResponse.json().frames.length; index += 1) {
      const frame = videoSelectedResponse.json().frames[index];
      const updatedFrame = await app.inject({ method: 'PATCH', url: `/api/content/${videoId}/frames/${frame.id}`, headers, payload: { durationSeconds: videoDurations[index] } });
      expect(updatedFrame.statusCode).toBe(200);
    }
    await app.inject({ method: 'POST', url: `/api/content/${videoId}/narrative`, headers, payload: {} });
    await waitFor(async () => Boolean((await app!.inject({ method: 'GET', url: `/api/content/${videoId}` })).json().narrative), 5_000);
    await app.inject({ method: 'POST', url: `/api/content/${videoId}/preview`, headers, payload: {} });
    await waitFor(async () => {
      const state = (await app!.inject({ method: 'GET', url: `/api/content/${videoId}` })).json();
      if (state.status === 'failed') throw new Error(`Video preview failed: ${JSON.stringify(state)}`);
      return state.status === 'preview_ready';
    }, 20_000);
    const videoPreview = (await app.inject({ method: 'GET', url: `/api/content/${videoId}` })).json();
    const videoAsset = videoPreview.assets.find((asset: { variant: string; mimeType: string }) => asset.variant === 'preview' && asset.mimeType === 'video/mp4');
    expect(videoAsset).toBeTruthy();
    expect(videoAsset.metadata.sceneDurations).toEqual(videoDurations);
    const archivedVideo = await app.inject({ method: 'DELETE', url: `/api/content/${videoId}`, headers });
    expect(archivedVideo.statusCode).toBe(200);
    expect(archivedVideo.json().status).toBe('archived');
    expect((await app.inject({ method: 'GET', url: `/api/content/${videoId}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/projects/${projectId}/content?pageSize=50` })).json().items.some((item: { id: string }) => item.id === videoId)).toBe(false);
  }, 60_000);

  it('allows video source media in the content selection step', async () => {
    db = createDatabase(':memory:');
    app = await buildApp({ db, settings: { ...config, localIntegrationToken: token } });
    const headers = { 'x-local-integration-token': token };
    const imported = await app.inject({ method: 'POST', url: '/api/imports/pinterest-board', headers, payload: {
      schemaVersion: 1,
      source: 'test',
      exportedAt: new Date().toISOString(),
      board: { externalId: 'video-board', name: 'Video board', url: 'https://www.pinterest.com/test/video-board/', description: null },
      pins: [{
        externalId: 'video-source',
        pinUrl: 'https://www.pinterest.com/pin/video-source/',
        imageUrl: 'https://i.pinimg.com/736x/aa/bb/cc/video-source.jpg',
        previewUrl: 'https://i.pinimg.com/236x/aa/bb/cc/video-source.jpg',
        mediaUrl: 'https://v.pinimg.com/videos/video-source.mp4',
        mediaType: 'video',
        mimeType: 'video/mp4',
        width: 736,
        height: 1104,
        durationSeconds: 4.2
      }]
    } });
    const collectionId = imported.json().collection.id as string;
    const createdProject = await app.inject({ method: 'POST', url: '/api/projects', headers, payload: { name: 'Video sources', niche: 'Travel', collectionIds: [collectionId] } });
    const projectId = createdProject.json().id as string;
    const videoAsset = (await app.inject({ method: 'GET', url: `/api/collections/${collectionId}/assets?mediaType=video` })).json().items[0];
    const draft = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/content`, headers, payload: { type: 'single_image', configuration: { sourceCollectionIds: [collectionId] } } });
    const selected = await app.inject({ method: 'POST', url: `/api/content/${draft.json().id}/images/select`, headers, payload: { mediaIds: [videoAsset.id] } });
    expect(selected.statusCode).toBe(200);
    expect(selected.json().frames[0].sourceMedia).toMatchObject({ mediaType: 'video', width: 736, height: 1104 });
    expect(selected.json().frames[0].role).toBe('title_and_summary');

    const videoDraft = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/content`, headers, payload: { type: 'video_slideshow', configuration: { sourceCollectionIds: [collectionId], totalFrames: 1, includeCover: false, includeCta: false, textMode: 'none', video: { secondsPerImage: 1.5 } } } });
    const videoContentId = videoDraft.json().id as string;
    const videoContentSelection = await app.inject({ method: 'POST', url: `/api/content/${videoContentId}/images/select`, headers, payload: { mediaIds: [videoAsset.id] } });
    expect(videoContentSelection.json().frames[0].durationSeconds).toBe(4.2);
    const durationUpdate = await app.inject({ method: 'PATCH', url: `/api/content/${videoContentId}/frames/${videoContentSelection.json().frames[0].id}`, headers, payload: { durationSeconds: 2.1 } });
    expect(durationUpdate.statusCode).toBe(200);
    expect(durationUpdate.json().frames[0].durationSeconds).toBe(2.1);
    const invalidDuration = await app.inject({ method: 'PATCH', url: `/api/content/${videoContentId}/frames/${videoContentSelection.json().frames[0].id}`, headers, payload: { durationSeconds: 4.3 } });
    expect(invalidDuration.statusCode).toBe(400);
    expect(invalidDuration.json().error.code).toBe('INVALID_FRAME_DURATION');
  });
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error('Timed out waiting for background job');
}
