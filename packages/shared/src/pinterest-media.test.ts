import { describe, expect, it } from 'vitest';
import { extractPinterestVideoMedia } from './pinterest-media.js';

describe('Pinterest video metadata', () => {
  it('prefers a direct MP4 and reads the poster and duration from pin HTML', () => {
    const html = '{"videoList":{"vHLSV3MOBILE":{"url":"https:\\/\\/v1.pinimg.com\\/videos\\/iht\\/hls\\/clip.m3u8"}},"videoList720P":{"v720P":{"url":"https:\\/\\/v1.pinimg.com\\/videos\\/iht\\/expMp4\\/clip_720w.mp4"}},"thumbnail":"https://i.pinimg.com/videos/thumbnails/originals/clip.jpg","duration":"PT13S"}';
    expect(extractPinterestVideoMedia(html)).toMatchObject({
      mediaUrl: 'https://v1.pinimg.com/videos/iht/expMp4/clip_720w.mp4',
      mimeType: 'video/mp4',
      posterUrl: 'https://i.pinimg.com/videos/thumbnails/originals/clip.jpg',
      durationSeconds: 13
    });
  });
});
