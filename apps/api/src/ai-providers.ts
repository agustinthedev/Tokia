import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";

export type ProviderType = "openai" | "openai_compatible" | "local_whisper";
export type AiTask = "TRANSCRIPTION" | "TOPIC_DETECTION" | "SUBTOPIC_DETECTION";
export type ProviderErrorCode =
  | "INVALID_CREDENTIAL"
  | "UNAUTHORIZED"
  | "INSUFFICIENT_PERMISSIONS"
  | "MODEL_NOT_FOUND"
  | "UNSUPPORTED_CAPABILITY"
  | "QUOTA_OR_BILLING_ERROR"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "INVALID_REQUEST"
  | "NETWORK_ERROR"
  | "PROVIDER_UNAVAILABLE"
  | "INVALID_BASE_URL"
  | "LOCAL_MODEL_NOT_FOUND"
  | "LOCAL_RUNTIME_UNAVAILABLE"
  | "INVALID_JSON_RESPONSE"
  | "UNKNOWN_ERROR";

export interface ProviderCapabilities {
  audioTranscription: boolean;
  timestampedSegments: boolean;
  wordTimestamps: boolean;
  textGeneration: boolean;
  jsonMode: boolean;
  structuredOutput: boolean;
  largeContext: boolean;
  localExecution?: boolean;
  maxContextTokens?: number;
}

export interface NormalizedTranscriptWord {
  startMs: number;
  endMs: number;
  text: string;
}
export interface NormalizedTranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
  words: NormalizedTranscriptWord[];
}
export interface NormalizedTranscript {
  text: string;
  language?: string;
  segments: NormalizedTranscriptSegment[];
  words: NormalizedTranscriptWord[];
  wordTimestamps: boolean;
}
export interface ProviderError extends Error {
  code: ProviderErrorCode;
}

const OPENAI_DEFAULT_CAPABILITIES: ProviderCapabilities = {
  audioTranscription: true,
  timestampedSegments: true,
  wordTimestamps: true,
  textGeneration: true,
  jsonMode: true,
  structuredOutput: true,
  largeContext: true,
};
const COMPATIBLE_DEFAULT_CAPABILITIES: ProviderCapabilities = {
  audioTranscription: false,
  timestampedSegments: false,
  wordTimestamps: false,
  textGeneration: true,
  jsonMode: true,
  structuredOutput: false,
  largeContext: false,
};
const LOCAL_DEFAULT_CAPABILITIES: ProviderCapabilities = {
  audioTranscription: true,
  timestampedSegments: true,
  wordTimestamps: false,
  textGeneration: false,
  jsonMode: false,
  structuredOutput: false,
  largeContext: false,
  localExecution: true,
};

type Row = Record<string, any>;
function now(): string {
  return new Date().toISOString();
}
function id(): string {
  return crypto.randomUUID();
}
function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return typeof value === "string"
      ? (JSON.parse(value) as T)
      : ((value as T) ?? fallback);
  } catch {
    return fallback;
  }
}
function bool(value: unknown): boolean {
  return value === true || value === 1 || value === "true";
}
function providerError(
  code: ProviderErrorCode,
  message: string,
): ProviderError {
  const error = new Error(message) as ProviderError;
  error.code = code;
  return error;
}

export function defaultCapabilities(type: ProviderType): ProviderCapabilities {
  if (type === "openai") return { ...OPENAI_DEFAULT_CAPABILITIES };
  if (type === "local_whisper") return { ...LOCAL_DEFAULT_CAPABILITIES };
  return { ...COMPATIBLE_DEFAULT_CAPABILITIES };
}

export function normalizeCapabilities(
  type: ProviderType,
  input: unknown,
): ProviderCapabilities {
  const base = defaultCapabilities(type);
  const source =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  return {
    ...base,
    ...Object.fromEntries(
      Object.keys(base)
        .filter((key) => source[key] !== undefined)
        .map((key) => [key, bool(source[key])]),
    ),
    maxContextTokens: Number.isFinite(Number(source.maxContextTokens))
      ? Number(source.maxContextTokens)
      : base.maxContextTokens,
  } as ProviderCapabilities;
}

