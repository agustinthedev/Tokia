# Tokia

Tokia es una aplicación local-first para importar referencias de imágenes desde un board de Pinterest y dejar una base confiable para futuras presentaciones tipo slideshow. Esta primera fase implementa únicamente la fundación de ingestión: API local, SQLite, normalización/deduplicación, observabilidad y una extensión Chrome/Brave Manifest V3.

No incluye generación de slideshows, IA, llamadas a OpenAI, proyectos, renderizado de texto, publicación en TikTok, scheduling, autenticación de usuarios finales, analytics ni descarga persistente de imágenes.

## Arquitectura

```text
Pinterest abierto y autenticado en Chrome/Brave
        │
        ▼
apps/extension (Manifest V3, scanner en memoria)
        │ JSON + X-Local-Integration-Token
        ▼
apps/api (Fastify + Zod)
        │ transacción SQLite
        ▼
collections ── collection_assets ── assets
        │
        └── import_runs
```

El monorepo está organizado así:

- `apps/api`: API Fastify, migraciones, SQLite, ingestión y endpoints de gestión.
- `apps/extension`: extensión MV3, popup, settings y scanner Pinterest.
- `packages/shared`: tipos, esquemas Zod y normalización compartida.
- `docs`: reservado para documentación adicional de futuras fases.

La extensión envía JSON al API en lugar de acceder directamente a SQLite para mantener una frontera clara entre navegador y aplicación, permitir validación/transacciones en un solo lugar y evitar exponer credenciales de base de datos. Pinterest se consulta solamente desde la pestaña autenticada del usuario; la extensión no usa la API oficial, no guarda cookies y no descarga imágenes grandes.

## Requisitos

- Node.js 20 o superior. Se desarrolla y verifica con Node 22.
- Google Chrome o Brave.
- Una sesión de Pinterest autenticada en el navegador para probar la extensión.
- No se usa Docker.

## Instalación y configuración

Desde la raíz del repositorio:

```bash
npm install
copy .env.example .env
```

En PowerShell, el equivalente de `copy` es `Copy-Item .env.example .env`.

Variables disponibles:

| Variable | Default | Uso |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Interfaz local del API. |
| `PORT` | `3000` | Puerto del API. |
| `DATABASE_PATH` | `./data/tokia.sqlite` | Ruta relativa al workspace del API. |
| `LOCAL_INTEGRATION_TOKEN` | `tokia-local-dev-token` en `.env.example` | Token requerido para imports y cambios de estado. Si se omite, el proceso genera uno aleatorio no persistente; para la extensión conviene configurarlo explícitamente. |
| `MAX_PINS_PER_IMPORT` | `2000` | Máximo de Pins por importación. |
| `MAX_REQUEST_BYTES` | `10485760` | Máximo de request, 10 MiB. |
| `CORS_ALLOWED_ORIGINS` | `http://localhost:3000` | Orígenes exactos separados por comas. Agregar el origen de la extensión luego de cargarla. |
| `LOG_LEVEL` | `info` | Nivel de logs estructurados. |

El token no se escribe en logs. La extensión lo almacena en `chrome.storage.local`.

## Base de datos y migraciones

El API usa SQLite con:

- WAL para permitir lecturas concurrentes durante imports locales.
- Foreign keys habilitadas.
- `busy_timeout` de 5 segundos.
- Migraciones versionadas en `apps/api/migrations`.

Cuando se ejecutan los scripts de workspace desde la raíz, la base por defecto queda en `apps/api/data/tokia.sqlite`. La carpeta y sus archivos WAL están ignorados por Git.

```bash
npm run migrate
```

Para resetear la base local, detener el API y eliminar únicamente estos archivos:

```powershell
Remove-Item .\apps\api\data\tokia.sqlite, .\apps\api\data\tokia.sqlite-shm, .\apps\api\data\tokia.sqlite-wal -ErrorAction SilentlyContinue
npm run migrate
```

## Ejecutar el API

```bash
npm run dev
```

El API queda en `http://127.0.0.1:3000` y la documentación Swagger UI en `http://127.0.0.1:3000/docs`.

