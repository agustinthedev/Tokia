import {
  extractPinterestPinId,
  normalizePinimgImageKey,
  normalizePinterestBoardUrl,
  normalizePinterestPinUrl,
  type ImageVariant,
  type IngestionPayload,
  type IngestionPin
} from '@tokia/shared';

export type ScanMode = 'visible' | 'full';

export interface ScanSettings {
  mode: ScanMode;
  maxPins: number;
  maxDurationMs: number;
  noNewRounds: number;
  waitMs: number;
  scrollRatio: number;
}

export interface DetectedBoard {
  isBoard: boolean;
  externalId: string | null;
  name: string;
  url: string;
  signals: string[];
}

export interface ScanProgress {
  mode: ScanMode;
  phase: 'scanning' | 'complete' | 'stopped' | 'max-pins' | 'timeout' | 'no-new-items';
  rounds: number;
  uniquePins: number;
  visiblePins: number;
}

export interface ScanResult {
  payload: IngestionPayload;
  progress: ScanProgress;
}

export interface ScanCallbacks {
  onProgress?: (progress: ScanProgress) => void;
  shouldStop?: () => boolean;
}

function text(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed ? trimmed : null;
}

function absoluteUrl(value: string | null | undefined, document: Document): string | null {
  if (!value) return null;
  try {
    return new URL(value, document.location.href).toString();
  } catch {
    return null;
  }
}

