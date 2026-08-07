import { describe, expect, it } from "vitest";
import {
  applyTopicSelection,
  buildEditMap,
  groupSubtitleWords,
  selectedTopicState,
  settingsFingerprint,
} from "../src/clipping-model.js";

describe("clipping model", () => {
  it("keeps topic parent state indeterminate when one child is deselected", () => {
    expect(selectedTopicState([true, false])).toBe("partial");
    expect(selectedTopicState([true, true])).toBe("selected");
    const selection = applyTopicSelection(["a", "b"], true, new Set<string>());
    expect([...selection]).toEqual(["a", "b"]);
  });

  it("groups timestamped words and remaps silence ranges", () => {
    const lines = groupSubtitleWords(
      [
        { startMs: 0, endMs: 400, text: "One" },
        { startMs: 400, endMs: 800, text: "two" },
        { startMs: 1000, endMs: 1300, text: "three" },
      ],
      0,
      1500,
      2,
    );
    expect(lines).toHaveLength(2);
    expect(
      buildEditMap(0, 1500, [{ startMs: 800, endMs: 1000 }]),
    ).toMatchObject({
      finalDurationMs: 1300,
      kept: [
        { startMs: 0, endMs: 800 },
        { startMs: 1000, endMs: 1500 },
      ],
    });
  });

  it("creates stable render fingerprints for the same settings", () => {
    expect(
      settingsFingerprint({
        subtitles: true,
        subtitlePreset: "highlight",
        subtitleFont: "Arial",
        overlayText: "",
        overlayPosition: "top",
        branding: false,
        brandText: "",
        mirror: false,
        removeSilence: false,
        silenceLevel: "balanced",
        normalizeAudio: true,
        aspectRatio: "9:16",
        quality: "standard",
        subtitleWordsPerLine: 5,
      }),
    ).toHaveLength(64);
  });
});