Comprobación rápida:

```bash
curl http://127.0.0.1:3000/api/health
```

El API inicia sin Docker. `npm run start` ejecuta el build compilado; `npm run dev` usa `tsx` con reload.

## API

Todos los endpoints de lectura son públicos en esta fase local. El import y los cambios de estado requieren `X-Local-Integration-Token`.

| Método | Endpoint | Descripción |
| --- | --- | --- |
| `GET` | `/api/health` | Salud del servicio y estado SQLite. |
| `POST` | `/api/imports/pinterest-board` | Importa un payload versionado. |
| `GET` | `/api/collections` | Lista paginada con búsqueda, provider, status y sort. |
| `GET` | `/api/collections/:id` | Detalle y cantidad de assets. |
| `GET` | `/api/collections/:id/assets` | Assets paginados con status, dimensiones, orientación, búsqueda y sort. |
| `GET` | `/api/import-runs` | Lista de ejecuciones con filtros. |
| `GET` | `/api/import-runs/:id` | Diagnóstico de una ejecución. |
| `PATCH` | `/api/assets/:id` | Cambia `status` de un asset sin borrarlo. |
| `PATCH` | `/api/collections/:id` | Cambia `status` de una colección sin borrarla. |

Las opciones de sort de colecciones son `name`, `createdAt`, `updatedAt`, `lastImportedAt`. Assets acepta `firstSeen`, `lastSeen`, `dimensions`. La orientación acepta `portrait`, `landscape` y `square`.

### Payload de importación

El schema actual es la versión `1`. El board requiere nombre y URL Pinterest normalizable. Cada Pin requiere `imageUrl` y al menos `externalId` o `pinUrl`; la URL Pin puede permitir extraer el ID. Los Pins individuales se validan con `safeParse`, por lo que un registro malformado produce warning y no descarta los válidos.

```json
{
  "schemaVersion": 1,
  "source": "pinterest-browser-extension",
  "exportedAt": "2026-08-05T21:00:00.000Z",
  "board": {
    "externalId": "optional-board-id",
    "name": "Luxury Lifestyle",
    "url": "https://www.pinterest.com/example/luxury-lifestyle/",
    "description": null
  },
  "pins": [
    {
      "externalId": "123456789012345678",
      "pinUrl": "https://www.pinterest.com/pin/123456789012345678/",
      "imageUrl": "https://i.pinimg.com/736x/ab/cd/ef/image.jpg",
      "previewUrl": "https://i.pinimg.com/236x/ab/cd/ef/image.jpg",
      "imageVariants": [{ "url": "https://i.pinimg.com/736x/ab/cd/ef/image.jpg", "width": 736 }],
      "title": "Luxury yacht",
      "description": null,
      "altText": "White yacht in Monaco",
      "sourceLink": null,
      "width": 736,
      "height": 1104
    }
  ]
}
```

Respuesta resumida:

```json
{
  "success": true,
  "collection": { "id": "collection-id", "name": "Luxury Lifestyle", "created": true },
  "importRunId": "import-run-id",
  "summary": {
    "received": 1,
    "valid": 1,
    "invalid": 0,
    "assetsCreated": 1,
    "assetsUpdated": 0,
    "membershipsCreated": 1,
    "duplicatesSkipped": 0
  },
  "warnings": []
}
```

Un schema version distinto de `1` devuelve `400` con `UNSUPPORTED_SCHEMA_VERSION`. El límite de Pins devuelve `413`; el límite de request de 10 MiB evita payloads accidentales demasiado grandes.

## Modelo y deduplicación

Se eligió un asset global normalizado con tabla de unión porque el mismo Pin puede pertenecer a varios boards:

- `collections`: provider, identidad de board, nombre, estado y timestamps de import.
- `assets`: identidad de Pin, URLs remotas, metadata, dimensiones y estado.
- `collection_assets`: membresía y `last_seen_at` por colección.
- `import_runs`: estado, contadores, timestamps y error agregado.

La identidad se resuelve por capas:

