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

  it("soft-deletes a folder while preserving its captions", async () => {
    await setup();
    const folder = await createFolder("To delete");
    const otherFolder = await createFolder("Keep this folder");
    await createCaption(folder.id, "This caption should be deleted too");

    const deleted = await app!.inject({
      method: "DELETE",
      url: `/api/caption-folders/${folder.id}`,
      headers,
    });
    expect(deleted.statusCode).toBe(204);

    const folderAfterDelete = await app!.inject({
      method: "GET",
      url: `/api/caption-folders/${folder.id}`,
    });
    expect(folderAfterDelete.statusCode).toBe(404);

    const captionsAfterDelete = await app!.inject({
      method: "GET",
      url: `/api/caption-folders/${folder.id}/captions`,
    });
    expect(captionsAfterDelete.statusCode).toBe(404);

    const folders = await app!.inject({ method: "GET", url: "/api/caption-folders" });
    expect(folders.json().items).toEqual([
      expect.objectContaining({ id: otherFolder.id, title: "Keep this folder" }),
    ]);

    const preservedFolder = db!.prepare("SELECT archived_at FROM caption_folders WHERE id = ?").get(folder.id) as { archived_at: string | null };
    expect(preservedFolder.archived_at).toEqual(expect.any(String));
    const preservedCaptions = db!.prepare("SELECT body FROM captions WHERE folder_id = ?").all(folder.id) as Array<{ body: string }>;
    expect(preservedCaptions).toEqual([{ body: "This caption should be deleted too" }]);

    const missingDelete = await app!.inject({
      method: "DELETE",
      url: `/api/caption-folders/${folder.id}`,
      headers,
    });
    expect(missingDelete.statusCode).toBe(404);
  });

  it("includes active caption folders and captions in global search while excluding archived folders", async () => {
    await setup();
    const activeFolder = await createFolder("Launch ideas");
    await createCaption(activeFolder.id, "A launch caption for the global search");
    const archivedFolder = await createFolder("Archived launch ideas");
    await createCaption(archivedFolder.id, "An archived launch caption");

    const archived = await app!.inject({
      method: "DELETE",
      url: `/api/caption-folders/${archivedFolder.id}`,
      headers,
    });
    expect(archived.statusCode).toBe(204);

    const search = await app!.inject({ method: "GET", url: "/api/search?q=launch" });
    expect(search.statusCode).toBe(200);
    expect(search.json().captionFolders).toEqual([
      expect.objectContaining({ id: activeFolder.id, title: "Launch ideas", captionCount: 1 }),
    ]);
    expect(search.json().captions).toEqual([
      expect.objectContaining({
        folderId: activeFolder.id,
        body: "A launch caption for the global search",
      }),
    ]);
    expect(search.json().captionFolders).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: archivedFolder.id })]),
    );
    expect(search.json().captions).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ folderId: archivedFolder.id })]),
    );

    const emptySearch = await app!.inject({ method: "GET", url: "/api/search" });
    expect(emptySearch.json()).toMatchObject({
      query: "",
      captionFolders: [],
      captions: [],
    });
  });

  it("validates caption input and persists edits", async () => {
    await setup();
    const folder = await createFolder();
    const updatedFolder = await app!.inject({
      method: "PATCH",
      url: `/api/caption-folders/${folder.id}`,
      headers,
      payload: { title: "Updated ideas", subtitle: "A new description", color: "#16a34a" },
    });
    expect(updatedFolder.statusCode).toBe(200);
    expect(updatedFolder.json()).toMatchObject({
      id: folder.id,
      title: "Updated ideas",
      subtitle: "A new description",
      color: "#16a34a",
    });

    const folderAfterReload = await app!.inject({
      method: "GET",
      url: `/api/caption-folders/${folder.id}`,
    });
    expect(folderAfterReload.statusCode).toBe(200);
    expect(folderAfterReload.json()).toMatchObject({
      title: "Updated ideas",
      subtitle: "A new description",
      color: "#16a34a",
    });

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
