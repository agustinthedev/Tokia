import type { ImageVariant, NormalizedPin, Provider } from './types.js';

const PINTEREST_HOSTS = new Set([
  'pinterest.com', 'www.pinterest.com', 'pin.it',
  'uk.pinterest.com', 'in.pinterest.com', 'es.pinterest.com', 'fr.pinterest.com',
  'br.pinterest.com', 'de.pinterest.com', 'it.pinterest.com', 'jp.pinterest.com',
  'ca.pinterest.com', 'mx.pinterest.com', 'au.pinterest.com', 'nz.pinterest.com'
]);

const PINTEREST_IMAGE_HOST = 'i.pinimg.com';
const IMAGE_SIZE_SEGMENTS = new Set([
  'originals', '236x', '270x', '290x', '300x', '320x', '350x', '400x', '474x',
  '500x', '564x', '600x', '736x', '750x', '1000x', '1200x', '60x60', '75x75',
  '170x', '222x'
]);

function isImageSizeSegment(value: string): boolean {
  return IMAGE_SIZE_SEGMENTS.has(value.toLowerCase()) || /^\d+x$/i.test(value);
}

function parseUrl(value: string | null | undefined): URL | null {
  if (!value || typeof value !== 'string') return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed;
  } catch {
    return null;
  }
}

function isPinterestHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return PINTEREST_HOSTS.has(host) || host.endsWith('.pinterest.com');
}

function normalizePathSegments(pathname: string): string[] {
  return pathname.split('/').map((part) => part.trim()).filter(Boolean)
    .filter((part, index) => !(index === 0 && /^[a-z]{2}(?:-[a-z]{2})?$/i.test(part)));
}

export function extractPinterestPinId(value: string | null | undefined): string | null {
  const parsed = parseUrl(value);
  if (!parsed || !isPinterestHost(parsed.hostname)) return null;
  const parts = normalizePathSegments(parsed.pathname);
  const pinIndex = parts.findIndex((part) => part.toLowerCase() === 'pin');
  if (pinIndex < 0) return null;
  const candidate = parts[pinIndex + 1];
  return candidate && /^[0-9A-Za-z_-]{3,200}$/.test(candidate) ? candidate : null;
}

export function normalizePinterestPinUrl(value: string | null | undefined): string | null {
  const parsed = parseUrl(value);
  if (!parsed || !isPinterestHost(parsed.hostname)) return null;
  const pinId = extractPinterestPinId(value);
  if (pinId) return `https://www.pinterest.com/pin/${pinId}/`;
  if (parsed.hostname.toLowerCase() !== 'pin.it') return null;
  return `https://pin.it/${normalizePathSegments(parsed.pathname).join('/')}`;
}

export function normalizePinterestBoardUrl(value: string | null | undefined): string | null {
  const parsed = parseUrl(value);
  if (!parsed || !isPinterestHost(parsed.hostname) || parsed.hostname.toLowerCase() === 'pin.it') return null;
  const parts = normalizePathSegments(parsed.pathname);
  if (parts.length < 2 || parts[0]?.toLowerCase() === 'pin') return null;
  return `https://www.pinterest.com/${parts.join('/')}/`;
}

export function normalizePinimgImageKey(value: string | null | undefined): string | null {
  const parsed = parseUrl(value);
  if (!parsed || parsed.hostname.toLowerCase() !== PINTEREST_IMAGE_HOST) return null;
  const parts = parsed.pathname.split('/').map((part) => decodeURIComponent(part)).filter(Boolean);
  if (parts.length < 2) return null;
  if (isImageSizeSegment(parts[0]!)) parts.shift();
  return parts.join('/').replace(/\/+/g, '/').toLowerCase();
}

export function normalizeRemoteUrl(value: string | null | undefined): string | null {
  const parsed = parseUrl(value);
  return parsed?.toString() ?? null;
}

export function cleanOptionalText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function identityKey(provider: Provider, externalId: string | null, canonicalUrl: string | null, imageKey: string | null): string {
  if (externalId) return `${provider}:external:${externalId.toLowerCase()}`;
  if (canonicalUrl) return `${provider}:url:${canonicalUrl}`;
  if (imageKey) return `${provider}:image:${imageKey}`;
  throw new Error('Pin has no usable identity');
}

export function normalizePin(input: {
  externalId?: string | null;
  pinUrl?: string | null;
  imageUrl: string;
  previewUrl?: string | null;
  imageVariants?: ImageVariant[];
  title?: string | null;
  description?: string | null;
  altText?: string | null;
  sourceLink?: string | null;
  width?: number | null;
  height?: number | null;
}, provider: Provider = 'pinterest'): NormalizedPin {
  const pinUrl = normalizePinterestPinUrl(input.pinUrl);
  const extractedId = extractPinterestPinId(input.pinUrl);
  const externalId = cleanOptionalText(input.externalId) ?? extractedId;
  const canonicalUrl = pinUrl;
  const imageUrl = normalizeRemoteUrl(input.imageUrl);
  if (!imageUrl) throw new Error('Pin imageUrl must be a valid http(s) URL');
  const imageVariants: ImageVariant[] = [];
  for (const variant of input.imageVariants ?? []) {
    const url = normalizeRemoteUrl(variant.url);
    if (url) imageVariants.push({ url, width: variant.width ?? null, height: variant.height ?? null });
  }
  const normalizedImageKey = normalizePinimgImageKey(imageUrl);
  if (!externalId && !canonicalUrl && !normalizedImageKey) throw new Error('Pin has no normalized identity');
  return {
    ...input,
    provider,
    externalId,
    canonicalUrl,
    normalizedImageKey,
    identityKey: identityKey(provider, externalId, canonicalUrl, normalizedImageKey),
    imageUrl,
    previewUrl: normalizeRemoteUrl(input.previewUrl),
    imageVariants,
    title: cleanOptionalText(input.title),
    description: cleanOptionalText(input.description),
    altText: cleanOptionalText(input.altText),
    sourceLink: normalizeRemoteUrl(input.sourceLink),
    width: input.width ?? null,
    height: input.height ?? null
  };
}

export function chooseBestImageUrl(pin: NormalizedPin): { imageUrl: string; width: number | null; height: number | null } {
  const candidates = [
    { url: pin.imageUrl, width: pin.width ?? null, height: pin.height ?? null },
    ...pin.imageVariants.map((variant) => ({ url: variant.url, width: variant.width ?? null, height: variant.height ?? null }))
  ];
  candidates.sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  const best = candidates[0]!;
  return { imageUrl: best.url, width: best.width, height: best.height };
}

export function derivePreviewUrl(pin: NormalizedPin): string | null {
  return pin.previewUrl ?? pin.imageVariants
    .filter((variant) => (variant.width ?? Number.MAX_SAFE_INTEGER) < (pin.width ?? Number.MAX_SAFE_INTEGER))
    .sort((a, b) => (a.width ?? 0) - (b.width ?? 0))[0]?.url ?? null;
}
