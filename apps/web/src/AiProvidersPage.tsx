import { useEffect, useState, type ReactElement, type ReactNode } from "react";

type AnyRecord = Record<string, any>;
const API_BASE = (
  import.meta.env.VITE_API_URL ?? "http://127.0.0.1:3000"
).replace(/\/$/, "");
const API_TOKEN =
  import.meta.env.VITE_INTEGRATION_TOKEN ?? "tokia-local-dev-token";

function preflightMessage(preflight: AnyRecord): string {
  const blocked: string[] = [];
  const transcription = preflight?.transcription;
  const analysis = preflight?.analysis;
  if (!transcription?.ready) {
    blocked.push(
      transcription?.provider
        ? `Transcription provider “${transcription.provider.providerName}” must be connected and support timestamped segments.`
        : "Choose and save a transcription provider.",
    );
  }
  if (!analysis?.ready) {
    blocked.push(
      analysis?.provider
        ? `Text analysis provider “${analysis.provider.providerName}” must be connected and support structured output or JSON mode.`
        : "Choose and save a text analysis provider.",
    );
  }
  return blocked.join(" ");
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.method && init.method !== "GET") {
    headers.set("X-Local-Integration-Token", API_TOKEN);
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      body?.error?.message ?? `Request failed (${response.status})`,
    );
  return body as T;
}
function Button({
  children,
  variant = "secondary",
  onClick,
  disabled = false,
}: {
  children: ReactNode;
  variant?: "primary" | "secondary" | "danger";
  onClick?: () => void;
  disabled?: boolean;
}): ReactElement {
  return (
    <button
      type="button"
      className={`button button-${variant}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export function AiProvidersPage(): ReactElement {
  const [data, setData] = useState<AnyRecord | null>(null);
  const [type, setType] = useState("openai");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [modelName, setModelName] = useState("gpt-4o-mini");
  const [transcriptionModel, setTranscriptionModel] = useState(
    "gpt-4o-mini-transcribe",
  );
  const [apiKey, setApiKey] = useState("");
  const [localModelPath, setLocalModelPath] = useState("");
  const [allowLocal, setAllowLocal] = useState(false);
  const [transcriptionProviderId, setTranscriptionProviderId] = useState("");
  const [analysisProviderId, setAnalysisProviderId] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = async (): Promise<void> => {
    try {
      setData(await api("/api/ai/providers"));
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not load AI providers",
      );
    }
  };
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    const assignments = data?.assignments ?? [];
    setTranscriptionProviderId(
      assignments.find((item: AnyRecord) => item.taskType === "TRANSCRIPTION")
        ?.providerId ?? "",
    );
    setAnalysisProviderId(
      assignments.find((item: AnyRecord) => item.taskType === "TOPIC_DETECTION")
        ?.providerId ?? "",
    );
  }, [data]);
  const add = async (): Promise<void> => {
    setBusyAction("add");
    setError("");
    try {
      const capabilities =
        type === "openai_compatible"
          ? {
              textGeneration: true,
              jsonMode: true,
              structuredOutput: false,
              largeContext: true,
              audioTranscription: false,
              timestampedSegments: false,
              wordTimestamps: false,
            }
          : undefined;
      await api("/api/ai/providers", {
        method: "POST",
        body: JSON.stringify({
          providerType: type,
          displayName:
            name ||
            (type === "openai"
              ? "OpenAI"
              : type === "local_whisper"
                ? "Local Whisper"
                : "OpenAI-compatible provider"),
          baseUrl: type === "local_whisper" ? undefined : baseUrl,
          modelName,
          transcriptionModel,
          apiKey: type === "local_whisper" ? undefined : apiKey,
          modelPath: localModelPath,
          allowLocalBaseUrl: allowLocal,
          capabilities,
        }),
      });
      setName("");
      setApiKey("");
      setNotice("Provider saved. Validate it before assigning a task.");
      await load();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not add provider",
      );
    } finally {
      setBusyAction(null);
    }
  };
  const validate = async (id: string): Promise<void> => {
    setBusyAction(`validate:${id}`);
    setError("");
    try {
      await api(`/api/ai/providers/${id}/validate`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setNotice("Provider validation completed.");
      await load();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Provider validation failed",
      );
      await load();
    } finally {
      setBusyAction(null);
    }
  };
  const assign = async (): Promise<void> => {
    setBusyAction("assign");
    setError("");
    try {
      await api("/api/ai/assignments", {
        method: "PUT",
        body: JSON.stringify({ transcriptionProviderId, analysisProviderId }),
      });
      setNotice("Task assignments saved.");
      await load();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not save task assignments",
      );
    } finally {
      setBusyAction(null);
    }
  };
  const busy = Boolean(busyAction);
  const providers = data?.providers ?? [];
  const remote = type !== "local_whisper";
  return (
    <div className="settings-embedded-page ai-providers-page">
      <div className="panel-heading">
        <div>
          <div className="eyebrow">AI Providers</div>
          <h2>Provider connections</h2>
          <p className="panel-caption">
            Credentials stay on the backend and are encrypted at rest. Clipping
            uses capabilities, not a hard-coded vendor.
          </p>
        </div>
      </div>
      {error && <div className="inline-error">{error}</div>}
      {notice && <div className="inline-note">{notice}</div>}
      <div className="settings-grid">
        <section className="panel settings-section">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">Add connection</div>
              <h3>Connect a provider</h3>
            </div>
          </div>
          <label className="form-field">
            <span>Provider type</span>
            <select
              value={type}
              onChange={(event) => {
                const value = event.target.value;
                setType(value);
                if (value === "openai") {
                  setBaseUrl("https://api.openai.com/v1");
                  setModelName("gpt-4o-mini");
                  setTranscriptionModel("gpt-4o-mini-transcribe");
                }
              }}
            >
              <option value="openai">OpenAI</option>
              <option value="openai_compatible">OpenAI-compatible</option>
              <option value="local_whisper">Local Whisper</option>
            </select>
          </label>
          <label className="form-field">
            <span>Display name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Production analysis"
            />
          </label>
          {remote && (
            <>
              <label className="form-field">
                <span>Base URL</span>
                <input
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder="https://api.example.com/v1"
                />
                <small>
                  Destination:{" "}
                  {(() => {
                    try {
                      return new URL(baseUrl).hostname;
                    } catch {
                      return "invalid URL";
                    }
                  })()}
                </small>
              </label>
              <label className="form-field">
                <span>API key</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="Enter once; never returned"
                />
              </label>
              <div className="form-row">
                <label className="form-field">
                  <span>Text model</span>
                  <input
                    value={modelName}
                    onChange={(event) => setModelName(event.target.value)}
                  />
                </label>
                <label className="form-field">
                  <span>Transcription model</span>
                  <input
                    value={transcriptionModel}
                    onChange={(event) =>
                      setTranscriptionModel(event.target.value)
                    }
                  />
                </label>
              </div>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={allowLocal}
                  onChange={(event) => setAllowLocal(event.target.checked)}
                />
                <span>
                  <strong>Allow local HTTP base URL</strong>
                  <small>Use only for a local compatible endpoint.</small>
                </span>
              </label>
            </>
          )}
          {!remote && (
            <label className="form-field">
              <span>Whisper model path or runtime command</span>
              <input
                value={localModelPath}
                onChange={(event) => setLocalModelPath(event.target.value)}
                placeholder="/models/ggml-base.bin"
              />
              <small>
                GPU is optional. The provider shows unavailable until a
                supported runtime is present.
              </small>
            </label>
          )}
          <Button variant="primary" onClick={() => void add()} disabled={busy}>
            {busyAction === "add" ? "Saving…" : "Add AI provider"}
          </Button>
        </section>
        <section className="panel settings-section">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">Task assignments</div>
              <h3>Choose capability owners</h3>
            </div>
          </div>
          <label className="form-field">
            <span>Transcription provider</span>
            <select
              value={transcriptionProviderId}
              onChange={(event) =>
                setTranscriptionProviderId(event.target.value)
              }
            >
              <option value="">Not assigned</option>
              {providers
                .filter(
                  (item: AnyRecord) =>
                    item.capabilities?.audioTranscription &&
                    item.capabilities?.timestampedSegments,
                )
                .map((item: AnyRecord) => (
                  <option key={item.id} value={item.id}>
                    {item.displayName}
                  </option>
                ))}
            </select>
          </label>
          <label className="form-field">
            <span>Text analysis provider</span>
            <select
              value={analysisProviderId}
              onChange={(event) => setAnalysisProviderId(event.target.value)}
            >
              <option value="">Not assigned</option>
              {providers
                .filter(
                  (item: AnyRecord) =>
                    item.capabilities?.textGeneration &&
                    (item.capabilities?.structuredOutput ||
                      item.capabilities?.jsonMode),
                )
                .map((item: AnyRecord) => (
                  <option key={item.id} value={item.id}>
                    {item.displayName}
                  </option>
                ))}
            </select>
          </label>
          <p className="wizard-help">
            Topic detection and subtopic detection share the text-analysis
            assignment in this first version.
          </p>
          <Button onClick={() => void assign()} disabled={busy}>
            {busyAction === "assign" ? "Saving…" : "Save task assignments"}
          </Button>
          {data?.preflight && (
            <div
              className={data.preflight.ready ? "inline-note" : "inline-error"}
            >
              <strong>
                Clipping preflight: {data.preflight.ready ? "ready" : "blocked"}
              </strong>
              <p>
                {data.preflight.ready
                  ? "Both required capabilities are connected."
                  : preflightMessage(data.preflight)}
              </p>
            </div>
          )}
        </section>
      </div>
      <section className="panel settings-section">
        <div className="panel-heading">
          <div>
            <div className="eyebrow">Provider connections</div>
            <h3>Saved providers</h3>
          </div>
        </div>
        {providers.length ? (
          <div className="provider-list">
            {providers.map((provider: AnyRecord) => (
              <article className="provider-card" key={provider.id}>
                <div className="provider-card-heading">
                  <div>
                    <strong>{provider.displayName}</strong>
                    <span>
                      {provider.providerType.replaceAll("_", " ")}
                      {provider.destinationHost
                        ? ` · ${provider.destinationHost}`
                        : ""}
                    </span>
                  </div>
                  <span className={`status status-${provider.status}`}>
                    {provider.status.replaceAll("_", " ")}
                  </span>
                </div>
                <div className="provider-capabilities">
                  {Object.entries(provider.capabilities ?? {})
                    .filter(([key]) =>
                      [
                        "audioTranscription",
                        "timestampedSegments",
                        "wordTimestamps",
                        "textGeneration",
                        "jsonMode",
                        "structuredOutput",
                        "largeContext",
                      ].includes(key),
                    )
                    .map(([key, value]) => (
                      <span
                        key={key}
                        className={value ? "capability-on" : "capability-off"}
                      >
                        {value ? "✓" : "×"} {key.replaceAll(/([A-Z])/g, " $1")}
                      </span>
                    ))}
                </div>
                <div className="provider-card-footer">
                  <span>
                    {provider.status === "connected"
                      ? "Connection validated"
                      : provider.status === "connection_failed"
                        ? `Last validation failed${provider.lastErrorMessage ? `: ${provider.lastErrorMessage}` : ""}`
                        : provider.hasCredential
                          ? "Credential saved (masked)"
                          : "No remote credential"}
                    {provider.lastValidatedAt
                      ? ` · ${provider.status === "connected" ? "validated" : "checked"} ${new Date(provider.lastValidatedAt).toLocaleString()}`
                      : ""}
                  </span>
                  <Button
                    onClick={() => void validate(provider.id)}
                    disabled={busy || provider.providerType === "local_whisper"}
                  >
                    {busyAction === `validate:${provider.id}`
                      ? "Testing…"
                      : "Test connection"}
                  </Button>
                  <Button
                    variant="danger"
                    onClick={async () => {
                      await api(`/api/ai/providers/${provider.id}`, {
                        method: "DELETE",
                        body: JSON.stringify({}),
                      });
                      await load();
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <h3>No providers configured</h3>
            <p>
              Add OpenAI, an OpenAI-compatible service, or Local Whisper to
              enable clipping.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
