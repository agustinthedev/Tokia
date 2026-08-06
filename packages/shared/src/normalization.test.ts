import { describe, expect, it } from 'vitest';
import {
  extractPinterestPinId,
  normalizePin,
  normalizePinimgImageKey,
  normalizePinterestBoardUrl,
  normalizePinterestPinUrl,
  chooseBestImageUrl,
  pinterestImageCandidates
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

  it('keeps a deferred video media URL empty instead of treating its poster as the video', () => {
    const pin = normalizePin({
      externalId: 'video-1',
      pinUrl: 'https://www.pinterest.com/pin/video-1/',
      imageUrl: 'https://i.pinimg.com/474x/aa/bb/cc/poster.jpg',
      mediaType: 'video'
    });
    expect(pin.mediaUrl).toBeNull();
    expect(pin.imageUrl).toContain('poster.jpg');
  });

  it('promotes Pinterest sources to originals and scales known dimensions', () => {
    const pin = normalizePin({
      externalId: 'small-source',
      pinUrl: 'https://www.pinterest.com/pin/small-source/',
      imageUrl: 'https://i.pinimg.com/236x/aa/bb/cc/photo.jpg',
      width: 236,
      height: 419
    });
    expect(chooseBestImageUrl(pin)).toMatchObject({
      imageUrl: 'https://i.pinimg.com/originals/aa/bb/cc/photo.jpg',
      width: 736,
      height: 1307
    });
  });

  it('prefers an originals variant over numeric CDN variants', () => {
    const pin = normalizePin({
      externalId: 'original-source',
      pinUrl: 'https://www.pinterest.com/pin/original-source/',
      imageUrl: 'https://i.pinimg.com/736x/aa/bb/cc/photo.jpg',
      width: 736,
      height: 1104,
      imageVariants: [
        { url: 'https://i.pinimg.com/1200x/aa/bb/cc/photo.jpg', width: 1200 },
        { url: 'https://i.pinimg.com/originals/aa/bb/cc/photo.jpg' }
      ]
    });
    expect(chooseBestImageUrl(pin)).toMatchObject({
      imageUrl: 'https://i.pinimg.com/originals/aa/bb/cc/photo.jpg',
      width: 1200,
      height: 1800
    });
  });

  it('keeps numeric Pinterest fallbacks behind originals for resilient downloads', () => {
    expect(pinterestImageCandidates('https://i.pinimg.com/originals/aa/bb/cc/photo.jpg')).toEqual([
      'https://i.pinimg.com/originals/aa/bb/cc/photo.jpg',
      'https://i.pinimg.com/1200x/aa/bb/cc/photo.jpg',
      'https://i.pinimg.com/1000x/aa/bb/cc/photo.jpg',
      'https://i.pinimg.com/736x/aa/bb/cc/photo.jpg'
    ]);
  });
});
