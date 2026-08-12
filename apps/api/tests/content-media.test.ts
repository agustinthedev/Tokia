import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { renderSlideshow, SLIDESHOW_VIDEO_ENCODING, textOverlayLayout } from '../src/content-media.js';
import { mergeConfiguration, ratioDimensions } from '../src/content-model.js';

const execFileAsync = promisify(execFile);

describe('content text overlays', () => {
  it('renders headline and body as distinct typographic layers', () => {
    const configuration = mergeConfiguration({ textMode: 'headline_and_body' });
    const parts = textOverlayLayout(configuration, 405, 720, { headline: 'Life lately', body: 'I like it' });

    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ key: 'headline', text: 'Life lately', fontSize: 54 });
    expect(parts[1]).toMatchObject({ key: 'body', text: 'I like it', fontSize: 31 });
    expect(parts[1]!.fontSize).toBeLessThan(parts[0]!.fontSize);
    expect(parts[1]!.y).toContain('+');
  });

  it('wraps long copy without introducing a replacement glyph between fields', () => {
    const configuration = mergeConfiguration({ textMode: 'headline_and_body', visual: { fontFamily: 'Arial', fontSize: 54, fontWeight: '700' } });
    const parts = textOverlayLayout(configuration, 405, 720, {
      headline: 'A headline that needs a second line',
      body: 'A longer body should wrap into readable lines without being rendered as one undifferentiated block.'
    });

    expect(parts[0]!.text).toContain('\n');
    expect(parts[1]!.text).toContain('\n');
    expect(parts.every((part) => !part.text.includes('\uFFFD'))).toBe(true);
  });
});

