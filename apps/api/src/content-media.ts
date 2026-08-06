import crypto from 'node:crypto';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ContentConfiguration } from './content-model.js';
import { ratioDimensions } from './content-model.js';

export class MediaProcessingError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'MediaProcessingError'; }
}

export function contentDirectory(storageDirectory: string, contentId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(contentId)) throw new MediaProcessingError('INVALID_CONTENT_ID', 'Invalid content identifier.');
  const root = path.resolve(storageDirectory);
  const directory = path.resolve(root, `content-${contentId}`);
  if (!directory.startsWith(`${root}${path.sep}`)) throw new MediaProcessingError('INVALID_CONTENT_PATH', 'Invalid content storage path.');
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

export async function downloadSource(url: string, destination: string): Promise<void> {
  if (url.startsWith('data:')) {
    const match = url.match(/^data:[^;,]+(?:;charset=[^;,]+)?(;base64)?,(.*)$/s);
    if (!match) throw new MediaProcessingError('UNSUPPORTED_SOURCE', 'The data URL is invalid.');
    const encoded = match[2] ?? '';
    const body = match[1] ? Buffer.from(encoded, 'base64') : Buffer.from(decodeURIComponent(encoded), 'utf8');
    if (body.byteLength > 25 * 1024 * 1024) throw new MediaProcessingError('SOURCE_TOO_LARGE', 'The source image is too large.');
    await fsp.writeFile(destination, body);
    return;
  }
  if (url.startsWith('file://')) {
    await fsp.copyFile(fileURLToPath(url), destination);
    return;
  }
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new MediaProcessingError('INVALID_SOURCE_URL', 'The source media URL is invalid.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new MediaProcessingError('UNSUPPORTED_SOURCE', 'Only HTTP(S), file, and data source media are supported.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(parsed, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok || !response.body) throw new MediaProcessingError('SOURCE_DOWNLOAD_FAILED', `The source image could not be downloaded (${response.status}).`);
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > 25 * 1024 * 1024) throw new MediaProcessingError('SOURCE_TOO_LARGE', 'The source image is too large.');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > 25 * 1024 * 1024) throw new MediaProcessingError('SOURCE_TOO_LARGE', 'The source image is too large.');
    await fsp.writeFile(destination, buffer);
  } catch (error) {
    if (error instanceof MediaProcessingError) throw error;
    throw new MediaProcessingError('SOURCE_DOWNLOAD_FAILED', error instanceof Error ? error.message : 'The source image could not be downloaded.');
  } finally { clearTimeout(timer); }
}

function escapedFilterPath(value: string): string { return value.replaceAll('\\', '/').replaceAll(':', '\\:').replaceAll("'", "\\'"); }

async function runFfmpeg(ffmpegPath: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); if (stderr.length > 8_000) stderr = stderr.slice(-8_000); });
    child.on('error', (error) => reject(new MediaProcessingError('FFMPEG_UNAVAILABLE', error.message)));
    child.on('close', (code) => code === 0 ? resolve() : reject(new MediaProcessingError('FFMPEG_FAILED', stderr.trim().split(/\r?\n/).slice(-3).join(' ') || `FFmpeg exited with code ${code}.`)));
  });
}

