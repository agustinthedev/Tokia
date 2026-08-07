import crypto from "node:crypto";

export interface ClipSettings {
  subtitles: boolean;
  subtitlePreset: "highlight" | "clean" | "boxed" | "minimal";
  subtitleFont: "Arial" | "DejaVu Sans" | "Georgia" | "Verdana";
  overlayText: string;
  overlayPosition: "top" | "center" | "bottom";
  branding: boolean;
  brandText: string;
  mirror: boolean;
  removeSilence: boolean;
  silenceLevel: "light" | "balanced" | "aggressive";
  normalizeAudio: boolean;
  aspectRatio: "9:16" | "original";
  quality: "standard" | "high";
  subtitleWordsPerLine: number;
}

export const DEFAULT_CLIP_SETTINGS: ClipSettings = {
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
};

export interface TranscriptWord {
  startMs: number;
  endMs: number;
  text: string;
}
export interface EditRange {
  startMs: number;
  endMs: number;
}

export interface SilenceDetectionConfig {
  thresholdDb: number;
  minDurationMs: number;
  paddingMs: number;
}

export function silenceDetectionConfig(
  level: ClipSettings["silenceLevel"],
): SilenceDetectionConfig {
  if (level === "light")
    return { thresholdDb: -35, minDurationMs: 600, paddingMs: 90 };
  if (level === "aggressive")
    return { thresholdDb: -25, minDurationMs: 200, paddingMs: 70 };
  return { thresholdDb: -30, minDurationMs: 350, paddingMs: 80 };
}

export function normalizeClipSettings(
  input: unknown,
  base: ClipSettings = DEFAULT_CLIP_SETTINGS,
): ClipSettings {
  const source =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const next = { ...base, ...source } as ClipSettings;
  next.subtitlePreset = ["highlight", "clean", "boxed", "minimal"].includes(
    next.subtitlePreset,
  )
    ? next.subtitlePreset
    : base.subtitlePreset;
  next.subtitleFont = ["Arial", "DejaVu Sans", "Georgia", "Verdana"].includes(
    next.subtitleFont,
  )
    ? next.subtitleFont
    : base.subtitleFont;
  next.overlayPosition = ["top", "center", "bottom"].includes(
    next.overlayPosition,
  )
    ? next.overlayPosition
    : base.overlayPosition;
  next.silenceLevel = ["light", "balanced", "aggressive"].includes(
    next.silenceLevel,
  )
    ? next.silenceLevel
    : base.silenceLevel;
  next.aspectRatio = next.aspectRatio === "original" ? "original" : "9:16";
  next.quality = next.quality === "high" ? "high" : "standard";
  next.subtitleWordsPerLine = Math.max(
    2,
    Math.min(
      8,
      Number.isInteger(Number(next.subtitleWordsPerLine))
        ? Number(next.subtitleWordsPerLine)
        : base.subtitleWordsPerLine,
    ),
  );
  next.overlayText = String(next.overlayText ?? "").slice(0, 160);
  next.brandText = String(next.brandText ?? "").slice(0, 120);
  for (const key of [
    "subtitles",
    "branding",
    "mirror",
    "removeSilence",
    "normalizeAudio",
  ])
    (next as unknown as Record<string, unknown>)[key] = Boolean(
      (next as unknown as Record<string, unknown>)[key],
    );
  return next;
}

export function settingsFingerprint(settings: ClipSettings): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(normalizeClipSettings(settings)))
    .digest("hex");
}

export function validateClipBounds(
  startMs: number,
  endMs: number,
  durationMs: number,
): void {
  if (
    !Number.isInteger(startMs) ||
    !Number.isInteger(endMs) ||
    startMs < 0 ||
    endMs <= startMs ||
    endMs > durationMs
  )
    throw new Error(
      "Clip boundaries must be ordered and inside the source video.",
    );
}

export function selectedTopicState(
  childSelections: boolean[],
): "selected" | "partial" | "unselected" {
  if (!childSelections.length || childSelections.every(Boolean))
    return "selected";
  if (childSelections.every((value) => !value)) return "unselected";
  return "partial";
}

export function applyTopicSelection(
  childIds: string[],
  selected: boolean,
  current: Set<string>,
): Set<string> {
  const next = new Set(current);
  for (const id of childIds) selected ? next.add(id) : next.delete(id);
  return next;
}

export function groupSubtitleWords(
  words: TranscriptWord[],
  clipStartMs: number,
  clipEndMs: number,
  wordsPerLine = 5,
): Array<{ startMs: number; endMs: number; words: TranscriptWord[] }> {
  const clipped = words
    .filter((word) => word.endMs > clipStartMs && word.startMs < clipEndMs)
    .map((word) => ({
      ...word,
      startMs: Math.max(clipStartMs, word.startMs),
      endMs: Math.min(clipEndMs, word.endMs),
    }));
  const result: Array<{
    startMs: number;
    endMs: number;
    words: TranscriptWord[];
  }> = [];
  for (let index = 0; index < clipped.length; index += wordsPerLine) {
    const line = clipped.slice(index, index + wordsPerLine);
    if (!line.length) continue;
    result.push({
      startMs: line[0]!.startMs,
      endMs: line.at(-1)!.endMs,
      words: line,
    });
  }
  return result;
}