describe('video slideshow audio', () => {
  it('keeps source audio by default and replaces it with silence when muted', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'tokia-slideshow-audio-'));
    try {
      const sourcePath = path.join(directory, 'source.mp4');
      await execFileAsync('ffmpeg', [
        '-y',
        '-f', 'lavfi',
        '-i', 'color=c=blue:s=64x64:r=24',
        '-f', 'lavfi',
        '-i', 'sine=frequency=440:sample_rate=48000',
        '-t', '0.6',
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-ar', '48000',
        '-ac', '2',
        sourcePath,
      ]);
      const imagePath = path.join(directory, 'image.png');
      await execFileAsync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=green:s=64x64', '-frames:v', '1', imagePath]);
      const configuration = mergeConfiguration({ textMode: 'none', video: { secondsPerImage: 0.4, fps: 24, outputResolution: '720p' } });
      const unmutedPath = path.join(directory, 'unmuted.mp4');
      const mutedPath = path.join(directory, 'muted.mp4');
      const mixedPath = path.join(directory, 'mixed.mp4');
      await renderSlideshow({
        ffmpegPath: 'ffmpeg',
        ffprobePath: 'ffprobe',
        scenes: [{ path: sourcePath, mediaType: 'video', durationSeconds: 0.4 }],
        outputPath: unmutedPath,
        configuration,
      });
      await renderSlideshow({
        ffmpegPath: 'ffmpeg',
        ffprobePath: 'ffprobe',
        scenes: [{ path: sourcePath, mediaType: 'video', durationSeconds: 0.4, muted: true }],
        outputPath: mutedPath,
        configuration,
      });
      await renderSlideshow({
        ffmpegPath: 'ffmpeg',
        ffprobePath: 'ffprobe',
        scenes: [
          { path: imagePath, mediaType: 'image', durationSeconds: 0.4 },
          { path: sourcePath, mediaType: 'video', durationSeconds: 0.4 },
        ],
        outputPath: mixedPath,
        configuration,
      });
      const probeAudio = async (filePath: string): Promise<string> => (await execFileAsync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', filePath])).stdout;
      expect(await probeAudio(unmutedPath)).toContain('audio');
      expect(await probeAudio(mutedPath)).toContain('audio');
      expect(await probeAudio(mixedPath)).toContain('audio');
      const volume = async (filePath: string): Promise<number> => {
        const result = await execFileAsync('ffmpeg', ['-hide_banner', '-i', filePath, '-af', 'volumedetect', '-f', 'null', '-']);
        const match = result.stderr.match(/mean_volume:\s+(-?\d+(?:\.\d+)?) dB/);
        return match ? Number(match[1]) : Number.NEGATIVE_INFINITY;
      };
      expect(await volume(unmutedPath)).toBeGreaterThan(-40);
      expect(await volume(mutedPath)).toBeLessThan(-80);
    } finally {
      await fsp.rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('video slideshow output quality', () => {
  it('maps resolution settings to standard canvas dimensions', () => {
    expect(ratioDimensions('16:9', '1080p')).toEqual({ width: 1920, height: 1080 });
    expect(ratioDimensions('16:9', '720p')).toEqual({ width: 1280, height: 720 });
    expect(ratioDimensions('9:16', '1080p')).toEqual({ width: 1080, height: 1920 });
    expect(ratioDimensions('9:16', '720p')).toEqual({ width: 720, height: 1280 });
    expect(ratioDimensions('4:5', '1080p')).toEqual({ width: 864, height: 1080 });
    expect(ratioDimensions('1:1', '1080p')).toEqual({ width: 1080, height: 1080 });
  });

  it('uses an explicit high-quality H.264 encoding contract', () => {
    expect(SLIDESHOW_VIDEO_ENCODING).toMatchObject({
      codec: 'libx264',
      preset: 'slow',
      profile: 'high',
      bitrate: '10M',
      maxRate: '12M',
      bufferSize: '24M',
      pixelFormat: 'yuv420p',
      audioBitrate: '192k'
    });
  });

  it('renders a 1080p landscape slideshow at full HD dimensions', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'tokia-slideshow-quality-'));
    try {
      const imagePath = path.join(directory, 'image.png');
      const outputPath = path.join(directory, 'output.mp4');
      await execFileAsync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=green:s=64x64', '-frames:v', '1', imagePath]);
      await renderSlideshow({
        ffmpegPath: 'ffmpeg',
        ffprobePath: 'ffprobe',
        imagePaths: [imagePath],
        outputPath,
        configuration: mergeConfiguration({
          aspectRatio: '16:9',
          textMode: 'none',
          video: { outputResolution: '1080p', fps: 24, secondsPerImage: 0.5, transition: 'none' }
        })
      });
      const probe = JSON.parse((await execFileAsync('ffprobe', [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name,width,height,pix_fmt',
        '-of', 'json',
        outputPath
      ])).stdout) as { streams?: Array<Record<string, unknown>> };
      expect(probe.streams?.[0]).toMatchObject({
        codec_name: 'h264',
        width: 1920,
        height: 1080,
        pix_fmt: 'yuv420p'
      });
    } finally {
      await fsp.rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('video slideshow transitions', () => {
  it('renders hard cuts for none and blended boundary frames for fade', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'tokia-slideshow-transition-'));
    try {
      const redPath = path.join(directory, 'red.png');
      const bluePath = path.join(directory, 'blue.png');
      await execFileAsync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', redPath]);
      await execFileAsync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64', '-frames:v', '1', bluePath]);
      const render = async (transition: 'none' | 'fade'): Promise<string> => {
        const outputPath = path.join(directory, `${transition}.mp4`);
        await renderSlideshow({
          ffmpegPath: 'ffmpeg',
          ffprobePath: 'ffprobe',
          imagePaths: [redPath, bluePath],
          outputPath,
          configuration: mergeConfiguration({ textMode: 'none', aspectRatio: '1:1', video: { transition, transitionDuration: 0.4, secondsPerImage: 1, fps: 30, outputResolution: '720p' } }),
        });
        return outputPath;
      };
      const nonePath = await render('none');
      const fadePath = await render('fade');
      const pixelAt = async (filePath: string, seconds: number): Promise<[number, number, number]> => {
        const { stdout } = await execFileAsync('ffmpeg', ['-v', 'error', '-ss', String(seconds), '-i', filePath, '-frames:v', '1', '-vf', 'scale=1:1,format=rgb24', '-f', 'rawvideo', '-'], { encoding: 'buffer' });
        return [stdout[0]!, stdout[1]!, stdout[2]!];
      };
      const hardBoundary = await pixelAt(nonePath, 0.9);
      const blendedBoundary = await pixelAt(fadePath, 0.8);
      expect(hardBoundary[0]).toBeGreaterThan(200);
      expect(hardBoundary[2]).toBeLessThan(50);
      expect(blendedBoundary[0]).toBeGreaterThan(60);
      expect(blendedBoundary[2]).toBeGreaterThan(60);
    } finally {
      await fsp.rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
