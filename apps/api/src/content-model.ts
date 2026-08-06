import crypto from 'node:crypto';

export const CONTENT_TYPES = ['single_image', 'carousel', 'video_slideshow'] as const;
export type ContentType = typeof CONTENT_TYPES[number];
export const CONTENT_STATUSES = ['draft', 'preview_generating', 'preview_ready', 'generation_queued', 'generating', 'ready', 'failed', 'archived'] as const;
export type ContentStatus = typeof CONTENT_STATUSES[number];
export const TEXT_MODES = ['none', 'cover_only', 'headline_only', 'headline_and_body', 'custom_per_slide'] as const;
export type TextMode = typeof TEXT_MODES[number];

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
    transition: 'fade',
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
  merged.totalFrames = Number.isInteger(merged.totalFrames) ? Math.max(1, Math.min(30, merged.totalFrames)) : DEFAULT_CONFIGURATION.totalFrames;
  merged.includeCover = Boolean(merged.includeCover);
  merged.includeCta = Boolean(merged.includeCta);
  merged.textMode = TEXT_MODES.includes(merged.textMode) ? merged.textMode : DEFAULT_CONFIGURATION.textMode;
  merged.aspectRatio = ['9:16', '1:1', '4:5', '16:9'].includes(merged.aspectRatio) ? merged.aspectRatio : DEFAULT_CONFIGURATION.aspectRatio;
  return merged;
}

export function frameRoles(type: ContentType, configuration: ContentConfiguration): FrameDefinition[] {
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

export function assertContentType(value: unknown): ContentType {
  if (typeof value !== 'string' || !CONTENT_TYPES.includes(value as ContentType)) throw new ContentValidationError('INVALID_CONTENT_TYPE', 'Content type must be single_image, carousel, or video_slideshow.');
  return value as ContentType;
}

export function ratioDimensions(aspectRatio: ContentConfiguration['aspectRatio'], resolution: '720p' | '1080p' = '720p'): { width: number; height: number } {
  const base = resolution === '1080p' ? 1080 : 720;
  if (aspectRatio === '1:1') return { width: base, height: base };
  if (aspectRatio === '4:5') return { width: Math.round(base * 0.8), height: base };
  if (aspectRatio === '16:9') return { width: base, height: Math.round(base * 9 / 16) };
  return { width: Math.round(base * 9 / 16), height: base };
}