export function buildEditMap(
  clipStartMs: number,
  clipEndMs: number,
  silenceRanges: EditRange[],
): { kept: EditRange[]; removed: EditRange[]; finalDurationMs: number } {
  const removed = silenceRanges
    .map((range) => ({
      startMs: Math.max(clipStartMs, range.startMs),
      endMs: Math.min(clipEndMs, range.endMs),
    }))
    .filter((range) => range.endMs > range.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  const merged: EditRange[] = [];
  for (const range of removed) {
    const previous = merged.at(-1);
    if (previous && range.startMs <= previous.endMs)
      previous.endMs = Math.max(previous.endMs, range.endMs);
    else merged.push({ ...range });
  }
  const kept: EditRange[] = [];
  let cursor = clipStartMs;
  for (const range of merged) {
    if (range.startMs > cursor)
      kept.push({ startMs: cursor, endMs: range.startMs });
    cursor = Math.max(cursor, range.endMs);
  }
  if (cursor < clipEndMs) kept.push({ startMs: cursor, endMs: clipEndMs });
  return {
    kept,
    removed: merged,
    finalDurationMs: kept.reduce(
      (total, range) => total + range.endMs - range.startMs,
      0,
    ),
  };
}

export function remapTimestamp(
  timestampMs: number,
  clipStartMs: number,
  editMap: Pick<ReturnType<typeof buildEditMap>, "removed">,
): number {
  const clamped = Math.max(clipStartMs, timestampMs);
  let removedBefore = 0;
  for (const range of editMap.removed) {
    if (clamped >= range.endMs) {
      removedBefore += range.endMs - range.startMs;
      continue;
    }
    if (clamped > range.startMs)
      return Math.max(0, range.startMs - clipStartMs - removedBefore);
    break;
  }
  return Math.max(0, clamped - clipStartMs - removedBefore);
}

export function remapTranscriptWords(
  words: TranscriptWord[],
  clipStartMs: number,
  clipEndMs: number,
  editMap: Pick<ReturnType<typeof buildEditMap>, "removed">,
): TranscriptWord[] {
  return words
    .filter((word) => word.endMs > clipStartMs && word.startMs < clipEndMs)
    .map((word) => {
      const startMs = remapTimestamp(
        Math.max(clipStartMs, word.startMs),
        clipStartMs,
        editMap,
      );
      const endMs = remapTimestamp(
        Math.min(clipEndMs, word.endMs),
        clipStartMs,
        editMap,
      );
      return { ...word, startMs, endMs };
    })
    .filter((word) => word.endMs > word.startMs);
}

export function subtitleColor(preset: ClipSettings["subtitlePreset"]): string {
  return preset === "highlight"
    ? "&H0000FFFF"
    : preset === "boxed"
      ? "&H00FFFFFF"
      : "&H00FFFFFF";
}

export function renderPlan(input: {
  sourcePath: string;
  outputPath: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  settings: ClipSettings;
  subtitlePath?: string;
  textPath?: string;
  brandTextPath?: string;
  editMap?: ReturnType<typeof buildEditMap>;
}): Record<string, unknown> {
  validateClipBounds(input.startMs, input.endMs, input.durationMs);
  const settings = normalizeClipSettings(input.settings);
  const filters: string[] = [];
  if (settings.aspectRatio === "9:16")
    filters.push(
      "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920",
    );
  if (settings.mirror) filters.push("hflip");
  if (input.subtitlePath && settings.subtitles)
    filters.push(`subtitles=${input.subtitlePath}`);
  if (input.textPath && settings.overlayText)
    filters.push(
      `drawtext=textfile=${input.textPath}:fontcolor=white:fontsize=48:x=60:y=80:box=1:boxcolor=black@0.45:boxborderw=18`,
    );
  if (input.brandTextPath && settings.branding && settings.brandText)
    filters.push(
      `drawtext=textfile=${input.brandTextPath}:fontcolor=white:fontsize=32:x=w-text_w-50:y=h-text_h-40`,
    );
  return {
    version: "clip-render-v1",
    input: input.sourcePath,
    output: input.outputPath,
    startMs: input.startMs,
    endMs: input.endMs,
    settings,
    videoFilters: filters,
    audioFilters: settings.normalizeAudio
      ? ["loudnorm=I=-16:TP=-1.5:LRA=11"]
      : [],
    editMap: input.editMap ?? null,
  };
}