function parseDimension(value: string | null | undefined): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function parseSrcset(value: string | null | undefined, document: Document): ImageVariant[] {
  if (!value) return [];
  const variants: ImageVariant[] = [];
  for (const entry of value.split(',')) {
    const parts = entry.trim().split(/\s+/);
    const url = absoluteUrl(parts[0], document);
    if (!url) continue;
    const widthToken = parts.find((part) => part.endsWith('w'));
    const width = widthToken ? parseDimension(widthToken.slice(0, -1)) : null;
    if (!variants.some((variant) => variant.url === url)) variants.push({ url, width });
  }
  return variants.sort((a, b) => {
    const score = (variant: ImageVariant): number => {
      if (variant.width) return variant.width;
      if (/\/originals\//i.test(variant.url)) return 100_000;
      const size = variant.url.match(/\/(\d+)x\//i)?.[1];
      return size ? Number(size) : 0;
    };
    return score(b) - score(a);
  });
}

function getPinImage(anchor: HTMLAnchorElement, document: Document): HTMLImageElement | null {
  return anchor.querySelector('img') ?? anchor.parentElement?.querySelector('img') ?? null;
}

function getCard(anchor: HTMLAnchorElement): Element {
  return anchor.closest('article, [data-test-id], [data-pin-id]') ?? anchor.parentElement ?? anchor;
}

function getTextFromCard(card: Element, selectors: string[]): string | null {
  for (const selector of selectors) {
    const node = card.querySelector(selector);
    const value = text(node?.textContent ?? node?.getAttribute('content') ?? node?.getAttribute('aria-label'));
    if (value) return value;
  }
  return null;
}

function pinIdentity(pin: IngestionPin): string | null {
  const externalId = text(pin.externalId);
  if (externalId) return `external:${externalId.toLowerCase()}`;
  const canonical = normalizePinterestPinUrl(pin.pinUrl);
  if (canonical) return `url:${canonical}`;
  const imageKey = normalizePinimgImageKey(pin.imageUrl);
  return imageKey ? `image:${imageKey}` : null;
}

export function dedupePins(pins: IngestionPin[]): IngestionPin[] {
  const result: IngestionPin[] = [];
  const seen = new Set<string>();
  for (const pin of pins) {
    const key = pinIdentity(pin);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(pin);
  }
  return result;
}

export function extractVisiblePins(document: Document): IngestionPin[] {
  const pins: IngestionPin[] = [];
  const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
    .filter((anchor) => /\/pin\//i.test(anchor.getAttribute('href') ?? ''));
  for (const anchor of anchors) {
    const pinUrl = absoluteUrl(anchor.getAttribute('href'), document);
    const canonicalUrl = normalizePinterestPinUrl(pinUrl);
    const externalId = extractPinterestPinId(pinUrl);
    const image = getPinImage(anchor, document);
    if (!image) continue;
    const variants = [
      ...parseSrcset(image.getAttribute('srcset'), document),
      ...parseSrcset(image.getAttribute('data-srcset'), document)
    ].filter((variant, index, list) => list.findIndex((other) => other.url === variant.url) === index);
    const currentImage = absoluteUrl(image.currentSrc || image.getAttribute('src') || image.getAttribute('data-src'), document);
    const best = variants[0]?.url ?? currentImage;
    if (!best) continue;
    const card = getCard(anchor);
    const width = variants[0]?.width ?? parseDimension(image.getAttribute('width')) ?? (image.naturalWidth || null);
    const height = parseDimension(image.getAttribute('height')) ?? (image.naturalHeight || null);
    const title = text(anchor.getAttribute('data-pin-title')) ?? text(anchor.getAttribute('title')) ?? getTextFromCard(card, ['[data-test-id*="title"]', 'h2', 'h3']);
    const description = text(anchor.getAttribute('data-pin-description')) ?? getTextFromCard(card, ['[data-test-id*="description"]', '[data-test-id*="desc"]']);
    const altText = text(image.getAttribute('alt'));
    pins.push({
      externalId,
      pinUrl: canonicalUrl ?? pinUrl,
      imageUrl: best,
      previewUrl: variants.at(-1)?.url ?? currentImage,
      imageVariants: variants,
      title,
      description,
      altText,
      sourceLink: absoluteUrl(anchor.getAttribute('data-source-link'), document),
      width,
      height
    });
  }
  return dedupePins(pins);
}

function findBoardId(document: Document): string | null {
  const direct = document.querySelector('[data-board-id], [data-test-board-id]');
  const directValue = direct?.getAttribute('data-board-id') ?? direct?.getAttribute('data-test-board-id');
  if (directValue?.trim()) return directValue.trim();
  const scripts = Array.from(document.scripts).map((script) => script.textContent ?? '').join('\n');
  return scripts.match(/"boardId"\s*:\s*"([^"\\]+)"/)?.[1] ?? scripts.match(/"id"\s*:\s*"(\d{5,})"[^}]{0,200}"type"\s*:\s*"board"/)?.[1] ?? null;
}

export function detectBoard(document: Document): DetectedBoard {
  const url = normalizePinterestBoardUrl(document.location.href);
  const pins = document.querySelectorAll('a[href*="/pin/"]').length;
  const images = document.querySelectorAll('img[src*="pinimg.com"], img[srcset*="pinimg.com"]').length;
  const metaTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content');
  const name = text(document.querySelector('h1')?.textContent) ?? text(metaTitle) ?? text(document.title?.replace(/\s*\|\s*Pinterest.*$/i, '')) ?? 'Pinterest board';
  const signals = [
    ...(url ? ['board-url'] : []),
    ...(pins > 0 ? ['pin-links'] : []),
    ...(images > 0 ? ['pinimg-images'] : []),
    ...(metaTitle ? ['page-metadata'] : [])
  ];
  return { isBoard: Boolean(url && signals.length >= 1), externalId: findBoardId(document), name, url: url ?? document.location.href, signals };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function scanBoard(document: Document, settings: ScanSettings, callbacks: ScanCallbacks = {}): Promise<ScanResult> {
  const board = detectBoard(document);
  if (!board.isBoard || !board.url) throw new Error('The current page does not appear to be a Pinterest board');
  const collected = new Map<string, IngestionPin>();
  const startedAt = Date.now();
  let rounds = 0;
  let noNewRounds = 0;
  let phase: ScanProgress['phase'] = 'scanning';
  const addVisible = () => {
    const visiblePins = extractVisiblePins(document);
    for (const pin of visiblePins) {
      const key = pinIdentity(pin);
      if (key && !collected.has(key)) collected.set(key, pin);
    }
    return visiblePins.length;
  };
  addVisible();
  callbacks.onProgress?.({ mode: settings.mode, phase, rounds, uniquePins: collected.size, visiblePins: collected.size });

  if (settings.mode === 'full') {
    while (collected.size < settings.maxPins) {
      if (callbacks.shouldStop?.()) { phase = 'stopped'; break; }
      if (Date.now() - startedAt >= settings.maxDurationMs) { phase = 'timeout'; break; }
      const before = collected.size;
      const view = document.defaultView;
      view?.scrollBy(0, Math.max(200, Math.round((view.innerHeight || 800) * settings.scrollRatio)));
      await wait(settings.waitMs);
      if (callbacks.shouldStop?.()) { phase = 'stopped'; break; }
      const visiblePins = addVisible();
      rounds += 1;
      if (collected.size === before) noNewRounds += 1;
      else noNewRounds = 0;
      callbacks.onProgress?.({ mode: settings.mode, phase, rounds, uniquePins: collected.size, visiblePins });
      if (noNewRounds >= settings.noNewRounds) { phase = 'no-new-items'; break; }
    }
    if (collected.size >= settings.maxPins) phase = 'max-pins';
  }
  if (phase === 'scanning') phase = 'complete';
  const payload: IngestionPayload = {
    schemaVersion: 1,
    source: 'pinterest-browser-extension',
    exportedAt: new Date().toISOString(),
    board: { externalId: board.externalId, name: board.name, url: board.url, description: null },
    pins: Array.from(collected.values()).slice(0, settings.maxPins)
  };
  const progress: ScanProgress = { mode: settings.mode, phase, rounds, uniquePins: payload.pins.length, visiblePins: extractVisiblePins(document).length };
  callbacks.onProgress?.(progress);
  return { payload, progress };
}