1. `provider + external_asset_id` — normalmente el Pin ID.
2. `provider + canonical_asset_url` — URL Pinterest normalizada, sin query/locale innecesarios.
3. `provider + normalized_image_key` — solo cuando no hay ID ni URL de Pin confiable; elimina el segmento de tamaño de URLs `i.pinimg.com`.

No hay índice único sobre `normalized_image_key`: dos Pins distintos que apunten al mismo path de imagen siguen siendo assets distintos si tienen IDs/URLs de Pin distintos. Los reimports actualizan `last_seen_at`, agregan membresías faltantes y no reemplazan metadata buena con null o texto vacío. La mejor variante conocida se conserva como `remote_image_url` y una preview separada; nunca se almacenan bytes ni rutas locales.

La identidad de colección prioriza `provider + external_id` y luego `provider + canonical_source_url`. Por eso renombrar un board con ID estable actualiza la colección; si Pinterest no expone un ID y cambia la URL canónica, se considera una colección distinta para evitar una unión especulativa.

## Extensión Chrome/Brave

Construir la carpeta cargable:

```bash
npm run build:extension
```

El resultado queda en `apps/extension/dist`.

### Cargar en Chrome

1. Abrir `chrome://extensions`.
2. Activar `Developer mode`.
3. Elegir `Load unpacked`.
4. Seleccionar `apps/extension/dist`.
5. Copiar el ID de la extensión, por ejemplo `abcdefghijklmnop...`.
6. Agregar `chrome-extension://ID_COPIADO` a `CORS_ALLOWED_ORIGINS` en `.env`.
7. Reiniciar el API después de cambiar `.env`.

### Cargar en Brave

1. Abrir `brave://extensions`.
2. Activar `Developer mode`.
3. Elegir `Load unpacked`.
4. Seleccionar la misma carpeta `apps/extension/dist`.
5. Agregar el origen `chrome-extension://ID_DE_BRAVE` a `CORS_ALLOWED_ORIGINS` si el ID difiere.

En el popup `Open settings` permite configurar:

- Backend URL, por defecto `http://localhost:3000`.
- Token local.
- Máximo de Pins, duración máxima, rondas sin novedades, espera entre rondas y proporción de scroll.

El popup muestra detección de página, nombre/URL/ID de board, estado de conexión, progreso, Pins únicos, resultado y errores. Las acciones son `Scan visible Pins`, `Scan entire board`, `Stop scan`, `Send to application`, `Copy JSON`, `Download JSON`, `Test connection` y `Open settings`.

El scanner:

- Usa URL, enlaces `/pin/`, imágenes `i.pinimg.com`, metadata, headings y atributos/JSON embebido como señales combinadas.
- Extrae IDs, URL canónica, `srcset`, título, descripción, alt, source link, width y height sin navegar Pin por Pin.
- Mantiene un `Map` en memoria durante el infinite scroll, incluso si Pinterest virtualiza y quita nodos viejos del DOM.
- Hace scroll progresivo, espera entre rondas, limita Pins/duración, detiene tras varias rondas sin novedades y admite cancelación.
- No continúa el scan cuando se cierra el popup o se descarga/navega la página relevante; el port de control se desconecta y cancela el scanner.
- Reintenta únicamente fallos transitorios del envío al API, con tres intentos máximos.

### Verificación manual end-to-end

1. Configurar `.env`, `CORS_ALLOWED_ORIGINS`, levantar el API y abrir `/api/health`.
2. Abrir Chrome o Brave con sesión Pinterest autenticada.
3. Abrir un board, esperar a que estén visibles algunos Pins y abrir el popup de Tokia.
4. Confirmar que el popup detecta el board y ejecutar `Scan visible Pins`.
5. Confirmar el número de Pins y usar `Send to application`.
6. Consultar `/api/collections`, `/api/collections/:id/assets` y `/api/import-runs`.
7. Repetir el envío: no deben crecer las filas de colección, asset ni membresía.
8. Ejecutar `Scan entire board`, verificar que el contador progresa, cancelar manualmente y comprobar que el payload conserva los Pins ya observados.
9. Agregar Pins al board, repetir la importación y confirmar que solo se agregan los nuevos.

