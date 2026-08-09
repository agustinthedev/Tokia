import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  buildEditMap,
  groupSubtitleWords,
  normalizeClipSettings,
  remapTranscriptWords,
  renderPlan,
  silenceDetectionConfig,
  type ClipSettings,
  type TranscriptWord,
} from "./clipping-model.js";
import { MediaProcessingError, sha256File } from "./content-media.js";

interface MediaInfo {
  durationMs: number;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
  format: string | null;
}
function toolError(code: string, message: string): MediaProcessingError {
  return new MediaProcessingError(code, message);
}

async function runTool(
  binary: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 16_000) stderr = stderr.slice(-16_000);
    });
    child.on("error", () =>
      reject(
        toolError(
          "MEDIA_TOOL_UNAVAILABLE",
          "The configured media processing tool is unavailable.",
        ),
      ),
    );
    child.on("close", (code) =>
      code === 0
        ? resolve({ stdout, stderr })
        : reject(
            toolError(
              "MEDIA_TOOL_FAILED",
              "Media processing failed. Check the source codec, available disk space, and FFmpeg configuration.",
            ),
          ),
    );
  });
}

export async function probeMedia(
  ffprobePath: string,
  sourcePath: string,
): Promise<MediaInfo> {
  let result: { stdout: string };
  try {
    result = await runTool(ffprobePath, [
      "-v",
      "error",
      "-show_entries",
      "format=duration,format_name:stream=codec_type,width,height",
      "-of",
      "json",
      sourcePath,
    ]);
  } catch (error) {
    if (error instanceof MediaProcessingError)
      throw toolError(
        "INVALID_MEDIA",
        "The uploaded file is not a readable video.",
      );
    throw error;
  }
  try {
    const json = JSON.parse(result.stdout) as any;
    const stream =
      (json.streams ?? []).find((item: any) => item.codec_type === "video") ??
      {};
    const durationMs = Math.round(Number(json.format?.duration ?? 0) * 1000);
    if (!durationMs) throw new Error("Missing duration");
    return {
      durationMs,
      width: Number.isFinite(Number(stream.width))
        ? Number(stream.width)
        : null,
      height: Number.isFinite(Number(stream.height))
        ? Number(stream.height)
        : null,
      hasAudio: (json.streams ?? []).some(
        (item: any) => item.codec_type === "audio",
      ),
      format:
        typeof json.format?.format_name === "string"
          ? json.format.format_name
          : null,
    };
  } catch {
    throw toolError(
      "INVALID_MEDIA",
      "The uploaded file is not a readable video.",
    );
  }
}

export async function extractAudio(
  ffmpegPath: string,
  sourcePath: string,
  outputPath: string,
): Promise<void> {
  await runTool(ffmpegPath, [
    "-y",
    "-i",
    sourcePath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "64k",
    outputPath,
  ]);
}

export async function extractAudioSegment(
  ffmpegPath: string,
  sourcePath: string,
  outputPath: string,
  startMs: number,
  durationMs: number,
): Promise<void> {
  await runTool(ffmpegPath, [
    "-y",
    "-ss",
    String(Math.max(0, startMs) / 1000),
    "-i",
    sourcePath,
    "-t",
    String(Math.max(1, durationMs) / 1000),
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "64k",
    outputPath,
  ]);
}

export async function renderPreviewSegment(options: {
  ffmpegPath: string;
  sourcePath: string;
  outputPath: string;
  startMs: number;
  endMs: number;
}): Promise<void> {
  const startMs = Math.max(0, Math.round(options.startMs));
  const durationMs = Math.max(1, Math.round(options.endMs) - startMs);
  await runTool(options.ffmpegPath, [
    "-y",
    "-ss",
    String(startMs / 1000),
    "-i",
    options.sourcePath,
    "-t",
    String(durationMs / 1000),
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "23",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    options.outputPath,
  ]);
}