function filterFor(configuration: ContentConfiguration, width: number, height: number): string {
  const crop = configuration.visual.cropMode;
  if (crop === 'fit' || crop === 'pad') return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`;
  return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
}

export async function normalizeImage(options: { ffmpegPath: string; sourcePath: string; outputPath: string; configuration: ContentConfiguration; text?: string | null; }): Promise<{ width: number; height: number }> {
  const { width, height } = ratioDimensions(options.configuration.aspectRatio, options.configuration.video.outputResolution === '1080p' ? '1080p' : '720p');
  const filters = [filterFor(options.configuration, width, height)];
  if (options.text && options.configuration.textMode !== 'none') {
    const textPath = `${options.outputPath}.txt`;
    await fsp.writeFile(textPath, options.text.slice(0, 600), 'utf8');
    const fontCandidate = process.platform === 'win32' ? 'C:/Windows/Fonts/arial.ttf' : '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
    const y = options.configuration.visual.textPosition === 'top' ? '80' : options.configuration.visual.textPosition === 'center' ? '(h-text_h)/2' : 'h-text_h-90';
    const x = options.configuration.visual.textAlignment === 'left' ? '60' : options.configuration.visual.textAlignment === 'right' ? 'w-text_w-60' : '(w-text_w)/2';
    const box = options.configuration.visual.overlay ? `:box=1:boxcolor=black@${Math.max(0, Math.min(1, options.configuration.visual.overlayOpacity))}:boxborderw=28` : '';
    filters.push(`drawtext=fontfile='${escapedFilterPath(fontCandidate)}':textfile='${escapedFilterPath(textPath)}':fontcolor=${options.configuration.visual.textColor}:fontsize=${Math.max(18, Math.min(120, options.configuration.visual.fontSize))}:x=${x}:y=${y}:line_spacing=10${box}`);
  }
  await runFfmpeg(options.ffmpegPath, ['-y', '-i', options.sourcePath, '-vf', filters.join(','), '-frames:v', '1', '-c:v', 'png', options.outputPath]);
  await fsp.rm(`${options.outputPath}.txt`, { force: true });
  return { width, height };
}

export async function createThumbnail(options: { ffmpegPath: string; sourcePath: string; outputPath: string }): Promise<{ width: number; height: number }> {
  await runFfmpeg(options.ffmpegPath, ['-y', '-i', options.sourcePath, '-vf', 'scale=320:-2:force_original_aspect_ratio=decrease', '-frames:v', '1', '-c:v', 'webp', options.outputPath]);
  return { width: 320, height: 320 };
}

export async function renderSlideshow(options: { ffmpegPath: string; imagePaths: string[]; outputPath: string; configuration: ContentConfiguration }): Promise<{ width: number; height: number; durationMs: number }> {
  if (!options.imagePaths.length) throw new MediaProcessingError('NO_IMAGES', 'At least one image is required for a video slideshow.');
  const dimensions = ratioDimensions(options.configuration.aspectRatio, options.configuration.video.outputResolution);
  // H.264 with yuv420p requires even dimensions. Keep image exports at their
  // requested dimensions, but make the video canvas encoder-safe.
  const width = dimensions.width % 2 === 0 ? dimensions.width : dimensions.width + 1;
  const height = dimensions.height % 2 === 0 ? dimensions.height : dimensions.height + 1;
  const listPath = `${options.outputPath}.concat.txt`;
  const seconds = Math.max(0.5, Math.min(30, options.configuration.video.secondsPerImage));
  const lines = [...options.imagePaths, options.imagePaths.at(-1)!].map((imagePath, index) => {
    const concatPath = imagePath.replaceAll('\\', '/').replaceAll("'", "'\\''");
    return `file '${concatPath}'${index < options.imagePaths.length ? `\nduration ${seconds}` : ''}`;
  });
  await fsp.writeFile(listPath, lines.join('\n'), 'utf8');
  const framing = options.configuration.visual.cropMode === 'crop'
    ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
    : `scale=${width}:${height}:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`;
  try {
    await runFfmpeg(options.ffmpegPath, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-vf', `${framing},format=yuv420p`, '-r', String(Math.max(1, Math.min(60, options.configuration.video.fps))), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', options.outputPath]);
  } finally {
    await fsp.rm(listPath, { force: true });
  }
  return { width, height, durationMs: Math.round(options.imagePaths.length * seconds * 1000) };
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => { const stream = fs.createReadStream(filePath); stream.on('data', (chunk) => hash.update(chunk)); stream.on('error', reject); stream.on('end', resolve); });
  return hash.digest('hex');
}
