import crypto from 'node:crypto';

export const CONTENT_TYPES = ['single_image', 'carousel', 'video_slideshow', 'video_clipping'] as const;
export type ContentType = typeof CONTENT_TYPES[number];
export const CONTENT_STATUSES = ['draft', 'preview_generating', 'preview_ready', 'generation_queued', 'generating', 'ready', 'failed', 'archived'] as const;
export type ContentStatus = typeof CONTENT_STATUSES[number];
export const TEXT_MODES = ['none', 'cover_only', 'headline_only', 'headline_and_body', 'custom_per_slide'] as const;
export type TextMode = typeof TEXT_MODES[number];
export const MAX_TOTAL_FRAMES = 100;
export const MIN_FRAME_DURATION_SECONDS = 0.1;
export const MAX_IMAGE_FRAME_DURATION_SECONDS = 30;

export interface FrameTrim {
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
}

export interface ContentConfiguration {
  sourceCollectionIds: string[];
  aspectRatio: '9:16' | '1:1' | '4:5' | '16:9';
  textMode: TextMode;
  includeCover: boolean;
  includeCta: boolean;
  totalFrames: number;
  topicMode: 'user' | 'ai';
  topic: string;
  tone: string;
  audience: string;
  customInstructions: string;
  ctaMode: 'none' | 'ai' | 'user';
  ctaText: string;
  captionEnabled: boolean;
  caption: string;
  visual: {
    cropMode: 'crop' | 'fit' | 'pad';
    fontFamily: string;
    fontSize: number;
    fontWeight: string;
    textAlignment: 'left' | 'center' | 'right';
    textPosition: 'top' | 'center' | 'bottom';
    textColor: string;
    overlay: boolean;
    overlayOpacity: number;
    branding: boolean;
    handle: string;
  };
  video: {
    outputResolution: '720p' | '1080p';
    fps: number;
    secondsPerImage: number;
    transition: 'none' | 'fade';
    transitionDuration: number;
    panZoom: boolean;
    intro: boolean;
    outro: boolean;
  };
}

export interface FrameDefinition { position: number; role: 'cover' | 'content' | 'cta' | 'title_and_summary'; }

export const DEFAULT_CONFIGURATION: ContentConfiguration = {
  sourceCollectionIds: [],
  aspectRatio: '9:16',
  textMode: 'headline_and_body',
  includeCover: true,
  includeCta: true,
  totalFrames: 5,
  topicMode: 'ai',
  topic: '',
  tone: 'educational',
  audience: '',
  customInstructions: '',
  ctaMode: 'ai',
  ctaText: '',
  captionEnabled: true,
  caption: '',
  visual: {
    cropMode: 'crop',
    fontFamily: 'Arial',
    fontSize: 54,
    fontWeight: '700',
    textAlignment: 'left',
    textPosition: 'bottom',
    textColor: '#ffffff',
    overlay: true,
    overlayOpacity: 0.5,
    branding: false,
    handle: ''
  },
  video: {
    outputResolution: '720p',
    fps: 30,
    secondsPerImage: 2.5,
    transition: 'none',
    transitionDuration: 0.35,
    panZoom: false,
    intro: false,
    outro: false
  }
};