function filterPath(value: string): string {
  return value
    .replaceAll("\\", "/")
    .replaceAll(":", "\\:")
    .replaceAll("'", "\\'");
}
function assTime(ms: number): string {
  const totalCs = Math.max(0, Math.round(ms / 10));
  const cs = totalCs % 100;
  const total = Math.floor(totalCs / 100);
  const seconds = total % 60;
  const minutes = Math.floor(total / 60);
  return `0:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}
function assText(text: string): string {
  return text.replace(/[{}\\]/g, "").replace(/\r?\n/g, " ");
}

export async function writeSubtitleAss(
  outputPath: string,
  words: TranscriptWord[],
  clipStartMs: number,
  clipEndMs: number,
  settings: ClipSettings,
): Promise<void> {
  const groups = groupSubtitleWords(
    words,
    clipStartMs,
    clipEndMs,
    settings.subtitleWordsPerLine,
  );
  const font = settings.subtitleFont;
  const alignment =
    settings.overlayPosition === "top"
      ? 8
      : settings.overlayPosition === "center"
        ? 5
        : 2;
  const lines = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1080",
    "PlayResY: 1920",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${font},64,&H00FFFFFF,&H0000FFFF,&H00000000,&H99000000,1,0,1,3,0,${alignment},60,60,80,1`,
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  for (const group of groups) {
    const relativeStart = group.startMs - clipStartMs;
    const relativeEnd = group.endMs - clipStartMs;
    const karaoke = group.words
      .map(
        (word) =>
          `{\\k${Math.max(1, Math.round((word.endMs - word.startMs) / 10))}}${assText(word.text)}`,
      )
      .join(" ");
    lines.push(
      `Dialogue: 0,${assTime(relativeStart)},${assTime(relativeEnd)},Default,,0,0,0,,${karaoke}`,
    );
  }
  await fsp.writeFile(outputPath, lines.join("\n"), "utf8");
}

export async function detectSilence(
  ffmpegPath: string,
  sourcePath: string,
  thresholdDb: number,
  minDurationSeconds = 0.35,
): Promise<Array<{ startMs: number; endMs: number }>> {
  try {
    const result = await runTool(ffmpegPath, [
      "-i",
      sourcePath,
      "-af",
      `silencedetect=noise=${thresholdDb}dB:d=${minDurationSeconds}`,
      "-f",
      "null",
      "-",
    ]);
    const ranges: Array<{ startMs: number; endMs: number }> = [];
    const pattern = /silence_start:\s*([\d.]+)[\s\S]*?silence_end:\s*([\d.]+)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(result.stderr)))
      ranges.push({
        startMs: Math.round(Number(match[1]) * 1000),
        endMs: Math.round(Number(match[2]) * 1000),
      });
    return ranges;
  } catch {
    return [];
  }
}

function defaultFfprobePath(ffmpegPath: string): string {
  if (/ffmpeg\.exe$/i.test(ffmpegPath))
    return ffmpegPath.replace(/ffmpeg\.exe$/i, "ffprobe.exe");
  if (/ffmpeg$/i.test(ffmpegPath))
    return ffmpegPath.replace(/ffmpeg$/i, "ffprobe");
  return "ffprobe";
}

function protectSilenceAroundWords(
  ranges: Array<{ startMs: number; endMs: number }>,
  words: TranscriptWord[],
  clipStartMs: number,
  clipEndMs: number,
  paddingMs: number,
  minDurationMs: number,
): Array<{ startMs: number; endMs: number }> {
  return ranges.flatMap((range) => {
    let pieces = [
      {
        startMs: Math.max(clipStartMs, range.startMs),
        endMs: Math.min(clipEndMs, range.endMs),
      },
    ];
    for (const word of words) {
      const guardStart = Math.max(clipStartMs, word.startMs - paddingMs);
      const guardEnd = Math.min(clipEndMs, word.endMs + paddingMs);
      pieces = pieces.flatMap((piece) => {
        if (guardEnd <= piece.startMs || guardStart >= piece.endMs)
          return [piece];
        return [
          ...(piece.startMs < guardStart
            ? [{ startMs: piece.startMs, endMs: guardStart }]
            : []),
          ...(guardEnd < piece.endMs
            ? [{ startMs: guardEnd, endMs: piece.endMs }]
            : []),
        ];
      });
    }
    return pieces.filter(
      (piece) => piece.endMs - piece.startMs >= minDurationMs,
    );
  });
}

