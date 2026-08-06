export interface PinterestVideoMedia {
  mediaUrl: string | null;
  mimeType: string | null;
  posterUrl: string | null;
  durationSeconds: number | null;
}

function decodeUrl(value: string): string {
  return value
    .replaceAll('\\u002F', '/')
    .replaceAll('\\u003A', ':')
    .replaceAll('\\u003F', '?')
    .replaceAll('\\u003D', '=')
    .replaceAll('\\u0026', '&')
    .replaceAll('\\/', '/')
    .replaceAll('&amp;', '&');
}

function cleanUrl(value: string): string | null {
  const decoded = decodeUrl(value).replace(/[),.;]+$/g, '');
  try {
    const url = new URL(decoded);
    if (!/^https?:$/i.test(url.protocol)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function videoCandidates(html: string): string[] {
  const decoded = decodeUrl(html);
  const matches = decoded.match(/https?:[^"'\s<>]+/gi) ?? [];
  return [...new Set(matches.map(cleanUrl).filter((value): value is string => Boolean(value)))];
}

function durationFromHtml(html: string): number | null {
  const iso = html.match(/"duration"\s*:\s*"PT(\d+(?:\.\d+)?)S"/i)?.[1];
  if (!iso) return null;
  const value = Number(iso);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function extractPinterestVideoMedia(html: string): PinterestVideoMedia {
  const candidates = videoCandidates(html);
  const mediaUrl = candidates.find((url) => /\.(?:mp4|webm|mov|m4v)(?:[?#]|$)/i.test(url)) ??
    candidates.find((url) => /\.m3u8(?:[?#]|$)/i.test(url)) ?? null;
  const posterUrl = candidates.find((url) => /\/videos\/thumbnails\//i.test(url)) ?? null;
  const mimeType = mediaUrl
    ? /\.mp4(?:[?#]|$)/i.test(mediaUrl) ? 'video/mp4'
      : /\.webm(?:[?#]|$)/i.test(mediaUrl) ? 'video/webm'
        : /\.mov(?:[?#]|$)/i.test(mediaUrl) ? 'video/quicktime'
          : /\.m3u8(?:[?#]|$)/i.test(mediaUrl) ? 'application/vnd.apple.mpegurl'
            : null
    : null;
  return { mediaUrl, mimeType, posterUrl, durationSeconds: durationFromHtml(html) };
}

export function isPlayableVideoUrl(value: string | null | undefined): boolean {
  return Boolean(value && /\.(?:mp4|webm|mov|m4v)(?:[?#]|$)/i.test(value));
}
