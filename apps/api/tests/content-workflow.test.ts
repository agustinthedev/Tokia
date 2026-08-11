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
    expect(draftResponse.json().wizardStep).toBe(1);
    expect(draftResponse.json().frames.map((frame: { role: string }) => frame.role)).toEqual(['cover', 'content', 'content', 'content', 'cta']);
    const stepUpdate = await app.inject({ method: 'PATCH', url: `/api/content/${contentId}/wizard-step`, headers, payload: { step: 5 } });
    expect(stepUpdate.statusCode).toBe(200);
    expect(stepUpdate.json().wizardStep).toBe(5);
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
    const videoDraft = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/content`, headers, payload: { type: 'video_slideshow', title: 'Morning mobility slideshow', configuration: { sourceCollectionIds: [collectionId], totalFrames: 3, includeCover: true, includeCta: false, textMode: 'none', video: { secondsPerImage: 0.35, fps: 24, outputResolution: '720p' } } } });
    const videoId = videoDraft.json().id as string;
    expect(videoDraft.json().title).toBe('Morning mobility slideshow');
    const videoSelectedResponse = await app.inject({ method: 'POST', url: `/api/content/${videoId}/images/select`, headers, payload: {} });
    expect(videoSelectedResponse.json().configuration.video.secondsPerImage).toBe(0.35);
    expect(videoSelectedResponse.json().frames.map((frame: { durationSeconds: number }) => frame.durationSeconds)).toEqual([0.35, 0.35, 0.35]);
    const firstVideoFrame = videoSelectedResponse.json().frames[0];
    const lockedDuration = await app.inject({ method: 'PATCH', url: `/api/content/${videoId}/frames/${firstVideoFrame.id}`, headers, payload: { durationSeconds: 0.7 } });
    expect(lockedDuration.statusCode).toBe(200);
    const lockedFrame = await app.inject({ method: 'PATCH', url: `/api/content/${videoId}/frames/${firstVideoFrame.id}`, headers, payload: { imageLocked: true } });
    expect(lockedFrame.statusCode).toBe(200);
    const bulkDuration = await app.inject({ method: 'PATCH', url: `/api/content/${videoId}/frames/duration`, headers, payload: { durationSeconds: 0.35 } });
    expect(bulkDuration.statusCode).toBe(200);
    expect(bulkDuration.json().frames.map((frame: { durationSeconds: number }) => frame.durationSeconds)).toEqual([0.7, 0.35, 0.35]);
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
      }, {
        externalId: 'image-source',
        pinUrl: 'https://www.pinterest.com/pin/image-source/',
        imageUrl: 'https://i.pinimg.com/736x/dd/ee/ff/image-source.jpg',
        previewUrl: 'https://i.pinimg.com/236x/dd/ee/ff/image-source.jpg',
        width: 736,
        height: 1104
      }]
    } });
    const collectionId = imported.json().collection.id as string;
    const createdProject = await app.inject({ method: 'POST', url: '/api/projects', headers, payload: { name: 'Video sources', niche: 'Travel', collectionIds: [collectionId] } });
    const projectId = createdProject.json().id as string;
    const videoAsset = (await app.inject({ method: 'GET', url: `/api/collections/${collectionId}/assets?mediaType=video` })).json().items[0];
    const imageAsset = (await app.inject({ method: 'GET', url: `/api/collections/${collectionId}/assets?mediaType=image` })).json().items[0];
    const durationMetadata = await app.inject({ method: 'PATCH', url: `/api/assets/${videoAsset.id}`, headers, payload: { durationSeconds: 13 } });
    expect(durationMetadata.statusCode).toBe(200);
    expect(durationMetadata.json().durationSeconds).toBe(13);
    const invalidAssetDuration = await app.inject({ method: 'PATCH', url: `/api/assets/${videoAsset.id}`, headers, payload: { durationSeconds: 0 } });
    expect(invalidAssetDuration.statusCode).toBe(400);
    expect(invalidAssetDuration.json().error.code).toBe('INVALID_ASSET_DURATION');
    const scopedAssets = await app.inject({ method: 'GET', url: `/api/assets?mediaType=source&collectionIds=${collectionId}&search=${videoAsset.externalId}` });
    expect(scopedAssets.statusCode).toBe(200);
    expect(scopedAssets.json().items.map((asset: { id: string }) => asset.id)).toContain(videoAsset.id);
    const draft = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/content`, headers, payload: { type: 'single_image', configuration: { sourceCollectionIds: [collectionId] } } });
    const selected = await app.inject({ method: 'POST', url: `/api/content/${draft.json().id}/images/select`, headers, payload: { mediaIds: [videoAsset.id] } });
    expect(selected.statusCode).toBe(200);
    expect(selected.json().frames[0].sourceMedia).toMatchObject({ mediaType: 'video', width: 736, height: 1104 });
    expect(selected.json().frames[0].role).toBe('title_and_summary');
    const manuallyLocked = await app.inject({ method: 'PUT', url: `/api/content/${draft.json().id}/frames/${selected.json().frames[0].id}/image`, headers, payload: { mediaId: videoAsset.id } });
    expect(manuallyLocked.statusCode).toBe(200);
    expect(manuallyLocked.json().frames[0].imageLocked).toBe(true);

    const videoDraft = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/content`, headers, payload: { type: 'video_slideshow', configuration: { sourceCollectionIds: [collectionId], totalFrames: 1, includeCover: false, includeCta: false, textMode: 'none', video: { secondsPerImage: 1.5 } } } });
    const videoContentId = videoDraft.json().id as string;
    const videoContentSelection = await app.inject({ method: 'POST', url: `/api/content/${videoContentId}/images/select`, headers, payload: { mediaIds: [videoAsset.id] } });
    expect(videoContentSelection.json().frames[0].durationSeconds).toBe(13);
    expect(videoContentSelection.json().frames[0].muted).toBe(false);
    const mutedFrame = await app.inject({ method: 'PATCH', url: `/api/content/${videoContentId}/frames/${videoContentSelection.json().frames[0].id}`, headers, payload: { muted: true } });
    expect(mutedFrame.statusCode).toBe(200);
    expect(mutedFrame.json().frames[0]).toMatchObject({ muted: true, settings: { muted: true } });
    const unmutedFrame = await app.inject({ method: 'PATCH', url: `/api/content/${videoContentId}/frames/${videoContentSelection.json().frames[0].id}`, headers, payload: { muted: false } });
    expect(unmutedFrame.statusCode).toBe(200);
    expect(unmutedFrame.json().frames[0]).toMatchObject({ muted: false, settings: { muted: false } });
    const durationUpdate = await app.inject({ method: 'PATCH', url: `/api/content/${videoContentId}/frames/${videoContentSelection.json().frames[0].id}`, headers, payload: { durationSeconds: 2.1 } });
    expect(durationUpdate.statusCode).toBe(200);
    expect(durationUpdate.json().frames[0].durationSeconds).toBe(2.1);
    const bulkVideoDuration = await app.inject({ method: 'PATCH', url: `/api/content/${videoContentId}/frames/duration`, headers, payload: { durationSeconds: 0.35 } });
    expect(bulkVideoDuration.statusCode).toBe(200);
    expect(bulkVideoDuration.json().frames[0].durationSeconds).toBe(2.1);
    const trimUpdate = await app.inject({ method: 'PATCH', url: `/api/content/${videoContentId}/frames/${videoContentSelection.json().frames[0].id}`, headers, payload: { startSeconds: 1.1, endSeconds: 3.3 } });
    expect(trimUpdate.statusCode).toBe(200);
    expect(trimUpdate.json().frames[0]).toMatchObject({ startSeconds: 1.1, endSeconds: 3.3, durationSeconds: 2.2 });
    const invalidTrim = await app.inject({ method: 'PATCH', url: `/api/content/${videoContentId}/frames/${videoContentSelection.json().frames[0].id}`, headers, payload: { startSeconds: 3.4, endSeconds: 3.3 } });
    expect(invalidTrim.statusCode).toBe(400);
    expect(invalidTrim.json().error.code).toBe('INVALID_FRAME_TRIM');
    const invalidDuration = await app.inject({ method: 'PATCH', url: `/api/content/${videoContentId}/frames/${videoContentSelection.json().frames[0].id}`, headers, payload: { durationSeconds: 13.1 } });
    expect(invalidDuration.statusCode).toBe(400);
    expect(invalidDuration.json().error.code).toBe('INVALID_FRAME_DURATION');
    const replacedWithImage = await app.inject({ method: 'PUT', url: `/api/content/${videoContentId}/frames/${videoContentSelection.json().frames[0].id}/image`, headers, payload: { mediaId: imageAsset.id } });
    expect(replacedWithImage.statusCode).toBe(200);
    expect(replacedWithImage.json().frames[0]).toMatchObject({ durationSeconds: 1.5, startSeconds: null, endSeconds: null, sourceMedia: { mediaType: 'image' } });
    expect(replacedWithImage.json().frames[0].settings).toMatchObject({ durationSeconds: 1.5, durationCustomized: false });
    expect(replacedWithImage.json().frames[0].settings.startSeconds).toBeUndefined();
    expect(replacedWithImage.json().frames[0].settings.endSeconds).toBeUndefined();
    expect(replacedWithImage.json().configuration.video.secondsPerImage).toBe(1.5);
    const unlockedImage = await app.inject({ method: 'PATCH', url: `/api/content/${videoContentId}/frames/${videoContentSelection.json().frames[0].id}`, headers, payload: { imageLocked: false } });
    expect(unlockedImage.statusCode).toBe(200);
    expect(unlockedImage.json().frames[0]).toMatchObject({ imageLocked: false, sourceMedia: { mediaType: 'image' } });
    const bulkImageDuration = await app.inject({ method: 'PATCH', url: `/api/content/${videoContentId}/frames/duration`, headers, payload: { durationSeconds: 0.8 } });
    expect(bulkImageDuration.statusCode).toBe(200);
    expect(bulkImageDuration.json().frames[0]).toMatchObject({ durationSeconds: 0.8, imageLocked: false, sourceMedia: { mediaType: 'image' } });
  });
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error('Timed out waiting for background job');
}