function segmentFilterComplex(
  kept: Array<{ startMs: number; endMs: number }>,
  clipStartMs: number,
  postVideoFilters: string,
  audioFilters: string,
): string {
  const segments: string[] = [];
  const videoLabels: string[] = [];
  const audioLabels: string[] = [];
  kept.forEach((range, index) => {
    const start = ((range.startMs - clipStartMs) / 1000).toFixed(3);
    const end = ((range.endMs - clipStartMs) / 1000).toFixed(3);
    const videoLabel = `v${index}`;
    const audioLabel = `a${index}`;
    videoLabels.push(`[${videoLabel}]`);
    audioLabels.push(`[${audioLabel}]`);
    segments.push(
      `[0:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[${videoLabel}]`,
      `[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[${audioLabel}]`,
    );
  });
  const postVideo = postVideoFilters || "null";
  const postAudio = audioFilters || "anull";
  segments.push(
    `${kept.map((_, index) => `${videoLabels[index]}${audioLabels[index]}`).join("")}concat=n=${kept.length}:v=1:a=1[basev][basea]`,
    `[basev]${postVideo}[vout]`,
    `[basea]${postAudio}[aout]`,
  );
  return segments.join(";");
}

export async function renderClip(options: {
  ffmpegPath: string;
  ffprobePath?: string;
  sourcePath: string;
  outputPath: string;
  startMs: number;
  endMs: number;
  sourceDurationMs: number;
  settings: ClipSettings;
  words: TranscriptWord[];
  workDirectory: string;
}): Promise<{
  info: MediaInfo;
  sha256: string;
  plan: Record<string, unknown>;
}> {
  const settings = normalizeClipSettings(options.settings);
  await fsp.mkdir(options.workDirectory, { recursive: true });
  const subtitlePath = path.join(
    options.workDirectory,
    `clip-${path.basename(options.outputPath)}.ass`,
  );
  const textPath = settings.overlayText
    ? path.join(
        options.workDirectory,
        `overlay-${path.basename(options.outputPath)}.txt`,
      )
    : undefined;
  const brandTextPath =
    settings.branding && settings.brandText
      ? path.join(
          options.workDirectory,
          `brand-${path.basename(options.outputPath)}.txt`,
        )
      : undefined;
  const silenceConfig = silenceDetectionConfig(settings.silenceLevel);
  const detectedSilence = settings.removeSilence
    ? await detectSilence(
        options.ffmpegPath,
        options.sourcePath,
        silenceConfig.thresholdDb,
        silenceConfig.minDurationMs / 1000,
      )
    : [];
  const silenceRanges = protectSilenceAroundWords(
    detectedSilence,
    options.words,
    options.startMs,
    options.endMs,
    silenceConfig.paddingMs,
    silenceConfig.minDurationMs,
  );
  const editMap = buildEditMap(options.startMs, options.endMs, silenceRanges);
  const hasEdits =
    settings.removeSilence &&
    editMap.removed.length > 0 &&
    editMap.kept.length > 0;
  const effectiveEditMap = hasEdits
    ? editMap
    : {
        kept: [{ startMs: options.startMs, endMs: options.endMs }],
        removed: [],
        finalDurationMs: options.endMs - options.startMs,
      };
  const subtitleWords = hasEdits
    ? remapTranscriptWords(
        options.words,
        options.startMs,
        options.endMs,
        editMap,
      )
    : options.words;
  if (settings.subtitles)
    await writeSubtitleAss(
      subtitlePath,
      subtitleWords,
      hasEdits ? 0 : options.startMs,
      hasEdits ? effectiveEditMap.finalDurationMs : options.endMs,
      settings,
    );
  if (textPath) await fsp.writeFile(textPath, settings.overlayText, "utf8");
  if (brandTextPath)
    await fsp.writeFile(brandTextPath, settings.brandText, "utf8");
  const plan = renderPlan({
    sourcePath: options.sourcePath,
    outputPath: options.outputPath,
    startMs: options.startMs,
    endMs: options.endMs,
    durationMs: options.sourceDurationMs,
    settings,
    subtitlePath: settings.subtitles ? filterPath(subtitlePath) : undefined,
    textPath: textPath ? filterPath(textPath) : undefined,
    brandTextPath: brandTextPath ? filterPath(brandTextPath) : undefined,
    editMap: hasEdits ? editMap : undefined,
  });
  const filters =
    (plan.videoFilters as string[])
      .map((filter) =>
        filter.startsWith("subtitles=")
          ? `subtitles=filename='${filterPath(subtitlePath)}'`
          : filter.startsWith("drawtext=textfile=") &&
              filter.includes("fontsize=48") &&
              textPath
            ? `drawtext=textfile='${filterPath(textPath)}':fontcolor=white:fontsize=48:x=60:y=80:box=1:boxcolor=black@0.45:boxborderw=18`
            : filter.startsWith("drawtext=textfile=") && brandTextPath
              ? `drawtext=textfile='${filterPath(brandTextPath)}':fontcolor=white:fontsize=32:x=w-text_w-50:y=h-text_h-40`
              : filter,
      )
      .join(",") || "null";
  const audioFilters = (plan.audioFilters as string[]).join(",");
  const durationSeconds = Math.max(
    0.04,
    effectiveEditMap.finalDurationMs / 1000,
  );
  const args = hasEdits
    ? [
        "-y",
        "-ss",
        (options.startMs / 1000).toFixed(3),
        "-t",
        ((options.endMs - options.startMs) / 1000).toFixed(3),
        "-i",
        options.sourcePath,
        "-filter_complex",
        segmentFilterComplex(
          effectiveEditMap.kept,
          options.startMs,
          filters,
          audioFilters,
        ),
        "-map",
        "[vout]",
        "-map",
        "[aout]",
        "-shortest",
        "-c:v",
        "libx264",
        "-preset",
        settings.quality === "high" ? "medium" : "fast",
        "-crf",
        settings.quality === "high" ? "18" : "23",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        options.outputPath,
      ]
    : [
        "-y",
        "-ss",
        (options.startMs / 1000).toFixed(3),
        "-t",
        durationSeconds.toFixed(3),
        "-i",
        options.sourcePath,
        "-vf",
        filters,
        ...(audioFilters ? ["-af", audioFilters] : []),
        "-c:v",
        "libx264",
        "-preset",
        settings.quality === "high" ? "medium" : "fast",
        "-crf",
        settings.quality === "high" ? "18" : "23",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        options.outputPath,
      ];
  try {
    await runTool(options.ffmpegPath, args);
    const info = await probeMedia(
      options.ffprobePath ?? defaultFfprobePath(options.ffmpegPath),
      options.outputPath,
    ).catch(() => ({
      durationMs: Math.round(durationSeconds * 1000),
      width: settings.aspectRatio === "9:16" ? 1080 : null,
      height: settings.aspectRatio === "9:16" ? 1920 : null,
      hasAudio: true,
      format: "mp4",
    }));
    return { info, sha256: await sha256File(options.outputPath), plan };
  } finally {
    await fsp.rm(subtitlePath, { force: true });
    if (textPath) await fsp.rm(textPath, { force: true });
    if (brandTextPath) await fsp.rm(brandTextPath, { force: true });
  }
}

export async function fileMetadata(
  filePath: string,
): Promise<{ size: number; sha256: string }> {
  const stat = await fsp.stat(filePath);
  return { size: stat.size, sha256: await sha256File(filePath) };
}
