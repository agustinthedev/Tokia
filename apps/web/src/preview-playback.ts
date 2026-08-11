export type PreviewPlaybackMode = "normal" | "loop";

export const DEFAULT_PREVIEW_PLAYBACK_MODE: PreviewPlaybackMode = "normal";

export function shouldLoopPreview(mode: PreviewPlaybackMode): boolean {
  return mode === "loop";
}