export function encryptSecret(
  secret: string,
  masterSecret: string,
): { payload: string; version: number; suffix: string } {
  const key = crypto.createHash("sha256").update(masterSecret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    payload: `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`,
    version: 1,
    suffix: secret.slice(-4),
  };
}

export function decryptSecret(payload: string, masterSecret: string): string {
  const [version, ivText, tagText, dataText] = payload.split(":");
  if (version !== "v1" || !ivText || !tagText || !dataText)
    throw new Error("Unsupported encrypted secret version.");
  const key = crypto.createHash("sha256").update(masterSecret).digest();
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivText, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function safeBaseUrl(
  providerType: ProviderType,
  input: unknown,
  allowLocalBaseUrl = false,
): string {
  const raw =
    typeof input === "string" && input.trim()
      ? input.trim()
      : providerType === "openai"
        ? "https://api.openai.com/v1"
        : "";
  if (!raw)
    throw providerError("INVALID_BASE_URL", "A provider base URL is required.");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw providerError(
      "INVALID_BASE_URL",
      "The provider base URL is invalid.",
    );
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const local = ["localhost", "127.0.0.1", "::1"].includes(hostname);
  const privateIpv4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(
    hostname,
  );
  const localNetwork = local || privateIpv4;
  if (localNetwork && !allowLocalBaseUrl)
    throw providerError(
      "INVALID_BASE_URL",
      "Local and private-network provider URLs require explicit approval.",
    );
  if (
    parsed.protocol !== "https:" &&
    !(allowLocalBaseUrl && parsed.protocol === "http:" && localNetwork)
  )
    throw providerError(
      "INVALID_BASE_URL",
      "Provider URLs must use HTTPS. Local HTTP URLs must be explicitly allowed.",
    );
  if (parsed.username || parsed.password)
    throw providerError(
      "INVALID_BASE_URL",
      "Provider URLs must not include credentials.",
    );
  return `${parsed.toString().replace(/\/$/, "")}`;
}

export function providerInput(
  input: Record<string, unknown>,
  masterSecret: string,
  existing?: Row,
): Row {
  const providerType = (input.providerType ??
    input.type ??
    existing?.provider_type) as ProviderType;
  if (!["openai", "openai_compatible", "local_whisper"].includes(providerType))
    throw providerError("UNKNOWN_ERROR", "Unsupported AI provider type.");
  const displayName = String(input.displayName ?? existing?.display_name ?? "")
    .trim()
    .slice(0, 120);
  if (!displayName)
    throw providerError("UNKNOWN_ERROR", "A display name is required.");
  const existingConfig = parseJson<Record<string, unknown>>(
    existing?.config_json,
    {},
  );
  const allowLocalBaseUrl =
    input.allowLocalBaseUrl === true ||
    existingConfig.allowLocalBaseUrl === true;
  const baseUrl =
    providerType === "local_whisper"
      ? null
      : safeBaseUrl(
          providerType,
          input.baseUrl ?? existing?.base_url,
          allowLocalBaseUrl,
        );
  const config = {
    ...existingConfig,
    ...(input.config && typeof input.config === "object" ? input.config : {}),
  };
  for (const key of [
    "device",
    "computeType",
    "language",
    "whisperCommand",
    "modelPath",
    "allowLocalBaseUrl",
  ])
    if (input[key] !== undefined)
      config[key] =
        typeof input[key] === "string"
          ? String(input[key]).slice(0, 240)
          : Boolean(input[key]);
  for (const key of Object.keys(config))
    if (/(api.?key|secret|token|password|authorization|header)/i.test(key))
      delete config[key];
  const capabilities = normalizeCapabilities(
    providerType,
    input.capabilities ?? parseJson(existing?.capabilities_json, {}),
  );
  const apiKey =
    typeof input.apiKey === "string" && input.apiKey.trim()
      ? input.apiKey.trim()
      : null;
  if (!existing && providerType !== "local_whisper" && !apiKey)
    throw providerError(
      "INVALID_CREDENTIAL",
      "An API key is required for remote providers.",
    );
  const encrypted = apiKey ? encryptSecret(apiKey, masterSecret) : null;
  return {
    id: existing?.id ?? id(),
    providerType,
    displayName,
    baseUrl,
    modelName:
      String(
        input.modelName ??
          existing?.model_name ??
          (providerType === "openai" ? "gpt-4o-mini" : ""),
      )
        .trim()
        .slice(0, 160) || null,
    transcriptionModel:
      String(
        input.transcriptionModel ??
          existing?.transcription_model ??
          (providerType === "openai" ? "whisper-1" : ""),
      )
        .trim()
        .slice(0, 160) || null,
    config,
    capabilities,
    encrypted,
    existing,
  };
}

export function providerSafe(row: Row): Row {
  const capabilities = parseJson<ProviderCapabilities>(
    row.capabilities_json,
    defaultCapabilities(row.provider_type as ProviderType),
  );
  const config = parseJson<Record<string, unknown>>(row.config_json, {});
  const localRuntimeConfigured = Boolean(
    config.modelPath || config.whisperCommand,
  );
  delete config.apiKey;
  delete config.secret;
  delete config.headers;
  delete config.modelPath;
  delete config.whisperCommand;
  for (const key of Object.keys(config))
    if (/(api.?key|secret|token|password|authorization|header)/i.test(key))
      delete config[key];
  return {
    id: row.id,
    displayName: row.display_name,
    providerType: row.provider_type,
    baseUrl: row.base_url,
    destinationHost: row.base_url ? new URL(row.base_url).hostname : null,
    modelName: row.model_name,
    transcriptionModel: row.transcription_model,
    capabilities,
    config,
    localRuntimeConfigured,
    status: row.status,
    hasCredential: Boolean(row.encrypted_secret),
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    lastValidatedAt: row.last_validated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function providerCapabilities(row: Row): ProviderCapabilities {
  return parseJson<ProviderCapabilities>(
    row.capabilities_json,
    defaultCapabilities(row.provider_type as ProviderType),
  );
}

export function capabilityForTask(task: AiTask): keyof ProviderCapabilities {
  if (task === "TRANSCRIPTION") return "audioTranscription";
  return "textGeneration";
}

export function transcriptionModelForClipping(row: Row): string {
  const configured = String(row.transcription_model ?? "").trim();
  if (row.provider_type === "openai" && configured !== "whisper-1")
    return "whisper-1";
  return configured || "whisper-1";
}

export function hasRequiredCapability(row: Row, task: AiTask): boolean {
  if (row.status !== "connected") return false;
  const caps = providerCapabilities(row);
  if (task === "TRANSCRIPTION")
    return Boolean(caps.audioTranscription && caps.timestampedSegments);
  return Boolean(
    caps.textGeneration && (caps.structuredOutput || caps.jsonMode),
  );
}

export function normalizeProviderError(
  error: unknown,
  responseStatus?: number,
): ProviderError {
  const errorCode = (error as ProviderError | undefined)?.code;
  if (typeof errorCode === "string") return error as ProviderError;
  const providerMessage =
    typeof (error as any)?.error?.message === "string"
      ? String((error as any).error.message).replace(/\s+/g, " ").slice(0, 300)
      : undefined;
  if (responseStatus === 400)
    return providerError(
      "INVALID_REQUEST",
      providerMessage
        ? `The provider rejected the request: ${providerMessage}`
        : "The provider rejected the request.",
    );
  if (responseStatus === 401 || responseStatus === 403)
    return providerError(
      responseStatus === 401
        ? "INVALID_CREDENTIAL"
        : "INSUFFICIENT_PERMISSIONS",
      "The provider rejected the saved credentials.",
    );
  if (responseStatus === 404)
    return providerError(
      "MODEL_NOT_FOUND",
      "The configured provider model or endpoint was not found.",
    );
  if (responseStatus === 429)
    return providerError(
      "RATE_LIMITED",
      "The provider rate limit was reached.",
    );
  if (responseStatus && responseStatus >= 500)
    return providerError(
      "PROVIDER_UNAVAILABLE",
      "The provider is temporarily unavailable.",
    );
  if (error instanceof Error && /abort|timeout/i.test(error.message))
    return providerError(
      "TIMEOUT",
      "The provider request timed out. Try again in a moment.",
    );
  if (
    error instanceof TypeError ||
    (error instanceof Error &&
      /fetch|network|timeout|abort/i.test(error.message))
  )
    return providerError("NETWORK_ERROR", "The provider could not be reached.");
  return providerError("UNKNOWN_ERROR", "The provider request failed.");
}

async function providerFetch(
  row: Row,
  masterSecret: string,
  endpoint: string,
  init: RequestInit = {},
  timeoutMs = 45_000,
): Promise<Response> {
  if (!row.base_url)
    throw providerError(
      "INVALID_BASE_URL",
      "The provider base URL is not configured.",
    );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let secret = "";
    if (row.encrypted_secret) {
      try {
        secret = decryptSecret(String(row.encrypted_secret), masterSecret);
      } catch {
        throw providerError(
          "INVALID_CREDENTIAL",
          "The saved provider credential could not be decrypted. Re-enter it.",
        );
      }
    }
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${secret}`);
    if (!headers.has("Content-Type") && !(init.body instanceof FormData))
      headers.set("Content-Type", "application/json");
    const response = await fetch(
      `${String(row.base_url).replace(/\/$/, "")}${endpoint}`,
      { ...init, headers, signal: controller.signal },
    );
    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.clone().json();
      } catch {
        body = undefined;
      }
      throw normalizeProviderError(body, response.status);
    }
    return response;
  } catch (error) {
    throw normalizeProviderError(error);
  } finally {
    clearTimeout(timeout);
  }
}

export async function validateProvider(
  row: Row,
  masterSecret: string,
): Promise<{
  capabilities: ProviderCapabilities;
  code?: ProviderErrorCode;
  message?: string;
}> {
  const configured = providerCapabilities(row);
  try {
    if (row.provider_type === "local_whisper") {
      const config = parseJson<Record<string, unknown>>(row.config_json, {});
      if (!config.modelPath && !config.whisperCommand)
        throw providerError(
          "LOCAL_MODEL_NOT_FOUND",
          "Configure a local Whisper model path or runtime command.",
        );
      throw providerError(
        "LOCAL_RUNTIME_UNAVAILABLE",
        "Local Whisper is configured, but this deployment does not bundle a supported runtime adapter.",
      );
    }
    await providerFetch(row, masterSecret, "/models", { method: "GET" }, 30_000);
    return { capabilities: configured };
  } catch (error) {
    const safe = normalizeProviderError(error);
    return { capabilities: configured, code: safe.code, message: safe.message };
  }
}

function milliseconds(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? Math.max(0, Math.round(numeric < 100_000 ? numeric * 1000 : numeric))
    : 0;
}

export function normalizeTranscript(raw: any): NormalizedTranscript {
  const sourceSegments = Array.isArray(raw?.segments) ? raw.segments : [];
  const segments: NormalizedTranscriptSegment[] = sourceSegments
    .map((segment: any) => {
      const words = (Array.isArray(segment.words) ? segment.words : [])
        .map((word: any) => ({
          startMs: milliseconds(word.start ?? word.start_time),
          endMs: Math.max(
            milliseconds(word.end ?? word.end_time),
            milliseconds(word.start ?? word.start_time) + 40,
          ),
          text: String(word.word ?? word.text ?? "").trim(),
        }))
        .filter((word: NormalizedTranscriptWord) => word.text);
      const startMs = milliseconds(segment.start ?? segment.start_time);
      const endMs = Math.max(
        milliseconds(segment.end ?? segment.end_time),
        startMs + 40,
      );
      return { startMs, endMs, text: String(segment.text ?? "").trim(), words };
    })
    .filter(
      (segment: NormalizedTranscriptSegment) =>
        segment.text || segment.words.length,
    );
  const words = segments.flatMap((segment) => segment.words);
  const text = String(
    raw?.text ??
      segments
        .map((segment) => segment.text)
        .filter(Boolean)
        .join(" "),
  ).trim();
  return {
    text,
    language: typeof raw?.language === "string" ? raw.language : undefined,
    segments,
    words,
    wordTimestamps: words.length > 0,
  };
}

export async function transcribe(
  row: Row,
  masterSecret: string,
  audioPath: string,
): Promise<NormalizedTranscript> {
  const caps = providerCapabilities(row);
  if (!caps.audioTranscription || !caps.timestampedSegments)
    throw providerError(
      "UNSUPPORTED_CAPABILITY",
      "The assigned transcription provider does not support timestamped transcription.",
    );
  if (row.provider_type === "local_whisper")
    throw providerError(
      "LOCAL_RUNTIME_UNAVAILABLE",
      "Local Whisper is configured but no executable transcription runtime is available in this deployment.",
    );
  const audio = await fs.readFile(audioPath);
  const form = new FormData();
  form.append(
    "file",
    new Blob([audio as unknown as BlobPart]),
    path.basename(audioPath),
  );
  form.append("model", transcriptionModelForClipping(row));
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  if (caps.wordTimestamps) form.append("timestamp_granularities[]", "word");
  const response = await providerFetch(
    row,
    masterSecret,
    "/audio/transcriptions",
    { method: "POST", body: form },
  );
  let json: any;
  try {
    json = await response.json();
  } catch {
    throw providerError(
      "INVALID_JSON_RESPONSE",
      "The transcription provider returned an invalid response.",
    );
  }
  return normalizeTranscript(json);
}

export async function structuredAnalysis<T>(
  row: Row,
  masterSecret: string,
  request: { system: string; user: string; schemaName: string },
): Promise<T> {
  const caps = providerCapabilities(row);
  if (!caps.textGeneration || (!caps.structuredOutput && !caps.jsonMode))
    throw providerError(
      "UNSUPPORTED_CAPABILITY",
      "The assigned analysis provider does not support validated structured output.",
    );
  const body: Record<string, unknown> = {
    model: row.model_name,
    temperature: 0.1,
    messages: [
      { role: "system", content: request.system },
      { role: "user", content: request.user },
    ],
  };
  if (caps.jsonMode) body.response_format = { type: "json_object" };
  const response = await providerFetch(row, masterSecret, "/chat/completions", {
    method: "POST",
    body: JSON.stringify(body),
  });
  let json: any;
  try {
    json = await response.json();
  } catch {
    throw providerError(
      "INVALID_JSON_RESPONSE",
      "The analysis provider returned an invalid response.",
    );
  }
  const content = json?.choices?.[0]?.message?.content;
  let parsed: unknown;
  try {
    parsed = typeof content === "string" ? JSON.parse(content) : content;
  } catch {
    throw providerError(
      "INVALID_JSON_RESPONSE",
      "The analysis provider returned malformed JSON.",
    );
  }
  if (!parsed || typeof parsed !== "object")
    throw providerError(
      "INVALID_JSON_RESPONSE",
      "The analysis provider returned an invalid structured result.",
    );
  return parsed as T;
}

export function assignmentSnapshot(
  db: Database.Database,
  ownerScope = "local",
): Row[] {
  return (
    db
      .prepare(
        `SELECT a.task_type, a.provider_connection_id, p.provider_type, p.display_name, p.status, p.capabilities_json FROM ai_task_assignments a JOIN ai_provider_connections p ON p.id = a.provider_connection_id WHERE a.owner_scope = ? ORDER BY a.task_type`,
      )
      .all(ownerScope) as Row[]
  ).map((row) => ({
    taskType: row.task_type,
    providerId: row.provider_connection_id,
    providerName: row.display_name,
    providerType: row.provider_type,
    status: row.status,
    capabilities: providerCapabilities(row),
  }));
}

export function preflight(db: Database.Database, ownerScope = "local"): Row {
  const assignments = assignmentSnapshot(db, ownerScope);
  const transcription = assignments.find(
    (item) => item.taskType === "TRANSCRIPTION",
  );
  const analysis = assignments.find(
    (item) => item.taskType === "TOPIC_DETECTION",
  );
  const transcriptionReady = Boolean(
    transcription &&
      transcription.status === "connected" &&
      transcription.capabilities.audioTranscription &&
      transcription.capabilities.timestampedSegments,
  );
  const analysisReady = Boolean(
    analysis &&
      analysis.status === "connected" &&
      analysis.capabilities.textGeneration &&
      (analysis.capabilities.structuredOutput ||
        analysis.capabilities.jsonMode),
  );
  return {
    ready: transcriptionReady && analysisReady,
    transcription: {
      ready: transcriptionReady,
      provider: transcription ?? null,
      required: ["audioTranscription", "timestampedSegments"],
    },
    analysis: {
      ready: analysisReady,
      provider: analysis ?? null,
      required: ["textGeneration", "structuredOutput or jsonMode"],
    },
    action:
      transcriptionReady && analysisReady ? null : "CONFIGURE_AI_PROVIDERS",
  };
}

export function insertProvider(
  db: Database.Database,
  input: Row,
  masterSecret: string,
  existing?: Row,
): Row {
  const value = providerInput(input, masterSecret, existing);
  const timestamp = now();
  const secret =
    value.encrypted ??
    (existing
      ? {
          payload: existing.encrypted_secret,
          version: existing.encryption_version,
          suffix: existing.secret_suffix,
        }
      : null);
  db.prepare(
    `INSERT INTO ai_provider_connections(id, owner_scope, provider_type, display_name, base_url, model_name, transcription_model, config_json, capabilities_json, encrypted_secret, encryption_version, secret_suffix, status, created_at, updated_at)
    VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET provider_type = excluded.provider_type, display_name = excluded.display_name, base_url = excluded.base_url, model_name = excluded.model_name, transcription_model = excluded.transcription_model, config_json = excluded.config_json, capabilities_json = excluded.capabilities_json, encrypted_secret = excluded.encrypted_secret, encryption_version = excluded.encryption_version, secret_suffix = excluded.secret_suffix, status = CASE WHEN ai_provider_connections.status = 'disabled' THEN 'disabled' ELSE 'configured' END, updated_at = excluded.updated_at`,
  ).run(
    value.id,
    value.providerType,
    value.displayName,
    value.baseUrl,
    value.modelName,
    value.transcriptionModel,
    JSON.stringify(value.config),
    JSON.stringify(value.capabilities),
    secret?.payload ?? null,
    secret?.version ?? null,
    secret?.suffix ?? null,
    existing?.status ?? "configured",
    existing?.created_at ?? timestamp,
    timestamp,
  );
  return db
    .prepare("SELECT * FROM ai_provider_connections WHERE id = ?")
    .get(value.id) as Row;
}

export function markProviderValidation(
  db: Database.Database,
  providerId: string,
  result: {
    capabilities: ProviderCapabilities;
    code?: ProviderErrorCode;
    message?: string;
  },
): Row {
  const timestamp = now();
  db.prepare(
    "UPDATE ai_provider_connections SET capabilities_json = ?, status = ?, last_error_code = ?, last_error_message = ?, last_validated_at = ?, updated_at = ? WHERE id = ?",
  ).run(
    JSON.stringify(result.capabilities),
    result.code ? "connection_failed" : "connected",
    result.code ?? null,
    result.code ? result.message : null,
    timestamp,
    timestamp,
    providerId,
  );
  return db
    .prepare("SELECT * FROM ai_provider_connections WHERE id = ?")
    .get(providerId) as Row;
}

export function touchRequest(
  db: Database.Database,
  providerId: string,
  taskType: string,
  status: string,
  metadata: Partial<Row> = {},
): void {
  db.prepare(
    `INSERT INTO ai_provider_requests(id, provider_connection_id, provider_type, task_type, model_name, input_tokens, output_tokens, audio_duration_ms, estimated_cost, provider_request_id, latency_ms, retry_count, status, error_code, created_at) VALUES (?, ?, (SELECT provider_type FROM ai_provider_connections WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id(),
    providerId,
    providerId,
    taskType,
    metadata.modelName ?? null,
    metadata.inputTokens ?? null,
    metadata.outputTokens ?? null,
    metadata.audioDurationMs ?? null,
    metadata.estimatedCost ?? null,
    metadata.providerRequestId ?? null,
    metadata.latencyMs ?? null,
    metadata.retryCount ?? 0,
    status,
    metadata.errorCode ?? null,
    now(),
  );
}
