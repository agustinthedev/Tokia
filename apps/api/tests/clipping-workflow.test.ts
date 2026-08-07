import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { createDatabase } from "../src/db.js";
import type Database from "better-sqlite3";

const execFileAsync = promisify(execFile);
const token = "clipping-test-token";
let db: Database.Database | undefined;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let storage: string | undefined;
let originalFetch: typeof fetch | undefined;

afterEach(async () => {
  if (app) await app.close();
  if (db?.open) db.close();
  if (storage) await fsp.rm(storage, { recursive: true, force: true });
  if (originalFetch) globalThis.fetch = originalFetch;
  app = undefined;
  db = undefined;
  storage = undefined;
  originalFetch = undefined;
});

describe("clipping workflow integration", () => {
  it("persists source processing, topic selection, render settings, and a rendered output", async () => {
    storage = await fsp.mkdtemp(path.join(os.tmpdir(), "tokia-clipping-"));
    db = createDatabase(":memory:");
    db.prepare(
      `INSERT INTO projects(id, name, niche, default_language, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    ).run(
      "project-clipping",
      "Clipping project",
      "Podcast",
      "English",
      new Date().toISOString(),
      new Date().toISOString(),
    );
    app = await buildApp({
      db,
      settings: {
        ...config,
        localIntegrationToken: token,
        contentStorageDirectory: storage,
        ffmpegPath: "ffmpeg",
        ffprobePath: "ffprobe",
        secretsEncryptionKey: "test-master-secret",
        maxUploadBytes: 25 * 1024 * 1024,
      },
    });
    const headers = { "x-local-integration-token": token };
    const providerResponse = await app.inject({
      method: "POST",
      url: "/api/ai/providers",
      headers,
      payload: {
        providerType: "openai",
        displayName: "Test provider",
        apiKey: "sk-test-secret-1234",
        modelName: "gpt-test",
        transcriptionModel: "whisper-test",
      },
    });
    expect(providerResponse.statusCode).toBe(201);
    expect(providerResponse.json().apiKey).not.toContain("sk-test-secret");
    const providerId = providerResponse.json().id as string;
    db.prepare(
      "UPDATE ai_provider_connections SET status = 'connected' WHERE id = ?",
    ).run(providerId);
    const assignment = await app.inject({
      method: "PUT",
      url: "/api/ai/assignments",
      headers,
      payload: {
        transcriptionProviderId: providerId,
        analysisProviderId: providerId,
      },
    });
    expect(assignment.statusCode).toBe(200);
    expect(assignment.json().preflight.ready).toBe(true);
    const draft = await app.inject({
      method: "POST",
      url: "/api/projects/project-clipping/content",
      headers,
      payload: { type: "video_clipping", title: "Interview clips" },
    });
    expect(draft.statusCode).toBe(201);
    const contentId = draft.json().id as string;
    const fixture = path.join(storage, "fixture.mp4");
    await execFileAsync("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=320x240:r=25",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=16000",
      "-t",
      "2",
      "-shortest",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      fixture,
    ]);
    const video = await fsp.readFile(fixture);
    const uploaded = await app.inject({
      method: "POST",
      url: `/api/content/${contentId}/clipping/source?filename=fixture.mp4`,
      headers: { ...headers, "content-type": "video/mp4" },
      payload: video,
    });
    expect(uploaded.statusCode).toBe(201);
    expect(uploaded.json().source.durationMs).toBeGreaterThan(0);
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/audio/transcriptions"))
        return new Response(
          JSON.stringify({
            text: "One two three four five six",
            language: "en",
            segments: [
              {
                start: 0,
                end: 2,
                text: "One two three four five six",
                words: [
                  { word: "One", start: 0, end: 0.3 },
                  { word: "two", start: 0.3, end: 0.6 },
                  { word: "three", start: 0.6, end: 0.9 },
                  { word: "four", start: 0.9, end: 1.2 },
                  { word: "five", start: 1.2, end: 1.5 },
                  { word: "six", start: 1.5, end: 1.8 },
                ],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      if (url.endsWith("/chat/completions"))
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    topics: [
                      {
                        title: "Main idea",
                        summary: "The central idea.",
                        startMs: 0,
                        endMs: 1800,
                        subtopics: [
                          { title: "Opening point", startMs: 0, endMs: 800 },
                          { title: "Closing point", startMs: 800, endMs: 1800 },
                        ],
                      },
                    ],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      return originalFetch!(input);
    }) as typeof fetch;
    const queued = await app.inject({
      method: "POST",
      url: `/api/content/${contentId}/clipping/analyze`,
      headers,
      payload: {},
    });
    expect(queued.statusCode).toBe(202);
    const ready = await waitFor(async () => {
      const response = await app!.inject({
        method: "GET",
        url: `/api/content/${contentId}/clipping`,
      });
      const state = response.json();
      return state.source?.processingStage === "ready" ? state : null;
    }, 30_000);
    expect(ready.topics).toHaveLength(1);
    expect(ready.topics[0].subtopics).toHaveLength(2);
    const providerCallsBeforeReopen = (globalThis.fetch as any).mock.calls
      .length;
    const reopened = await app.inject({
      method: "POST",
      url: `/api/content/${contentId}/clipping/analyze`,
      headers,
      payload: {},
    });
    expect(reopened.statusCode).toBe(202);
    expect(reopened.json().job.status).toBe("completed");
    expect((globalThis.fetch as any).mock.calls.length).toBe(
      providerCallsBeforeReopen,
    );
    const topicId = ready.topics[0].id as string;
    const first = ready.topics[0].subtopics[0].id as string;
    await app.inject({
      method: "POST",
      url: `/api/content/${contentId}/clipping/topics/${topicId}/selection`,
      headers,
      payload: { selected: false },
    });
    const selected = await app.inject({
      method: "POST",
      url: `/api/content/${contentId}/clipping/subtopics/${first}/selection`,
      headers,
      payload: { selected: true },
    });
    expect(selected.json().topics[0].selectionState).toBe("partial");
    await app.inject({
      method: "PATCH",
      url: `/api/content/${contentId}/clipping/selections/${first}/settings`,
      headers,
      payload: {
        subtitles: true,
        subtitlePreset: "highlight",
        aspectRatio: "9:16",
        normalizeAudio: true,
      },
    });
    const render = await app.inject({
      method: "POST",
      url: `/api/content/${contentId}/clipping/render`,
      headers,
      payload: {},
    });
    expect(render.statusCode).toBe(202);
    const rendered = await waitFor(async () => {
      const response = await app!.inject({
        method: "GET",
        url: `/api/content/${contentId}/clipping`,
      });
      const state = response.json();
      return state.batches?.[0]?.status === "completed" ? state : null;
    }, 30_000);
    expect(rendered.batches[0].completedCount).toBe(1);
    const clipId = rendered.batches[0].clips[0].id as string;
    const download = await app.inject({
      method: "GET",
      url: `/api/clipping/rendered/${clipId}/download`,
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toContain("video/mp4");
  }, 60_000);
});

async function waitFor<T>(
  check: () => Promise<T | null>,
  timeoutMs: number,
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Timed out waiting for clipping worker");
}
