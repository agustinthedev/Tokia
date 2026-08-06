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

export interface TextOverlay {
  headline?: string | null;
  body?: string | null;
}

interface TextOverlayPart {
  key: 'headline' | 'body';
  text: string;
  fontSize: number;
  fontFile: string;
  x: string;
  y: string;
  lineSpacing: number;
  boxBorderWidth: number;
}

const TEXT_LINE_SPACING = 8;
const TEXT_BLOCK_GAP = 18;

function clamp(value: number, minimum: number, maximum: number): number { return Math.max(minimum, Math.min(maximum, value)); }

function wrapOverlayText(value: string, maximumCharacters: number): string {
  return value.replace(/\r\n?/g, '\n').split('\n').flatMap((paragraph) => {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return [''];
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (line && next.length > maximumCharacters) { lines.push(line); line = word; } else line = next;
    }
    if (line) lines.push(line);
    return lines;
  }).join('\n');
}

function fontFileFor(fontFamily: string, fontWeight: string): string {
  const bold = /^(bold|[6-9]\d{2})$/i.test(String(fontWeight ?? '').trim());
  const family = String(fontFamily ?? 'Arial').trim().toLowerCase();
  const candidates = family === 'georgia'
    ? (bold
      ? ['C:/Windows/Fonts/georgiab.ttf', '/usr/share/fonts/truetype/msttcorefonts/Georgia_Bold.ttf', '/usr/share/fonts/truetype/liberation2/LiberationSerif-Bold.ttf']
      : ['C:/Windows/Fonts/georgia.ttf', '/usr/share/fonts/truetype/msttcorefonts/Georgia.ttf', '/usr/share/fonts/truetype/liberation2/LiberationSerif-Regular.ttf'])
    : family === 'dejavu sans'
      ? (bold
        ? ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 'C:/Windows/Fonts/arialbd.ttf', '/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf']
        : ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 'C:/Windows/Fonts/arial.ttf', '/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf'])
      : (bold
        ? ['C:/Windows/Fonts/arialbd.ttf', '/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf']
        : ['C:/Windows/Fonts/arial.ttf', '/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']);
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]!;
}

function textX(configuration: ContentConfiguration): string {
  if (configuration.visual.textAlignment === 'left') return '60';
  if (configuration.visual.textAlignment === 'right') return 'w-text_w-60';
  return '(w-text_w)/2';
}

export function textOverlayLayout(configuration: ContentConfiguration, width: number, height: number, text: TextOverlay): TextOverlayPart[] {
  const headline = text.headline?.trim() ?? '';
  const body = text.body?.trim() ?? '';
  if (!headline && !body) return [];
  const headlineSize = clamp(Math.round(configuration.visual.fontSize || 54), 28, 120);
  const bodySize = clamp(Math.round(headlineSize * 0.58), 20, 72);
  const headlineText = headline ? wrapOverlayText(headline, clamp(Math.floor(width / (headlineSize * 0.5)), 12, 42)) : '';
  const bodyText = body ? wrapOverlayText(body, clamp(Math.floor(width / (bodySize * 0.5)), 18, 64)) : '';
  const headlineLines = headlineText ? headlineText.split('\n').length : 0;
  const bodyLines = bodyText ? bodyText.split('\n').length : 0;
  const headlineHeight = headlineLines ? headlineLines * headlineSize + (headlineLines - 1) * TEXT_LINE_SPACING : 0;
  const bodyHeight = bodyLines ? bodyLines * bodySize + (bodyLines - 1) * TEXT_LINE_SPACING : 0;
  const blockHeight = headlineHeight + bodyHeight + (headlineText && bodyText ? TEXT_BLOCK_GAP : 0);
  const top = configuration.visual.textPosition === 'top'
    ? '80'
    : configuration.visual.textPosition === 'center'
      ? `(h-${blockHeight})/2`
      : `h-${blockHeight}-90`;
  const bodyY = headlineText ? `${top}+${headlineHeight + TEXT_BLOCK_GAP}` : top;
  const x = textX(configuration);
  const parts: TextOverlayPart[] = [];
  if (headlineText) parts.push({ key: 'headline', text: headlineText, fontSize: headlineSize, fontFile: fontFileFor(configuration.visual.fontFamily, configuration.visual.fontWeight), x, y: top, lineSpacing: TEXT_LINE_SPACING, boxBorderWidth: 24 });
  if (bodyText) parts.push({ key: 'body', text: bodyText, fontSize: bodySize, fontFile: fontFileFor(configuration.visual.fontFamily, '400'), x, y: bodyY, lineSpacing: TEXT_LINE_SPACING, boxBorderWidth: 16 });
  return parts;
}

export async function normalizeImage(options: { ffmpegPath: string; sourcePath: string; outputPath: string; configuration: ContentConfiguration; text?: TextOverlay | null; }): Promise<{ width: number; height: number }> {
  const { width, height } = ratioDimensions(options.configuration.aspectRatio, options.configuration.video.outputResolution === '1080p' ? '1080p' : '720p');
  const filters = [filterFor(options.configuration, width, height)];
  const textPaths: string[] = [];
  try {
    if (options.text && options.configuration.textMode !== 'none') {
      for (const part of textOverlayLayout(options.configuration, width, height, options.text)) {
        const textPath = `${options.outputPath}.${part.key}.txt`;
        textPaths.push(textPath);
        await fsp.writeFile(textPath, part.text.slice(0, part.key === 'headline' ? 120 : 600), 'utf8');
        const box = options.configuration.visual.overlay ? `:box=1:boxcolor=black@${Math.max(0, Math.min(1, options.configuration.visual.overlayOpacity))}:boxborderw=${part.boxBorderWidth}` : '';
        filters.push(`drawtext=fontfile='${escapedFilterPath(part.fontFile)}':textfile='${escapedFilterPath(textPath)}':fontcolor=${options.configuration.visual.textColor}:fontsize=${part.fontSize}:x=${part.x}:y=${part.y}:line_spacing=${part.lineSpacing}${box}`);
      }
    }
    await runFfmpeg(options.ffmpegPath, ['-y', '-i', options.sourcePath, '-vf', filters.join(','), '-frames:v', '1', '-c:v', 'png', options.outputPath]);
  } finally {
    await Promise.all(textPaths.map((textPath) => fsp.rm(textPath, { force: true })));
  }
  return { width, height };
}

