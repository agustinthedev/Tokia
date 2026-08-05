import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { detectBoard, dedupePins, extractVisiblePins, parseSrcset, scanBoard } from '../src/scanner.js';

function dom(html: string): JSDOM {
  return new JSDOM(html, { url: 'https://www.pinterest.com/demo/luxury/' });
}

describe('extension Pinterest scanner', () => {
  it('detects boards and extracts Pin IDs, metadata, and srcset variants', () => {
    const page = dom(`<html><head><title>Luxury Lifestyle | Pinterest</title></head><body>
      <h1>Luxury Lifestyle</h1><a href="/pin/123456789/?utm_source=test" data-pin-title="Yacht"><img alt="White yacht" src="https://i.pinimg.com/236x/aa/bb/cc/yacht.jpg" srcset="https://i.pinimg.com/236x/aa/bb/cc/yacht.jpg 236w, https://i.pinimg.com/736x/aa/bb/cc/yacht.jpg 736w"></a>
    </body></html>`);
    const board = detectBoard(page.window.document);
    expect(board).toMatchObject({ isBoard: true, name: 'Luxury Lifestyle' });
    const pins = extractVisiblePins(page.window.document);
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({ externalId: '123456789', title: 'Yacht', altText: 'White yacht', imageUrl: 'https://i.pinimg.com/736x/aa/bb/cc/yacht.jpg' });
    expect(parseSrcset('https://i.pinimg.com/236x/aa/bb/cc/a.jpg 236w, https://i.pinimg.com/736x/aa/bb/cc/a.jpg 736w', page.window.document)[0]?.width).toBe(736);
    expect(parseSrcset('https://i.pinimg.com/236x/aa/bb/cc/a.jpg 1x, https://i.pinimg.com/736x/aa/bb/cc/a.jpg 3x, https://i.pinimg.com/originals/aa/bb/cc/a.jpg 4x', page.window.document)[0]?.url)
      .toBe('https://i.pinimg.com/originals/aa/bb/cc/a.jpg');
  });

  it('deduplicates pins by strong identity while preserving distinct Pin IDs with one image path', () => {
    const pins = [
      { externalId: '1', pinUrl: 'https://www.pinterest.com/pin/1/', imageUrl: 'https://i.pinimg.com/236x/aa/bb/cc/same.jpg' },
      { externalId: '1', pinUrl: 'https://www.pinterest.com/pin/1/?x=1', imageUrl: 'https://i.pinimg.com/736x/aa/bb/cc/same.jpg' },
      { externalId: '2', pinUrl: 'https://www.pinterest.com/pin/2/', imageUrl: 'https://i.pinimg.com/736x/aa/bb/cc/same.jpg' }
    ];
    expect(dedupePins(pins)).toHaveLength(2);
  });

  it('stops a full scan when cancellation is requested and keeps accumulated DOM observations', async () => {
    const page = dom(`<html><body><h1>Board</h1><a href="/pin/123/"><img src="https://i.pinimg.com/236x/aa/bb/cc/a.jpg"></a></body></html>`);
    const view = page.window as unknown as { scrollBy: () => void };
    view.scrollBy = () => undefined;
    const result = await scanBoard(page.window.document, { mode: 'full', maxPins: 2_000, maxDurationMs: 10_000, noNewRounds: 5, waitMs: 0, scrollRatio: 0.75 }, { shouldStop: () => true });
    expect(result.progress.phase).toBe('stopped');
    expect(result.payload.pins).toHaveLength(1);
  });
});
