# Tokia

Tokia is a local-first workspace for importing Pinterest references, organizing them into projects, and producing reusable visual content. The current workflows support single images, carousels, video slideshows, and AI-assisted video clipping.

## Repository structure

```text
Tokia/
├── apps/
│   ├── api/          Fastify API, SQLite persistence, migrations, and media jobs
│   ├── extension/    Chrome/Brave Manifest V3 Pinterest scanner
│   └── web/          React + Vite local workspace
├── packages/
│   └── shared/       Shared TypeScript types, schemas, and normalization helpers
├── docs/             Workflow and implementation notes
├── data/             Local runtime data created by the API (gitignored)
├── package.json      npm workspace scripts
└── tsconfig.base.json
```

## Architecture

```text
Authenticated Pinterest tab
          │
          ▼
Manifest V3 extension ── versioned JSON ──▶ Fastify API
                                                │
                            ┌───────────────────┼───────────────────┐
                            ▼                   ▼                   ▼
                         SQLite             Filesystem          FFmpeg/FFprobe
                                                ▲
                                                │
                                      React/Vite web app
```

The browser extension scans Pinterest pages in the authenticated browser tab and sends normalized data to the local API. It does not call the Pinterest API, store browser cookies, or access SQLite directly. The web app communicates with the API for projects, imports, content generation, settings, and job status.

## Requirements

- Node.js 20 or newer
- npm
- FFmpeg and FFprobe on `PATH`, or their paths configured in the application settings
- Chrome or Brave if you want to use the Pinterest browser extension

Docker and a `.env` file are not required for the normal local workflow.

## Quick start

Install dependencies and apply the database migrations from the repository root:

```bash
npm install
npm run migrate
```

Start the API in one terminal:

```bash
npm run dev
```

Start the web app in a second terminal:

```bash
npm run dev:web
```

The default local endpoints are:

- Web app: `http://127.0.0.1:5173`
- API: `http://127.0.0.1:3000`
- API health check: `http://127.0.0.1:3000/api/health`
- Swagger UI: `http://127.0.0.1:3000/docs`

## Pinterest browser extension

Build the extension with:

```bash
npm run build:extension
```

Then load `apps/extension/dist` as an unpacked extension:

1. Open `chrome://extensions` or `brave://extensions`.
2. Enable Developer mode.
3. Select **Load unpacked** and choose the `apps/extension/dist` directory.
4. In Tokia, open **Settings → Connection** and connect the extension.
5. Open a Pinterest board in the same browser and start a scan from the extension.

The extension uses the local integration token managed by Tokia. Mutation requests to the API require that token in the `X-Local-Integration-Token` header.

## Content workflows

Projects are the main organizing unit. A project stores its niche, language, notes, visual defaults, and references to source collections without copying the source media.

From a project, **Create content** provides the following content types:

- **Single image**: one generated visual asset.
- **Carousel**: independently generated slides exported as a downloadable ZIP with metadata and caption text.
- **Video slideshow**: an MP4 composed from timed image and video scenes, with a cover and optional call to action.
- **Video clipping**: candidate clips generated from an uploaded long-form video, with subtitles, branding, and export settings.

The content wizard collects the content title at the beginning, then walks through source selection, structure, content, visuals, text, and preview. For video slideshows, image duration can be set globally before content selection, applied in bulk only to unlocked image scenes, and adjusted per scene afterward. Video scenes expose a two-handle range over the original source so each scene can keep any valid section of its video.

Preview generation is local and must complete before the final confirmation step. Generated media is stored under the configured content storage directory; originals are left untouched. Video slideshow exports use true 720p/1080p dimensions for the selected aspect ratio and high-quality H.264/AAC encoding; Pinterest image sources use the largest/original CDN variant when available.

## Runtime configuration and local data

Runtime settings are managed in **Settings → Advanced** and persisted to:

```text
data/tokia-settings.json
```

The default settings are:

| Setting | Default |
| --- | --- |
| `host` | `127.0.0.1` |
| `port` | `3000` |
| `databasePath` | `./data/tokia.sqlite` |
| `contentStorageDirectory` | `./data/content` |
| `ffmpegPath` | `ffmpeg` |
| `ffprobePath` | `ffprobe` |
| `maxUploadBytes` | `250 MB` |
| `modelProvider` | `local` |
| `modelName` | `local-structured-v1` |
| `maxPinsPerImport` | `2000` |
| `maxRequestBytes` | `10 MB` |
| `logLevel` | `info` |

The API creates these local files as needed:

- `data/tokia.sqlite`: application database.
- `data/content/`: source media and derived assets.
- `data/.tokia-secrets.json`: encryption material for stored provider credentials.

The entire `data/` directory is ignored by Git. Keep its contents private and back it up before moving or resetting a local installation. Settings that affect the running process, such as the port or media tool paths, may require an API restart after saving.

## AI providers and clipping

AI provider settings are configured from the application. Provider credentials are handled by the backend and stored encrypted locally. The deterministic local narrative provider is available by default for structured content generation.

The clipping workflow supports transcription, topic analysis, candidate selection, subtitle configuration, branding, and rendering. Local Whisper is not bundled; configure an available runtime if you want to use it. See [`docs/video-clipping.md`](docs/video-clipping.md) for the workflow and current limitations.

## Database migrations

SQL migrations live in `apps/api/migrations`. Apply pending migrations with:

```bash
npm run migrate
```

The migration runner records applied migrations in SQLite and is safe to run after every update.

## Development commands

Run these commands from the repository root:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Build the shared package and start the API in watch mode |
| `npm run dev:web` | Start the Vite web development server |
| `npm run migrate` | Apply pending SQLite migrations |
| `npm test` | Run the Vitest suite once |
| `npm run test:watch` | Run Vitest in watch mode |
| `npm run typecheck` | Typecheck every workspace |
| `npm run build` | Build every workspace |
| `npm run build:api` | Build the API |
| `npm run build:web` | Build the web app |
| `npm run build:extension` | Build the browser extension |
| `npm run start` | Start the built API |

Before opening a pull request, run:

```bash
npm run typecheck
npm test
npm run build
```

## Documentation

- [`docs/phase3-content-workflow.md`](docs/phase3-content-workflow.md): project and content-generation workflow details.
- [`docs/video-clipping.md`](docs/video-clipping.md): clipping architecture, provider setup, rendering, and limitations.

## Current scope

Tokia is currently focused on local content research and generation. User authentication, multi-user collaboration, social publishing, scheduling, analytics, and automatic publishing integrations are outside the current local-first scope.
