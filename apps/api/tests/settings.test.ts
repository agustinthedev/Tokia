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

  it("exposes advanced defaults without secrets and validates runtime updates", async () => {
    db = createDatabase(":memory:");
    app = await buildApp({
      db,
      settings: { ...config, localIntegrationToken: token },
    });

    const settings = await app.inject({ method: "GET", url: "/api/settings" });
    expect(settings.json().advanced).toMatchObject({
      host: config.host,
      port: config.port,
      maxPinsPerImport: config.maxPinsPerImport,
    });
    expect(settings.json().advanced).not.toHaveProperty("secretsEncryptionKey");

    const invalid = await app.inject({
      method: "PATCH",
      url: "/api/settings/advanced",
      headers: { "x-local-integration-token": token },
      payload: { port: 70_000 },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe("INVALID_RUNTIME_SETTINGS");
  });

  it("bootstraps the local client and rotates the token without restarting", async () => {
    db = createDatabase(":memory:");
    app = await buildApp({
      db,
      settings: { ...config, localIntegrationToken: token },
    });

    const bootstrap = await app.inject({ method: "GET", url: "/api/settings/bootstrap" });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json().integrationToken).toBe(token);

    const rotated = await app.inject({
      method: "POST",
      url: "/api/settings/integration-token",
      headers: { "x-local-integration-token": token },
    });
    expect(rotated.statusCode).toBe(200);
    const nextToken = rotated.json().integrationToken;
    expect(nextToken).toMatch(/^[a-f0-9]{48}$/);
    expect(nextToken).not.toBe(token);

    const oldTokenRequest = await app.inject({
      method: "PATCH",
      url: "/api/settings/browser-extension",
      headers: { "x-local-integration-token": token },
      payload: { extensionId },
    });
    expect(oldTokenRequest.statusCode).toBe(401);

    const newTokenRequest = await app.inject({
      method: "PATCH",
      url: "/api/settings/browser-extension",
      headers: { "x-local-integration-token": nextToken },
      payload: { extensionId },
    });
    expect(newTokenRequest.statusCode).toBe(200);
  });
});
