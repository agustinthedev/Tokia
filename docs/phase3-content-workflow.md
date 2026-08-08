# Phase 3: project content workflow

Tokia’s Projects area now supports a local-first content asset workflow. A project has a name, niche, language, notes, visual defaults, and one or more reusable source collections. Collections remain global ingestion records and are referenced through `project_collections`; project creation never copies source media.

## Wizard flow

The project wizard covers basic information, source collections, default content preferences, and review. A project name and niche are required, active duplicate names are rejected, and at least one source collection must be connected.

The content wizard stays inside the project and supports:

1. Single image, carousel, or video slideshow selection.
2. Per-item source collection overrides.
3. Exact frame structure, including cover and CTA roles.
4. Unique image selection, shuffle, replacement, reordering, and image locks.
5. Aspect ratio, crop, typography, overlay, branding, and video timing controls.
6. Structured copy review with field editing, locks, and bounded regeneration actions.
7. Local preview rendering and explicit confirmation before final generation.

A carousel is a group of independent images intended for manual swiping. It does not show video timing or transition settings. A video slideshow is one MP4 composed from timed scenes and exposes those video-only settings. With five total slides, cover enabled, and CTA enabled, the generator receives three `content` roles—not five tips.

## Persistence and jobs

Migration `apps/api/migrations/003_content_workflow.sql` adds `content_items`, `content_frames`, `content_assets`, and `generation_jobs`, plus project metadata columns. Jobs are persisted in SQLite, claimed by a single-host worker, and reset from `running` to `queued` during startup recovery. A failed job stores a stable error code, human-readable message, attempt count, and retryable status.

The local structured narrative provider is deterministic by default (`modelProvider=local` in Settings → Advanced). Its response is validated for exact frame count, ordered roles, required fields, text mode, and character limits before it reaches SQLite or the renderer. The stored configuration, provider, model name, narrative, and version fields are intentionally future-ready for templates without adding template behavior in this phase.

## Media and output storage

The API downloads selected source media, normalizes it with FFmpeg, and stores derived files under the configured content storage directory (`content-{id}`). Original ingested assets are not mutated. PNG frames, WebP thumbnails, MP4 videos, SHA-256 hashes, dimensions, and metadata are persisted in `content_assets`. Carousel ZIP downloads include final slides, `metadata.json`, and `caption.txt`. The API exposes download URLs rather than filesystem paths.

Change the FFmpeg executable path from Settings → Advanced when FFmpeg is not available on `PATH`. Node.js 20+ and the existing SQLite dependency are required. No Docker is used.

## Run and test

```bash
npm run migrate
npm run dev
npm run dev:web
npm test
npm run typecheck
npm run build
```

The content workflow integration test uses a deterministic local image server and covers project creation, five-frame carousel roles, narrative generation, image selection, preview rendering, final generation, ZIP packaging, and MP4 preview rendering. Real Pinterest media must be reachable by the local API for normalization; corrupt or unreachable media is recorded as a retryable generation failure.

Publishing, scheduling, TikTok, Instagram, Facebook, account authentication, analytics, automatic uploads, and reusable templates are outside this phase. Generated assets are reusable files that can be downloaded and uploaded manually later.