export function mergeConfiguration(input: unknown, projectDefaults?: unknown): ContentConfiguration {
  const source = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const defaults = (projectDefaults && typeof projectDefaults === 'object' ? projectDefaults : {}) as Record<string, unknown>;
  const merged = { ...DEFAULT_CONFIGURATION, ...defaults, ...source } as ContentConfiguration;
  merged.sourceCollectionIds = Array.isArray(source.sourceCollectionIds) ? source.sourceCollectionIds.filter((value): value is string => typeof value === 'string') : Array.isArray(defaults.sourceCollectionIds) ? defaults.sourceCollectionIds.filter((value): value is string => typeof value === 'string') : [];
  merged.visual = { ...DEFAULT_CONFIGURATION.visual, ...(defaults.visual as object ?? {}), ...(source.visual as object ?? {}) };
  merged.video = { ...DEFAULT_CONFIGURATION.video, ...(defaults.video as object ?? {}), ...(source.video as object ?? {}) };
  const secondsPerImage = Number(merged.video.secondsPerImage);
  merged.video.secondsPerImage = Number.isFinite(secondsPerImage) ? Math.max(MIN_FRAME_DURATION_SECONDS, Math.min(MAX_IMAGE_FRAME_DURATION_SECONDS, secondsPerImage)) : DEFAULT_CONFIGURATION.video.secondsPerImage;
  merged.totalFrames = Number.isInteger(merged.totalFrames) ? Math.max(1, Math.min(MAX_TOTAL_FRAMES, merged.totalFrames)) : DEFAULT_CONFIGURATION.totalFrames;
  merged.includeCover = Boolean(merged.includeCover);
  merged.includeCta = Boolean(merged.includeCta);
  merged.textMode = TEXT_MODES.includes(merged.textMode) ? merged.textMode : DEFAULT_CONFIGURATION.textMode;
  merged.aspectRatio = ['9:16', '1:1', '4:5', '16:9'].includes(merged.aspectRatio) ? merged.aspectRatio : DEFAULT_CONFIGURATION.aspectRatio;
  return merged;
}

export function frameRoles(type: ContentType, configuration: ContentConfiguration): FrameDefinition[] {
  if (type === 'video_clipping') return [];
  if (type === 'single_image') return [{ position: 1, role: 'title_and_summary' }];
  const total = configuration.totalFrames;
  const required = Number(configuration.includeCover) + Number(configuration.includeCta);
  if (total < Math.max(1, required)) throw new ContentValidationError('FRAME_COUNT_TOO_SMALL', 'The selected frame count is too small for the enabled cover and CTA.');
  const roles: FrameDefinition[] = [];
  let position = 1;
  if (configuration.includeCover) roles.push({ position: position++, role: 'cover' });
  for (let index = roles.length; index < total - Number(configuration.includeCta); index += 1) roles.push({ position: position++, role: 'content' });
  if (configuration.includeCta) roles.push({ position: position++, role: 'cta' });
  return roles;
}

export function contentFrameCount(type: ContentType, configuration: ContentConfiguration): number {
  return frameRoles(type, configuration).filter((frame) => frame.role === 'content').length;
}

export function slugify(value: string): string {
  const result = value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return result || crypto.randomUUID().slice(0, 8);
}

export class ContentValidationError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'ContentValidationError'; }
}

export function isMotionMedia(mediaType: unknown): boolean {
  return mediaType === 'video' || mediaType === 'animated';
}

export function frameDurationLimit(mediaType: unknown, originalDurationSeconds: unknown): number {
  const original = Number(originalDurationSeconds);
  return isMotionMedia(mediaType) && Number.isFinite(original) && original > 0 ? original : MAX_IMAGE_FRAME_DURATION_SECONDS;
}

export function defaultFrameDuration(configuration: ContentConfiguration, mediaType?: unknown, originalDurationSeconds?: unknown): number {
  if (isMotionMedia(mediaType)) {
    const original = Number(originalDurationSeconds);
    if (Number.isFinite(original) && original > 0) return Math.round(original * 100) / 100;
  }
  return Math.round(Math.max(MIN_FRAME_DURATION_SECONDS, Math.min(MAX_IMAGE_FRAME_DURATION_SECONDS, Number(configuration.video.secondsPerImage) || DEFAULT_CONFIGURATION.video.secondsPerImage)) * 100) / 100;
}

