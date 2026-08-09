import {
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { API_BASE, apiRequest } from "./api-client";
import "./clipping.css";

type AnyRecord = Record<string, any>;
interface Project {
  id: string;
  name: string;
  defaultLanguage?: string;
}
interface Props {
  project: Project;
  existingId?: string;
  onClose: () => void;
  onSaved: () => void;
}
const defaultSettings = {
  subtitles: true,
  subtitlePreset: "highlight",
  subtitleFont: "Arial",
  overlayText: "",
  overlayPosition: "top",
  branding: false,
  brandText: "",
  mirror: false,
  removeSilence: false,
  silenceLevel: "balanced",
  normalizeAudio: true,
  aspectRatio: "9:16",
  quality: "standard",
  subtitleWordsPerLine: 5,
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (
    init?.body &&
    !(init.body instanceof Blob) &&
    !(init.body instanceof FormData)
  )
    headers.set("Content-Type", "application/json");
  return apiRequest<T>(path, { ...init, headers });
}

function ms(value: number | undefined): string {
  if (!Number.isFinite(value)) return "—";
  const seconds = Math.round(Number(value) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
function statusLabel(value?: string): string {
  return String(value ?? "not started").replaceAll("_", " ");
}
function processingStageLabel(value?: string): string {
  const labels: Record<string, string> = {
    uploaded: "Ready to process",
    audio_extraction: "Extracting audio",
    audio_extracted: "Ready to transcribe",
    transcribing: "Transcribing",
    detecting_topics: "Analyzing topics",
    detecting_subtopics: "Finding clip candidates",
    ready: "Ready",
    failed: "Processing failed",
  };
  return labels[String(value ?? "")] ?? statusLabel(value);
}

export function ClippingWizard({
  project,
  existingId,
  onClose,
  onSaved,
}: Props): ReactElement {
  const [contentId, setContentId] = useState(existingId);
  const [state, setState] = useState<AnyRecord | null>(null);
  const [preflight, setPreflight] = useState<AnyRecord | null>(null);
  const [step, setStep] = useState(existingId ? 2 : 1);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [currentClip, setCurrentClip] = useState<string | null>(null);
  const [previewCandidate, setPreviewCandidate] = useState<AnyRecord | null>(
    null,
  );
  const [settings, setSettings] = useState<AnyRecord>(defaultSettings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const refresh = async (id = contentId): Promise<AnyRecord | null> => {
    if (!id) return null;
    const value = await api<AnyRecord>(`/api/content/${id}/clipping`);
    setState(value);
    return value;
  };
  useEffect(() => {
    void api<AnyRecord>("/api/ai/preflight")
      .then(setPreflight)
      .catch((caught) =>
        setError(
          caught instanceof Error
            ? caught.message
            : "Could not read AI provider status",
        ),
      );
    if (existingId)
      void refresh(existingId)
        .then((value) => {
          const persistedStep = Number(value?.source?.wizardStep);
          if (Number.isInteger(persistedStep) && persistedStep >= 1 && persistedStep <= 7)
            setStep(persistedStep);
          if (value?.source?.title) setTitle(String(value.source.title));
          if (value?.source?.notes) setNotes(String(value.source.notes));
        })
        .catch((caught) =>
          setError(
            caught instanceof Error
              ? caught.message
              : "Could not load clipping draft",
          ),
        );
  }, [existingId]);
  useEffect(() => {
    if (!contentId) return;
    const active =
      state?.jobs?.some((job: AnyRecord) =>
        ["queued", "running"].includes(job.status),
      ) || ["processing", "uploaded"].includes(state?.source?.status);
    if (!active) return;
    const timer = window.setInterval(() => {
      void refresh().catch(() => undefined);
    }, 900);
    return () => window.clearInterval(timer);
  }, [
    contentId,
    state?.source?.status,
    state?.jobs?.map((job: AnyRecord) => `${job.id}:${job.status}`).join(","),
  ]);
  const selected = useMemo(
    () => (state?.selections ?? []).filter((item: AnyRecord) => item.selected),
    [state],
  );
  const current =
    (state?.selections ?? []).find(
      (item: AnyRecord) => item.subtopicId === currentClip,
    ) ?? selected[0];
  useEffect(() => {
    if (!current) return;
    setCurrentClip((value) => value ?? current.subtopicId);
    setSettings(current.settings ?? defaultSettings);
  }, [current?.subtopicId, current?.settings?.fingerprint]);
  const ensureDraft = async (): Promise<string> => {
    if (contentId) return contentId;
    const draft = await api<AnyRecord>(`/api/projects/${project.id}/content`, {
      method: "POST",
      body: JSON.stringify({
        type: "video_clipping",
        title: title.trim() || null,
        language: project.defaultLanguage ?? "English",
        configuration: { clipping: { version: 1 } },
      }),
    });
    setContentId(draft.id);
    await refresh(draft.id);
    return draft.id;
  };
  const persistStep = async (next: number): Promise<void> => {
    setStep(next);
    if (contentId)
      await api<AnyRecord>(`/api/content/${contentId}/clipping/wizard-step`, {
        method: "PATCH",
        body: JSON.stringify({ step: next }),
      }).then((value) => setState(value));
  };
  const upload = async (): Promise<void> => {
    if (!file) {
      setError("Choose a video file first.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const id = await ensureDraft();
      const uploaded = await api<AnyRecord>(
        `/api/content/${id}/clipping/source?filename=${encodeURIComponent(file.name)}&title=${encodeURIComponent(title)}&notes=${encodeURIComponent(notes)}`,
        {
          method: "POST",
          body: file,
          headers: { "Content-Type": file.type || "application/octet-stream" },
        },
      );
      setState(uploaded.clipping);
      setNotice("Source uploaded and inspected.");
      await persistStep(3);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not upload the source video",
      );
    } finally {
      setBusy(false);
    }
  };
  const analyze = async (): Promise<void> => {
    if (!contentId) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<AnyRecord>(
        `/api/content/${contentId}/clipping/analyze`,
        { method: "POST", body: JSON.stringify({}) },
      );
      setState(result.clipping);
      setNotice(
        "Processing queued. This wizard will update as each stage completes.",
      );
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not start processing",
      );
    } finally {
      setBusy(false);
    }
  };
  const selectTopic = async (
    topicId: string,
    value: boolean,
  ): Promise<void> => {
    if (!contentId) return;
    setState(
      await api(
        `/api/content/${contentId}/clipping/topics/${topicId}/selection`,
        { method: "POST", body: JSON.stringify({ selected: value }) },
      ),
    );
  };
  const selectSubtopic = async (
    subtopicId: string,
    value: boolean,
  ): Promise<void> => {
    if (!contentId) return;
    setState(
      await api(
        `/api/content/${contentId}/clipping/subtopics/${subtopicId}/selection`,
        { method: "POST", body: JSON.stringify({ selected: value }) },
      ),
    );
  };
  const saveSettings = async (): Promise<void> => {
    if (!contentId || !current) return;
    setBusy(true);
    try {
      setState(
        await api(
          `/api/content/${contentId}/clipping/selections/${current.subtopicId}/settings`,
          { method: "PATCH", body: JSON.stringify(settings) },
        ),
      );
      setNotice("Clip settings saved.");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not save clip settings",
      );
    } finally {
      setBusy(false);
    }
  };
  const applyAll = async (): Promise<void> => {
    if (!contentId || !current) return;
    setBusy(true);
    try {
      setState(
        await api(
          `/api/content/${contentId}/clipping/selections/${current.subtopicId}/apply-to-all`,
          { method: "POST", body: JSON.stringify({}) },
        ),
      );
      setNotice("Settings applied to all selected clips.");
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not apply settings",
      );
    } finally {
      setBusy(false);
    }
  };
  const render = async (): Promise<void> => {
    if (!contentId) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<AnyRecord>(
        `/api/content/${contentId}/clipping/render`,
        { method: "POST", body: JSON.stringify({}) },
      );
      setState(result.clipping);
      setNotice(`Render batch ${result.batchId} queued.`);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not queue rendering",
      );
    } finally {
      setBusy(false);
    }
  };
  const openSettings = (): void => {
    window.open("/settings?tab=ai-providers", "_blank", "noopener,noreferrer");
  };
  const close = (): void => {
    if (contentId) onSaved();
    onClose();
  };
  const topics = state?.topics ?? [];
  const processing =
    state?.source?.status === "processing" ||
    state?.jobs?.some((job: AnyRecord) =>
      ["queued", "running"].includes(job.status),
    );
  const latestBatch = state?.batches?.[0];
  return (
    <div className="modal-backdrop">
      <section className="modal modal-wide clipping-modal">
        <header className="modal-header">
          <div>
            <div className="eyebrow">Long-form video</div>
            <h2>{existingId ? "Continue clipping" : "Create clipping"}</h2>
          </div>
          <button className="close-button" onClick={close} aria-label="Close">
            ×
          </button>
        </header>
        <div className="wizard-progress" aria-label="Clipping steps">
          {[
            "Type",
            "Source video",
            "Processing",
            "Topics & clips",
            "Configure clips",
            "Render",
            "Export",
          ].map((label, index) => (
            <button
              type="button"
              key={label}
              className={
                step === index + 1
                  ? "active"
                  : step > index + 1
                    ? "complete"
                    : ""
              }
              onClick={() => index + 1 < step && void persistStep(index + 1)}
            >
              <span>{index + 1}</span>
              {label}
            </button>
          ))}
        </div>
        {step === 1 && (
          <div className="clip-step">
            <div className="wizard-step">
              <span className="step-number">1</span>
              <div>
                <div className="eyebrow">Content type</div>
                <h3>Clip a long-form spoken video</h3>
              </div>
            </div>
            <div className="clipping-type-hero">
              <span className="type-icon">▶</span>
              <div>
                <strong>Clipping</strong>
                <p>
                  Turn a podcast, interview, webinar, course, or talk into
                  short-form clips with transcript-based subtitles.
                </p>
              </div>
            </div>
            {preflight && !preflight.ready && (
              <div className="inline-error">
                <strong>AI providers need attention.</strong>
                <p>
                  Clipping requires a connected transcription provider with
                  timestamped segments and a connected text-analysis provider
                  with validated JSON output.
                </p>
                <Button onClick={openSettings}>Configure AI providers</Button>
              </div>
            )}
            {preflight?.ready && (
              <div className="inline-note">
                AI preflight passed. Your configured providers are ready for
                transcription and structured analysis.
              </div>
            )}
            <div className="modal-footer">
              <Button onClick={close}>Close</Button>
              <Button
                variant="primary"
                disabled={!preflight?.ready}
                onClick={() => void persistStep(2)}
              >
                Continue
              </Button>
            </div>
          </div>
        )}
        {step === 2 && (
          <div className="clip-step">
            <div className="wizard-step">
              <span className="step-number">2</span>
              <div>
                <div className="eyebrow">Source video</div>
                <h3>Upload one long-form video</h3>
              </div>
            </div>
            <label className="form-field">
              <span>
                Source title <small>Optional</small>
              </span>
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="e.g. The future of creative work"
              />
            </label>
            <label className="form-field">
              <span>
                Context or notes <small>Optional</small>
              </span>
              <textarea
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                rows={3}
                placeholder="Help the analysis understand names, themes, or intended audience."
              />
            </label>
            <label className="upload-dropzone">
              <input
                type="file"
                accept="video/*"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
              <span className="type-icon">↥</span>
              <strong>{file?.name ?? "Choose a video file"}</strong>
              <small>
                {file
                  ? `${(file.size / 1024 / 1024).toFixed(1)} MB`
                  : "MP4, MOV, WebM, or another FFmpeg-readable format"}
              </small>
            </label>
            <p className="wizard-help">
              Choosing a file only selects it locally. The upload starts when
              you click “Upload and continue”.
            </p>
            {state?.source && (
              <div className="inline-note">
                {state.source.originalFilename} · {ms(state.source.durationMs)}{" "}
                · {state.source.width ?? "—"} × {state.source.height ?? "—"}
              </div>
            )}
            {error && <div className="inline-error">{error}</div>}
            <div className="modal-footer">
              <Button onClick={() => void persistStep(1)}>Back</Button>
              <Button
                variant="primary"
                disabled={busy || (!file && !state?.source)}
                onClick={() => (file ? void upload() : void persistStep(3))}
              >
                {busy
                  ? "Uploading…"
                  : state?.source
                    ? "Continue"
                    : "Upload and continue"}
              </Button>
            </div>
          </div>
        )}
        {step === 3 && (
          <div className="clip-step">
            <div className="wizard-step">
              <span className="step-number">3</span>
              <div>
                <div className="eyebrow">Progressive processing</div>
                <h3>Extract, transcribe, and understand the video</h3>
              </div>
            </div>
            <div className="processing-card">
              <div>
                <strong>{processingStageLabel(state?.source?.processingStage)}</strong>
                <span>{state?.source?.processingProgress ?? 0}% complete</span>
              </div>
              <div className="progress-track">
                <span
                  style={{
                    width: `${state?.source?.processingProgress ?? 0}%`,
                  }}
                />
              </div>
              {state?.jobs?.slice(0, 5).map((job: AnyRecord) => (
                <div className="job-row" key={job.id}>
                  <span>{statusLabel(job.jobType)}</span>
                  <Status value={job.status} />
                </div>
              ))}
            </div>
            {state?.source?.status === "uploaded" && (
              <div className="inline-note">
                Video uploaded and inspected. Click “Start processing” to
                extract audio, transcribe it, and find topics.
              </div>
            )}
            {processing && state?.source?.processingStage === "transcribing" && (
              <div className="inline-note">
                Transcription can take a few minutes for longer videos.
              </div>
            )}
            {state?.source?.errorMessage && (
              <div className="inline-error">
                <strong>Processing failed.</strong>
                <p>{state.source.errorMessage}</p>
                {state.source.errorCode && (
                  <small>Error code: {state.source.errorCode}</small>
                )}
              </div>
            )}
            <div className="modal-footer">
              <Button onClick={() => void persistStep(2)}>Back</Button>
              {state?.source?.status === "ready" ? (
                <Button variant="primary" onClick={() => void persistStep(4)}>
                  Review topics
                </Button>
              ) : (
                <Button
                  variant="primary"
                  disabled={busy || processing || !state?.source}
                  onClick={() => void analyze()}
                >
                  {processing
                    ? "Processing…"
                    : state?.source?.status === "failed"
                      ? "Retry processing"
                      : "Start processing"}
                </Button>
              )}
            </div>
          </div>
        )}
        {step === 4 && (
          <div className="clip-step">
            <div className="wizard-step">
              <span className="step-number">4</span>
              <div>
                <div className="eyebrow">Topics and clip candidates</div>
                <h3>Select the moments worth publishing</h3>
              </div>
              <span className="selection-label">
                {selected.length} selected
              </span>
            </div>
            {!topics.length ? (
              <div className="preview-empty">
                <p>Topics will appear after processing completes.</p>
                <Button onClick={() => void refresh()}>Refresh status</Button>
              </div>
            ) : (
              <div className="topic-tree">
                {topics.map((topic: AnyRecord) => (
                  <div className="topic-card" key={topic.id}>
                    <div className="topic-heading">
                      <label>
                        <input
                          type="checkbox"
                          checked={topic.selectionState === "selected"}
                          onChange={(event) =>
                            void selectTopic(topic.id, event.target.checked)
                          }
                        />
                        <strong>{topic.title}</strong>
                      </label>
                      <span
                        className={`selection-state ${topic.selectionState}`}
                      >
                        {topic.selectionState}
                      </span>
                      <small>
                        {ms(topic.startMs)}–{ms(topic.endMs)}
                      </small>
                    </div>
                    {topic.summary && <p>{topic.summary}</p>}
                    <div className="subtopic-list">
                      {topic.subtopics.map((subtopic: AnyRecord) => (
                        <div className="subtopic-row" key={subtopic.id}>
                          <label>
                            <input
                              type="checkbox"
                              checked={subtopic.selected}
                              onChange={(event) =>
                                void selectSubtopic(
                                  subtopic.id,
                                  event.target.checked,
                                )
                              }
                            />
                            <span>
                              <strong>{subtopic.title}</strong>
                              <small>
                                {ms(subtopic.startMs)}–{ms(subtopic.endMs)}
                                {subtopic.summary
                                  ? ` · ${subtopic.summary}`
                                  : ""}
                              </small>
                            </span>
                          </label>
                          <button
                            type="button"
                            className="subtopic-preview-button"
                            onClick={() => setPreviewCandidate(subtopic)}
                          >
                            Preview
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="modal-footer">
              <Button onClick={() => void persistStep(3)}>Back</Button>
              <Button
                variant="primary"
                disabled={!selected.length}
                onClick={() => void persistStep(5)}
              >
                Configure selected clips
              </Button>
            </div>
          </div>
        )}
        {step === 5 && (
          <div className="clip-step">
            <div className="wizard-step">
              <span className="step-number">5</span>
              <div>
                <div className="eyebrow">Per-clip configuration</div>
                <h3>Make each selected clip feel finished</h3>
              </div>
            </div>
            {selected.length ? (
              <>
                <div className="clip-picker">
                  {selected.map((item: AnyRecord) => (
                    <button
                      type="button"
                      key={item.subtopicId}
                      className={
                        current?.subtopicId === item.subtopicId ? "active" : ""
                      }
                      onClick={() => {
                        setCurrentClip(item.subtopicId);
                        setSettings(item.settings ?? defaultSettings);
                      }}
                    >
                      <strong>{item.subtopicTitle}</strong>
                      <small>
                        {ms(item.startMs)}–{ms(item.endMs)}
                      </small>
                    </button>
                  ))}
                </div>
                {current && (
                  <div className="clip-settings-grid">
                    <div className="inline-note">
                      <strong>{current.topicTitle}</strong>
                      <p>
                        {current.subtopicTitle} · {ms(current.startMs)}–
                        {ms(current.endMs)}
                      </p>
                    </div>
                    <label className="toggle-row">
                      <input
                        type="checkbox"
                        checked={Boolean(settings.subtitles)}
                        onChange={(event) =>
                          setSettings({
                            ...settings,
                            subtitles: event.target.checked,
                          })
                        }
                      />
                      <span>
                        <strong>Animated highlighted-word subtitles</strong>
                        <small>
                          Uses the persisted transcript and word timings.
                        </small>
                      </span>
                    </label>
                    <div className="form-row">
                      <label className="form-field">
                        <span>Subtitle preset</span>
                        <select
                          value={settings.subtitlePreset}
                          onChange={(event) =>
                            setSettings({
                              ...settings,
                              subtitlePreset: event.target.value,
                            })
                          }
                        >
                          <option value="highlight">Highlight</option>
                          <option value="clean">Clean</option>
                          <option value="boxed">Boxed</option>
                          <option value="minimal">Minimal</option>
                        </select>
                      </label>
                      <label className="form-field">
                        <span>Font</span>
                        <select
                          value={settings.subtitleFont}
                          onChange={(event) =>
                            setSettings({
                              ...settings,
                              subtitleFont: event.target.value,
                            })
                          }
                        >
                          <option>Arial</option>
                          <option>DejaVu Sans</option>
                          <option>Georgia</option>
                          <option>Verdana</option>
                        </select>
                      </label>
                    </div>
                    <label className="form-field">
                      <span>
                        Overlay text <small>Optional</small>
                      </span>
                      <input
                        value={settings.overlayText}
                        onChange={(event) =>
                          setSettings({
                            ...settings,
                            overlayText: event.target.value,
                          })
                        }
                        placeholder="A short context line"
                      />
                    </label>
                    <div className="form-row">
                      <label className="form-field">
                        <span>Output format</span>
                        <select
                          value={settings.aspectRatio}
                          onChange={(event) =>
                            setSettings({
                              ...settings,
                              aspectRatio: event.target.value,
                            })
                          }
                        >
                          <option value="9:16">Vertical 9:16</option>
                          <option value="original">
                            Original aspect ratio
                          </option>
                        </select>
                      </label>
                      <label className="form-field">
                        <span>Quality</span>
                        <select
                          value={settings.quality}
                          onChange={(event) =>
                            setSettings({
                              ...settings,
                              quality: event.target.value,
                            })
                          }
                        >
                          <option value="standard">Standard</option>
                          <option value="high">High</option>
                        </select>
                      </label>
                    </div>
                    <div className="form-row">
                      <label className="toggle-row">
                        <input
                          type="checkbox"
                          checked={Boolean(settings.removeSilence)}
                          onChange={(event) =>
                            setSettings({
                              ...settings,
                              removeSilence: event.target.checked,
                            })
                          }
                        />
                        <span>
                          <strong>Remove silence</strong>
                          <small>
                            Light, balanced, or aggressive detection.
                          </small>
                        </span>
                      </label>
                      <label className="form-field">
                        <span>Silence level</span>
                        <select
                          value={settings.silenceLevel}
                          onChange={(event) =>
                            setSettings({
                              ...settings,
                              silenceLevel: event.target.value,
                            })
                          }
                        >
                          <option value="light">Light</option>
                          <option value="balanced">Balanced</option>
                          <option value="aggressive">Aggressive</option>
                        </select>
                      </label>
                    </div>
                    <div className="form-row">
                      <label className="toggle-row">
                        <input
                          type="checkbox"
                          checked={Boolean(settings.branding)}
                          onChange={(event) =>
                            setSettings({
                              ...settings,
                              branding: event.target.checked,
                            })
                          }
                        />
                        <span>
                          <strong>Branding</strong>
                          <small>Add a safe text handle to the video.</small>
                        </span>
                      </label>
                      <label className="toggle-row">
                        <input
                          type="checkbox"
                          checked={Boolean(settings.mirror)}
                          onChange={(event) =>
                            setSettings({
                              ...settings,
                              mirror: event.target.checked,
                            })
                          }
                        />
                        <span>
                          <strong>Mirror video</strong>
                          <small>Graphics remain unmirrored.</small>
                        </span>
                      </label>
                    </div>
                    {settings.branding && (
                      <label className="form-field">
                        <span>Brand text</span>
                        <input
                          value={settings.brandText}
                          onChange={(event) =>
                            setSettings({
                              ...settings,
                              brandText: event.target.value,
                            })
                          }
                          placeholder="@yourbrand"
                        />
                      </label>
                    )}
                    <label className="toggle-row">
                      <input
                        type="checkbox"
                        checked={Boolean(settings.normalizeAudio)}
                        onChange={(event) =>
                          setSettings({
                            ...settings,
                            normalizeAudio: event.target.checked,
                          })
                        }
                      />
                      <span>
                        <strong>Normalize audio</strong>
                        <small>Speech-oriented loudness normalization.</small>
                      </span>
                    </label>
                    <div className="detail-actions">
                      <Button
                        variant="primary"
                        onClick={() => void saveSettings()}
                        disabled={busy}
                      >
                        Save clip settings
                      </Button>
                      <Button onClick={() => void applyAll()} disabled={busy}>
                        Apply to all selected clips
                      </Button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="inline-note">
                Return to Topics and Clips and select at least one candidate.
              </div>
            )}
            <div className="modal-footer">
              <Button onClick={() => void persistStep(4)}>Back</Button>
              <Button
                variant="primary"
                disabled={!selected.length}
                onClick={() => void persistStep(6)}
              >
                Continue to render
              </Button>
            </div>
          </div>
        )}
        {step === 6 && (
          <div className="clip-step">
            <div className="wizard-step">
              <span className="step-number">6</span>
              <div>
                <div className="eyebrow">Rendering</div>
                <h3>Render each selected clip independently</h3>
              </div>
            </div>
            <div className="render-summary">
              <div>
                <strong>{latestBatch?.completedCount ?? 0}</strong>
                <span>completed</span>
              </div>
              <div>
                <strong>{latestBatch?.failedCount ?? 0}</strong>
                <span>failed</span>
              </div>
              <div>
                <strong>{latestBatch?.totalCount ?? selected.length}</strong>
                <span>total</span>
              </div>
            </div>
            {latestBatch?.clips?.map((clip: AnyRecord) => (
              <div className="job-row" key={clip.id}>
                <span>{clip.subtopicId}</span>
                <Status value={clip.status} />
              </div>
            ))}
            <div className="inline-note">
              Successful clips remain available even if another clip fails.
              Retrying a clip does not re-run transcription or analysis.
            </div>
            <div className="modal-footer">
              <Button onClick={() => void persistStep(5)}>Back</Button>
              <Button
                variant="primary"
                disabled={
                  busy ||
                  !selected.length ||
                  latestBatch?.status === "running" ||
                  latestBatch?.status === "queued"
                }
                onClick={() => void render()}
              >
                {latestBatch ? "Render again" : "Render selected clips"}
              </Button>
              <Button
                onClick={() => void persistStep(7)}
                disabled={!latestBatch || latestBatch.completedCount < 1}
              >
                View exports
              </Button>
            </div>
          </div>
        )}
        {step === 7 && (
          <div className="clip-step">
            <div className="wizard-step">
              <span className="step-number">7</span>
              <div>
                <div className="eyebrow">Export</div>
                <h3>Your clips are ready</h3>
              </div>
            </div>
            {state?.batches
              ?.flatMap((batch: AnyRecord) => batch.clips ?? [])
              .map((clip: AnyRecord) =>
                clip.status === "completed" ? (
                  <div className="rendered-clip-row" key={clip.id}>
                    <div>
                      <strong>Clip {clip.id.slice(0, 8)}</strong>
                      <span>
                        {ms(clip.finalDurationMs)} · {clip.width ?? "—"} ×{" "}
                        {clip.height ?? "—"}
                      </span>
                    </div>
                    <div className="detail-actions">
                      <Button
                        onClick={() =>
                          window.open(`${API_BASE}${clip.previewUrl}`, "_blank")
                        }
                      >
                        Preview
                      </Button>
                      <Button
                        variant="primary"
                        onClick={() =>
                          window.open(
                            `${API_BASE}${clip.downloadUrl}`,
                            "_blank",
                          )
                        }
                      >
                        Download
                      </Button>
                    </div>
                  </div>
                ) : null,
              )}
            <div className="modal-footer">
              <Button onClick={() => void persistStep(6)}>Back</Button>
              <Button
                variant="primary"
                onClick={() =>
                  window.open(
                    `${API_BASE}/api/content/${contentId}/clipping/download-all`,
                    "_blank",
                  )
                }
              >
                Download all successful
              </Button>
              <Button onClick={close}>Done</Button>
            </div>
          </div>
        )}
        {previewCandidate && state?.source?.id && (
          <div
            className="modal-backdrop clipping-preview-backdrop"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setPreviewCandidate(null);
            }}
          >
            <section
              className="modal modal-wide clipping-preview-modal"
              role="dialog"
              aria-modal="true"
              aria-label="Clip preview"
            >
              <header className="modal-header">
                <div>
                  <div className="eyebrow">Clip preview</div>
                  <h2>{previewCandidate.title}</h2>
                </div>
                <button
                  className="close-button"
                  onClick={() => setPreviewCandidate(null)}
                  aria-label="Close preview"
                >
                  ×
                </button>
              </header>
              <video
                key={previewCandidate.id}
                className="clipping-preview-video"
                controls
                preload="auto"
                src={`${API_BASE}/api/clipping/source/${state.source.id}/preview?startMs=${encodeURIComponent(String(previewCandidate.startMs))}&endMs=${encodeURIComponent(String(previewCandidate.endMs))}`}
              />
              <div className="clipping-preview-meta">
                <strong>
                  {ms(previewCandidate.startMs)}–{ms(previewCandidate.endMs)}
                </strong>
                <span>Preview only · selecting the checkbox is separate.</span>
              </div>
              <div className="modal-footer">
                <Button onClick={() => setPreviewCandidate(null)}>Close</Button>
              </div>
            </section>
          </div>
        )}
        {notice && <div className="inline-note">{notice}</div>}
        {error && <div className="inline-error">{error}</div>}
      </section>
    </div>
  );
}

function Status({ value }: { value?: string }): ReactElement {
  return (
    <span className={`status status-${value ?? "draft"}`}>
      {statusLabel(value)}
    </span>
  );
}
function Button({
  children,
  variant = "secondary",
  onClick,
  disabled = false,
}: {
  children: ReactNode;
  variant?: "primary" | "secondary";
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
