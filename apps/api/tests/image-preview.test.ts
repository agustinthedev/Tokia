import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { createDatabase } from "../src/db.js";
import type Database from "better-sqlite3";

const conversion = vi.hoisted(() => ({
  convertHeicToJpeg: vi.fn(async () => Buffer.from("jpeg-pixels")),
}));
vi.mock("../src/image-conversion.js", () => conversion);

const token = "image-preview-test-token";

describe("Pinterest image previews", () => {
  let db: Database.Database | undefined;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;

  afterEach(async () => {
    vi.unstubAllGlobals();
    conversion.convertHeicToJpeg.mockClear();
    if (app) await app.close();
    if (db?.open) db.close();
    app = undefined;
    db = undefined;
  });

  it("converts HEIC sources into a browser-compatible JPEG response", async () => {
    db = createDatabase(":memory:");
    app = await buildApp({ db, settings: { ...config, localIntegrationToken: token } });
    const imported = await app.inject({
      method: "POST",
      url: "/api/imports/pinterest-board",
      headers: { "x-local-integration-token": token },
      payload: {
        schemaVersion: 1,
        source: "pinterest-browser-extension",
        exportedAt: new Date().toISOString(),
        board: { name: "HEIC board", url: "https://www.pinterest.com/demo/heic/" },
        pins: [{
          externalId: "heic-1",
          pinUrl: "https://www.pinterest.com/pin/heic-1/",
          imageUrl: "https://i.pinimg.com/originals/aa/bb/cc/startup.heic",
          mediaType: "image",
          width: 736,
          height: 979,
        }],
      },
    });
    expect(imported.statusCode).toBe(200);
    const assetId = (db.prepare("SELECT id FROM assets WHERE external_asset_id = ?").get("heic-1") as { id: string }).id;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(Buffer.from("heic-source"), { status: 200, headers: { "content-type": "image/heic" } })));

    const preview = await app.inject({ method: "GET", url: `/api/assets/${assetId}/image` });

    expect(preview.statusCode).toBe(200);
    expect(preview.headers["content-type"]).toBe("image/jpeg");
    expect(preview.body).toBe("jpeg-pixels");
    expect(conversion.convertHeicToJpeg).toHaveBeenCalledOnce();
  });
});
