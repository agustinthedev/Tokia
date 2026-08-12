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

export const SLIDESHOW_VIDEO_ENCODINGS = Object.freeze({
  balanced: Object.freeze({
    codec: 'libx264',
    preset: 'medium',
    profile: 'high',
    level: '4.2',
    crf: 20,
    maxRate: '8M',
    bufferSize: '16M',
    pixelFormat: 'yuv420p',
    audioBitrate: '160k'
  }),
  high: Object.freeze({
    codec: 'libx264',
    preset: 'slow',
    profile: 'high',
    level: '4.2',
    crf: 18,
    maxRate: '12M',
    bufferSize: '24M',
    pixelFormat: 'yuv420p',
    audioBitrate: '192k'
  }),
  maximum: Object.freeze({
    codec: 'libx264',
    preset: 'slower',
    profile: 'high',
    level: '4.2',
    crf: 16,
    maxRate: '20M',
    bufferSize: '40M',
    pixelFormat: 'yuv420p',
    audioBitrate: '256k'
  })
});

export const SLIDESHOW_VIDEO_ENCODING = SLIDESHOW_VIDEO_ENCODINGS.high;

function slideshowVideoEncodingArgs(qualityMode: ContentConfiguration['video']['qualityMode']): string[] {
  const encoding = SLIDESHOW_VIDEO_ENCODINGS[qualityMode] ?? SLIDESHOW_VIDEO_ENCODING;
  return [
    '-c:v', encoding.codec,
    '-preset', encoding.preset,
    '-profile:v', encoding.profile,
    '-level', encoding.level,
    '-crf', String(encoding.crf),
    '-maxrate', encoding.maxRate,
    '-bufsize', encoding.bufferSize,
    '-pix_fmt', encoding.pixelFormat
  ];
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

function defaultFfprobePath(ffmpegPath: string): string {
  if (/ffmpeg\.exe$/i.test(ffmpegPath)) return ffmpegPath.replace(/ffmpeg\.exe$/i, 'ffprobe.exe');
  if (/ffmpeg$/i.test(ffmpegPath)) return ffmpegPath.replace(/ffmpeg$/i, 'ffprobe');
  return 'ffprobe';
}

async function hasAudioTrack(ffprobePath: string, sourcePath: string): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const child = spawn(ffprobePath, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=index', '-of', 'csv=p=0', sourcePath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); if (stderr.length > 8_000) stderr = stderr.slice(-8_000); });
    child.on('error', (error) => reject(new MediaProcessingError('FFPROBE_UNAVAILABLE', error.message)));
    child.on('close', (code) => code === 0
      ? resolve(Boolean(stdout.trim()))
      : reject(new MediaProcessingError('FFPROBE_FAILED', stderr.trim().split(/\r?\n/).slice(-3).join(' ') || `FFprobe exited with code ${code}.`)));
  });
}

export interface MediaDimensions {
  width: number;
  height: number;
}

