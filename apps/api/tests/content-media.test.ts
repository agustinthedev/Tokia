import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { renderSlideshow, textOverlayLayout } from '../src/content-media.js';
import { mergeConfiguration } from '../src/content-model.js';

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