export async function createThumbnail(options: { ffmpegPath: string; sourcePath: string; outputPath: string }): Promise<{ width: number; height: number }> {
  await runFfmpeg(options.ffmpegPath, ['-y', '-i', options.sourcePath, '-vf', 'scale=320:-2:force_original_aspect_ratio=decrease', '-frames:v', '1', '-c:v', 'webp', options.outputPath]);
  return { width: 320, height: 320 };
}

export interface SlideshowScene {
  path: string;
  mediaType: 'image' | 'video';
  durationSeconds: number;
  text?: TextOverlay | null;
}

async function renderSceneClip(options: { ffmpegPath: string; scene: SlideshowScene; outputPath: string; configuration: ContentConfiguration; width: number; height: number }): Promise<void> {
  const { scene, configuration, width, height } = options;
  const filters = [filterFor(configuration, width, height)];
  const textPaths: string[] = [];
  try {
    if (scene.text && configuration.textMode !== 'none') {
      for (const part of textOverlayLayout(configuration, width, height, scene.text)) {
        const textPath = `${options.outputPath}.${part.key}.txt`;
        textPaths.push(textPath);
        await fsp.writeFile(textPath, part.text.slice(0, part.key === 'headline' ? 120 : 600), 'utf8');
        const box = configuration.visual.overlay ? `:box=1:boxcolor=black@${Math.max(0, Math.min(1, configuration.visual.overlayOpacity))}:boxborderw=${part.boxBorderWidth}` : '';
        filters.push(`drawtext=fontfile='${escapedFilterPath(part.fontFile)}':textfile='${escapedFilterPath(textPath)}':fontcolor=${configuration.visual.textColor}:fontsize=${part.fontSize}:x=${part.x}:y=${part.y}:line_spacing=${part.lineSpacing}${box}`);
      }
    }
    const duration = Math.max(0.1, Number(scene.durationSeconds) || configuration.video.secondsPerImage);
    const input = scene.mediaType === 'video' ? ['-i', scene.path] : ['-loop', '1', '-i', scene.path];
    await runFfmpeg(options.ffmpegPath, ['-y', ...input, '-t', String(duration), '-vf', `${filters.join(',')},format=yuv420p`, '-an', '-r', String(Math.max(1, Math.min(60, configuration.video.fps))), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', options.outputPath]);
  } finally {
    await Promise.all(textPaths.map((textPath) => fsp.rm(textPath, { force: true })));
  }
}

export async function renderSlideshow(options: { ffmpegPath: string; imagePaths?: string[]; scenes?: SlideshowScene[]; outputPath: string; configuration: ContentConfiguration }): Promise<{ width: number; height: number; durationMs: number }> {
  const scenes = options.scenes ?? (options.imagePaths ?? []).map((imagePath) => ({ path: imagePath, mediaType: 'image' as const, durationSeconds: options.configuration.video.secondsPerImage }));
  if (!scenes.length) throw new MediaProcessingError('NO_IMAGES', 'At least one image or video is required for a video slideshow.');
  const dimensions = ratioDimensions(options.configuration.aspectRatio, options.configuration.video.outputResolution);
  // H.264 with yuv420p requires even dimensions. Keep image exports at their
  // requested dimensions, but make the video canvas encoder-safe.
  const width = dimensions.width % 2 === 0 ? dimensions.width : dimensions.width + 1;
  const height = dimensions.height % 2 === 0 ? dimensions.height : dimensions.height + 1;
  const listPath = `${options.outputPath}.concat.txt`;
  const clipPaths = scenes.map((_, index) => `${options.outputPath}.scene-${String(index + 1).padStart(2, '0')}.mp4`);
  try {
    for (let index = 0; index < scenes.length; index += 1) {
      await renderSceneClip({ ffmpegPath: options.ffmpegPath, scene: scenes[index]!, outputPath: clipPaths[index]!, configuration: options.configuration, width, height });
    }
    const lines = clipPaths.map((clipPath) => `file '${clipPath.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`);
    await fsp.writeFile(listPath, lines.join('\n'), 'utf8');
    await runFfmpeg(options.ffmpegPath, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-movflags', '+faststart', options.outputPath]);
  } finally {
    await fsp.rm(listPath, { force: true });
    await Promise.all(clipPaths.map((clipPath) => fsp.rm(clipPath, { force: true })));
  }
  return { width, height, durationMs: Math.round(scenes.reduce((total, scene) => total + Math.max(0.1, Number(scene.durationSeconds) || options.configuration.video.secondsPerImage), 0) * 1000) };
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => { const stream = fs.createReadStream(filePath); stream.on('data', (chunk) => hash.update(chunk)); stream.on('error', reject); stream.on('end', resolve); });
  return hash.digest('hex');
}
