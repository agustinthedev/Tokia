import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  hasRequiredCapability,
  insertProvider,
  normalizeProviderError,
  providerSafe,
} from "../src/ai-providers.js";

describe("AI provider security and capability model", () => {
  it("encrypts credentials and never exposes the plaintext", () => {
    const encrypted = encryptSecret(
      "sk-test-secret-1234",
      "test-master-secret",
    );
    expect(encrypted.payload).not.toContain("sk-test-secret-1234");
    expect(decryptSecret(encrypted.payload, "test-master-secret")).toBe(
      "sk-test-secret-1234",
    );
    expect(encrypted.suffix).toBe("1234");
  });

  it("stores provider credentials encrypted and matches clipping capabilities", () => {
    const db = new Database(":memory:");
    db.exec(
      `CREATE TABLE ai_provider_connections (id TEXT PRIMARY KEY, owner_scope TEXT, provider_type TEXT, display_name TEXT, base_url TEXT, model_name TEXT, transcription_model TEXT, config_json TEXT, capabilities_json TEXT, encrypted_secret TEXT, encryption_version INTEGER, secret_suffix TEXT, status TEXT, last_error_code TEXT, last_error_message TEXT, last_validated_at TEXT, created_at TEXT, updated_at TEXT)`,
    );
    const row = insertProvider(
      db,
      {
        providerType: "openai",
        displayName: "Test OpenAI",
        apiKey: "sk-test-secret-1234",
        baseUrl: "https://api.openai.com/v1",
        modelName: "gpt-test",
        transcriptionModel: "whisper-test",
        config: { apiKey: "should-not-be-persisted", device: "cpu" },
      },
      "test-master-secret",
    );
    expect(row.encrypted_secret).not.toContain("sk-test-secret-1234");
    expect(String(row.config_json)).not.toContain("should-not-be-persisted");
    expect(providerSafe(row)).not.toHaveProperty("apiKey");
    expect(providerSafe(row).hasCredential).toBe(true);
    expect(
      hasRequiredCapability({ ...row, status: "connected" }, "TRANSCRIPTION"),
    ).toBe(true);
    expect(
      hasRequiredCapability({ ...row, status: "connected" }, "TOPIC_DETECTION"),
    ).toBe(true);
    db.close();
  });

  it("normalizes aborted provider requests as timeouts", () => {
    const aborted = Object.assign(new Error("This operation was aborted"), {
      code: 20,
    });
    expect(normalizeProviderError(aborted)).toMatchObject({
      code: "TIMEOUT",
      message: "The provider request timed out. Try again in a moment.",
    });
  });
});
