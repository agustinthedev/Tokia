import { extractPinterestVideoMedia, type PinterestVideoMedia } from '@tokia/shared';

const REQUEST_TIMEOUT_MS = 12_000;

export async function resolvePinterestVideo(pinUrl: string): Promise<PinterestVideoMedia> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(pinUrl, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 Tokia local media resolver'
      }
    });
    if (!response.ok) return { mediaUrl: null, mimeType: null, posterUrl: null, durationSeconds: null };
    return extractPinterestVideoMedia(await response.text());
  } catch {
    return { mediaUrl: null, mimeType: null, posterUrl: null, durationSeconds: null };
  } finally {
    clearTimeout(timeout);
  }
}
