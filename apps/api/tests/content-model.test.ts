import { describe, expect, it } from 'vitest';
import { contentFrameCount, defaultFrameDuration, effectiveFrameTrim, frameDurationLimit, frameRoles, mergeConfiguration, normalizeFrameDuration, normalizeFrameTrim } from '../src/content-model.js';
import { generateNarrative, validateNarrative } from '../src/narrative.js';

describe('content model and narrative contract', () => {
  it('counts cover and CTA inside the requested total', () => {
    const configuration = mergeConfiguration({ totalFrames: 5, includeCover: true, includeCta: true });
    expect(frameRoles('carousel', configuration).map((frame) => frame.role)).toEqual(['cover', 'content', 'content', 'content', 'cta']);
    expect(contentFrameCount('carousel', configuration)).toBe(3);
    expect(frameRoles('single_image', configuration)).toEqual([{ position: 1, role: 'title_and_summary' }]);
  });

  it('keeps video frame counts above the former 30-frame limit', () => {
    const configuration = mergeConfiguration({ totalFrames: 35, includeCover: true, includeCta: true });
    expect(configuration.totalFrames).toBe(35);
    expect(frameRoles('video_slideshow', configuration)).toHaveLength(35);
  });

  it('validates ordered roles and text-mode restrictions', () => {
    const configuration = mergeConfiguration({ totalFrames: 3, includeCover: true, includeCta: false, textMode: 'cover_only' });
    const roles = frameRoles('carousel', configuration);
    const narrative = generateNarrative({ type: 'carousel', language: 'English', niche: 'Fitness', projectDescription: '', topic: 'Mobility', tone: 'educational', audience: '', customInstructions: '', ctaMode: 'ai', ctaText: '', textMode: 'cover_only', roles });
    expect(narrative.frames.map((frame) => [frame.role, frame.headline, frame.body])).toEqual([
      ['cover', expect.any(String), null],
      ['content', null, null],
      ['content', null, null]
    ]);
    expect(validateNarrative(narrative, roles, configuration).frames).toHaveLength(3);
    expect(() => validateNarrative({ ...narrative, frames: narrative.frames.map((frame, index) => index === 1 ? { ...frame, headline: 'Not allowed' } : frame) }, roles, configuration)).toThrow('cover_only');
  });

  it('uses the global image default and the original video duration per frame', () => {
    const configuration = mergeConfiguration({ video: { secondsPerImage: 1.5 } });
    expect(defaultFrameDuration(configuration, 'image')).toBe(1.5);
    expect(defaultFrameDuration(configuration, 'video', 4.25)).toBe(4.25);
    expect(frameDurationLimit('video', 4.25)).toBe(4.25);
    expect(normalizeFrameDuration(2.1, configuration, 'video', 4.25)).toBe(2.1);
    expect(() => normalizeFrameDuration(4.3, configuration, 'video', 4.25)).toThrow('4.25');
  });

  it('normalizes a video trim range and derives its duration', () => {
    expect(normalizeFrameTrim(1.25, 4.2, 'video', 5)).toEqual({ startSeconds: 1.25, endSeconds: 4.2, durationSeconds: 2.95 });
    expect(effectiveFrameTrim({ startSeconds: 1.25, endSeconds: 4.2 }, mergeConfiguration({}), 'video', 5)).toEqual({ startSeconds: 1.25, endSeconds: 4.2, durationSeconds: 2.95 });
  });

  it('rejects video trim ranges whose handles cross or leave the source', () => {
    expect(() => normalizeFrameTrim(3, 2.9, 'video', 5)).toThrow(/Video trim/);
    expect(() => normalizeFrameTrim(0, 5.1, 'video', 5)).toThrow(/source video is 5.00 seconds long/);
  });
});
