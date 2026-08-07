import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { renderClip } from "../src/clipping-media.js";

const execFileAsync = promisify(execFile);
let directory: string | undefined;

afterEach(async () => {
  if (directory) await fsp.rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("clipping media renderer", () => {
  it("removes detected silence and keeps subtitle timing on the edited timeline", async () => {
    directory = await fsp.mkdtemp(
      path.join(os.tmpdir(), "tokia-clipping-media-"),
    );
    const sourcePath = path.join(directory, "source.mp4");
    const outputPath = path.join(directory, "output.mp4");
    await execFileAsync("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=320x240:r=25:d=2",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=16000:duration=0.6",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=channel_layout=mono:sample_rate=16000:duration=0.8",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=16000:duration=0.6",
      "-filter_complex",
      "[1:a][2:a][3:a]concat=n=3:v=0:a=1[a]",
      "-map",
      "0:v",
      "-map",
      "[a]",
      "-shortest",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      sourcePath,
    ]);
    const result = await renderClip({
      ffmpegPath: "ffmpeg",
      ffprobePath: "ffprobe",
      sourcePath,
      outputPath,
      startMs: 0,
      endMs: 2000,
      sourceDurationMs: 2000,
      settings: {
        subtitles: true,
        subtitlePreset: "highlight",
        subtitleFont: "Arial",
        overlayText: "",
        overlayPosition: "top",
        branding: false,
        brandText: "",
        mirror: false,
        removeSilence: true,
        silenceLevel: "balanced",
        normalizeAudio: false,
        aspectRatio: "original",
        quality: "standard",
        subtitleWordsPerLine: 4,
      },
      words: [
        { startMs: 100, endMs: 300, text: "hello" },
        { startMs: 1500, endMs: 1700, text: "world" },
      ],
      workDirectory: directory,
    });
    const editMap = result.plan.editMap as {
      removed: Array<{ startMs: number; endMs: number }>;
      finalDurationMs: number;
    };
    expect(editMap.removed.length).toBeGreaterThan(0);
    expect(editMap.finalDurationMs).toBeLessThan(1700);
    expect(result.info.durationMs).toBeLessThan(1700);
    expect(result.sha256).toHaveLength(64);
  }, 60_000);
});
