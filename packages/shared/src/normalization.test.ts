import { describe, expect, it } from 'vitest';
import {
  extractPinterestPinId,
  normalizePinimgImageKey,
  normalizePinterestBoardUrl,
  normalizePinterestPinUrl
} from './normalization.js';

describe('Pinterest URL normalization', () => {
  it('normalizes board locale, query, hash, and trailing slash variants', () => {
    expect(normalizePinterestBoardUrl('https://es.pinterest.com/demo/luxury/?foo=bar#top'))
      .toBe('https://www.pinterest.com/demo/luxury/');
  });

  it('normalizes Pin URLs and extracts IDs', () => {
    const value = 'https://uk.pinterest.com/pin/123456789/?utm_source=test';
    expect(extractPinterestPinId(value)).toBe('123456789');
    expect(normalizePinterestPinUrl(value)).toBe('https://www.pinterest.com/pin/123456789/');
  });

  it('derives the shared key from Pinterest CDN size variants', () => {
    expect(normalizePinimgImageKey('https://i.pinimg.com/236x/AB/CD/EF/photo.jpg?foo=bar'))
      .toBe('ab/cd/ef/photo.jpg');
    expect(normalizePinimgImageKey('https://i.pinimg.com/originals/ab/cd/ef/photo.jpg'))
      .toBe('ab/cd/ef/photo.jpg');
    expect(normalizePinimgImageKey('https://i.pinimg.com/474x/ab/cd/ef/photo.jpg'))
      .toBe('ab/cd/ef/photo.jpg');
  });

  it('rejects non-Pinterest board and image URLs', () => {
    expect(normalizePinterestBoardUrl('https://example.com/demo/board')).toBeNull();
    expect(normalizePinterestPinUrl('https://example.com/pin/123')).toBeNull();
    expect(normalizePinimgImageKey('https://example.com/image.jpg')).toBeNull();
  });
});
