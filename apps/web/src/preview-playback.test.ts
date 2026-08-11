import { describe, expect, it } from "vitest";
import { DEFAULT_PREVIEW_PLAYBACK_MODE, shouldLoopPreview } from "./preview-playback";

describe("video preview playback", () => {
  it("defaults to normal playback", () => {
    expect(DEFAULT_PREVIEW_PLAYBACK_MODE).toBe("normal");
    expect(shouldLoopPreview(DEFAULT_PREVIEW_PLAYBACK_MODE)).toBe(false);
  });

  it("enables looping only for loop mode", () => {
    expect(shouldLoopPreview("loop")).toBe(true);
    expect(shouldLoopPreview("normal")).toBe(false);
  });
});
