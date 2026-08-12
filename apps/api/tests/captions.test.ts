import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { createDatabase } from "../src/db.js";
import { insertProvider } from "../src/ai-providers.js";

const token = "captions-test-token";
const headers = { "x-local-integration-token": token };

describe("captions library", () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let db: Database.Database | undefined;
  const originalFetch = globalThis.fetch;

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (app) await app.close();
    if (db?.open) db.close();
    app = undefined;
    db = undefined;
  });

  async function setup(): Promise<void> {
    db = createDatabase(":memory:");
    app = await buildApp({
      db,
      settings: { ...config, localIntegrationToken: token },
    });
  }

  async function createFolder(title = "Launch ideas"): Promise<any> {
    const response = await app!.inject({
      method: "POST",
      url: "/api/caption-folders",
      headers,
      payload: { title, subtitle: "Short-form copy", color: "#2468ec" },
    });
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  async function createCaption(folderId: string, body: string, color = "#f59e0b"): Promise<any> {
    const response = await app!.inject({
      method: "POST",
      url: `/api/caption-folders/${folderId}/captions`,
      headers,
      payload: { body, color },
    });
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  it("creates folders and keeps captions isolated while preserving line breaks", async () => {
    await setup();
    const firstFolder = await createFolder();
    const secondFolder = await createFolder("Other ideas");
    const saved = await createCaption(firstFolder.id, "First line\nSecond line\n\nFourth line");

    expect(saved).toMatchObject({
      folderId: firstFolder.id,
      body: "First line\nSecond line\n\nFourth line",
      color: "#f59e0b",
    });

    const firstList = await app!.inject({ method: "GET", url: `/api/caption-folders/${firstFolder.id}/captions` });
    expect(firstList.statusCode).toBe(200);
    expect(firstList.json().items).toHaveLength(1);
    expect(firstList.json().items[0].body).toBe("First line\nSecond line\n\nFourth line");

    const secondList = await app!.inject({ method: "GET", url: `/api/caption-folders/${secondFolder.id}/captions` });
    expect(secondList.statusCode).toBe(200);
    expect(secondList.json().items).toHaveLength(0);

    const folders = await app!.inject({ method: "GET", url: "/api/caption-folders" });
    expect(folders.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: firstFolder.id, title: "Launch ideas", subtitle: "Short-form copy", captionCount: 1 }),
      expect.objectContaining({ id: secondFolder.id, captionCount: 0 }),
    ]));
  });

  it("validates caption input and persists edits", async () => {
    await setup();
    const folder = await createFolder();
    const invalidFolder = await app!.inject({
      method: "POST",
      url: "/api/caption-folders",
      headers,
      payload: { title: "", color: "not-a-color" },
    });
    expect(invalidFolder.statusCode).toBe(400);

    const oversizedFolderTitle = await app!.inject({
      method: "POST",
      url: "/api/caption-folders",
      headers,
      payload: { title: "x".repeat(121) },
    });
    expect(oversizedFolderTitle.statusCode).toBe(400);
    expect(oversizedFolderTitle.json().error.code).toBe("CAPTION_FOLDER_TITLE_TOO_LONG");

    const oversizedFolderSubtitle = await app!.inject({
      method: "POST",
      url: "/api/caption-folders",
      headers,
      payload: { title: "Valid title", subtitle: "x".repeat(241) },
    });
    expect(oversizedFolderSubtitle.statusCode).toBe(400);
    expect(oversizedFolderSubtitle.json().error.code).toBe("CAPTION_FOLDER_SUBTITLE_TOO_LONG");

    const invalidCaption = await app!.inject({
      method: "POST",
      url: `/api/caption-folders/${folder.id}/captions`,
      headers,
      payload: { body: "", color: "#fff" },
    });
    expect(invalidCaption.statusCode).toBe(400);

    const caption = await createCaption(folder.id, "Before");
    const updated = await app!.inject({
      method: "PATCH",
      url: `/api/captions/${caption.id}`,
      headers,
      payload: { body: "After\nwith a new line", color: "#16a34a" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ body: "After\nwith a new line", color: "#16a34a" });
  });

  it("reports AI unavailable and rejects generation without a connected text provider", async () => {
    await setup();
    const folder = await createFolder();
    const status = await app!.inject({ method: "GET", url: "/api/captions/ai-status" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ ready: false });

    const generated = await app!.inject({
      method: "POST",
      url: `/api/caption-folders/${folder.id}/captions/generate`,
      headers,
      payload: { prompt: "Write a warm launch caption" },
    });
    expect(generated.statusCode).toBe(503);
    expect(generated.json().error.code).toBe("AI_UNAVAILABLE");
  });

  it("generates a validated draft using at most 30 folder examples", async () => {
    await setup();
    const folder = await createFolder();
    for (let index = 1; index <= 101; index += 1) {
      await createCaption(folder.id, `Example caption ${index}`);
    }

    const provider = insertProvider(
      db!,
      {
        providerType: "openai_compatible",
        displayName: "Test text provider",
        apiKey: "test-provider-secret",
        baseUrl: "https://provider.example/v1",
        modelName: "caption-model",
      },
      config.secretsEncryptionKey,
    );
    db!.prepare("UPDATE ai_provider_connections SET status = 'connected' WHERE id = ?").run(provider.id);
    db!.prepare(
      "INSERT INTO ai_task_assignments(owner_scope, task_type, provider_connection_id, updated_at) VALUES ('local', 'TOPIC_DETECTION', ?, ?)",
    ).run(provider.id, new Date().toISOString());

    let requestBody = "";
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify({ caption: "Generated first line\nGenerated second line" }) } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const status = await app!.inject({ method: "GET", url: "/api/captions/ai-status" });
    expect(status.json()).toMatchObject({ ready: true, providerName: "Test text provider" });

    const generated = await app!.inject({
      method: "POST",
      url: `/api/caption-folders/${folder.id}/captions/generate`,
      headers,
      payload: { prompt: "Write a warm launch caption" },
    });
    expect(generated.statusCode).toBe(200);
    expect(generated.json()).toMatchObject({
      caption: "Generated first line\nGenerated second line",
      examplesUsed: 30,
    });

    const body = JSON.parse(requestBody) as { messages: Array<{ content: string }> };
    expect(body.messages[1].content).toContain("Write a warm launch caption");
    expect((body.messages[1].content.match(/--- Example/g) ?? []).length).toBe(30);
    expect(body.messages[1].content).not.toContain("Example caption 1\n");
  });
});
