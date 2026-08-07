# Long-form video clipping

Tokia's clipping workflow lives inside the existing Project → Create content wizard. Select **Clipping** to upload a spoken long-form video, run persisted transcription and topic analysis, choose candidate clips, configure each clip, render, and export successful outputs.

## Provider setup

Open **Settings → AI Providers**. Add one or more of:

- **OpenAI** for timestamped transcription and structured analysis.
- **OpenAI-compatible** for text analysis against a compatible `/chat/completions` endpoint. JSON mode is supported when strict structured output is unavailable.
- **Local Whisper** for local transcription configuration. The current deployment reports the provider as unavailable unless a supported local runtime is present.

Assign providers to **Transcription** and **Text analysis**. Clipping preflight requires a connected transcription provider with audio transcription and timestamped segments, plus a connected analysis provider with text generation and structured output or JSON mode. The wizard blocks upload processing until those capabilities are available.

Remote API keys are sent only to authenticated backend mutations, encrypted with AES-256-GCM using `APP_SECRETS_ENCRYPTION_KEY`, and never returned to the browser. Keep the encryption key outside SQLite and rotate it through a versioned secret-management process before changing deployments.

## Runtime configuration

Copy the relevant values from `.env.example`:

```text
APP_SECRETS_ENCRYPTION_KEY=replace-with-a-long-random-secret
FFMPEG_PATH=ffmpeg
FFPROBE_PATH=ffprobe
MAX_UPLOAD_BYTES=262144000
CONTENT_STORAGE_DIRECTORY=./data/content
```

FFmpeg and FFprobe must be installed and available to the API process. Video binaries and rendered clips are stored under the content storage directory; SQLite stores metadata, processing state, transcripts, selections, settings, and safe error information.

## Processing and recovery

Audio extraction, transcription, topic analysis, subtopic persistence, and rendering are persisted jobs. Each stage is idempotent at the workflow level and reports progress through `GET /api/content/:id/clipping`. Render failures are isolated to individual clips and can be retried without repeating semantic analysis.

The source, transcript, topics, selections, per-clip settings, render batches, and rendered outputs are restored when a clipping content item is reopened from its project. Historical renders retain their provider/model metadata through the transcript and request records.

## Adding a provider adapter

Implement a normalized adapter in `apps/api/src/ai-providers.ts` and map its response into `NormalizedTranscript` or a schema-validated structured result. Add the provider's capabilities to `defaultCapabilities`, normalize remote errors into a safe `ProviderErrorCode`, and add unit coverage for masking, normalization, malformed JSON, and capability matching. Do not pass provider SDK response objects into clipping business logic.

## Known limitations

- Local Whisper configuration is persisted and capability-aware, but this deployment does not bundle a Whisper runtime.
- Silence removal uses FFmpeg detection, protects transcript-word margins, persists an edit map in the render plan, remaps subtitle timing, and concatenates the kept video/audio segments. It is intentionally heuristic rather than a manual timeline editor.
- Crop framing is fixed to center crop/fill for vertical output; a manual crop or timeline editor is intentionally out of scope.
- There is no automatic provider failover, virality score, B-roll, social publishing, or advanced subtitle editor.

## Verification

Run the complete checks from the repository root:

```text
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

The clipping integration test uses a deterministic FFmpeg fixture and mocked remote provider responses, and verifies encrypted credentials, preflight, persisted analysis, parent/child selection behavior, rendering, and download.
