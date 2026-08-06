import { describe, expect, it } from 'vitest';
import { textOverlayLayout } from '../src/content-media.js';
import { mergeConfiguration } from '../src/content-model.js';

describe('content text overlays', () => {
  it('renders headline and body as distinct typographic layers', () => {
    const configuration = mergeConfiguration({ textMode: 'headline_and_body' });
    const parts = textOverlayLayout(configuration, 405, 720, { headline: 'Life lately', body: 'I like it' });

    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ key: 'headline', text: 'Life lately', fontSize: 54 });
    expect(parts[1]).toMatchObject({ key: 'body', text: 'I like it', fontSize: 31 });
    expect(parts[1]!.fontSize).toBeLessThan(parts[0]!.fontSize);
    expect(parts[1]!.y).toContain('+');
  });

  it('wraps long copy without introducing a replacement glyph between fields', () => {
    const configuration = mergeConfiguration({ textMode: 'headline_and_body', visual: { fontFamily: 'Arial', fontSize: 54, fontWeight: '700' } });
    const parts = textOverlayLayout(configuration, 405, 720, {
      headline: 'A headline that needs a second line',
      body: 'A longer body should wrap into readable lines without being rendered as one undifferentiated block.'
    });

    expect(parts[0]!.text).toContain('\n');
    expect(parts[1]!.text).toContain('\n');
    expect(parts.every((part) => !part.text.includes('\uFFFD'))).toBe(true);
  });
});