export function effectiveFrameDuration(value: unknown, configuration: ContentConfiguration, mediaType?: unknown, originalDurationSeconds?: unknown): number {
  const maximum = frameDurationLimit(mediaType, originalDurationSeconds);
  const minimum = Math.min(MIN_FRAME_DURATION_SECONDS, maximum);
  const fallback = defaultFrameDuration(configuration, mediaType, originalDurationSeconds);
  const duration = Number(value);
  return Math.round(Math.max(minimum, Math.min(maximum, Number.isFinite(duration) ? duration : fallback)) * 100) / 100;
}

export function normalizeFrameDuration(value: unknown, configuration: ContentConfiguration, mediaType?: unknown, originalDurationSeconds?: unknown): number {
  const duration = Number(value);
  const maximum = frameDurationLimit(mediaType, originalDurationSeconds);
  const minimum = Math.min(MIN_FRAME_DURATION_SECONDS, maximum);
  if (!Number.isFinite(duration) || duration < minimum || duration > maximum) {
    const suffix = isMotionMedia(mediaType) && Number.isFinite(Number(originalDurationSeconds)) ? ` The source video is ${maximum.toFixed(2)} seconds long.` : '';
    throw new ContentValidationError('INVALID_FRAME_DURATION', `Frame duration must be between ${minimum.toFixed(2)} and ${maximum.toFixed(2)} seconds.${suffix}`);
  }
  return Math.round(duration * 100) / 100;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

export function normalizeFrameTrim(startValue: unknown, endValue: unknown, mediaType: unknown, originalDurationSeconds: unknown): FrameTrim {
  const maximum = frameDurationLimit(mediaType, originalDurationSeconds);
  const minimum = Math.min(MIN_FRAME_DURATION_SECONDS, maximum);
  const start = Number(startValue);
  const end = Number(endValue);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > maximum || end - start < minimum) {
    const suffix = isMotionMedia(mediaType) && Number.isFinite(Number(originalDurationSeconds)) ? ` The source video is ${maximum.toFixed(2)} seconds long.` : '';
    throw new ContentValidationError('INVALID_FRAME_TRIM', `Video trim must start at or after 0, end at or before ${maximum.toFixed(2)} seconds, and keep at least ${minimum.toFixed(2)} seconds.${suffix}`);
  }
  return {
    startSeconds: rounded(start),
    endSeconds: rounded(end),
    durationSeconds: rounded(end - start),
  };
}

export function effectiveFrameTrim(settings: unknown, configuration: ContentConfiguration, mediaType?: unknown, originalDurationSeconds?: unknown): FrameTrim {
  const source = (settings && typeof settings === 'object' ? settings : {}) as Record<string, unknown>;
  const maximum = frameDurationLimit(mediaType, originalDurationSeconds);
  const minimum = Math.min(MIN_FRAME_DURATION_SECONDS, maximum);
  const start = Number(source.startSeconds);
  const end = Number(source.endSeconds);
  if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end <= maximum && end - start >= minimum) {
    return {
      startSeconds: rounded(start),
      endSeconds: rounded(end),
      durationSeconds: rounded(end - start),
    };
  }
  const duration = effectiveFrameDuration(source.durationSeconds, configuration, mediaType, originalDurationSeconds);
  return { startSeconds: 0, endSeconds: duration, durationSeconds: duration };
}

export function assertContentType(value: unknown): ContentType {
  if (typeof value !== 'string' || !CONTENT_TYPES.includes(value as ContentType)) throw new ContentValidationError('INVALID_CONTENT_TYPE', 'Content type must be single_image, carousel, video_slideshow, or video_clipping.');
  return value as ContentType;
}

export function ratioDimensions(aspectRatio: ContentConfiguration['aspectRatio'], resolution: '720p' | '1080p' = '720p'): { width: number; height: number } {
  const base = resolution === '1080p' ? 1080 : 720;
  if (aspectRatio === '1:1') return { width: base, height: base };
  if (aspectRatio === '4:5') return { width: Math.round(base * 0.8), height: base };
  if (aspectRatio === '16:9') return { width: base, height: Math.round(base * 9 / 16) };
  return { width: Math.round(base * 9 / 16), height: base };
}