La extracción depende de la estructura dinámica de Pinterest; si Pinterest cambia el DOM, los selectores y señales de `apps/extension/src/scanner.ts` son el punto de ajuste. No se debe tomar un fixture como evidencia de que el sitio vivo sigue igual.

En la validación de esta fase se pudo abrir un board público real desde el navegador integrado y observar enlaces `/pin/`, alt text, URLs `i.pinimg.com`, variantes `srcset` con descriptores `1x/2x/3x/4x` y variantes `originals`. Esa observación se usó para ajustar el scanner. El entorno no expuso una sesión Chrome/Brave controlable ni permitió cargar la carpeta unpacked dentro del navegador integrado, por lo que la instalación de la extensión y el envío desde una sesión Pinterest autenticada quedan como verificación manual siguiendo los pasos anteriores.

## Tests y builds

```bash
npm test
npm run typecheck
npm run build
npm run build:extension
```

La suite cubre normalización de URLs, IDs, claves de imágenes, primera importación, reimportación, rename con ID, import parcial, rollback, límite de payload, cross-collection, no colapso de Pins con la misma imagen, filtros de lectura, estados soft-disable y scanner DOM con `srcset`, deduplicación y cancelación.

## Alcance futuro

## Phase 2: local media workspace

Phase 2 adds `apps/web`, a React + Vite application connected to the Fastify API. It keeps the local-first boundary intact: the browser talks to the API, and only the API opens SQLite. The interface is a light, neon-accented, responsive media workspace with a collapsible navigation shell, dashboard, collection galleries, global asset browsing, project management, import diagnostics, global search, and local settings.

Collections and projects are intentionally different. A collection is an imported or reusable source board with global asset memberships and import history. A project references one or more collections through `project_collections`; it never copies collection assets. This leaves room for future weighting, media-type rules, usage history, randomized selection, and manual replacement.

### Phase 2 development

Run the API and web app in separate terminals:

```bash
npm run dev
npm run dev:web
```

The API runs at `http://127.0.0.1:3000`; the Vite app runs at `http://127.0.0.1:5173`. If the local token differs from the example value, set `VITE_INTEGRATION_TOKEN` before starting the web app. The API allows the Vite origins through `CORS_ALLOWED_ORIGINS`.

Build everything with:

```bash
npm run build
npm run typecheck
npm test
npm run migrate
```

Phase 2 migration `apps/api/migrations/002_phase2.sql` adds separate local collection metadata, cover references, lifecycle timestamps, media type/video metadata, projects, and the project-to-collection relationship. It is additive and safe to run against the Phase 1 SQLite database.

The extension scanner recognizes Pinterest video cards from `<video>`, `<source>`, poster metadata, and embedded `.mp4`/`.webm` URLs. After rebuilding the extension, reload the unpacked extension in Chrome/Brave and re-scan the board; existing assets are matched by Pin ID and updated with video metadata instead of being duplicated.

### Phase 2 API surface

The UI uses `GET /api/dashboard`, `/api/settings`, `/api/search`, collection and asset list/detail routes, project CRUD and project-collection association routes, and import-run list/detail routes. Mutation routes retain the local integration token boundary. Image cards use lazy remote previews. Video cards use poster-first rendering and an explicit play affordance; the detail drawer resolves deferred Pinterest video metadata when necessary, persists the direct MP4 source, and mounts native playback controls with the original Pin as fallback.

### Deferred generation layer

The project schema intentionally stores extensible `config_json` and a relationship row per collection. Weighted selection, recency avoidance, asset usage history, target-format crop previews, text-slide safe areas, overlay rules, and manual asset replacement are extension points, not fake controls in this phase.

La tabla de unión permite que una futura entidad `projects` consuma varias colecciones sin acoplar proyectos al origen Pinterest. Las partes más frágiles son la detección de metadata/board ID y los selectores del DOM Pinterest; el API y la deduplicación quedan aislados en `packages/shared` y `apps/api` para que esos cambios no contaminen el almacenamiento.
