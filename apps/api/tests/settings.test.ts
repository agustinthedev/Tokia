import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { createDatabase } from "../src/db.js";

const token = "settings-test-token";
const extensionId = "abcdefghijklmnopabcdefghijklmnop";

describe("local browser extension settings", () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let db: Database.Database | undefined;

  afterEach(async () => {
    if (app) await app.close();
    if (db?.open) db.close();
    app = undefined;
    db = undefined;
  });

  it("persists the extension ID and enables its CORS origin without restarting", async () => {
    db = createDatabase(":memory:");
    app = await buildApp({
      db,
      settings: {
        ...config,
        localIntegrationToken: token,
        corsAllowedOrigins: ["http://127.0.0.1:5173"],
      },
    });

    const before = await app.inject({ method: "GET", url: "/api/settings" });
    expect(before.json()).toMatchObject({
      browserExtensionConfigured: false,
      browserExtensionId: null,
    });

    const saved = await app.inject({
      method: "PATCH",
      url: "/api/settings/browser-extension",
      headers: { "x-local-integration-token": token },
      payload: { extensionId },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      browserExtensionConfigured: true,
      browserExtensionId: extensionId,
      browserExtensionOrigin: `chrome-extension://${extensionId}`,
    });

    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/api/imports/pinterest-board",
      headers: {
        origin: `chrome-extension://${extensionId}`,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,x-local-integration-token",
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(
      `chrome-extension://${extensionId}`,
    );
  });

  it("rejects malformed IDs and does not expose the integration token", async () => {
    db = createDatabase(":memory:");
    app = await buildApp({
      db,
      settings: { ...config, localIntegrationToken: token },
    });

    const invalid = await app.inject({
      method: "PATCH",
      url: "/api/settings/browser-extension",
      headers: { "x-local-integration-token": token },
      payload: { extensionId: "not-a-browser-extension-id" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe("INVALID_BROWSER_EXTENSION_ID");

    const settings = await app.inject({ method: "GET", url: "/api/settings" });
    expect(settings.json()).not.toHaveProperty("localIntegrationToken");
    expect(settings.json()).not.toHaveProperty("integrationToken");
  });
});