async function probeDimensions(ffprobePath: string, sourcePath: string): Promise<MediaDimensions> {
  return await new Promise<MediaDimensions>((resolve, reject) => {
    const child = spawn(ffprobePath, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', sourcePath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); if (stderr.length > 8_000) stderr = stderr.slice(-8_000); });
    child.on('error', (error) => reject(new MediaProcessingError('FFPROBE_UNAVAILABLE', error.message)));
    child.on('close', (code) => {
      const match = stdout.trim().match(/^(\d+)x(\d+)/);
      if (code === 0 && match) return resolve({ width: Number(match[1]), height: Number(match[2]) });
      reject(new MediaProcessingError('FFPROBE_FAILED', stderr.trim().split(/\r?\n/).slice(-3).join(' ') || `FFprobe exited with code ${code}.`));
    });
  });
}

async function probeDimensionsIfAvailable(ffprobePath: string, sourcePath: string): Promise<MediaDimensions | undefined> {
  try { return await probeDimensions(ffprobePath, sourcePath); } catch { return undefined; }
}

export function shouldUpscale(source: MediaDimensions | undefined, target: MediaDimensions): boolean {
  return Boolean(source && (source.width < target.width || source.height < target.height));
}

export function filterFor(configuration: ContentConfiguration, width: number, height: number, source?: MediaDimensions): string {
  const crop = configuration.visual.cropMode;
  const resize = crop === 'fit' || crop === 'pad'
    ? `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`
    : `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height}`;
  const resized = shouldUpscale(source, { width, height }) ? `${resize},unsharp=5:5:0.35:5:5:0` : resize;
  return `${resized},setsar=1`;
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

function textLayoutScale(configuration: ContentConfiguration, width: number, height: number): number {
  const reference = ratioDimensions(configuration.aspectRatio, '720p');
  return Math.min(width / reference.width, height / reference.height);
}

export function textOverlayLayout(configuration: ContentConfiguration, width: number, height: number, text: TextOverlay): TextOverlayPart[] {
  const headline = text.headline?.trim() ?? '';
  const body = text.body?.trim() ?? '';
  if (!headline && !body) return [];
  const scale = textLayoutScale(configuration, width, height);
  const lineSpacing = Math.max(1, Math.round(TEXT_LINE_SPACING * scale));
  const blockGap = Math.max(1, Math.round(TEXT_BLOCK_GAP * scale));
  const horizontalMargin = Math.max(1, Math.round(60 * scale));
  const topMargin = Math.max(1, Math.round(80 * scale));
  const bottomMargin = Math.max(1, Math.round(90 * scale));
  const referenceHeadlineSize = clamp(Math.round(configuration.visual.fontSize || 54), 28, 120);
  const headlineSize = Math.max(1, Math.round(referenceHeadlineSize * scale));
  const referenceBodySize = clamp(Math.round(referenceHeadlineSize * 0.58), 20, 72);
  const bodySize = Math.max(1, Math.round(referenceBodySize * scale));
  const headlineText = headline ? wrapOverlayText(headline, clamp(Math.floor(width / (headlineSize * 0.5)), 12, 42)) : '';
  const bodyText = body ? wrapOverlayText(body, clamp(Math.floor(width / (bodySize * 0.5)), 18, 64)) : '';
  const headlineLines = headlineText ? headlineText.split('\n').length : 0;
  const bodyLines = bodyText ? bodyText.split('\n').length : 0;
  const headlineHeight = headlineLines ? headlineLines * headlineSize + (headlineLines - 1) * lineSpacing : 0;
  const bodyHeight = bodyLines ? bodyLines * bodySize + (bodyLines - 1) * lineSpacing : 0;
  const blockHeight = headlineHeight + bodyHeight + (headlineText && bodyText ? blockGap : 0);
  const top = configuration.visual.textPosition === 'top'
    ? String(topMargin)
    : configuration.visual.textPosition === 'center'
      ? `(h-${blockHeight})/2`
      : `h-${blockHeight}-${bottomMargin}`;
  const bodyY = headlineText ? `${top}+${headlineHeight + blockGap}` : top;
  const x = configuration.visual.textAlignment === 'left'
    ? String(horizontalMargin)
    : configuration.visual.textAlignment === 'right'
      ? `w-text_w-${horizontalMargin}`
      : '(w-text_w)/2';
  const parts: TextOverlayPart[] = [];
  if (headlineText) parts.push({ key: 'headline', text: headlineText, fontSize: headlineSize, fontFile: fontFileFor(configuration.visual.fontFamily, configuration.visual.fontWeight), x, y: top, lineSpacing, boxBorderWidth: Math.max(1, Math.round(24 * scale)) });
  if (bodyText) parts.push({ key: 'body', text: bodyText, fontSize: bodySize, fontFile: fontFileFor(configuration.visual.fontFamily, '400'), x, y: bodyY, lineSpacing, boxBorderWidth: Math.max(1, Math.round(16 * scale)) });
  return parts;
}

export async function normalizeImage(options: { ffmpegPath: string; ffprobePath?: string; sourcePath: string; outputPath: string; configuration: ContentConfiguration; text?: TextOverlay | null; }): Promise<{ width: number; height: number }> {
  const { width, height } = ratioDimensions(options.configuration.aspectRatio, options.configuration.video.outputResolution === '1080p' ? '1080p' : '720p');
  const sourceDimensions = await probeDimensionsIfAvailable(options.ffprobePath ?? defaultFfprobePath(options.ffmpegPath), options.sourcePath);
  const filters = [filterFor(options.configuration, width, height, sourceDimensions)];
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
  startSeconds?: number;
  endSeconds?: number;
  muted?: boolean;
  text?: TextOverlay | null;
}

function sceneDuration(scene: SlideshowScene, configuration: ContentConfiguration): number {
  const rangeDuration = Number(scene.endSeconds) - Number(scene.startSeconds ?? 0);
  return Math.max(0.1, Number.isFinite(rangeDuration) ? rangeDuration : Number(scene.durationSeconds) || configuration.video.secondsPerImage);
}

export async function renderSlideshow(options: { ffmpegPath: string; ffprobePath?: string; imagePaths?: string[]; scenes?: SlideshowScene[]; outputPath: string; configuration: ContentConfiguration }): Promise<{ width: number; height: number; durationMs: number }> {
  const scenes: SlideshowScene[] = options.scenes ?? (options.imagePaths ?? []).map((imagePath) => ({ path: imagePath, mediaType: 'image' as const, durationSeconds: options.configuration.video.secondsPerImage }));
  if (!scenes.length) throw new MediaProcessingError('NO_IMAGES', 'At least one image or video is required for a video slideshow.');
  const dimensions = ratioDimensions(options.configuration.aspectRatio, options.configuration.video.outputResolution);
  // H.264 with yuv420p requires even dimensions. Keep image exports at their
  // requested dimensions, but make the video canvas encoder-safe.
  const width = dimensions.width % 2 === 0 ? dimensions.width : dimensions.width + 1;
  const height = dimensions.height % 2 === 0 ? dimensions.height : dimensions.height + 1;
  const ffprobePath = options.ffprobePath ?? defaultFfprobePath(options.ffmpegPath);
  const fps = Math.max(1, Math.min(60, options.configuration.video.fps));
  const configuredTransitionDuration = Number(options.configuration.video.transitionDuration);
  const transitionDuration = options.configuration.video.transition === 'fade' && scenes.length > 1 && Number.isFinite(configuredTransitionDuration) && configuredTransitionDuration > 0
    ? Math.min(configuredTransitionDuration, ...scenes.map((scene) => Math.max(0, sceneDuration(scene, options.configuration) - 0.1)))
    : 0;
  const inputArgs: string[] = [];
  const filters: string[] = [];
  const textPaths: string[] = [];
  const filterGraphPath = `${options.outputPath}.filtergraph`;
  const videoLabels: string[] = [];
  const audioLabels: string[] = [];
  let inputCount = 0;
  try {
    for (let index = 0; index < scenes.length; index += 1) {
      const scene = scenes[index]!;
      const duration = sceneDuration(scene, options.configuration);
      const hasAudio = scene.mediaType === 'video' && scene.muted !== true ? await hasAudioTrack(ffprobePath, scene.path) : false;
      const sourceDimensions = await probeDimensionsIfAvailable(ffprobePath, scene.path);
      const videoInputIndex = inputCount;
      if (scene.mediaType === 'video') {
        if (Number(scene.startSeconds) > 0) inputArgs.push('-ss', String(scene.startSeconds));
        inputArgs.push('-i', scene.path);
      } else {
        inputArgs.push('-loop', '1', '-framerate', String(fps), '-i', scene.path);
      }
      inputCount += 1;
      const audioInputIndex = hasAudio ? videoInputIndex : inputCount;
      if (!hasAudio) {
        inputArgs.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
        inputCount += 1;
      }
      const textFilters: string[] = [];
      if (scene.text && options.configuration.textMode !== 'none') {
        for (const part of textOverlayLayout(options.configuration, width, height, scene.text)) {
          const textPath = `${options.outputPath}.scene-${String(index + 1).padStart(2, '0')}.${part.key}.txt`;
          textPaths.push(textPath);
          await fsp.writeFile(textPath, part.text.slice(0, part.key === 'headline' ? 120 : 600), 'utf8');
          const box = options.configuration.visual.overlay ? `:box=1:boxcolor=black@${Math.max(0, Math.min(1, options.configuration.visual.overlayOpacity))}:boxborderw=${part.boxBorderWidth}` : '';
          textFilters.push(`drawtext=fontfile='${escapedFilterPath(part.fontFile)}':textfile='${escapedFilterPath(textPath)}':fontcolor=${options.configuration.visual.textColor}:fontsize=${part.fontSize}:x=${part.x}:y=${part.y}:line_spacing=${part.lineSpacing}${box}`);
        }
      }
      const videoLabel = `scene-v${index}`;
      const audioLabel = `scene-a${index}`;
      const videoFilter = `${filterFor(options.configuration, width, height, sourceDimensions)}${textFilters.length ? `,${textFilters.join(',')}` : ''},format=yuv420p,fps=${fps},settb=AVTB,trim=duration=${duration},setpts=PTS-STARTPTS`;
      filters.push(`[${videoInputIndex}:v:0]${videoFilter}[${videoLabel}]`);
      filters.push(`[${audioInputIndex}:a:0]atrim=duration=${duration},asetpts=PTS-STARTPTS,aresample=48000,apad,atrim=duration=${duration}[${audioLabel}]`);
      videoLabels.push(`[${videoLabel}]`);
      audioLabels.push(`[${audioLabel}]`);
    }

    let videoOutput: string;
    let audioOutput: string;
    if (transitionDuration > 0) {
      videoOutput = videoLabels[0]!;
      audioOutput = audioLabels[0]!;
      let elapsed = sceneDuration(scenes[0]!, options.configuration);
      for (let index = 1; index < scenes.length; index += 1) {
        const nextVideo = `transition-v${index}`;
        const nextAudio = `transition-a${index}`;
        const offset = elapsed - transitionDuration * index;
        filters.push(`${videoOutput}${videoLabels[index]!}xfade=transition=fade:duration=${transitionDuration}:offset=${offset}[${nextVideo}]`);
        filters.push(`${audioOutput}${audioLabels[index]!}acrossfade=d=${transitionDuration}:c1=tri:c2=tri[${nextAudio}]`);
        videoOutput = `[${nextVideo}]`;
        audioOutput = `[${nextAudio}]`;
        elapsed += sceneDuration(scenes[index]!, options.configuration);
      }
    } else {
      filters.push(`${scenes.flatMap((_, index) => `${videoLabels[index]!}${audioLabels[index]!}`).join('')}concat=n=${scenes.length}:v=1:a=1[video-output][audio-output]`);
      videoOutput = '[video-output]';
      audioOutput = '[audio-output]';
    }
    const encoding = SLIDESHOW_VIDEO_ENCODINGS[options.configuration.video.qualityMode] ?? SLIDESHOW_VIDEO_ENCODING;
    await fsp.writeFile(filterGraphPath, filters.join(';\n'), 'utf8');
    await runFfmpeg(options.ffmpegPath, [
      '-y',
      ...inputArgs,
      '-filter_complex_script', filterGraphPath,
      '-map', videoOutput,
      '-map', audioOutput,
      ...slideshowVideoEncodingArgs(options.configuration.video.qualityMode),
      '-c:a', 'aac',
      '-ar', '48000',
      '-ac', '2',
      '-b:a', encoding.audioBitrate,
      '-movflags', '+faststart',
      options.outputPath,
    ]);
  } finally {
    await Promise.all([...textPaths, filterGraphPath].map((filePath) => fsp.rm(filePath, { force: true })));
  }
  return { width, height, durationMs: Math.round((scenes.reduce((total, scene) => total + sceneDuration(scene, options.configuration), 0) - transitionDuration * (scenes.length - 1)) * 1000) };
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => { const stream = fs.createReadStream(filePath); stream.on('data', (chunk) => hash.update(chunk)); stream.on('error', reject); stream.on('end', resolve); });
  return hash.digest('hex');
}
