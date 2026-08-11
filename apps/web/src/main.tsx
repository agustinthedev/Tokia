import { StrictMode, useEffect, useRef, useState, type ChangeEvent, type CSSProperties, type FormEvent, type ReactElement, type ReactNode, type SyntheticEvent } from "react";
import { createRoot } from "react-dom/client";
import { InfiniteAssetFooter, useInfiniteAssets } from "./asset-pagination";
import { bindPreviewGallery } from "./preview-gallery";
import "./styles.css";
import { AiProvidersPage } from "./AiProvidersPage";
import { ClippingWizard } from "./ClippingWizard";
import { API_BASE, apiRequest, getIntegrationToken, setApiBase, setIntegrationToken } from "./api-client";
import "./clipping.css";
import "./saas-theme.css";

type AnyRecord = Record<string, any>;
type PageKey = "home" | "collections" | "assets" | "projects" | "imports" | "settings";
type SettingsTab =
  | "connection"
  | "advanced"
  | "api"
  | "preview"
  | "assets"
  | "imports"
  | "ai-providers";
interface AdvancedRuntimeSettings {
  host: string;
  port: number;
  databasePath: string;
  contentStorageDirectory: string;
  ffmpegPath: string;
  ffprobePath: string;
  maxUploadBytes: number;
  modelProvider: string;
  modelName: string;
  maxPinsPerImport: number;
  maxRequestBytes: number;
  corsAllowedOrigins: string[];
  logLevel: string;
}
type MediaKind = "image" | "video" | "animated";

interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
interface Asset {
  id: string;
  externalId?: string;
  mediaType: MediaKind;
  mediaUrl?: string;
  imageUrl?: string;
  previewUrl?: string;
  remoteImageUrl?: string;
  remotePreviewUrl?: string;
  thumbnailUrl?: string;
  title?: string;
  description?: string;
  altText?: string;
  sourceLink?: string;
  canonicalUrl?: string;
  width?: number;
  height?: number;
  aspectRatio?: number;
  orientation?: string;
  durationSeconds?: number;
  mimeType?: string;
  status: string;
  provider?: string;
  collectionId?: string;
  collectionName?: string;
  collections?: Collection[];
  firstSeenAt?: string;
  lastSeenAt?: string;
  createdAt?: string;
  updatedAt?: string;
  localNotes?: string;
  localTags?: string;
  archivedAt?: string;
}
interface Collection {
  id: string;
  name: string;
  sourceName?: string;
  description?: string;
  provider: string;
  canonicalSourceUrl: string;
  status: string;
  assetCount: number;
  imageCount: number;
  videoCount: number;
  coverPreviewUrl?: string;
  coverAssetId?: string;
  lastImportedAt?: string;
  lastSuccessfulImportAt?: string;
  updatedAt?: string;
  createdAt?: string;
  archivedAt?: string;
}
interface Project {
  id: string;
  name: string;
  description?: string;
  niche?: string;
  defaultLanguage?: string;
  internalNotes?: string;
  color?: string;
  status: string;
  collectionCount: number;
  totalAssets: number;
  imageCount: number;
  videoCount: number;
  contentCount?: number;
  draftCount?: number;
  generatingCount?: number;
  readyCount?: number;
  config?: AnyRecord;
  createdAt: string;
  updatedAt: string;
  collections?: Collection[];
  recentAssets?: Asset[];
}
interface ContentSummary {
  id: string;
  projectId: string;
  type: string;
  title?: string;
  status: string;
  language: string;
  topic?: string;
  frameCount: number;
  previewVersion: number;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  thumbnailUrl?: string;
}
interface ContentFrame {
  id: string;
  position: number;
  role: string;
  headline?: string | null;
  body?: string | null;
  durationSeconds?: number | null;
  textLocked: boolean;
  imageLocked: boolean;
  sourceMedia?: Asset | null;
}
interface ContentDetail extends ContentSummary {
  wizardStep?: number;
  configuration: AnyRecord;
  narrative?: {
    topic: string;
    title: string;
    frames: Array<{
      index: number;
      role: string;
      headline?: string | null;
      body?: string | null;
    }>;
    caption: string;
    hashtags: string[];
  } | null;
  frames: ContentFrame[];
  assets: Array<{
    id: string;
    frameId?: string;
    assetType: string;
    variant: string;
    mimeType: string;
    previewUrl: string;
    downloadUrl: string;
  }>;
  jobs: Array<{
    id: string;
    jobType: string;
    status: string;
    progress: number;
    errorMessage?: string;
  }>;
  contentFrameCount: number;
  projectName?: string;
}
interface ImportRun {
  id: string;
  collectionId?: string;
  collectionName?: string;
  sourceUrl: string;
  status: string;
  recordsReceived: number;
  recordsValid: number;
  recordsInvalid: number;
  assetsCreated: number;
  assetsUpdated: number;
  membershipsCreated: number;
  duplicatesSkipped: number;
  startedAt: string;
  completedAt?: string;
  createdAt?: string;
  errorMessage?: string;
}
interface Dashboard {
  stats: {
    totalCollections: number;
    totalAssets: number;
    totalImages: number;
    totalVideos: number;
    totalProjects: number;
    attentionImports: number;
  };
  recentCollections: Collection[];
  recentAssets: Asset[];
  recentImports: ImportRun[];
  topCollections: Collection[];
  mediaDistribution: { mediaType: string; count: number }[];
}
interface SearchResult {
  query: string;
  collections: Collection[];
  assets: Asset[];
  projects: Project[];
}

if (typeof document !== "undefined") bindPreviewGallery(document);

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const apiPath = path === "/api/assets?mediaType=image&pageSize=100" ? "/api/assets?mediaType=source&pageSize=100" : path;
  const hasBody = init?.body !== undefined && init?.body !== null;
  const body = await apiRequest<T>(apiPath, {
    ...init,
    headers: {
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  return normalizeAssetTitles(body) as T;
}

function useApi<T>(path: string | null, refresh = 0): { data: T | null; loading: boolean; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (!path) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    request<T>(path)
      .then((value) => {
        if (active) setData(value);
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : "Could not load data");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [path, refresh]);
  return { data, loading, error };
}

function formatDate(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat("en", {
        month: "short",
        day: "numeric",
        year: "numeric",
      }).format(date);
}
function formatDateTime(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat("en", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(date);
}
function compact(value: number): string {
  return new Intl.NumberFormat("en", {
    notation: value > 9999 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}
function duration(value?: number): string {
  if (value == null) return "—";
  const mins = Math.floor(value / 60);
  const seconds = Math.floor(value % 60)
    .toString()
    .padStart(2, "0");
  return `${mins}:${seconds}`;
}
function cleanAssetLabel(value?: string): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  const withoutPinterestPrefix = normalized
    .replace(/^esto contiene (?:una imagen|un video) de\s*:?\s*/i, "")
    .replace(/^this (?:image|video) contains\s*:?[\s-]*/i, "")
    .trim();
  return withoutPinterestPrefix || null;
}
function isNoisyAssetLabel(value: string): boolean {
  return /(^|\s)#|instagram|^(?:ig|insta(?:gram)?|inst|𝙄𝙂)\s*:|follow\s+me|link\s+in\s+bio|https?:\/\/|www\.|(^|\s)@[a-z0-9_.]+/i.test(value);
}
function assetDisplayTitle(asset: Asset): string {
  for (const candidate of [asset.title, asset.description, asset.altText]) {
    const label = cleanAssetLabel(candidate);
    if (label && !isNoisyAssetLabel(label)) return label;
  }
  const pinId = asset.externalId ?? asset.canonicalUrl?.match(/\/pin\/(\d+)/i)?.[1];
  return pinId ?? "Untitled asset";
}
function normalizeAssetTitles<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => normalizeAssetTitles(item)) as T;
  if (!value || typeof value !== "object") return value;
  const next = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeAssetTitles(item)]));
  if (typeof next.id === "string" && typeof next.mediaType === "string") next.title = assetDisplayTitle(next as Asset);
  return next as T;
}
function navigate(path: string): void {
  const nextPath = path === "/assets" ? "/settings?tab=assets" : path === "/imports" ? "/settings?tab=imports" : path;
  window.history.pushState({}, "", nextPath);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
function settingsTabFromUrl(): SettingsTab {
  const tab = new URLSearchParams(window.location.search).get("tab");
  if (window.location.pathname === "/assets") return "assets";
  if (window.location.pathname === "/imports") return "imports";
  return tab === "api" || tab === "advanced" || tab === "preview" || tab === "assets" || tab === "imports" || tab === "ai-providers"
    ? tab
    : "connection";
}
function getRoute(): { page: PageKey; id?: string } {
  const parts = window.location.pathname.split("/").filter(Boolean);
  const rawPage = parts[0] ?? "home";
  if (rawPage === "collection" && parts[1]) return { page: "collections", id: parts[1] };
  if (rawPage === "project" && parts[1]) return { page: "projects", id: parts[1] };
  if (rawPage === "assets" || rawPage === "imports") return { page: "settings" };
  const page = rawPage as PageKey;
  return {
    page: ["home", "collections", "projects", "settings"].includes(page) ? page : "home",
  };
}

function Icon({ name }: { name: string }): ReactElement {
  const svgIcons: Record<string, ReactNode> = {
    home: <><path d="m3 10 9-7 9 7" /><path d="M5 9.5V21h14V9.5" /><path d="M9 21v-6h6v6" /></>,
    collections: <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M4 9h16M9 4v16M15 4v16" /></>,
    assets: <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="m7 16 3-3 2 2 2-3 3 4" /><circle cx="9" cy="9" r="1" /></>,
    projects: <><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h4l2 2h5A2.5 2.5 0 0 1 20 9.5v7A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5z" /></>,
    imports: <><path d="M12 3v11" /><path d="m8 10 4 4 4-4" /><path d="M5 20h14" /></>,
    settings: <><path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h16" /><circle cx="9" cy="6" r="2" /><circle cx="15" cy="12" r="2" /><circle cx="11" cy="18" r="2" /></>,
    search: <><circle cx="10.8" cy="10.8" r="6.3" /><path d="m16 16 4.2 4.2" /></>,
    plus: <><path d="M12 5v14M5 12h14" /></>,
    arrow: <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>,
    filter: <><path d="M4 6h16M7 12h10M10 18h4" /></>,
    grid: <><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></>,
    list: <><path d="M9 6h11M9 12h11M9 18h11" /><path d="M4 6h.01M4 12h.01M4 18h.01" /></>,
    play: <><path d="m8 5 11 7-11 7z" /></>,
    more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
    check: <><path d="m5 12 4 4L19 6" /></>,
    alert: <><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    image: <><rect x="4" y="5" width="16" height="14" rx="2" /><path d="m7 16 3-3 2 2 2-3 3 4" /><circle cx="9" cy="9" r="1" /></>,
    video: <><rect x="4" y="6" width="13" height="12" rx="2" /><path d="m17 10 3-2v8l-3-2z" /></>,
    "lock-open": <><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 7.6-1.8" /></>,
    "lock-closed": <><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
    "chevron-up": <path d="m6 15 6-6 6 6" />,
    "chevron-down": <path d="m6 9 6 6 6-6" />,
    edit: <><path d="M4 17.5V20h2.5L19 7.5 16.5 5z" /><path d="m14.8 6.2 2.5 2.5" /></>,
    archive: <><path d="M5 7h14M9 7V5h6v2m-8 0 .8 12h6.4L15 7M10 10v6m4-6v6" /></>,
    menu: <><path d="M5 7h14M5 12h14M5 17h14" /></>,
    "arrow-left": <><path d="M19 12H5" /><path d="m11 6-6 6 6 6" /></>,
    "arrow-right": <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>,
  };
  const svgIcon = svgIcons[name];
  if (svgIcon) {
    return (
      <span className={`icon icon-${name}`} aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">{svgIcon}</svg>
      </span>
    );
  }
  if (name === "archive") {
    return (
      <span className="icon icon-archive" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          <path d="M5 7h14M9 7V5h6v2m-8 0 .8 12h6.4L15 7M10 10v6m4-6v6" />
        </svg>
      </span>
    );
  }
  const icons: Record<string, string> = {
    home: "⌂",
    collections: "▦",
    assets: "◈",
    projects: "◒",
    imports: "↥",
    settings: "⚙",
    search: "⌕",
    plus: "+",
    arrow: "↗",
    filter: "≡",
    grid: "▦",
    list: "☰",
    play: "▶",
    more: "•••",
    check: "✓",
    alert: "!",
    clock: "◷",
    image: "▧",
    video: "▷",
    edit: "✎",
    archive: "□",
  };
  return (
    <span className={`icon icon-${name}`} aria-hidden="true">
      {icons[name] ?? "•"}
    </span>
  );
}

function Button({ children, variant = "secondary", onClick, type = "button", disabled = false, className = "" }: { children: ReactNode; variant?: "primary" | "secondary" | "ghost" | "danger"; onClick?: () => void; type?: "button" | "submit"; disabled?: boolean; className?: string }): ReactElement {
  return (
    <button type={type} className={`button button-${variant} ${className}`} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}
function StatusBadge({ value }: { value: string }): ReactElement {
  const label = value.replaceAll("_", " ");
  return (
    <span className={`status status-${value}`}>
      {value === "completed" || value === "active" || value === "available" ? <Icon name="check" /> : value === "failed" || value === "error" ? <Icon name="alert" /> : null}
      {label}
    </span>
  );
}

function MediaPreview({ asset, detail = false, onImageLoad }: { asset: Asset; detail?: boolean; onImageLoad?: (size: { width: number; height: number }) => void }): ReactElement {
  const [sourceIndex, setSourceIndex] = useState(0);
  useEffect(() => setSourceIndex(0), [asset.id]);
  const imageSources = Array.from(new Set((asset.mediaType === "video" ? [asset.remotePreviewUrl, asset.previewUrl, asset.thumbnailUrl, asset.remoteImageUrl, asset.imageUrl] : [asset.remoteImageUrl, asset.mediaUrl, asset.previewUrl, asset.remotePreviewUrl, asset.thumbnailUrl, asset.imageUrl]).filter((value): value is string => Boolean(value))));
  const image = imageSources[sourceIndex];
  const videoSource = asset.mediaType === "video" && asset.mediaUrl ? asset.mediaUrl : undefined;
  const handleImageError = (): void => setSourceIndex((current) => current + 1);
  const handleImageLoad = (event: SyntheticEvent<HTMLImageElement>): void =>
    onImageLoad?.({
      width: event.currentTarget.naturalWidth,
      height: event.currentTarget.naturalHeight,
    });
  if (asset.mediaType === "video")
    return (
      <div className={`media-preview media-video ${detail ? "media-detail" : ""}`}>
        {image ? (
          <img src={image} alt={asset.altText ?? asset.title ?? "Video poster"} onLoad={handleImageLoad} onError={handleImageError} />
        ) : (
          <div className="media-fallback">
            <Icon name="video" />
            <span>Video preview unavailable</span>
          </div>
        )}
        <span className="play-badge">
          <Icon name="play" />
        </span>
        {asset.durationSeconds != null && <span className="duration-badge">{duration(asset.durationSeconds)}</span>}
        {detail && videoSource && (
          <video controls preload="metadata" poster={image} onError={handleImageError}>
            <source src={videoSource} type={asset.mimeType || undefined} />
          </video>
        )}
      </div>
    );
  if (!image)
    return (
      <div className={`media-preview media-fallback ${detail ? "media-detail" : ""}`}>
        <Icon name="image" />
        <span>No preview</span>
      </div>
    );
  return (
    <div className={`media-preview ${detail ? "media-detail" : ""}`}>
      <img src={image} alt={asset.altText ?? asset.title ?? "Media asset"} loading={detail ? "eager" : "lazy"} onLoad={handleImageLoad} onError={handleImageError} />
    </div>
  );
}

function AssetCard({ asset, onOpen, selected = false, onSelect }: { asset: Asset; onOpen: () => void; selected?: boolean; onSelect?: () => void }): ReactElement {
  const [dimensions, setDimensions] = useState<{
    width?: number;
    height?: number;
  }>({});
  const title = assetDisplayTitle(asset);
  return (
    <article className={`asset-card ${selected ? "is-selected" : ""}`}>
      <button className="asset-visual-button" onClick={onOpen} aria-label={`Open ${title}`}>
        <MediaPreview asset={asset} onImageLoad={(size) => setDimensions(size)} />
      </button>
      <div className="asset-card-body">
        <div className="asset-card-title" title={title}>
          {title}
        </div>
        <div className="asset-card-meta">
          <span>
            {asset.mediaType === "video" ? <Icon name="video" /> : <Icon name="image" />}
            {asset.mediaType}
          </span>
          {dimensions.width && dimensions.height ? (
            <span>
              {dimensions.width} × {dimensions.height}
            </span>
          ) : null}
          {onSelect && (
            <button
              className={`select-dot ${selected ? "selected" : ""}`}
              onClick={(event) => {
                event.stopPropagation();
                onSelect();
              }}
              aria-label={selected ? "Deselect asset" : "Select asset"}
            >
              {selected ? "✓" : ""}
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

function getMasonryColumnCount(): number {
  if (typeof window === "undefined") return 5;
  return window.innerWidth <= 580 ? 2 : window.innerWidth <= 1200 ? 4 : 5;
}

function useMasonryColumnCount(): number {
  const [columnCount, setColumnCount] = useState(getMasonryColumnCount);
  useEffect(() => {
    const handleResize = (): void => setColumnCount(getMasonryColumnCount());
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);
  return columnCount;
}

function AssetGrid({ assets, loading, error, onOpen, empty = "No media matches these filters.", selectedIds, onSelect }: { assets: Asset[]; loading: boolean; error: string | null; onOpen: (asset: Asset) => void; empty?: string; selectedIds?: Set<string>; onSelect?: (id: string) => void }): ReactElement {
  const columnCount = useMasonryColumnCount();
  const columns = Array.from({ length: columnCount }, (_, columnIndex) => assets.filter((_, assetIndex) => assetIndex % columnCount === columnIndex));
  const renderCard = (asset: Asset): ReactElement => <AssetCard key={asset.id} asset={asset} onOpen={() => onOpen(asset)} selected={selectedIds?.has(asset.id)} onSelect={onSelect ? () => onSelect(asset.id) : undefined} />;
  if (loading)
    return (
      <div className="asset-grid" style={{ "--asset-columns": columnCount } as CSSProperties}>
        {columns.map((_, columnIndex) => (
          <div className="asset-grid-column" key={columnIndex}>
            {Array.from({ length: Math.ceil(8 / columnCount) }).map((__, skeletonIndex) => (
              <div className="skeleton asset-skeleton" key={skeletonIndex} />
            ))}
          </div>
        ))}
      </div>
    );
  if (error) return <ErrorState message={error} />;
  if (!assets.length) return <EmptyState icon="◈" title="Nothing here yet" message={empty} />;
  return (
    <div className="asset-grid" style={{ "--asset-columns": columnCount } as CSSProperties}>
      {columns.map((column, columnIndex) => (
        <div className="asset-grid-column" key={columnIndex}>
          {column.map(renderCard)}
        </div>
      ))}
    </div>
  );
}

function EmptyState({ icon, title, message, action }: { icon: string; title: string; message: string; action?: ReactNode }): ReactElement {
  return (
    <div className="empty-state">
      <div className="empty-icon"><Icon name={icon} /></div>
      <h3>{title}</h3>
      <p>{message}</p>
      {action}
    </div>
  );
}
function ErrorState({ message, retry }: { message: string; retry?: () => void }): ReactElement {
  return (
    <div className="error-state">
      <div className="error-icon"><Icon name="alert" /></div>
      <div>
        <strong>Something went wrong</strong>
        <p>{message}</p>
        {retry && <Button onClick={retry}>Try again</Button>}
      </div>
    </div>
  );
}
function SectionHeader({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: ReactNode }): ReactElement {
  return (
    <div className="section-header">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {action}
    </div>
  );
}
function StatCard({ label, value, detail, icon, tone = "green" }: { label: string; value: number | string; detail?: string; icon: string; tone?: string }): ReactElement {
  return (
    <div className={`stat-card tone-${tone}`}>
      <div className="stat-top">
        <span className="stat-icon">
          <Icon name={icon} />
        </span>
        <span className="stat-detail">{detail}</span>
      </div>
      <div className="stat-value">{typeof value === "number" ? compact(value) : value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function Shell({ route, children, onSearch }: { route: { page: PageKey; id?: string }; children: ReactNode; onSearch: () => void }): ReactElement {
  const links: { key: PageKey; label: string; icon: string }[] = [
    { key: "home", label: "Home", icon: "home" },
    { key: "collections", label: "Collections", icon: "collections" },
    { key: "projects", label: "Projects", icon: "projects" },
  ];
  const [collapsed, setCollapsed] = useState(() => typeof window !== "undefined" && window.innerWidth <= 860);
  const wasMobile = useRef(typeof window !== "undefined" && window.innerWidth <= 860);
  useEffect(() => {
    const handleResize = (): void => {
      const isMobile = window.innerWidth <= 860;
      if (isMobile !== wasMobile.current) {
        setCollapsed(isMobile);
        wasMobile.current = isMobile;
      }
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);
  const goTo = (path: string): void => {
    navigate(path);
    if (window.innerWidth <= 860) setCollapsed(true);
  };
  return (
    <div className={`app-shell ${collapsed ? "sidebar-collapsed" : ""}`}>
      <aside className="sidebar" id="tokia-sidebar" aria-label="Workspace navigation">
        <div className="brand">
          <div className="brand-mark">
            <img src="/tokia-rocket.svg" alt="" />
          </div>
          <span className="brand-copy">
            <strong>Tokia</strong>
            <small>Creative workspace</small>
          </span>
        </div>
        <nav className="nav-list" aria-label="Main navigation">
          {links.map((link) => (
            <button
              key={link.key}
              className={`nav-item ${route.page === link.key ? "active" : ""}`}
              onClick={() => goTo(link.key === "home" ? "/" : `/${link.key}`)}
              aria-current={route.page === link.key ? "page" : undefined}
              title={collapsed ? link.label : undefined}
            >
              <Icon name={link.icon} />
              <span>{link.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            className={`nav-item ${route.page === "settings" ? "active" : ""}`}
            onClick={() => goTo("/settings")}
            aria-current={route.page === "settings" ? "page" : undefined}
            title={collapsed ? "Settings" : undefined}
          >
            <Icon name="settings" />
            <span>Settings</span>
          </button>
          <div className="connection-card">
            <span className="online-dot" />
            <span className="connection-copy">
              <strong>Backend online</strong>
              <small>Local workspace</small>
            </span>
          </div>
          <button className="collapse-button" onClick={() => setCollapsed((value) => !value)} aria-label="Toggle sidebar">
            <Icon name={collapsed ? "arrow-right" : "arrow-left"} />
          </button>
        </div>
      </aside>
      {!collapsed && <button className="sidebar-scrim" onClick={() => setCollapsed(true)} aria-label="Close navigation" />}
      <main className="main-area">
        <header className="topbar">
          <button
            className="mobile-menu"
            onClick={() => setCollapsed((value) => !value)}
            aria-label="Toggle navigation"
            aria-controls="tokia-sidebar"
            aria-expanded={!collapsed}
          >
            <Icon name="menu" />
          </button>
          <button className="global-search" onClick={onSearch} aria-label="Search workspace">
            <Icon name="search" />
            <span>Search collections, assets, projects...</span>
            <kbd>⌘ K</kbd>
          </button>
          <div className="topbar-actions">
            <span className="workspace-label">
              <strong>Local workspace</strong>
              <small>Private library</small>
            </span>
            <div className="avatar">TK</div>
          </div>
        </header>
        <div className="page-content">{children}</div>
      </main>
    </div>
  );
}

function DashboardPage({ onOpenAsset }: { onOpenAsset: (asset: Asset) => void }): ReactElement {
  const { data, loading, error } = useApi<Dashboard>("/api/dashboard");
  if (loading) return <PageLoading />;
  if (error || !data) return <ErrorState message={error ?? "Dashboard is unavailable"} />;
  const { stats } = data;
  const imagePercent = stats.totalAssets ? Math.round((stats.totalImages / stats.totalAssets) * 100) : 0;
  return (
    <>
      <SectionHeader
        eyebrow="Overview"
        title="Good to see you"
        description="Everything happening across your creative library, at a glance."
        action={
          <Button variant="primary" onClick={() => navigate("/collections")}>
            <Icon name="collections" /> Browse collections
          </Button>
        }
      />
      <section className="stats-grid" aria-label="Library overview">
        <StatCard label="Collections" value={stats.totalCollections} detail="all sources" icon="collections" />
        <StatCard label="Total assets" value={stats.totalAssets} detail="across library" icon="assets" tone="violet" />
        <StatCard label="Images" value={stats.totalImages} detail={`${imagePercent}% of library`} icon="image" tone="cyan" />
        <StatCard label="Videos" value={stats.totalVideos} detail="ready to review" icon="video" tone="orange" />
      </section>
      <div className="dashboard-grid">
        <section className="panel recent-panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">Library pulse</div>
              <h2>Recently imported</h2>
              <p className="panel-subtitle">The newest additions from your connected collections.</p>
            </div>
            <button className="text-button" onClick={() => navigate("/assets")}>
              View all <Icon name="arrow" />
            </button>
          </div>
          <div className="recent-assets">
            {data.recentAssets.slice(0, 6).map((asset) => (
              <button className="recent-asset" key={asset.id} onClick={() => onOpenAsset(asset)}>
                <div className="recent-thumb">
                  <MediaPreview asset={asset} />
                </div>
                <div>
                  <strong>{asset.title ?? asset.altText ?? "Untitled asset"}</strong>
                  <span>
                    {asset.collectionName ?? "Unassigned"} · {formatDate(asset.createdAt)}
                  </span>
                </div>
                <Icon name="arrow" />
              </button>
            ))}
          </div>
        </section>
        <section className="panel distribution-panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">Media mix</div>
              <h2>Library composition</h2>
              <p className="panel-subtitle">A quick view of the formats available for your next project.</p>
            </div>
            <span className="panel-caption">{compact(stats.totalAssets)} assets</span>
          </div>
          <div className="donut-wrap">
            <div className="donut" style={{ "--percent": `${imagePercent}%` } as CSSProperties}>
              <div>
                <strong>{imagePercent}%</strong>
                <span>images</span>
              </div>
            </div>
            <div className="legend">
              <div>
                <span className="legend-dot green" /> Images <strong>{compact(stats.totalImages)}</strong>
              </div>
              <div>
                <span className="legend-dot violet" /> Videos <strong>{compact(stats.totalVideos)}</strong>
              </div>
              <div>
                <span className="legend-dot muted" /> Other <strong>{compact(Math.max(0, stats.totalAssets - stats.totalImages - stats.totalVideos))}</strong>
              </div>
            </div>
          </div>
          <div className="quick-actions">
            <button onClick={() => navigate("/imports")}>
              <Icon name="imports" /> Review imports
            </button>
            <button onClick={() => navigate("/projects")}>
              <Icon name="plus" /> Create project
            </button>
          </div>
        </section>
      </div>
      <div className="dashboard-grid lower-grid">
        <section className="panel collections-panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">Most used sources</div>
              <h2>Collections by volume</h2>
            </div>
            <button className="text-button" onClick={() => navigate("/collections")}>
              Explore <Icon name="arrow" />
            </button>
          </div>
          <div className="collection-rank-list">
            {data.topCollections.map((collection, index) => (
              <button className="rank-row" key={collection.id} onClick={() => navigate(`/collection/${collection.id}`)}>
                <span className="rank-number">0{index + 1}</span>
                <div className="rank-info">
                  <strong>{collection.name}</strong>
                  <span>
                    {collection.imageCount} images · {collection.videoCount} videos
                  </span>
                </div>
                <div className="rank-bar">
                  <span
                    style={{
                      width: `${Math.min(100, (collection.assetCount / Math.max(1, data.topCollections[0]?.assetCount ?? 1)) * 100)}%`,
                    }}
                  />
                </div>
                <b>{compact(collection.assetCount)}</b>
              </button>
            ))}
          </div>
        </section>
        <section className="panel imports-panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">Import health</div>
              <h2>Latest runs</h2>
            </div>
            <button className="text-button" onClick={() => navigate("/imports")}>
              All runs <Icon name="arrow" />
            </button>
          </div>
          <div className="run-list">
            {data.recentImports.slice(0, 4).map((run) => (
              <div className="run-row" key={run.id}>
                <div className="run-icon">
                  <Icon name={run.status === "failed" ? "alert" : "check"} />
                </div>
                <div>
                  <strong>{run.collectionName ?? "Unknown collection"}</strong>
                  <span>
                    {run.assetsCreated} new · {run.duplicatesSkipped} duplicates · {formatDateTime(run.createdAt ?? run.startedAt)}
                  </span>
                </div>
                <StatusBadge value={run.status} />
              </div>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}

function PageLoading(): ReactElement {
  return (
    <div className="page-loading">
      <div className="spinner" />
      <span>Loading workspace…</span>
    </div>
  );
}

function CollectionCard({ collection }: { collection: Collection }): ReactElement {
  return (
    <button className="collection-card" onClick={() => navigate(`/collection/${collection.id}`)}>
      <div className="collection-cover">
        {collection.coverPreviewUrl ? (
          <img src={collection.coverPreviewUrl} alt="" loading="lazy" />
        ) : (
          <div className="cover-pattern">
            <span /> <span /> <span />
          </div>
        )}
        <span className="source-pill">{collection.provider}</span>
        <span className="card-arrow">
          <Icon name="arrow" />
        </span>
      </div>
      <div className="collection-card-content">
        <div className="collection-title-row">
          <h3>{collection.name}</h3>
          <StatusBadge value={collection.status} />
        </div>
        <p>{collection.description ?? "No local description yet."}</p>
        <div className="collection-stats">
          <span>
            <Icon name="assets" /> {compact(collection.assetCount)} assets
          </span>
          <span>
            <Icon name="image" /> {collection.imageCount}
          </span>
          <span>
            <Icon name="video" /> {collection.videoCount}
          </span>
        </div>
        <div className="collection-updated">Updated {formatDate(collection.updatedAt ?? collection.lastImportedAt)}</div>
      </div>
    </button>
  );
}

function CollectionsPage(): ReactElement {
  const [search, setSearch] = useState("");
  const [media, setMedia] = useState("");
  const [sort, setSort] = useState("updatedAt");
  const query = new URLSearchParams({ pageSize: "24", sort });
  if (search) query.set("search", search);
  if (media === "image") query.set("hasImages", "true");
  if (media === "video") query.set("hasVideos", "true");
  const { data, loading, error } = useApi<{
    items: Collection[];
    pagination: Pagination;
  }>(`/api/collections?${query.toString()}`, 0);
  return (
    <>
      <SectionHeader
        eyebrow="Library"
        title="Collections"
        description="Reusable source boards, organized for review and future projects."
        action={
          <Button variant="primary" onClick={() => navigate("/imports")}>
            <Icon name="imports" /> Review latest import
          </Button>
        }
      />
      <div className="toolbar">
        <label className="search-field">
          <Icon name="search" />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search collections…" />
        </label>
        <select value={media} onChange={(event) => setMedia(event.target.value)}>
          <option value="">All media</option>
          <option value="image">Contains images</option>
          <option value="video">Contains videos</option>
        </select>
        <select value={sort} onChange={(event) => setSort(event.target.value)}>
          <option value="updatedAt">Recently updated</option>
          <option value="assetCount">Most assets</option>
          <option value="name">Name</option>
          <option value="lastImportedAt">Recently imported</option>
        </select>
        <div className="toolbar-spacer" />
        <span className="result-count">{data ? `${data.pagination.total} collections` : "—"}</span>
      </div>
      {error ? (
        <ErrorState message={error} />
      ) : loading ? (
        <div className="collection-grid">
          {Array.from({ length: 6 }).map((_, index) => (
            <div className="skeleton collection-skeleton" key={index} />
          ))}
        </div>
      ) : data?.items.length ? (
        <div className="collection-grid">
          {data.items.map((collection) => (
            <CollectionCard collection={collection} key={collection.id} />
          ))}
        </div>
      ) : (
        <EmptyState
          icon="▦"
          title="No collections found"
          message={search ? "Try a different search term." : "Import a board with the Tokia browser extension to get started."}
          action={
            <Button variant="primary" onClick={() => navigate("/imports")}>
              See import runs
            </Button>
          }
        />
      )}
    </>
  );
}

function CollectionDetailPage({ id, onOpenAsset }: { id: string; onOpenAsset: (asset: Asset) => void }): ReactElement {
  const [tab, setTab] = useState("all");
  const [search, setSearch] = useState("");
  const [refresh, setRefresh] = useState(0);
  const collection = useApi<Collection & { cover?: Asset }>(`/api/collections/${id}`, refresh);
  const query = new URLSearchParams({ sort: "seen" });
  if (tab !== "all") query.set("mediaType", tab === "images" ? "image" : "video");
  if (search) query.set("search", search);
  const assets = useInfiniteAssets<Asset>(`/api/collections/${id}/assets?${query.toString()}`, refresh);
  if (collection.loading) return <PageLoading />;
  if (collection.error || !collection.data) return <ErrorState message={collection.error ?? "Collection not found"} />;
  const item = collection.data;
  return (
    <>
      <button className="back-link" onClick={() => navigate("/collections")}>
        ← Back to collections
      </button>
      <div className="detail-hero">
        <div className="detail-cover">
          {item.cover ? (
            <MediaPreview asset={item.cover} />
          ) : (
            <div className="cover-pattern large">
              <span />
              <span />
              <span />
            </div>
          )}
        </div>
        <div className="detail-copy">
          <div className="eyebrow">{item.provider} collection</div>
          <h1>{item.name}</h1>
          <p>{item.description ?? "A reusable media source with no local description yet."}</p>
          <div className="detail-meta">
            <span>
              <Icon name="assets" /> {item.assetCount} assets
            </span>
            <span>
              <Icon name="image" /> {item.imageCount} images
            </span>
            <span>
              <Icon name="video" /> {item.videoCount} videos
            </span>
            <span>
              <Icon name="clock" /> Imported {formatDate(item.lastImportedAt)}
            </span>
          </div>
          <div className="detail-actions">
            <Button variant="primary" onClick={() => item.canonicalSourceUrl && window.open(item.canonicalSourceUrl, "_blank", "noopener,noreferrer")}>
              <Icon name="arrow" /> Open source
            </Button>
            <Button onClick={() => setRefresh((value) => value + 1)}>Refresh</Button>
            <StatusBadge value={item.status} />
          </div>
        </div>
      </div>
      <div className="tabs">
        <button className={tab === "all" ? "active" : ""} onClick={() => setTab("all")}>
          All media <span>{item.assetCount}</span>
        </button>
        <button className={tab === "images" ? "active" : ""} onClick={() => setTab("images")}>
          Images <span>{item.imageCount}</span>
        </button>
        <button className={tab === "videos" ? "active" : ""} onClick={() => setTab("videos")}>
          Videos <span>{item.videoCount}</span>
        </button>
        <button className={tab === "info" ? "active" : ""} onClick={() => setTab("info")}>
          Collection info
        </button>
      </div>
      {tab === "info" ? (
        <CollectionInfo collection={item} />
      ) : (
        <>
          <div className="toolbar compact-toolbar">
            <label className="search-field">
              <Icon name="search" />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search captions and descriptions…" />
            </label>
            <span className="result-count">{assets.pagination ? `${assets.pagination.total} results` : "—"}</span>
          </div>
          <AssetGrid assets={assets.items} loading={assets.loading} error={assets.error} onOpen={onOpenAsset} empty="This collection has no media for the selected view." />
          <InfiniteAssetFooter state={assets} />
        </>
      )}
    </>
  );
}
function CollectionInfo({ collection }: { collection: Collection }): ReactElement {
  return (
    <div className="info-grid">
      <div className="info-card">
        <span>Source board</span>
        <strong>{collection.sourceName ?? collection.name}</strong>
        <a href={collection.canonicalSourceUrl} target="_blank" rel="noreferrer">
          {collection.canonicalSourceUrl}
        </a>
      </div>
      <div className="info-card">
        <span>Last successful import</span>
        <strong>{formatDateTime(collection.lastSuccessfulImportAt)}</strong>
        <small>Collection records are preserved through re-imports.</small>
      </div>
      <div className="info-card">
        <span>Local status</span>
        <strong>
          <StatusBadge value={collection.status} />
        </strong>
        <small>Archive and local metadata controls are available through the API.</small>
      </div>
    </div>
  );
}

function AssetsPage({ onOpenAsset }: { onOpenAsset: (asset: Asset) => void }): ReactElement {
  const [search, setSearch] = useState("");
  const [media, setMedia] = useState("");
  const [orientationFilter, setOrientationFilter] = useState("");
  const [sort, setSort] = useState("seen");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const query = new URLSearchParams({ pageSize: "60", sort });
  if (search) query.set("search", search);
  if (media) query.set("mediaType", media);
  if (orientationFilter) query.set("orientation", orientationFilter);
  const assets = useApi<{ items: Asset[]; pagination: Pagination }>(`/api/assets?${query.toString()}`);
  return (
    <>
      <SectionHeader
        eyebrow="Library"
        title="All assets"
        description="Search and review media across every collection."
        action={
          selected.size > 0 ? (
            <span className="selection-label">{selected.size} selected</span>
          ) : (
            <Button variant="secondary" onClick={() => setSelected(new Set())}>
              <Icon name="filter" /> Refine library
            </Button>
          )
        }
      />
      <div className="toolbar">
        <label className="search-field wide">
          <Icon name="search" />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search titles, captions, source IDs…" />
        </label>
        <select value={media} onChange={(event) => setMedia(event.target.value)}>
          <option value="">All types</option>
          <option value="image">Images</option>
          <option value="video">Videos</option>
        </select>
        <select value={orientationFilter} onChange={(event) => setOrientationFilter(event.target.value)}>
          <option value="">All orientations</option>
          <option value="portrait">Portrait</option>
          <option value="landscape">Landscape</option>
          <option value="square">Square</option>
        </select>
        <select value={sort} onChange={(event) => setSort(event.target.value)}>
          <option value="seen">Recently seen</option>
          <option value="newest">Newest</option>
          <option value="dimensions">Largest dimensions</option>
          <option value="duration">Longest videos</option>
        </select>
      </div>
      <AssetGrid
        assets={assets.data?.items ?? []}
        loading={assets.loading}
        error={assets.error}
        onOpen={onOpenAsset}
        selectedIds={selected}
        onSelect={(id) =>
          setSelected((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          })
        }
        empty="Imported assets will appear here."
      />
    </>
  );
}

function ProjectsPage({ onEdit }: { onEdit: (project?: Project) => void }): ReactElement {
  const { data, loading, error } = useApi<{
    items: Project[];
    pagination: Pagination;
  }>("/api/projects?pageSize=100");
  return (
    <>
      <SectionHeader
        eyebrow="Workspace"
        title="Projects"
        description="Turn reusable source collections into finished content assets."
        action={
          <Button variant="primary" onClick={() => onEdit()}>
            <Icon name="plus" /> New project
          </Button>
        }
      />
      <div className="project-intro">
        <div>
          <span className="intro-icon">◒</span>
          <div>
            <strong>One project, many reusable assets</strong>
            <p>Projects remember your niche, language, visual defaults, and source collections for repeatable content creation.</p>
          </div>
        </div>
        <span className="future-label">Generation and publishing stay separate</span>
      </div>
      {error ? (
        <ErrorState message={error} />
      ) : loading ? (
        <div className="project-grid">
          {Array.from({ length: 3 }).map((_, index) => (
            <div className="skeleton project-skeleton" key={index} />
          ))}
        </div>
      ) : data?.items.length ? (
        <div className="project-grid">
          {data.items.map((project) => (
            <ProjectCard key={project.id} project={project} onEdit={() => onEdit(project)} />
          ))}
        </div>
      ) : (
        <EmptyState
          icon="◒"
          title="No projects yet"
          message="Create a project to start generating reusable content."
          action={
            <Button variant="primary" onClick={() => onEdit()}>
              <Icon name="plus" /> Create first project
            </Button>
          }
        />
      )}
    </>
  );
}
function ProjectCard({ project, onEdit }: { project: Project; onEdit: () => void }): ReactElement {
  return (
    <article className="project-card">
      <button className="project-card-main" onClick={() => navigate(`/project/${project.id}`)}>
        <div className="project-card-top">
          <div className="project-cover">
            <span>{project.name.slice(0, 1).toUpperCase()}</span>
          </div>
          <StatusBadge value={project.status} />
        </div>
        <h3>{project.name}</h3>
        <p>{project.niche ?? project.description ?? "No niche configured yet."}</p>
        <div className="project-metrics">
          <span>
            <b>{compact(project.contentCount ?? 0)}</b> content
          </span>
          <span>
            <b>{compact(project.totalAssets)}</b> assets
          </span>
          <span>
            <b>{project.readyCount ?? 0}</b> ready
          </span>
        </div>
      </button>
      <div className="project-footer">
        <span>{project.collectionCount} collections</span>
        <span>Updated {formatDate(project.updatedAt)}</span>
        <button className="card-edit" onClick={onEdit} aria-label="Edit project">
          <Icon name="edit" /> Edit
        </button>
      </div>
    </article>
  );
}

function ProjectDetailPage({ id, onEdit, onOpenAsset, onCreateContent, onOpenContent, onDeleted, onContentChanged, refresh = 0 }: { id: string; onEdit: (project: Project) => void; onOpenAsset: (asset: Asset) => void; onCreateContent: (project: Project) => void; onOpenContent: (content: ContentSummary) => void; onDeleted: () => void; onContentChanged: () => void; refresh?: number }): ReactElement {
  const { data, loading, error } = useApi<Project>(`/api/projects/${id}`, refresh);
  const [titleEditor, setTitleEditor] = useState<ContentSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ContentSummary | null>(null);
  const contents = useApi<{ items: ContentSummary[]; pagination: Pagination }>(`/api/projects/${id}/content?pageSize=50`, refresh);
  const [deleteOpen, setDeleteOpen] = useState(false);
  if (loading) return <PageLoading />;
  if (error || !data) return <ErrorState message={error ?? "Project not found"} />;
  const project = data;
  return (
    <>
      <button className="back-link" onClick={() => navigate("/projects")}>
        ← Back to projects
      </button>
      <div className="project-detail-hero">
        <div className="project-detail-mark">{project.name.slice(0, 1).toUpperCase()}</div>
        <div>
          <div className="eyebrow">Project workspace · {project.niche ?? "No niche configured"}</div>
          <h1>{project.name}</h1>
          <p>{project.description ?? "A reusable space for finished content assets."}</p>
          <div className="detail-actions">
            <StatusBadge value={project.status} />
            <Button variant="primary" onClick={() => onCreateContent(project)}>
              <Icon name="plus" /> Create content
            </Button>
            <Button onClick={() => onEdit(project)}>
              <Icon name="edit" /> Settings
            </Button>
          </div>
        </div>
      </div>
      <div className="stats-grid project-stats">
        <StatCard label="Total content" value={project.contentCount ?? 0} detail={`${project.draftCount ?? 0} drafts`} icon="assets" />
        <StatCard label="Ready" value={project.readyCount ?? 0} detail="final assets" icon="check" tone="cyan" />
        <StatCard label="Generating" value={project.generatingCount ?? 0} detail="background jobs" icon="clock" tone="violet" />
        <StatCard label="Source media" value={project.totalAssets} detail={`${project.imageCount} images · ${project.videoCount} videos`} icon="collections" tone="orange" />
      </div>
      <section className="panel content-list-panel">
        <div className="panel-heading">
          <div>
            <div className="eyebrow">Content</div>
            <h2>Reusable assets</h2>
          </div>
          <span className="panel-caption">No automatic publishing</span>
        </div>
        {contents.loading ? (
          <div className="selection-loading">Loading content…</div>
        ) : contents.error ? (
          <ErrorState message={contents.error} />
        ) : contents.data?.items.length ? (
          <div className="content-list">
            {contents.data.items.map((item) => (
              <div className="content-list-row" key={item.id}>
                <button className="content-list-main" onClick={() => onOpenContent(item)}>
                  <div className="content-list-thumb">{item.thumbnailUrl ? <img src={`${API_BASE}${item.thumbnailUrl}`} alt="" /> : <span>{item.type === "carousel" ? "▤" : item.type === "video_slideshow" ? "▶" : item.type === "video_clipping" ? "✂" : "▧"}</span>}</div>
                  <div className="content-list-copy">
                    <strong>{item.title ?? item.topic ?? "Untitled draft"}</strong>
                    <span>
                      {item.type.replaceAll("_", " ")} · {item.frameCount} frames · updated {formatDate(item.updatedAt)}
                    </span>
                  </div>
                  <StatusBadge value={item.status} />
                  <Icon name="arrow" />
                </button>
                <div className="content-list-actions">
                  <button className="content-action-button" onClick={() => setTitleEditor(item)} aria-label={`Edit title for ${item.title ?? item.topic ?? "content"}`}>
                    <Icon name="edit" /> Edit title
                  </button>
                  <button className="content-action-button content-action-danger" onClick={() => setDeleteTarget(item)} aria-label={`Delete ${item.title ?? item.topic ?? "content"}`}>
                    <Icon name="archive" /> Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon="◈"
            title="No content yet"
            message="Create a single image, carousel, or video slideshow from this project."
            action={
              <Button variant="primary" onClick={() => onCreateContent(project)}>
                <Icon name="plus" /> Create first content
              </Button>
            }
          />
        )}
      </section>
      <div className="detail-two-column">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">Sources</div>
              <h2>Connected collections</h2>
            </div>
            <button className="text-button" onClick={() => onEdit(project)}>
              Manage <Icon name="edit" />
            </button>
          </div>
          {project.collections?.length ? (
            <div className="linked-collections">
              {project.collections.map((collection) => (
                <button className="linked-collection" key={collection.id} onClick={() => navigate(`/collection/${collection.id}`)}>
                  <div className="linked-cover">{collection.coverPreviewUrl ? <img src={collection.coverPreviewUrl} alt="" /> : <span>{collection.name.slice(0, 1)}</span>}</div>
                  <div>
                    <strong>{collection.name}</strong>
                    <span>
                      {collection.assetCount} assets · {collection.imageCount} images · {collection.videoCount} videos
                    </span>
                  </div>
                  <Icon name="arrow" />
                </button>
              ))}
            </div>
          ) : (
            <EmptyState icon="▦" title="No collections linked" message="Edit the project to choose reusable sources." />
          )}
        </section>
        <section className="panel project-media-panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">Available source media</div>
              <h2>Recent images and videos</h2>
            </div>
            <span className="panel-caption">Original records are never copied</span>
          </div>
          <AssetGrid assets={project.recentAssets ?? []} loading={false} error={null} onOpen={onOpenAsset} empty="Connected collections have no available media." />
        </section>
      </div>
      <section className="panel project-danger-zone">
        <div>
          <div className="eyebrow">Project management</div>
          <h2>Delete project</h2>
          <p>This hides the project from Tokia while preserving its content, source links, and history in the database.</p>
        </div>
        <Button variant="danger" onClick={() => setDeleteOpen(true)}>
          <Icon name="archive" /> Delete project
        </Button>
      </section>
      {deleteOpen && <ProjectDeleteDialog project={project} onClose={() => setDeleteOpen(false)} onDeleted={onDeleted} />}
      {titleEditor && <ContentTitleDialog content={titleEditor} onClose={() => setTitleEditor(null)} onSaved={() => { setTitleEditor(null); onContentChanged(); }} />}
      {deleteTarget && <ContentDeleteDialog content={deleteTarget} onClose={() => setDeleteTarget(null)} onDeleted={() => { setDeleteTarget(null); onContentChanged(); }} />}
    </>
  );
}

function ProjectDeleteDialog({ project, onClose, onDeleted }: { project: Project; onClose: () => void; onDeleted: () => void }): ReactElement {
  const [confirmation, setConfirmation] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const matches = confirmation.trim() === project.name;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!matches) return;
    setSaving(true);
    setError("");
    try {
      await request(`/api/projects/${project.id}`, { method: "DELETE" });
      onDeleted();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete project");
      setSaving(false);
    }
  };
  return (
    <Modal title="Delete project" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="danger-callout">
          <strong>This is a soft delete.</strong>
          <p>The project and its related data will remain in the database, but the project will no longer appear in the normal UI.</p>
        </div>
        <label className="form-field">
          <span>Type the project name to confirm</span>
          <input autoFocus value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder={project.name} />
        </label>
        {error && <div className="inline-error">{error}</div>}
        <div className="modal-footer">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" type="submit" disabled={!matches || saving}>
            {saving ? "Deleting…" : "Delete project"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ContentTitleDialog({ content, onClose, onSaved }: { content: ContentSummary; onClose: () => void; onSaved: () => void }): ReactElement {
  const [title, setTitle] = useState(content.title ?? content.topic ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) {
      setError("A content title is required.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await request(`/api/content/${content.id}`, { method: "PATCH", body: JSON.stringify({ title: title.trim() }) });
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update content title");
      setSaving(false);
    }
  };
  return (
    <Modal title="Edit content title" onClose={onClose}>
      <form onSubmit={submit}>
        <label className="form-field">
          <span>Content title</span>
          <input autoFocus maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Evening routine" />
        </label>
        <div className="inline-note">This changes the title shown in the project. The caption and generated copy remain unchanged.</div>
        {error && <div className="inline-error">{error}</div>}
        <div className="modal-footer">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={saving || !title.trim()}>
            {saving ? "Saving…" : "Save title"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ContentDeleteDialog({ content, onClose, onDeleted }: { content: ContentSummary; onClose: () => void; onDeleted: () => void }): ReactElement {
  const displayTitle = content.title ?? content.topic ?? "Untitled draft";
  const [confirmation, setConfirmation] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const matches = confirmation.trim() === displayTitle;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!matches) return;
    setSaving(true);
    setError("");
    try {
      await request(`/api/content/${content.id}`, { method: "DELETE" });
      onDeleted();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete content");
      setSaving(false);
    }
  };
  return (
    <Modal title="Delete content" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="danger-callout">
          <strong>This is a soft delete.</strong>
          <p>The content and its generated assets remain in the database, but this item will no longer appear in the project.</p>
        </div>
        <label className="form-field">
          <span>Type the content title to confirm</span>
          <input autoFocus value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder={displayTitle} />
        </label>
        {error && <div className="inline-error">{error}</div>}
        <div className="modal-footer">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" type="submit" disabled={!matches || saving}>
            {saving ? "Deleting…" : "Delete content"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ImportsPage(): ReactElement {
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState<ImportRun | null>(null);
  const query = status ? `?status=${status}` : "";
  const { data, loading, error } = useApi<{
    items: ImportRun[];
    pagination: Pagination;
  }>(`/api/import-runs${query}`);
  return (
    <>
      <SectionHeader
        eyebrow="Operations"
        title="Import runs"
        description="Trace what the browser extension sent and how the library changed."
        action={
          <Button variant="secondary" onClick={() => navigate("/settings")}>
            <Icon name="settings" /> Connection settings
          </Button>
        }
      />
      <div className="toolbar">
        <select value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">All statuses</option>
          <option value="completed">Completed</option>
          <option value="completed_with_warnings">With warnings</option>
          <option value="failed">Failed</option>
        </select>
        <span className="result-count">{data ? `${data.pagination.total} runs` : "—"}</span>
      </div>
      {error ? (
        <ErrorState message={error} />
      ) : loading ? (
        <PageLoading />
      ) : data?.items.length ? (
        <div className="table-card">
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Collection</th>
                <th>Result</th>
                <th>Records</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.items.map((run) => (
                <tr key={run.id} onClick={() => setSelected(run)}>
                  <td>
                    <strong className="mono">{run.id.slice(0, 8)}</strong>
                    <span className="table-sub">{run.sourceUrl.replace(/^https?:\/\//, "").slice(0, 34)}</span>
                  </td>
                  <td>{run.collectionName ?? "—"}</td>
                  <td>
                    <StatusBadge value={run.status} />
                    <span className="table-sub">
                      {run.assetsCreated} new · {run.duplicatesSkipped} dupes
                    </span>
                  </td>
                  <td>
                    {run.recordsReceived} received
                    <br />
                    <span className="table-sub">{run.recordsInvalid} invalid</span>
                  </td>
                  <td>{formatDateTime(run.createdAt ?? run.startedAt)}</td>
                  <td>
                    <Icon name="arrow" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState icon="↥" title="No import runs yet" message="Your browser extension import history will appear here." />
      )}
      {selected && <ImportDialog run={selected} onClose={() => setSelected(null)} />}
    </>
  );
}
function ImportDialog({ run, onClose }: { run: ImportRun; onClose: () => void }): ReactElement {
  return (
    <Modal title="Import run details" onClose={onClose}>
      <div className="dialog-run-header">
        <div className="run-icon">
          <Icon name={run.status === "failed" ? "alert" : "check"} />
        </div>
        <div>
          <StatusBadge value={run.status} />
          <h3>{run.collectionName ?? "Unknown collection"}</h3>
          <p>
            {formatDateTime(run.startedAt)} · {run.id}
          </p>
        </div>
      </div>
      <div className="run-stats">
        <div>
          <strong>{run.recordsReceived}</strong>
          <span>received</span>
        </div>
        <div>
          <strong>{run.assetsCreated}</strong>
          <span>new assets</span>
        </div>
        <div>
          <strong>{run.assetsUpdated}</strong>
          <span>updated</span>
        </div>
        <div>
          <strong>{run.duplicatesSkipped}</strong>
          <span>duplicates</span>
        </div>
        <div>
          <strong>{run.recordsInvalid}</strong>
          <span>invalid</span>
        </div>
      </div>
      {run.errorMessage && <div className="inline-error">{run.errorMessage}</div>}
      <details>
        <summary>Developer details</summary>
        <pre>{JSON.stringify(run, null, 2)}</pre>
      </details>
    </Modal>
  );
}

const extensionIdPattern = /^[a-p]{32}$/i;

function extensionIdFromMessage(event: MessageEvent): string | null {
  if (event.source !== window || event.origin !== window.location.origin) return null;
  const data = event.data as { source?: string; type?: string; extensionId?: unknown } | undefined;
  if (data?.source !== "tokia-browser-extension" || data.type !== "EXTENSION_ID") return null;
  if (typeof data.extensionId !== "string" || !extensionIdPattern.test(data.extensionId)) return null;
  return data.extensionId.toLowerCase();
}

function extensionConfigurationFromMessage(event: MessageEvent): { extensionId: string; ok: boolean; error?: string } | null {
  if (event.source !== window || event.origin !== window.location.origin) return null;
  const data = event.data as { source?: string; type?: string; extensionId?: unknown; ok?: unknown; error?: unknown } | undefined;
  if (data?.source !== "tokia-browser-extension" || data.type !== "EXTENSION_CONFIGURED") return null;
  if (typeof data.extensionId !== "string" || !extensionIdPattern.test(data.extensionId)) return null;
  return {
    extensionId: data.extensionId.toLowerCase(),
    ok: data.ok === true,
    error: typeof data.error === "string" ? data.error : undefined,
  };
}

function configureExtension(extensionId: string, backendUrl: string, integrationToken: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let timeout = 0;
    const cleanup = (): void => {
      window.removeEventListener("message", onMessage);
      window.clearTimeout(timeout);
    };
    const onMessage = (event: MessageEvent): void => {
      const result = extensionConfigurationFromMessage(event);
      if (!result || result.extensionId !== extensionId) return;
      cleanup();
      if (result.ok) resolve();
      else reject(new Error(result.error ?? "The extension settings could not be saved."));
    };
    window.addEventListener("message", onMessage);
    timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("The extension was detected, but it did not confirm its settings update."));
    }, 1800);
    window.postMessage(
      { source: "tokia-web-app", type: "CONFIGURE_EXTENSION", extensionId, backendUrl, integrationToken },
      window.location.origin,
    );
  });
}

function BrowserExtensionSettings({
  initialId,
  backendUrl,
  onSaved,
}: {
  initialId?: string | null;
  backendUrl: string;
  onSaved: (value: AnyRecord) => void;
}): ReactElement {
  const [extensionId, setExtensionId] = useState(initialId ?? "");
  const [detectedExtensionId, setDetectedExtensionId] = useState<string | null>(null);
  const [detectionState, setDetectionState] = useState<"checking" | "detected" | "missing">("checking");
  const [detectionAttempt, setDetectionAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [rotatingToken, setRotatingToken] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => setExtensionId(initialId ?? ""), [initialId]);
  useEffect(() => {
    let active = true;
    let hasDetectedExtension = false;
    const handleMessage = (event: MessageEvent): void => {
      const detectedId = extensionIdFromMessage(event);
      if (detectedId && active) {
        hasDetectedExtension = true;
        setDetectedExtensionId(detectedId);
        setDetectionState("detected");
      }
    };
    setDetectedExtensionId(null);
    setDetectionState("checking");
    window.addEventListener("message", handleMessage);
    window.postMessage(
      { source: "tokia-web-app", type: "REQUEST_EXTENSION_ID" },
      window.location.origin,
    );
    const timeout = window.setTimeout(() => {
      if (active && !hasDetectedExtension) setDetectionState("missing");
    }, 1800);
    return () => {
      active = false;
      window.clearTimeout(timeout);
      window.removeEventListener("message", handleMessage);
    };
  }, [detectionAttempt]);

  const saveExtensionId = async (value: string): Promise<void> => {
    const saved = await request<AnyRecord>("/api/settings/browser-extension", {
      method: "PATCH",
      body: JSON.stringify({ extensionId: value }),
    });
    onSaved(saved);
    setExtensionId(saved.browserExtensionId ?? "");
  };

  const connect = async (): Promise<void> => {
    setConnecting(true);
    setError("");
    setNotice("");
    try {
      const detected = detectedExtensionId;
      if (!detected) throw new Error("The extension is not detected on this page.");
      setDetectedExtensionId(detected);
      const integrationToken = await getIntegrationToken();
      await configureExtension(detected, backendUrl, integrationToken);
      await saveExtensionId(detected);
      setNotice("Extension connected and backend URL configured successfully.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not connect the extension");
    } finally {
      setConnecting(false);
    }
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await saveExtensionId(extensionId.trim());
      setNotice(extensionId.trim() ? "Extension origin saved." : "Extension origin cleared.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the extension ID");
    } finally {
      setSaving(false);
    }
  };

  const rotateIntegrationToken = async (): Promise<void> => {
    setRotatingToken(true);
    setError("");
    setNotice("");
    try {
      const result = await request<{ integrationToken?: string }>("/api/settings/integration-token", {
        method: "POST",
      });
      if (!result.integrationToken) throw new Error("The new integration token was not returned.");
      setIntegrationToken(result.integrationToken);
      setNotice("A new local integration token was generated. Connect the extension again to apply it.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not generate a new integration token");
    } finally {
      setRotatingToken(false);
    }
  };

  const isConnected = detectionState === "detected" && Boolean(detectedExtensionId && detectedExtensionId === extensionId);

  return (
    <section className="panel settings-section extension-settings-panel">
      <div className="panel-heading">
        <div>
          <div className="eyebrow">Browser extension</div>
          <h2>Extension connection</h2>
        </div>
        <span className={`setting-value ${isConnected ? "online" : ""}`}>
          {isConnected && <span className="online-dot" />}
          {detectionState === "checking"
            ? "Checking…"
            : detectedExtensionId
              ? detectedExtensionId === extensionId
                ? "Connected"
                : "Detected"
              : "Not detected"}
        </span>
      </div>
      <p className="settings-help">
        Connect the extension after loading it in your browser. Tokia will read its browser-generated ID and save the backend URL and local integration token automatically.
      </p>
      <div className="setting-row extension-token-row">
        <div>
          <strong>Local integration token</strong>
          <span>Managed automatically by Tokia for local API access.</span>
        </div>
        <div className="detail-actions extension-row-actions">
          <span className="setting-value online">
            <span className="online-dot" />
            Configured
          </span>
          <Button className="extension-action-button" onClick={() => void rotateIntegrationToken()} disabled={rotatingToken || connecting || saving}>
            {rotatingToken ? "Generating…" : "Generate new token"}
          </Button>
        </div>
      </div>
      {detectionState === "checking" && (
        <div className="setting-row extension-status-row">
          <div>
            <strong>Checking for the Tokia extension…</strong>
            <span>Waiting for the installed extension to respond.</span>
          </div>
          <span className="setting-value">Checking</span>
        </div>
      )}
      {detectionState === "missing" && (
        <div className="setting-row extension-status-row">
          <div>
            <strong>Tokia extension not detected</strong>
            <span>Reload the extension in the browser extensions page, then reload Tokia and try again.</span>
          </div>
          <div className="detail-actions extension-row-actions">
            <span className="setting-value">Not detected</span>
            <Button onClick={() => setDetectionAttempt((value) => value + 1)} disabled={connecting || saving}>
              Retry detection
            </Button>
          </div>
        </div>
      )}
      {detectionState === "detected" && (
        <div className="setting-row extension-status-row">
          <div>
            <strong>Extension detected</strong>
            <span>The installed Tokia extension is available on this page.</span>
          </div>
          <div className="detail-actions extension-row-actions">
            <span className={`setting-value ${isConnected ? "online" : ""}`}>
              {isConnected && <span className="online-dot" />}
              {isConnected ? "Connected" : "Detected"}
            </span>
            <Button className="extension-action-button" variant="primary" onClick={() => void connect()} disabled={connecting || saving}>
              {connecting ? "Connecting…" : "Connect extension"}
            </Button>
          </div>
        </div>
      )}
      {error && <div className="inline-error">{error}</div>}
      {notice && <div className="inline-note">{notice}</div>}
      <details className="extension-manual-settings">
        <summary>Advanced: enter extension ID manually</summary>
        <form onSubmit={submit}>
          <label className="form-field">
            <span>Browser extension ID</span>
            <input
              value={extensionId}
              onChange={(event) => setExtensionId(event.target.value)}
              placeholder="32 lowercase letters from a to p"
              maxLength={80}
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <small>The ID is only used to allow the extension origin through local CORS.</small>
          <div className="detail-actions">
            <Button type="submit" disabled={saving || connecting}>
              {saving ? "Saving…" : "Save manually"}
            </Button>
          </div>
        </form>
      </details>
    </section>
  );
}

interface AdvancedSettingsForm {
  host: string;
  port: string;
  databasePath: string;
  contentStorageDirectory: string;
  ffmpegPath: string;
  ffprobePath: string;
  maxUploadMiB: string;
  modelProvider: string;
  modelName: string;
  maxPinsPerImport: string;
  maxRequestMiB: string;
  corsAllowedOrigins: string;
  logLevel: string;
}

function bytesToMiB(value: number): string {
  return String(Math.max(1, Math.round(value / (1024 * 1024))));
}
function advancedSettingsForm(settings: AdvancedRuntimeSettings): AdvancedSettingsForm {
  return {
    host: settings.host,
    port: String(settings.port),
    databasePath: settings.databasePath,
    contentStorageDirectory: settings.contentStorageDirectory,
    ffmpegPath: settings.ffmpegPath,
    ffprobePath: settings.ffprobePath,
    maxUploadMiB: bytesToMiB(settings.maxUploadBytes),
    modelProvider: settings.modelProvider,
    modelName: settings.modelName,
    maxPinsPerImport: String(settings.maxPinsPerImport),
    maxRequestMiB: bytesToMiB(settings.maxRequestBytes),
    corsAllowedOrigins: settings.corsAllowedOrigins.join("\n"),
    logLevel: settings.logLevel,
  };
}
function AdvancedSettingsPanel({ data }: { data: AnyRecord | null }): ReactElement {
  const advanced = data?.advanced as AdvancedRuntimeSettings | undefined;
  const defaults = data?.advancedDefaults as AdvancedRuntimeSettings | undefined;
  const [form, setForm] = useState<AdvancedSettingsForm | null>(advanced ? advancedSettingsForm(advanced) : null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (advanced) setForm(advancedSettingsForm(advanced));
  }, [data?.advanced]);
  const update = (field: keyof AdvancedSettingsForm) => (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>): void => {
    setForm((current) => current ? { ...current, [field]: event.target.value } : current);
  };
  const resetDefaults = (): void => {
    if (defaults) setForm(advancedSettingsForm(defaults));
    setError("");
    setNotice("Defaults loaded in the form. Save to apply them.");
  };
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!form) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const saved = await request<AnyRecord>("/api/settings/advanced", {
        method: "PATCH",
        body: JSON.stringify({
          host: form.host.trim(),
          port: Number(form.port),
          databasePath: form.databasePath.trim(),
          contentStorageDirectory: form.contentStorageDirectory.trim(),
          ffmpegPath: form.ffmpegPath.trim(),
          ffprobePath: form.ffprobePath.trim(),
          maxUploadBytes: Math.round(Number(form.maxUploadMiB) * 1024 * 1024),
          modelProvider: form.modelProvider.trim(),
          modelName: form.modelName.trim(),
          maxPinsPerImport: Number(form.maxPinsPerImport),
          maxRequestBytes: Math.round(Number(form.maxRequestMiB) * 1024 * 1024),
          corsAllowedOrigins: form.corsAllowedOrigins.split(/\r?\n|,/).map((origin) => origin.trim()).filter(Boolean),
          logLevel: form.logLevel,
        }),
      });
      if (saved.advanced) setForm(advancedSettingsForm(saved.advanced as AdvancedRuntimeSettings));
      if (typeof saved.backendBaseUrl === "string") setApiBase(saved.backendBaseUrl);
      setNotice(saved.message ?? "Advanced settings saved.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save advanced settings");
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="panel settings-section advanced-settings-panel">
      <div className="panel-heading">
        <div>
          <div className="eyebrow">Advanced</div>
          <h2>Runtime settings</h2>
        </div>
        <span className="setting-value">Optional</span>
      </div>
      <p className="settings-help">These values have safe defaults for a local installation. Most users never need to change them. They are stored by Tokia, so no <code>.env</code> file is required.</p>
      {!form ? <PageLoading /> : (
        <form className="advanced-settings-form" onSubmit={(event) => void submit(event)}>
          <div className="advanced-settings-block">
            <div className="advanced-settings-heading"><div><h3>Server and storage</h3><span>Changes to the API endpoint or storage paths require an API restart.</span></div></div>
            <div className="form-row">
              <label className="form-field"><span>API host</span><input value={form.host} onChange={update("host")} autoComplete="off" /><small>Usually 127.0.0.1 for local use.</small></label>
              <label className="form-field"><span>API port</span><input type="number" min="1" max="65535" value={form.port} onChange={update("port")} /><small>Default: 3000.</small></label>
            </div>
            <div className="form-row">
              <label className="form-field"><span>Database path</span><input value={form.databasePath} onChange={update("databasePath")} autoComplete="off" /><small>Changing it points Tokia to another database after restart; files are not moved automatically.</small></label>
              <label className="form-field"><span>Content storage directory</span><input value={form.contentStorageDirectory} onChange={update("contentStorageDirectory")} autoComplete="off" /><small>Changing it affects future files; existing content stays in its current folder.</small></label>
            </div>
          </div>
          <div className="advanced-settings-block">
            <div className="advanced-settings-heading"><div><h3>Processing limits</h3><span>Increase these only when the machine has enough disk space and memory.</span></div></div>
            <div className="form-row">
              <label className="form-field"><span>Maximum video upload (MiB)</span><input type="number" min="1" step="1" value={form.maxUploadMiB} onChange={update("maxUploadMiB")} /><small>Default: 250 MiB.</small></label>
              <label className="form-field"><span>Maximum request size (MiB)</span><input type="number" min="1" step="1" value={form.maxRequestMiB} onChange={update("maxRequestMiB")} /><small>Default: 10 MiB for API requests.</small></label>
            </div>
            <div className="form-row">
              <label className="form-field"><span>Maximum Pins per import</span><input type="number" min="1" max="10000" step="1" value={form.maxPinsPerImport} onChange={update("maxPinsPerImport")} /><small>Default: 2,000 Pins.</small></label>
              <label className="form-field"><span>Log level</span><select value={form.logLevel} onChange={update("logLevel")}>{["trace", "debug", "info", "warn", "error", "fatal", "silent"].map((level) => <option key={level} value={level}>{level}</option>)}</select><small>Use debug or trace only while diagnosing an issue.</small></label>
            </div>
          </div>
          <div className="advanced-settings-block">
            <div className="advanced-settings-heading"><div><h3>Processing tools and model defaults</h3><span>Leave the executable names as-is when FFmpeg is available on the system PATH.</span></div></div>
            <div className="form-row">
              <label className="form-field"><span>FFmpeg executable</span><input value={form.ffmpegPath} onChange={update("ffmpegPath")} autoComplete="off" /></label>
              <label className="form-field"><span>FFprobe executable</span><input value={form.ffprobePath} onChange={update("ffprobePath")} autoComplete="off" /></label>
            </div>
            <div className="form-row">
              <label className="form-field"><span>Model provider</span><input value={form.modelProvider} onChange={update("modelProvider")} autoComplete="off" /></label>
              <label className="form-field"><span>Model name</span><input value={form.modelName} onChange={update("modelName")} autoComplete="off" /></label>
            </div>
          </div>
          <div className="advanced-settings-block">
            <div className="advanced-settings-heading"><div><h3>Allowed web origins</h3><span>One origin per line. The connected browser extension is managed separately.</span></div></div>
            <label className="form-field"><span>CORS allowed origins</span><textarea rows={4} value={form.corsAllowedOrigins} onChange={update("corsAllowedOrigins")} spellCheck={false} /><small>Keep the default localhost origins unless you know you need another local client.</small></label>
          </div>
          {error && <div className="inline-error">{error}</div>}
          {notice && <div className="inline-note">{notice}</div>}
          <div className="detail-actions advanced-settings-actions"><Button type="button" onClick={resetDefaults} disabled={saving}>Reset defaults</Button><Button type="submit" variant="primary" disabled={saving}>{saving ? "Saving..." : "Save advanced settings"}</Button></div>
        </form>
      )}
    </section>
  );
}

function SettingsPage({ onOpenAsset }: { onOpenAsset: (asset: Asset) => void }): ReactElement {
  const [settingsRefresh, setSettingsRefresh] = useState(0);
  const { data, loading, error } = useApi<AnyRecord>("/api/settings", settingsRefresh);
  const health = useApi<AnyRecord>("/api/health");
  const [tab, setTab] = useState<SettingsTab>(settingsTabFromUrl());
  const selectTab = (next: SettingsTab): void => {
    setTab(next);
    window.history.replaceState({}, "", next === "connection" ? "/settings" : `/settings?tab=${next}`);
  };
  if (loading) return <PageLoading />;
  return (
    <>
      <SectionHeader eyebrow="Workspace" title="Settings" description="Connection, AI providers, media defaults, assets, and import history for Tokia." />
      <div className="settings-tabs" role="tablist" aria-label="Settings sections">
        {(
          [
            ["connection", "Connection", "settings"],
            ["preview", "Preview", "image"],
            ["ai-providers", "AI Providers", "settings"],
            ["assets", "Assets", "assets"],
            ["imports", "Imports", "imports"],
            ["advanced", "Advanced", "settings"],
            ["api", "API", "arrow"],
          ] as const
        ).map(([key, label, icon]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? "active" : ""} onClick={() => selectTab(key)}>
            <Icon name={icon} /> {label}
          </button>
        ))}
      </div>
      {tab === "connection" && (
        <>
          <div className="settings-grid">
            <section className="panel settings-section">
              <div className="panel-heading">
                <div>
                  <div className="eyebrow">Connection</div>
                  <h2>Backend status</h2>
                </div>
                <StatusBadge value={health.data?.status === "ok" ? "active" : "error"} />
              </div>
              {error ? (
                <ErrorState message={error} />
              ) : (
                <>
                  <div className="setting-row">
                    <div>
                      <strong>API connection</strong>
                      <span>{data?.backendBaseUrl ?? API_BASE}</span>
                    </div>
                    <span className="setting-value online">
                      <span className="online-dot" /> Connected
                    </span>
                  </div>
                  <div className="setting-row">
                    <div>
                      <strong>SQLite database</strong>
                      <span>{data?.databaseFile ?? "tokia.sqlite"}</span>
                    </div>
                    <span className="setting-value">{data?.database ?? "sqlite"}</span>
                  </div>
                  <div className="setting-row">
                    <div>
                      <strong>Integration token</strong>
                      <span>Only used for local mutations and extension imports.</span>
                    </div>
                    <span className="setting-value">{data?.integrationTokenConfigured ? "Configured" : "Not configured"}</span>
                  </div>
                </>
              )}
            </section>
          </div>
          <BrowserExtensionSettings
            initialId={data?.browserExtensionId}
            backendUrl={data?.backendBaseUrl ?? API_BASE}
            onSaved={() => setSettingsRefresh((value) => value + 1)}
          />
        </>
      )}
      {tab === "advanced" && <AdvancedSettingsPanel data={data} />}
      {tab === "api" && (
        <section className="panel settings-section api-docs-panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">Developer tools</div>
              <h2>API documentation</h2>
            </div>
          </div>
          <p className="settings-help">Reference documentation for advanced local integrations and diagnostics. Most users will not need this section.</p>
          <Button onClick={() => window.open(`${API_BASE}/docs`, "_blank", "noopener,noreferrer")}>
            Open API docs <Icon name="arrow" />
          </Button>
        </section>
      )}
      {tab === "preview" && (
        <section className="panel settings-section">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">Preview behavior</div>
              <h2>Media defaults</h2>
            </div>
          </div>
          <div className="setting-row">
            <div>
              <strong>Gallery density</strong>
              <span>Cards keep source aspect ratios and load original media lazily.</span>
            </div>
            <span className="setting-value">Comfortable</span>
          </div>
          <div className="setting-row">
            <div>
              <strong>Video playback</strong>
              <span>Poster-first, muted by default. Full playback happens in the detail view.</span>
            </div>
            <span className="setting-value">Defensive</span>
          </div>
          <div className="setting-row">
            <div>
              <strong>Application version</strong>
              <span>Phase 2 local-first workspace</span>
            </div>
            <span className="setting-value">{data?.applicationVersion ?? "0.2.0"}</span>
          </div>
        </section>
      )}
      {tab === "ai-providers" && <AiProvidersPage />}
      {tab === "assets" && (
        <div className="settings-embedded-page">
          <AssetsPage onOpenAsset={onOpenAsset} />
        </div>
      )}
      {tab === "imports" && (
        <div className="settings-embedded-page">
          <ImportsPage />
        </div>
      )}
    </>
  );
}

function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }): ReactElement {
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="close-button" onClick={onClose} aria-label="Close dialog">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ProjectDialog({ project, onClose, onSaved }: { project?: Project; onClose: () => void; onSaved: (project?: Project) => void }): ReactElement {
  const collectionQuery = useApi<{
    items: Collection[];
    pagination: Pagination;
  }>("/api/collections?pageSize=100");
  const [step, setStep] = useState(1);
  useEffect(() => {
    const modals = document.querySelectorAll<HTMLElement>(".modal");
    modals[modals.length - 1]?.scrollTo({ top: 0, behavior: "auto" });
  }, [step]);
  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [niche, setNiche] = useState(project?.niche ?? "");
  const [language, setLanguage] = useState(project?.defaultLanguage ?? "English");
  const [notes, setNotes] = useState(project?.internalNotes ?? "");
  const [color, setColor] = useState(project?.color ?? "#b9f36b");
  const [selected, setSelected] = useState<Set<string>>(new Set(project?.collections?.map((item) => item.id) ?? []));
  const [search, setSearch] = useState("");
  const initialDefaults = project?.config ?? {
    aspectRatio: project?.config?.aspectRatio ?? "9:16",
    preferredContentTypes: project?.config?.preferredContentTypes ?? ["single_image", "carousel", "video_slideshow", "video_clipping"],
    textMode: project?.config?.textMode ?? "headline_and_body",
    tone: project?.config?.tone ?? "educational",
    includeCta: project?.config?.includeCta ?? true,
    visual: project?.config?.visual ?? {
      fontFamily: "Arial",
      fontWeight: "700",
      textAlignment: "left",
      textPosition: "bottom",
      textColor: "#ffffff",
      overlay: true,
      overlayOpacity: 0.5,
    },
  };
  const initialProjectState = useRef({
    name: project?.name ?? "",
    description: project?.description ?? "",
    niche: project?.niche ?? "",
    language: project?.defaultLanguage ?? "English",
    notes: project?.internalNotes ?? "",
    color: project?.color ?? "#b9f36b",
    selected: (project?.collections?.map((item) => item.id) ?? []).sort(),
    defaults: initialDefaults,
  });
  const [defaults, setDefaults] = useState<AnyRecord>(initialDefaults);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dirty = JSON.stringify({
    name,
    description,
    niche,
    language,
    notes,
    color,
    selected: [...selected].sort(),
    defaults,
  }) !== JSON.stringify(initialProjectState.current);
  const close = () => {
    if (dirty && !window.confirm("Discard unsaved project changes?")) return;
    onClose();
  };
  const visible = (collectionQuery.data?.items ?? []).filter((item) => !search.trim() || item.name.toLowerCase().includes(search.trim().toLowerCase()) || (item.description ?? "").toLowerCase().includes(search.trim().toLowerCase()));
  const toggle = (collectionId: string) =>
    setSelected((current) => {
      const next = new Set(current);
      next.has(collectionId) ? next.delete(collectionId) : next.add(collectionId);
      return next;
    });
  const toggleVisible = () =>
    setSelected((current) => {
      const next = new Set(current);
      const all = visible.every((item) => next.has(item.id));
      visible.forEach((item) => (all ? next.delete(item.id) : next.add(item.id)));
      return next;
    });
  const valid = step === 1 ? Boolean(name.trim() && niche.trim()) : step === 2 ? selected.size > 0 : true;
  const next = () => {
    setError("");
    if (!valid) {
      setError(step === 1 ? "Project name and niche are required." : "Select at least one source collection.");
      return;
    }
    setStep((value) => Math.min(4, value + 1));
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (step !== 4) {
      return;
    }
    setSaving(true);
    setError("");
    try {
      const payload = {
        name: name.trim(),
        description,
        niche: niche.trim(),
        defaultLanguage: language,
        internalNotes: notes,
        color,
        collectionIds: [...selected],
        defaultSettings: defaults,
      };
      const saved = project
        ? await request<Project>(`/api/projects/${project.id}`, {
            method: "PATCH",
            body: JSON.stringify(payload),
          })
        : await request<Project>("/api/projects", {
            method: "POST",
            body: JSON.stringify(payload),
          });
      onSaved(saved);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save project");
    } finally {
      setSaving(false);
    }
  };
  const stepNames = ["Basics", "Sources", "Preferences", "Review"];
  return (
    <Modal title={project ? "Edit project" : "New project"} onClose={close} wide>
      <form onSubmit={submit}>
        <div className="wizard-progress" aria-label="Project creation steps">
          {stepNames.map((label, index) => (
            <button type="button" key={label} className={step === index + 1 ? "active" : step > index + 1 ? "complete" : ""} onClick={() => index + 1 < step && setStep(index + 1)}>
              <span>{index + 1}</span>
              {label}
            </button>
          ))}
        </div>
        {step === 1 && (
          <div>
            <div className="wizard-step">
              <span className="step-number">1</span>
              <div>
                <div className="eyebrow">Basic information</div>
                <h3>Define the project context</h3>
              </div>
            </div>
            <label className="form-field">
              <span>Project name</span>
              <input autoFocus required value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Luxury interiors" />
            </label>
            <label className="form-field">
              <span>Niche or subject</span>
              <input required value={niche} onChange={(event) => setNiche(event.target.value)} placeholder="e.g. Interior design" />
            </label>
            <label className="form-field">
              <span>
                Description <small>Optional</small>
              </span>
              <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What should this project help you create?" rows={3} />
            </label>
            <div className="form-row">
              <label className="form-field">
                <span>Default language</span>
                <select value={language} onChange={(event) => setLanguage(event.target.value)}>
                  <option>English</option>
                  <option>Spanish</option>
                  <option>Portuguese</option>
                  <option>French</option>
                </select>
              </label>
              <label className="form-field">
                <span>Project color</span>
                <input type="color" value={color} onChange={(event) => setColor(event.target.value)} />
              </label>
            </div>
            <label className="form-field">
              <span>
                Internal notes <small>Optional</small>
              </span>
              <textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Private planning notes" rows={2} />
            </label>
          </div>
        )}
        {step === 2 && (
          <div>
            <div className="wizard-step">
              <span className="step-number">2</span>
              <div>
                <div className="eyebrow">Source collections</div>
                <h3>Choose reusable source boards</h3>
              </div>
              <span className="selection-label">{selected.size} selected</span>
            </div>
            <label className="search-field">
              <Icon name="search" />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search collections" />
            </label>
            <div className="selector-actions">
              <button type="button" className="text-button" onClick={toggleVisible}>
                {visible.length && visible.every((item) => selected.has(item.id)) ? "Deselect visible" : "Select visible"}
              </button>
            </div>
            {collectionQuery.loading ? (
              <div className="selection-loading">Loading collections…</div>
            ) : (
              <div className="collection-selector">
                {visible.map((collection) => (
                  <button type="button" key={collection.id} className={`selector-card ${selected.has(collection.id) ? "selected" : ""}`} onClick={() => toggle(collection.id)}>
                    {collection.coverPreviewUrl ? <img className="selector-cover" src={collection.coverPreviewUrl} alt="" /> : <span className="selector-cover-fallback">{collection.name.slice(0, 1)}</span>}
                    <span className="selector-check">{selected.has(collection.id) ? "✓" : ""}</span>
                    <div>
                      <strong>{collection.name}</strong>
                      <span>
                        {collection.assetCount} assets · {collection.imageCount} images · {collection.videoCount} videos
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {step === 3 && (
          <div>
            <div className="wizard-step">
              <span className="step-number">3</span>
              <div>
                <div className="eyebrow">Default content preferences</div>
                <h3>Set the starting point for each asset</h3>
              </div>
            </div>
            <label className="form-field">
              <span>Preferred aspect ratio</span>
              <select
                value={defaults.aspectRatio}
                onChange={(event) =>
                  setDefaults((current) => ({
                    ...current,
                    aspectRatio: event.target.value,
                  }))
                }
              >
                <option value="9:16">9:16 vertical</option>
                <option value="1:1">1:1 square</option>
                <option value="4:5">4:5 portrait</option>
                <option value="16:9">16:9 landscape</option>
              </select>
            </label>
            <div className="form-field">
              <span>Preferred content types</span>
              <div className="choice-grid">
                {["single_image", "carousel", "video_slideshow", "video_clipping"].map((type) => (
                  <label className="choice-card" key={type}>
                    <input
                      type="checkbox"
                      checked={(defaults.preferredContentTypes as string[]).includes(type)}
                      onChange={(event) =>
                        setDefaults((current) => ({
                          ...current,
                          preferredContentTypes: event.target.checked ? [...(current.preferredContentTypes as string[]), type] : (current.preferredContentTypes as string[]).filter((value) => value !== type),
                        }))
                      }
                    />
                    <strong>{type === "single_image" ? "Single image" : type === "carousel" ? "Carousel" : type === "video_clipping" ? "Clipping" : "Video slideshow"}</strong>
                    <small>{type === "carousel" ? "Independent swipeable slides" : type === "video_slideshow" ? "An MP4 with timed scenes" : type === "video_clipping" ? "Short clips from a long-form video" : "One finished image"}</small>
                  </label>
                ))}
              </div>
            </div>
            <div className="form-row">
              <label className="form-field">
                <span>Default tone</span>
                <select
                  value={defaults.tone}
                  onChange={(event) =>
                    setDefaults((current) => ({
                      ...current,
                      tone: event.target.value,
                    }))
                  }
                >
                  {["educational", "informational", "aspirational", "entertaining", "professional", "custom"].map((tone) => (
                    <option key={tone}>{tone}</option>
                  ))}
                </select>
              </label>
              <label className="form-field">
                <span>Default text mode</span>
                <select
                  value={defaults.textMode}
                  onChange={(event) =>
                    setDefaults((current) => ({
                      ...current,
                      textMode: event.target.value,
                    }))
                  }
                >
                  <option value="none">No text</option>
                  <option value="cover_only">Cover only</option>
                  <option value="headline_only">Headline only</option>
                  <option value="headline_and_body">Headline and body</option>
                </select>
              </label>
            </div>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={Boolean(defaults.includeCta)}
                onChange={(event) =>
                  setDefaults((current) => ({
                    ...current,
                    includeCta: event.target.checked,
                  }))
                }
              />
              <span>
                <strong>Default CTA enabled</strong>
                <small>Content items can override this default.</small>
              </span>
            </label>
          </div>
        )}
        {step === 4 && (
          <div>
            <div className="wizard-step">
              <span className="step-number">4</span>
              <div>
                <div className="eyebrow">Review</div>
                <h3>Ready to create this project?</h3>
              </div>
            </div>
            <div className="review-grid">
              <div>
                <span>Name</span>
                <strong>{name}</strong>
              </div>
              <div>
                <span>Niche</span>
                <strong>{niche}</strong>
              </div>
              <div>
                <span>Language</span>
                <strong>{language}</strong>
              </div>
              <div>
                <span>Sources</span>
                <strong>{selected.size} collections</strong>
              </div>
              <div>
                <span>Aspect ratio</span>
                <strong>{defaults.aspectRatio}</strong>
              </div>
              <div>
                <span>Types</span>
                <strong>{(defaults.preferredContentTypes as string[]).map((type) => type.replaceAll("_", " ")).join(", ")}</strong>
              </div>
              <div>
                <span>Tone</span>
                <strong>{defaults.tone}</strong>
              </div>
              <div>
                <span>Text</span>
                <strong>{defaults.textMode.replaceAll("_", " ")}</strong>
              </div>
            </div>
          </div>
        )}
        {error && <div className="inline-error">{error}</div>}
        <div className="modal-footer">
          <Button onClick={close}>Cancel</Button>
          {step > 1 && <Button onClick={() => setStep((value) => value - 1)}>Back</Button>}
          {step < 4 ? (
            <Button variant="primary" type="button" onClick={next}>
              Next
            </Button>
          ) : (
            <Button variant="primary" type="submit" disabled={saving}>
              {saving ? "Creating…" : project ? "Save project" : "Create project"}
            </Button>
          )}
        </div>
      </form>
    </Modal>
  );
}

function typeLabel(type: string): string {
  return type === "single_image"
    ? "Single image"
    : type === "video_slideshow"
      ? "Video slideshow"
      : type === "video_clipping"
        ? "Clipping"
        : "Carousel";
}
function LegacyContentWizard({ project, existingId, onClose, onSaved, onSelectClipping }: { project: Project; existingId?: string; onClose: () => void; onSaved: () => void; onSelectClipping: () => void }): ReactElement {
  const defaultSettings = project.config ?? {};
  const [step, setStep] = useState(existingId ? 4 : 1);
  const [type, setType] = useState(String((defaultSettings.preferredContentTypes as string[] | undefined)?.[0] ?? "carousel"));
  const [title, setTitle] = useState("");
  const [selectedCollections, setSelectedCollections] = useState<string[]>(project.collections?.map((item) => item.id) ?? []);
  const [config, setConfig] = useState<AnyRecord>({
    sourceCollectionIds: project.collections?.map((item) => item.id) ?? [],
    aspectRatio: defaultSettings.aspectRatio ?? "9:16",
    totalFrames: 5,
    includeCover: true,
    includeCta: true,
    textMode: defaultSettings.textMode ?? "headline_and_body",
    topicMode: "ai",
    topic: "",
    tone: defaultSettings.tone ?? "educational",
    audience: "",
    customInstructions: "",
    ctaMode: "ai",
    ctaText: "",
    captionEnabled: true,
    visual: defaultSettings.visual ?? {
      cropMode: "crop",
      fontFamily: "Arial",
      fontSize: 54,
      fontWeight: "700",
      textAlignment: "left",
      textPosition: "bottom",
      textColor: "#ffffff",
      overlay: true,
      overlayOpacity: 0.5,
    },
    video: {
      outputResolution: "720p",
      fps: 30,
      secondsPerImage: 2.5,
      transition: "fade",
      transitionDuration: 0.35,
      panZoom: false,
      intro: false,
      outro: false,
    },
  });
  const [content, setContent] = useState<ContentDetail | null>(null);
  const [durationDrafts, setDurationDrafts] = useState<Record<string, string>>({});
  const [bulkDurationDraft, setBulkDurationDraft] = useState("2.5");
  const [previewPolling, setPreviewPolling] = useState(false);
  const captionDraft = useRef("");
  const captionContentId = useRef<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [sourcePickerFrameId, setSourcePickerFrameId] = useState<string | null>(null);
  const [sourceSearch, setSourceSearch] = useState("");
  const [sourcePreview, setSourcePreview] = useState<{ frame: ContentFrame; asset: Asset } | null>(null);
  const sourcePickerPath =
    sourcePickerFrameId && selectedCollections.length
      ? `/api/assets?mediaType=source&pageSize=100&collectionIds=${encodeURIComponent(selectedCollections.join(","))}${sourceSearch.trim() ? `&search=${encodeURIComponent(sourceSearch.trim())}` : ""}`
      : null;
  const sourceAssets = useApi<{ items: Asset[]; pagination: Pagination }>(sourcePickerPath);
  const [dirty, setDirty] = useState(false);
  const updateConfig = (key: string, value: unknown) => {
    setDirty(true);
    setConfig((current) => ({ ...current, [key]: value }));
  };
  const patchContent = async (body: AnyRecord): Promise<ContentDetail | undefined> => {
    if (!content) return undefined;
    const updated = await request<ContentDetail>(`/api/content/${content.id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    setContent(updated);
    setDirty(false);
    return updated;
  };
  const refreshContent = async (id = content?.id) => {
    if (!id) return;
    try {
      const updated = await request<ContentDetail>(`/api/content/${id}`);
      setContent(updated);
      return updated;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not refresh content status");
      return undefined;
    }
  };
  useEffect(() => {
    if (!existingId) return;
    let active = true;
    request<ContentDetail>(`/api/content/${existingId}`)
      .then((loaded) => {
        if (!active) return;
        setContent(loaded);
        setType(loaded.type);
        setTitle(loaded.title ?? "");
        setConfig(loaded.configuration);
        setSelectedCollections(loaded.configuration.sourceCollectionIds ?? []);
        setPreviewPolling(loaded.status === "preview_generating" || loaded.jobs.some((job) => job.jobType === "preview_render" && ["queued", "running"].includes(job.status)));
        const persistedStep = Number(loaded.wizardStep);
        const fallbackStep = loaded.narrative || loaded.frames.some((frame) => frame.sourceMedia) ? 4 : 1;
        setStep(
          loaded.status === "preview_ready" || loaded.status === "ready"
            ? 7
            : Number.isInteger(persistedStep) && persistedStep >= 1 && persistedStep <= 7
              ? persistedStep
              : fallbackStep,
        );
        setDirty(false);
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : "Could not load the draft"));
    return () => {
      active = false;
    };
  }, [existingId]);
  useEffect(() => {
    if (type === "video_slideshow") {
      setBulkDurationDraft(String(config.video?.secondsPerImage ?? 2.5));
    }
  }, [type, config.video?.secondsPerImage]);
  const persistStep = async (nextStep: number, id = content?.id): Promise<void> => {
    const boundedStep = Math.max(1, Math.min(7, Math.round(nextStep)));
    setStep(boundedStep);
    if (!id) return;
    const updated = await request<ContentDetail>(`/api/content/${id}/wizard-step`, {
      method: "PATCH",
      body: JSON.stringify({ step: boundedStep }),
    });
    setContent(updated);
  };
  const hasActiveTextJob = content?.jobs?.some((job) => ["narrative_generation", "caption_regeneration", "frame_regeneration"].includes(job.jobType) && ["queued", "running"].includes(job.status)) ?? false;
  useEffect(() => {
    const hasActivePreviewJob = content?.jobs?.some((job) => job.jobType === "preview_render" && ["queued", "running"].includes(job.status)) ?? false;
    const isPreviewTerminal = content && ["preview_ready", "failed", "ready"].includes(content.status);
    if (previewPolling && isPreviewTerminal) {
      setPreviewPolling(false);
      return;
    }
    if (!content || (!hasActiveTextJob && !hasActivePreviewJob && !previewPolling && !["preview_generating", "generation_queued", "generating"].includes(content.status))) return;
    const timer = window.setInterval(() => {
      void refreshContent();
    }, 900);
    return () => window.clearInterval(timer);
  }, [content?.id, content?.status, content?.jobs?.length, content?.jobs?.[0]?.status, hasActiveTextJob, previewPolling]);
  useEffect(() => {
    if (content && captionContentId.current !== content.id) {
      captionContentId.current = content.id;
      captionDraft.current = content.narrative?.caption ?? content.configuration.caption ?? "";
    }
  }, [content?.id]);
  const ensureDraft = async (): Promise<ContentDetail> => {
    if (content) {
      const updated = await patchContent({
        title,
        type,
        configuration: { ...config, sourceCollectionIds: selectedCollections },
      });
      return updated ?? content;
    }
    const created = await request<ContentDetail>(`/api/projects/${project.id}/content`, {
      method: "POST",
      body: JSON.stringify({
        type,
        title,
        configuration: {
          ...config,
          sourceCollectionIds: selectedCollections,
        },
        autoSelect: false,
      }),
    });
    setContent(created);
    try {
      const selected = await request<ContentDetail>(`/api/content/${created.id}/images/select`, { method: "POST", body: JSON.stringify({}) });
      setContent(selected);
      setDirty(false);
      return selected;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not select source images");
    }
    return created;
  };
  const next = async () => {
    setError("");
    setNotice("");
    try {
      if (step === 1) {
        if (content) await patchContent({ title });
        await persistStep(2);
        return;
      }
      if (step === 2) {
        if (!selectedCollections.length) {
          setError("Select at least one project source collection.");
          return;
        }
        await persistStep(3);
        return;
      }
      if (step === 3) {
        if (type !== "single_image" && Number(config.totalFrames) < (Number(Boolean(config.includeCover)) + Number(Boolean(config.includeCta)) || 1)) {
          setError("Total frames must include the enabled cover and CTA.");
          return;
        }
        const draft = await ensureDraft();
        setContent(draft);
        await persistStep(4, draft.id);
        return;
      }
      if (step === 4) {
        await patchContent({
          configuration: {
            ...config,
            sourceCollectionIds: selectedCollections,
          },
        });
        await persistStep(5);
        return;
      }
      if (step === 5) {
        await patchContent({
          configuration: {
            ...config,
            sourceCollectionIds: selectedCollections,
          },
        });
        await persistStep(6);
        return;
      }
      if (step === 6) {
        await saveTextFields();
        await persistStep(7);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save this step");
    }
  };
  const selectImages = async () => {
    if (!content) return;
    setSaving(true);
    setError("");
    try {
      setContent(await request<ContentDetail>(`/api/content/${content.id}/images/select`, { method: "POST", body: JSON.stringify({}) }));
      setDurationDrafts({});
      setDirty(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not select images");
    } finally {
      setSaving(false);
    }
  };
  const shuffleImages = async () => {
    if (!content) return;
    setSaving(true);
    try {
      setContent(await request<ContentDetail>(`/api/content/${content.id}/images/shuffle`, { method: "POST", body: JSON.stringify({}) }));
      setDurationDrafts({});
      setDirty(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not shuffle images");
    } finally {
      setSaving(false);
    }
  };
  const lockFrame = async (frame: ContentFrame, field: "textLocked" | "imageLocked") => {
    if (!content) return;
    try {
      setContent(await request<ContentDetail>(`/api/content/${content.id}/frames/${frame.id}`, { method: "PATCH", body: JSON.stringify({ [field]: !frame[field] }) }));
      setDirty(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update lock");
    }
  };
  const toggleSourcePicker = (frameId: string) => {
    setSourcePickerFrameId((current) => (current === frameId ? null : frameId));
    setSourceSearch("");
    setSourcePreview(null);
  };
  const chooseSourceForFrame = async (frame: ContentFrame, asset: Asset) => {
    if (!content) return;
    setSaving(true);
    setError("");
    try {
      const updated = await request<ContentDetail>(
        `/api/content/${content.id}/frames/${frame.id}/image`,
        {
          method: "PUT",
          body: JSON.stringify({ mediaId: asset.id }),
        },
      );
      setContent(updated);
      setSourcePickerFrameId(null);
      setSourceSearch("");
      setSourcePreview(null);
      setDirty(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not select source content");
    } finally {
      setSaving(false);
    }
  };
  const editFrame = (frame: ContentFrame, field: "headline" | "body", value: string) => {
    setDirty(true);
    setContent((current) =>
      current
        ? {
            ...current,
            frames: current.frames.map((item) => (item.id === frame.id ? { ...item, [field]: value } : item)),
          }
        : current,
    );
  };
  const saveFrame = async (frame: ContentFrame) => {
    if (!content) return;
    try {
      setContent(
        await request<ContentDetail>(`/api/content/${content.id}/frames/${frame.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            headline: frame.headline,
            body: frame.body,
          }),
        }),
      );
      setDirty(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save text");
    }
  };
  const frameDurationMaximum = (frame: ContentFrame) => {
    const source = frame.sourceMedia;
    return source && (source.mediaType === "video" || source.mediaType === "animated") && source.durationSeconds && source.durationSeconds > 0 ? source.durationSeconds : 30;
  };
  const saveFrameDuration = async (frame: ContentFrame) => {
    if (!content || durationDrafts[frame.id] === undefined) return;
    const value = Number(durationDrafts[frame.id]);
    if (!Number.isFinite(value)) {
      setError("Enter a valid duration in seconds.");
      return;
    }
    try {
      setContent(await request<ContentDetail>(`/api/content/${content.id}/frames/${frame.id}`, { method: "PATCH", body: JSON.stringify({ durationSeconds: value }) }));
      setDirty(false);
      setDurationDrafts((current) => {
        const next = { ...current };
        delete next[frame.id];
        return next;
      });
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save frame duration");
    }
  };
  const applyUnlockedImageDuration = async () => {
    if (!content || type !== "video_slideshow") return;
    const value = Number(bulkDurationDraft);
    const targetCount = content.frames.filter((frame) => frame.sourceMedia?.mediaType === "image" && !frame.imageLocked).length;
    if (!Number.isFinite(value)) {
      setError("Enter a valid duration in seconds.");
      return;
    }
    if (!targetCount) {
      setNotice("There are no unlocked image frames to update.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      setContent(
        await request<ContentDetail>(`/api/content/${content.id}/frames/duration`, {
          method: "PATCH",
          body: JSON.stringify({ durationSeconds: value }),
        }),
      );
      setDirty(false);
      setNotice(`Applied ${value.toFixed(2)}s to ${targetCount} unlocked image ${targetCount === 1 ? "frame" : "frames"}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not apply image duration");
    } finally {
      setSaving(false);
    }
  };
  const generateCopy = async () => {
    if (!content) return;
    setSaving(true);
    setError("");
    try {
      const endpoint = content.narrative ? "narrative/regenerate" : "narrative";
      const result = await request<{ content: ContentDetail; job: AnyRecord }>(`/api/content/${content.id}/${endpoint}`, { method: "POST", body: JSON.stringify({}) });
      setContent(result.content);
      setDirty(false);
      captionDraft.current = result.content.narrative?.caption ?? result.content.configuration.caption ?? "";
      setNotice(content.narrative ? "Copy regeneration queued." : "Copy generation queued. The fields will update automatically.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not generate copy");
    } finally {
      setSaving(false);
    }
  };
  const editCaption = (value: string) => {
    setDirty(true);
    captionDraft.current = value;
    setContent((current) =>
      current
        ? {
            ...current,
            configuration: { ...current.configuration, caption: value },
            narrative: current.narrative ? { ...current.narrative, caption: value } : current.narrative,
          }
        : current,
    );
  };
  const saveCaption = async () => {
    if (!content) return;
    try {
      setContent(
        await request<ContentDetail>(`/api/content/${content.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            configuration: {
              ...content.configuration,
              caption: captionDraft.current,
            },
          }),
        }),
      );
      setDirty(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save caption");
    }
  };
  const saveTextFields = async () => {
    if (!content) return;
    setSaving(true);
    try {
      let latest = content;
      for (const frame of content.frames) {
        latest = await request<ContentDetail>(`/api/content/${content.id}/frames/${frame.id}`, {
          method: "PATCH",
          body: JSON.stringify({ headline: frame.headline, body: frame.body }),
        });
      }
      latest = await request<ContentDetail>(`/api/content/${content.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          configuration: {
            ...latest.configuration,
            caption: captionDraft.current,
          },
        }),
      });
      setContent(latest);
      setDirty(false);
    } finally {
      setSaving(false);
    }
  };
  const generatePreview = async () => {
    if (!content) return;
    setSaving(true);
    setError("");
    try {
      const result = await request<{ content: ContentDetail; job: AnyRecord }>(`/api/content/${content.id}/preview`, { method: "POST", body: JSON.stringify({}) });
      setContent(result.content);
      setPreviewPolling(true);
      setDirty(false);
      setNotice("Preview is rendering locally.");
    } catch (caught) {
      setPreviewPolling(false);
      setError(caught instanceof Error ? caught.message : "Could not generate preview");
    } finally {
      setSaving(false);
    }
  };
  const retryPreview = async () => {
    if (!content) return;
    setSaving(true);
    setError("");
    try {
      const result = await request<{ content: ContentDetail; job: AnyRecord }>(`/api/content/${content.id}/retry`, {
        method: "POST",
        body: JSON.stringify({ jobType: "preview_render" }),
      });
      setContent(result.content);
      setPreviewPolling(true);
      setNotice("Preview is rendering locally.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not retry preview");
    } finally {
      setSaving(false);
    }
  };
  const confirmFinal = async () => {
    if (!content) return;
    setSaving(true);
    try {
      const result = await request<{ content: ContentDetail; job: AnyRecord }>(`/api/content/${content.id}/confirm`, { method: "POST", body: JSON.stringify({}) });
      setContent(result.content);
      setDirty(false);
      setNotice("Final generation queued. You can close this dialog and watch the project list update.");
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not queue final generation");
    } finally {
      setSaving(false);
    }
  };
  const close = () => {
    if (dirty && !window.confirm("Close this content wizard? Your saved draft will remain available in the project.")) return;
    onClose();
  };
  const roles =
    type === "single_image"
      ? ["content"]
      : [
          ...(config.includeCover ? ["cover"] : []),
          ...Array.from(
            {
              length: Math.max(0, Number(config.totalFrames) - Number(Boolean(config.includeCover)) - Number(Boolean(config.includeCta))),
            },
            () => "content",
          ),
          ...(config.includeCta ? ["cta"] : []),
        ];
  const contentSlides = type === "single_image" ? 1 : Math.max(0, Number(config.totalFrames) - Number(Boolean(config.includeCover)) - Number(Boolean(config.includeCta)));
  const previewAsset = content?.assets.find((asset) => asset.variant === "preview" && asset.assetType === (content.type === "video_slideshow" ? "video" : "image"));
  const previewJob = content?.jobs.find((job) => job.jobType === "preview_render");
  const stepLabels = ["Type", "Sources", "Structure", "Content", "Visuals", "Text", "Preview"];
  return (
    <>
      <Modal title={existingId ? "Continue content draft" : "Create content"} onClose={close} wide>
      <div className="wizard-progress" aria-label="Content creation steps">
        {stepLabels.map((label, index) => (
          <button type="button" key={label} className={step === index + 1 ? "active" : step > index + 1 ? "complete" : ""} onClick={() => index + 1 < step && void persistStep(index + 1)}>
            <span>{index + 1}</span>
            {label}
          </button>
        ))}
      </div>
      {step === 1 && (
        <div>
          <div className="wizard-step">
            <span className="step-number">1</span>
            <div>
              <div className="eyebrow">Content type</div>
              <h3>Choose the finished asset format</h3>
            </div>
          </div>
          <label className="form-field content-title-field">
            <span>Content title</span>
            <input
              value={title}
              maxLength={200}
              onChange={(event) => {
                setDirty(true);
                setTitle(event.target.value);
              }}
              placeholder="e.g. 5 morning mobility habits"
            />
            <small>Used to identify this content in the project and downloads.</small>
          </label>
          <div className="content-type-grid">
            {[
              ["single_image", "Single image", "One finished image with optional text."],
              ["carousel", "Carousel", "Independent images intended to be swiped manually."],
              ["video_slideshow", "Video slideshow", "One MP4 composed from timed image scenes."],
              ["video_clipping", "Clipping", "Turn a long-form video into multiple short-form clips."],
            ].map(([value, label, description]) => (
              <button
                type="button"
                key={value}
                className={`content-type-card ${type === value ? "selected" : ""}`}
                onClick={() => {
                  if (value === "video_clipping") {
                    onSelectClipping();
                    return;
                  }
                  setDirty(true);
                  setType(value);
                  if (value === "single_image")
                    setConfig((current) => ({
                      ...current,
                      totalFrames: 1,
                      includeCover: false,
                      includeCta: false,
                    }));
                }}
              >
                <span className="type-icon">{value === "video_slideshow" ? "▶" : value === "carousel" ? "▤" : "▧"}</span>
                <strong>{label}</strong>
                <small>{description}</small>
              </button>
            ))}
          </div>
        </div>
      )}
      {step === 2 && (
        <div>
          <div className="wizard-step">
            <span className="step-number">2</span>
            <div>
              <div className="eyebrow">Source collections</div>
              <h3>Choose content from these project sources</h3>
            </div>
            <span className="selection-label">{selectedCollections.length} selected</span>
          </div>
          <div className="collection-selector">
            {(project.collections ?? []).map((collection) => (
              <button
                type="button"
                key={collection.id}
                className={`selector-card ${selectedCollections.includes(collection.id) ? "selected" : ""}`}
                onClick={() => {
                  setDirty(true);
                  setSelectedCollections((current) => (current.includes(collection.id) ? current.filter((value) => value !== collection.id) : [...current, collection.id]));
                }}
              >
                {collection.coverPreviewUrl ? <img className="selector-cover" src={collection.coverPreviewUrl} alt="" /> : <span className="selector-cover-fallback">{collection.name.slice(0, 1)}</span>}
                <span className="selector-check">{selectedCollections.includes(collection.id) ? "✓" : ""}</span>
                <div>
                  <strong>{collection.name}</strong>
                  <span>
                    {collection.assetCount} assets · {collection.imageCount} images · {collection.videoCount} videos
                    {project.collections?.some((item) => item.id === collection.id) ? " · project default" : ""}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
      {step === 3 && (
        <div>
          <div className="wizard-step">
            <span className="step-number">3</span>
            <div>
              <div className="eyebrow">Structure and content options</div>
              <h3>Control the frame roles before copy generation</h3>
            </div>
          </div>
          {type !== "single_image" && (
            <>
              <label className="form-field">
                <span>Total slides or scenes</span>
                <input type="number" min="1" max="100" value={config.totalFrames} onChange={(event) => updateConfig("totalFrames", Number(event.target.value))} />
                <small>
                  {contentSlides} informational content slides · {Boolean(config.includeCover) ? "cover" : "no cover"} · {Boolean(config.includeCta) ? "CTA" : "no CTA"}
                </small>
              </label>
              <div className="form-row">
                <label className="toggle-row">
                  <input type="checkbox" checked={Boolean(config.includeCover)} onChange={(event) => updateConfig("includeCover", event.target.checked)} />
                  <span>
                    <strong>Include cover</strong>
                    <small>Counts toward the total.</small>
                  </span>
                </label>
                <label className="toggle-row">
                  <input type="checkbox" checked={Boolean(config.includeCta)} onChange={(event) => updateConfig("includeCta", event.target.checked)} />
                  <span>
                    <strong>Include CTA</strong>
                    <small>Counts toward the total.</small>
                  </span>
                </label>
              </div>
            </>
          )}
          {type === "single_image" && <div className="inline-note">Single image uses exactly one content frame.</div>}
          <div className="form-row">
            <label className="form-field">
              <span>Text mode</span>
              <select value={config.textMode} onChange={(event) => updateConfig("textMode", event.target.value)}>
                <option value="none">No text</option>
                <option value="cover_only">Cover only</option>
                <option value="headline_only">Headline only</option>
                <option value="headline_and_body">Headline and body</option>
              </select>
            </label>
            <label className="form-field">
              <span>Tone</span>
              <select value={config.tone} onChange={(event) => updateConfig("tone", event.target.value)}>
                {["educational", "informational", "aspirational", "entertaining", "professional", "custom"].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
          </div>
          {type === "video_slideshow" && (
            <div className="video-controls">
              <div className="eyebrow">Video slideshow timing</div>
              <label className="form-field">
                <span>Default duration for images</span>
                <input
                  type="number"
                  min="0.1"
                  max="30"
                  step="0.05"
                  value={config.video?.secondsPerImage ?? 2.5}
                  onChange={(event) =>
                    updateConfig("video", {
                      ...config.video,
                      secondsPerImage: Number(event.target.value),
                    })
                  }
                />
                <small>Applied when the frames are first assigned. Video sources keep their original duration.</small>
              </label>
            </div>
          )}
          <label className="form-field">
            <span>Topic</span>
            <input
              value={config.topic}
              onChange={(event) => {
                updateConfig("topic", event.target.value);
                updateConfig("topicMode", event.target.value ? "user" : "ai");
              }}
              placeholder="Leave blank for an AI-proposed topic"
            />
          </label>
          <div className="form-row">
            <label className="form-field">
              <span>Target audience</span>
              <input value={config.audience} onChange={(event) => updateConfig("audience", event.target.value)} placeholder="e.g. young professionals" />
            </label>
            <label className="form-field">
              <span>CTA text mode</span>
              <select value={config.ctaMode} onChange={(event) => updateConfig("ctaMode", event.target.value)}>
                <option value="none">No CTA copy</option>
                <option value="ai">AI generated</option>
                <option value="user">User provided</option>
              </select>
            </label>
          </div>
          {config.ctaMode === "user" && (
            <label className="form-field">
              <span>CTA text</span>
              <input value={config.ctaText} onChange={(event) => updateConfig("ctaText", event.target.value)} placeholder="Follow for more" />
            </label>
          )}
        </div>
      )}
      {step === 4 && (
        <div>
          <div className="wizard-step">
            <span className="step-number">4</span>
            <div>
              <div className="eyebrow">Content selection</div>
              <h3>Assign unique source content to the ordered frames</h3>
            </div>
            <div className="detail-actions">
              <Button onClick={shuffleImages} disabled={!content || saving}>
                Shuffle unlocked
              </Button>
              <Button onClick={selectImages} disabled={!content || saving}>
                Auto-select
              </Button>
            </div>
          </div>
          {error && <div className="inline-error">{error}</div>}
          {type === "video_slideshow" && (
            <div className="frame-duration-bulk">
              <label className="frame-duration-control">
                <span>Set image duration in bulk</span>
                <div className="frame-duration-input">
                  <input
                    type="number"
                    min="0.1"
                    max="30"
                    step="0.05"
                    value={bulkDurationDraft}
                    onChange={(event) => setBulkDurationDraft(event.target.value)}
                    aria-label="Duration for unlocked image frames"
                  />
                  <span>s</span>
                </div>
              </label>
              <Button
                onClick={() => void applyUnlockedImageDuration()}
                disabled={!content || saving || !content.frames.some((frame) => frame.sourceMedia?.mediaType === "image" && !frame.imageLocked)}
              >
                Apply to unlocked images
              </Button>
              <small>Locked frames and video sources are left unchanged.</small>
            </div>
          )}
          <div className="frame-selection-list">
            {content?.frames.map((frame) => (
              <div className="frame-selection-group" key={frame.id}>
                <div className="frame-selection-row" draggable onDragStart={(event) => event.dataTransfer.setData("text/plain", frame.id)}>
                <span className="frame-number">{frame.position}</span>
                <div className="frame-selection-preview">
                  {frame.sourceMedia ? (
                    <button
                      type="button"
                      className="frame-selection-preview-button"
                      onClick={() => setSourcePreview({ frame, asset: frame.sourceMedia! })}
                      title="Preview assigned content"
                      aria-label={`Preview assigned content for slot ${frame.position}`}
                    >
                      <MediaPreview asset={frame.sourceMedia} />
                    </button>
                  ) : (
                    <span>?</span>
                  )}
                </div>
                <div>
                  <strong>{frame.role}{frame.sourceMedia ? ` (${frame.sourceMedia.mediaType === "video" || frame.sourceMedia.mediaType === "animated" ? "video" : "image"})` : ""}</strong>
                  <span>
                    {frame.sourceMedia?.collectionName ?? "No content selected"}
                    {frame.sourceMedia?.width && frame.sourceMedia?.height ? ` · ${frame.sourceMedia.width} × ${frame.sourceMedia.height}` : ""}
                  </span>
                </div>
                {type === "video_slideshow" && (
                  <label className="frame-duration-control">
                    <span>Duration</span>
                    <div className="frame-duration-input">
                      <input
                        type="number"
                        min="0.1"
                        max={frameDurationMaximum(frame)}
                        step="0.05"
                        value={durationDrafts[frame.id] ?? String(frame.durationSeconds ?? config.video?.secondsPerImage ?? 2.5)}
                        onChange={(event) => {
                          setDirty(true);
                          setDurationDrafts((current) => ({ ...current, [frame.id]: event.target.value }));
                        }}
                        onBlur={() => void saveFrameDuration(frame)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            event.currentTarget.blur();
                          }
                        }}
                        aria-label={`Duration for frame ${frame.position}`}
                      />
                      <span>s</span>
                    </div>
                    <small>
                      {frame.sourceMedia?.durationSeconds && (frame.sourceMedia.mediaType === "video" || frame.sourceMedia.mediaType === "animated")
                        ? `Original ${frame.sourceMedia.durationSeconds.toFixed(2)}s · trim only`
                        : `Default ${Number(config.video?.secondsPerImage ?? 2.5).toFixed(1)}s`}
                    </small>
                  </label>
                )}
                <button
                  type="button"
                  className="frame-icon-button frame-picker-button"
                  onClick={() => toggleSourcePicker(frame.id)}
                  disabled={!selectedCollections.length || saving}
                  title={sourcePickerFrameId === frame.id ? "Close content picker" : "Choose content"}
                  aria-label={sourcePickerFrameId === frame.id ? "Close content picker" : "Choose content"}
                >
                  <Icon name={sourcePickerFrameId === frame.id ? "chevron-up" : "chevron-down"} />
                </button>
                <button
                  type="button"
                  className={`frame-icon-button frame-lock-button ${frame.imageLocked ? "is-locked" : "is-unlocked"}`}
                  onClick={() => void lockFrame(frame, "imageLocked")}
                  title={frame.imageLocked ? "Unlock image" : "Lock image"}
                  aria-label={frame.imageLocked ? "Unlock image" : "Lock image"}
                >
                  <Icon name={frame.imageLocked ? "lock-closed" : "lock-open"} />
                </button>
                </div>
                {sourcePickerFrameId === frame.id && (
                  <div className="frame-source-picker">
                    <div className="frame-source-picker-heading">
                      <div>
                        <strong>Choose content for slot {frame.position}</strong>
                        <span>Showing assets from the selected project collections.</span>
                      </div>
                      <button type="button" className="text-button" onClick={() => toggleSourcePicker(frame.id)}>
                        Close
                      </button>
                    </div>
                    <input
                      className="frame-source-search"
                      value={sourceSearch}
                      onChange={(event) => setSourceSearch(event.target.value)}
                      placeholder="Search by Pin ID"
                      aria-label={`Search content for slot ${frame.position} by Pin ID`}
                    />
                    {sourceAssets.loading && <div className="selection-loading">Loading collection content…</div>}
                    {sourceAssets.error && <div className="inline-error">{sourceAssets.error}</div>}
                    {!sourceAssets.loading && !sourceAssets.error && (
                      <div className="frame-source-options">
                        {(sourceAssets.data?.items ?? []).map((asset) => (
                          <div className={`frame-source-option ${asset.id === frame.sourceMedia?.id ? "selected" : ""}`} key={asset.id}>
                            <button
                              type="button"
                              className="frame-source-option-thumb"
                              onClick={() => setSourcePreview({ frame, asset })}
                              aria-label={`Preview ${asset.title ?? asset.externalId ?? "content"}`}
                              title="Preview content"
                            >
                              <MediaPreview asset={asset} />
                            </button>
                            <button type="button" className="frame-source-option-details" onClick={() => void chooseSourceForFrame(frame, asset)}>
                              <strong>{asset.title ?? asset.externalId ?? "Untitled asset"}</strong>
                              <small>{asset.externalId ?? "No Pin ID"}{asset.collectionName ? ` · ${asset.collectionName}` : ""}</small>
                            </button>
                          </div>
                        ))}
                        {!sourceAssets.data?.items.length && <div className="selection-loading">No content matches that Pin ID.</div>}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          <p className="wizard-help">Content is linked to the original collection records. Source previews stay visible so you can replace them before rendering.{type === "video_slideshow" ? " Set each scene duration here; images use the global default and videos start at their original length." : ""}</p>
        </div>
      )}
      {step === 5 && (
        <div>
          <div className="wizard-step">
            <span className="step-number">5</span>
            <div>
              <div className="eyebrow">Visual and format settings</div>
              <h3>Keep the output style consistent</h3>
            </div>
          </div>
          <div className="form-row">
            <label className="form-field">
              <span>Aspect ratio</span>
              <select value={config.aspectRatio} onChange={(event) => updateConfig("aspectRatio", event.target.value)}>
                <option value="9:16">9:16 vertical</option>
                <option value="1:1">1:1 square</option>
                <option value="4:5">4:5 portrait</option>
                <option value="16:9">16:9 landscape</option>
              </select>
            </label>
            <label className="form-field">
              <span>Crop behavior</span>
              <select
                value={config.visual?.cropMode ?? "crop"}
                onChange={(event) =>
                  updateConfig("visual", {
                    ...config.visual,
                    cropMode: event.target.value,
                  })
                }
              >
                <option value="crop">Crop to fill</option>
                <option value="fit">Fit with letterbox</option>
                <option value="pad">Pad with background</option>
              </select>
            </label>
          </div>
          <div className="form-row">
            <label className="form-field">
              <span>Font family</span>
              <select
                value={config.visual?.fontFamily ?? "Arial"}
                onChange={(event) =>
                  updateConfig("visual", {
                    ...config.visual,
                    fontFamily: event.target.value,
                  })
                }
              >
                <option>Arial</option>
                <option>DejaVu Sans</option>
                <option>Georgia</option>
              </select>
            </label>
            <label className="form-field">
              <span>Text alignment</span>
              <select
                value={config.visual?.textAlignment ?? "left"}
                onChange={(event) =>
                  updateConfig("visual", {
                    ...config.visual,
                    textAlignment: event.target.value,
                  })
                }
              >
                <option>left</option>
                <option>center</option>
                <option>right</option>
              </select>
            </label>
          </div>
          <div className="form-row">
            <label className="form-field">
              <span>Text color</span>
              <input
                type="color"
                value={config.visual?.textColor ?? "#ffffff"}
                onChange={(event) =>
                  updateConfig("visual", {
                    ...config.visual,
                    textColor: event.target.value,
                  })
                }
              />
            </label>
            <label className="form-field">
              <span>Overlay opacity</span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={config.visual?.overlayOpacity ?? 0.5}
                onChange={(event) =>
                  updateConfig("visual", {
                    ...config.visual,
                    overlayOpacity: Number(event.target.value),
                  })
                }
              />
            </label>
          </div>
          <label className="toggle-row">
            <input type="checkbox" checked={config.textMode !== "none"} onChange={(event) => updateConfig("textMode", event.target.checked ? "headline_and_body" : "none")} />
            <span>
              <strong>Text overlay enabled</strong>
              <small>Text mode controls whether copy is rendered.</small>
            </span>
          </label>
          {type === "video_slideshow" && (
            <div className="video-controls">
              <div className="eyebrow">Video slideshow controls</div>
              <div className="form-row">
                <label className="form-field">
                  <span>Output resolution</span>
                  <select
                    value={config.video?.outputResolution ?? "720p"}
                    onChange={(event) =>
                      updateConfig("video", {
                        ...config.video,
                        outputResolution: event.target.value,
                      })
                    }
                  >
                    <option>720p</option>
                    <option>1080p</option>
                  </select>
                </label>
                <label className="form-field">
                  <span>FPS</span>
                  <input
                    type="number"
                    min="12"
                    max="60"
                    value={config.video?.fps ?? 30}
                    onChange={(event) =>
                      updateConfig("video", {
                        ...config.video,
                        fps: Number(event.target.value),
                      })
                    }
                  />
                </label>
              </div>
              <div className="form-row">
                <label className="form-field">
                  <span>Transition</span>
                  <select
                    value={config.video?.transition ?? "fade"}
                    onChange={(event) =>
                      updateConfig("video", {
                        ...config.video,
                        transition: event.target.value,
                      })
                    }
                  >
                    <option value="fade">Fade</option>
                    <option value="none">None</option>
                  </select>
                </label>
              </div>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={Boolean(config.video?.panZoom)}
                  onChange={(event) =>
                    updateConfig("video", {
                      ...config.video,
                      panZoom: event.target.checked,
                    })
                  }
                />
                <span>
                  <strong>Pan or zoom effect</strong>
                  <small>Stored for the renderer; fixed framing is used for this local phase.</small>
                </span>
              </label>
            </div>
          )}
        </div>
      )}
      {step === 6 && (
        <div>
          <div className="wizard-step">
            <span className="step-number">6</span>
            <div>
              <div className="eyebrow">Text review</div>
              <h3>Review structured copy before rendering</h3>
            </div>
            <div className="detail-actions">
              <Button onClick={generateCopy} disabled={!content || saving || hasActiveTextJob}>
                {content?.narrative ? "Regenerate copy" : "Generate copy"}
              </Button>
              <Button
                onClick={() =>
                  content &&
                  request(`/api/content/${content.id}/caption`, {
                    method: "POST",
                    body: JSON.stringify({}),
                  }).then((result: AnyRecord) => {
                    setContent(result.content);
                    setNotice("Caption regeneration queued.");
                  })
                }
                disabled={!content || saving || hasActiveTextJob}
              >
                Regenerate caption
              </Button>
            </div>
          </div>
          {content ? (
            <div className="text-review-list">
              {content.frames.map((frame) => (
                <div className="text-review-card" key={frame.id}>
                  <div className="frame-review-heading">
                    <span>
                      {frame.position} · {frame.role}
                    </span>
                    <Button onClick={() => lockFrame(frame, "textLocked")}>{frame.textLocked ? "Unlock text" : "Lock text"}</Button>
                  </div>
                  <label className="form-field">
                    <span>Headline</span>
                    <input value={frame.headline ?? ""} disabled={frame.textLocked} onChange={(event) => editFrame(frame, "headline", event.target.value)} onBlur={(event) => saveFrame({ ...frame, headline: event.target.value })} />
                  </label>
                  {frame.role !== "cta" && (
                    <label className="form-field">
                      <span>Body</span>
                      <textarea value={frame.body ?? ""} disabled={frame.textLocked} onChange={(event) => editFrame(frame, "body", event.target.value)} onBlur={(event) => saveFrame({ ...frame, body: event.target.value })} rows={2} />
                    </label>
                  )}
                </div>
              ))}
              <label className="form-field">
                <span>Caption</span>
                <textarea value={content.narrative?.caption ?? content.configuration.caption ?? ""} onChange={(event) => editCaption(event.target.value)} onBlur={saveCaption} rows={3} />
              </label>
              {content.narrative && (
                <div className="hashtag-row">
                  {content.narrative.hashtags.map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="inline-note">Create the draft first to edit its text fields.</div>
          )}
        </div>
      )}
      {step === 7 && (
        <div>
          <div className="wizard-step">
            <span className="step-number">7</span>
            <div>
              <div className="eyebrow">Preview and final confirmation</div>
              <h3>Review the actual rendered proposal</h3>
            </div>
            <div className="detail-actions">
              <Button onClick={generatePreview} disabled={!content || saving}>
                Regenerate preview
              </Button>
            </div>
          </div>
          {content?.status === "preview_generating" && (
            <div className="preview-progress" role="status">
              <strong>Preview is rendering locally.</strong>
              <span>{previewJob ? `Render progress: ${previewJob.progress}%` : "The local renderer is starting…"}</span>
            </div>
          )}
          {content?.status === "failed" && (
            <div className="inline-error">
              <span>{content.errorMessage ?? "Preview rendering failed."}</span>
              <Button onClick={() => void retryPreview()} disabled={saving}>Retry preview</Button>
            </div>
          )}
          {previewAsset ? (
            <div className="preview-workspace">
              <div className="preview-main">
                {previewAsset.assetType === "video" ? (
                  <video
                    src={`${API_BASE}${previewAsset.previewUrl}`}
                    controls
                    playsInline
                    preload="metadata"
                    aria-label="Generated video preview"
                    style={{ maxWidth: "100%", maxHeight: 540, objectFit: "contain" }}
                  />
                ) : (
                  <img src={`${API_BASE}${previewAsset.previewUrl}`} alt="Generated preview" />
                )}
              </div>
              <div className="preview-meta">
                <StatusBadge value={content?.status ?? "draft"} />
                <p>{content?.type === "carousel" ? `${content.frames.length} independent slides` : content?.type === "video_slideshow" ? "MP4 slideshow preview" : "Single image preview"}</p>
                {content?.type === "carousel" && (
                  <div className="preview-strip">
                    {content.assets
                      .filter((asset) => asset.variant === "preview" && asset.assetType === "image")
                      .map((asset) => (
                        <img key={asset.id} src={`${API_BASE}${asset.previewUrl}`} alt="" />
                      ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="preview-empty">
              {content?.status === "preview_generating" ? (
                <p>Keep this window open while the local renderer finishes.</p>
              ) : content?.status !== "failed" ? (
                <>
                  <p>Generate a preview after copy and images are ready.</p>
                  <Button variant="primary" onClick={generatePreview} disabled={!content || saving}>
                    Generate preview
                  </Button>
                </>
              ) : null}
            </div>
          )}
          {content?.status === "ready" && (
            <div className="ready-actions">
              <Button variant="primary" onClick={() => window.open(`${API_BASE}/api/content/${content.id}/download`, "_blank")}>
                {content.type === "video_slideshow" ? "Download MP4" : content.type === "carousel" ? "Download slides (ZIP)" : "Download final"}
              </Button>
              <Button onClick={() => window.open(`${API_BASE}/api/content/${content.id}/package.zip`, "_blank")}>Download package (ZIP)</Button>
            </div>
          )}
        </div>
      )}
      {notice && <div className="inline-note">{notice}</div>}
      {error && <div className="inline-error">{error}</div>}
      <div className="modal-footer">
        <Button onClick={close}>Close</Button>
        {step > 1 && <Button onClick={() => void persistStep(step - 1)}>Back</Button>}
        {step < 7 && (
          <Button variant="primary" onClick={next} disabled={saving}>
            Next
          </Button>
        )}
        {step === 7 && content?.status === "preview_ready" && (
          <Button variant="primary" onClick={confirmFinal} disabled={saving}>
            Confirm and generate final
          </Button>
        )}
        {content?.status === "ready" && (
          <Button variant="primary" onClick={() => onClose()}>
            Done
          </Button>
        )}
        <Button
          onClick={async () => {
            try {
              const draft = await ensureDraft();
              await persistStep(step, draft.id);
              onClose();
            } catch (caught) {
              setError(caught instanceof Error ? caught.message : "Could not save draft");
            }
          }}
        >
          Save draft
        </Button>
      </div>
      </Modal>
      {sourcePreview && (
        <Modal title="Preview content" onClose={() => setSourcePreview(null)} wide>
          <div className="source-preview-modal">
            <div className="source-preview-media">
              <MediaPreview asset={sourcePreview.asset} detail />
            </div>
            <div className="source-preview-copy">
              <div className="eyebrow">Slot {sourcePreview.frame.position}</div>
              <h3>{sourcePreview.asset.title ?? sourcePreview.asset.externalId ?? "Untitled asset"}</h3>
              <p>Review this content at full size before assigning it to the slot.</p>
              <div className="metadata-list">
                <div>
                  <span>Pin ID</span>
                  <strong>{sourcePreview.asset.externalId ?? "Not available"}</strong>
                </div>
                <div>
                  <span>Collection</span>
                  <strong>{sourcePreview.asset.collectionName ?? "Selected project source"}</strong>
                </div>
                <div>
                  <span>Dimensions</span>
                  <strong>{sourcePreview.asset.width && sourcePreview.asset.height ? `${sourcePreview.asset.width} × ${sourcePreview.asset.height}` : "Unknown"}</strong>
                </div>
              </div>
              <div className="source-preview-actions">
                <Button onClick={() => setSourcePreview(null)}>Close preview</Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    const selection = sourcePreview;
                    setSourcePreview(null);
                    void chooseSourceForFrame(selection.frame, selection.asset);
                  }}
                >
                  Use this content
                </Button>
              </div>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

function ContentWizard({
  project,
  existingId,
  onClose,
  onSaved,
}: {
  project: Project;
  existingId?: string;
  onClose: () => void;
  onSaved: () => void;
}): ReactElement {
  const existing = useApi<ContentDetail>(
    existingId ? `/api/content/${existingId}` : null,
  );
  const [clipping, setClipping] = useState(false);
  useEffect(() => {
    if (existing.data?.type === "video_clipping") setClipping(true);
  }, [existing.data?.type]);
  if (clipping)
    return (
      <ClippingWizard
        project={project}
        existingId={existingId}
        onClose={onClose}
        onSaved={onSaved}
      />
    );
  return (
    <LegacyContentWizard
      project={project}
      existingId={existingId}
      onClose={onClose}
      onSaved={onSaved}
      onSelectClipping={() => setClipping(true)}
    />
  );
}

function AssetDrawer({ asset, onClose }: { asset: Asset | null; onClose: () => void }): ReactElement | null {
  const detail = useApi<Asset & { collections?: Collection[] }>(asset ? `/api/assets/${asset.id}` : null);
  const [dimensions, setDimensions] = useState<{
    width?: number;
    height?: number;
  }>({});
  useEffect(() => setDimensions({}), [asset?.id]);
  const item = detail.data ?? asset;
  if (!asset) return null;
  return (
    <Modal title={item?.mediaType === "video" ? "Video asset" : "Image asset"} onClose={onClose} wide>
      <div className="asset-detail-layout">
        <div className="asset-detail-preview">{item && <MediaPreview asset={item} detail onImageLoad={(size) => setDimensions(size)} />}</div>
        <div className="asset-detail-info">
          <StatusBadge value={item?.status ?? "available"} />
          <h2>{item?.title ?? item?.altText ?? "Untitled asset"}</h2>
          {item?.description && <p>{item.description}</p>}
          <div className="metadata-list">
            <div>
              <span>Dimensions</span>
              <strong>{dimensions.width && dimensions.height ? `${dimensions.width} × ${dimensions.height}` : "Loading…"}</strong>
            </div>
            <div>
              <span>Aspect ratio</span>
              <strong>
                {item?.aspectRatio ? item.aspectRatio.toFixed(2) : "Unknown"} · {item?.orientation ?? "unknown"}
              </strong>
            </div>
            <div>
              <span>Collection</span>
              <strong>{item?.collectionName ?? item?.collections?.[0]?.name ?? "Multiple sources"}</strong>
            </div>
            <div>
              <span>First seen</span>
              <strong>{formatDate(item?.firstSeenAt ?? item?.createdAt)}</strong>
            </div>
            <div>
              <span>Last seen</span>
              <strong>{formatDate(item?.lastSeenAt ?? item?.updatedAt)}</strong>
            </div>
            <div>
              <span>Source platform</span>
              <strong>{item?.provider ?? "Pinterest"}</strong>
            </div>
          </div>
          <div className="detail-actions vertical">
            <Button onClick={() => item?.mediaUrl && navigator.clipboard.writeText(item.mediaUrl)}>Copy media link</Button>
            {(item?.canonicalUrl || item?.sourceLink) && (
              <Button variant="primary" onClick={() => window.open(item.canonicalUrl ?? item.sourceLink, "_blank", "noopener,noreferrer")}>
                <Icon name="arrow" /> Open original
              </Button>
            )}
          </div>
          <p className="remote-note">Remote media stays at its source. If playback or preview is unavailable, use the original link.</p>
        </div>
      </div>
    </Modal>
  );
}

function SearchDialog({ onClose }: { onClose: () => void }): ReactElement {
  const [query, setQuery] = useState("");
  const result = useApi<SearchResult>(query.trim().length > 1 ? `/api/search?q=${encodeURIComponent(query.trim())}` : null);
  return (
    <Modal title="Search workspace" onClose={onClose} wide>
      <label className="search-field search-dialog-input">
        <Icon name="search" />
        <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search collections, assets, projects…" />
      </label>
      {result.loading && <div className="selection-loading">Searching…</div>}
      {result.error && <ErrorState message={result.error} />}
      {result.data && (
        <div className="search-results">
          {result.data.collections.length > 0 && (
            <div>
              <div className="eyebrow">Collections</div>
              {result.data.collections.map((item) => (
                <button
                  className="search-result"
                  key={item.id}
                  onClick={() => {
                    onClose();
                    navigate(`/collection/${item.id}`);
                  }}
                >
                  <span className="result-icon">▦</span>
                  <span>
                    <strong>{item.name}</strong>
                    <small>
                      {item.assetCount} assets · {item.provider}
                    </small>
                  </span>
                  <Icon name="arrow" />
                </button>
              ))}
            </div>
          )}
          {result.data.assets.length > 0 && (
            <div>
              <div className="eyebrow">Assets</div>
              {result.data.assets.map((item) => (
                <button
                  className="search-result"
                  key={item.id}
                  onClick={() => {
                    onClose();
                  }}
                >
                  <span className="result-thumb">
                    <MediaPreview asset={item} />
                  </span>
                  <span>
                    <strong>{item.title ?? item.altText ?? "Untitled asset"}</strong>
                    <small>
                      {item.collectionName ?? "Asset"} · {item.mediaType}
                    </small>
                  </span>
                  <Icon name="arrow" />
                </button>
              ))}
            </div>
          )}
          {result.data.projects.length > 0 && (
            <div>
              <div className="eyebrow">Projects</div>
              {result.data.projects.map((item) => (
                <button
                  className="search-result"
                  key={item.id}
                  onClick={() => {
                    onClose();
                    navigate(`/project/${item.id}`);
                  }}
                >
                  <span className="result-icon">◒</span>
                  <span>
                    <strong>{item.name}</strong>
                    <small>
                      {item.collectionCount} collections · {item.totalAssets} assets
                    </small>
                  </span>
                  <Icon name="arrow" />
                </button>
              ))}
            </div>
          )}
          {!result.data.collections.length && !result.data.assets.length && !result.data.projects.length && <EmptyState icon="⌕" title="No results" message="Try a collection name, caption, source ID, or project." />}
        </div>
      )}
    </Modal>
  );
}

function App(): ReactElement {
  const [route, setRoute] = useState(getRoute());
  const [asset, setAsset] = useState<Asset | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [projectDialog, setProjectDialog] = useState<Project | "new" | false>(false);
  const [contentWizard, setContentWizard] = useState<{
    project: Project;
    existingId?: string;
  } | null>(null);
  const [projectRefresh, setProjectRefresh] = useState(0);
  useEffect(() => {
    const update = () => setRoute(getRoute());
    window.addEventListener("popstate", update);
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener("keydown", key);
    };
  }, []);
  let content: ReactNode;
  if (route.page === "home") content = <DashboardPage onOpenAsset={setAsset} />;
  if (route.page === "collections") content = route.id ? <CollectionDetailPage id={route.id} onOpenAsset={setAsset} /> : <CollectionsPage />;
  if (route.page === "assets") content = <AssetsPage onOpenAsset={setAsset} />;
  if (route.page === "projects")
    content = route.id ? (
      <ProjectDetailPage
        id={route.id}
        refresh={projectRefresh}
        onDeleted={() => {
          setProjectRefresh((value) => value + 1);
          navigate("/projects");
        }}
        onContentChanged={() => setProjectRefresh((value) => value + 1)}
        onEdit={(project) => setProjectDialog(project)}
        onOpenAsset={setAsset}
        onCreateContent={(project) => setContentWizard({ project })}
        onOpenContent={(item) => {
          void request<Project>(`/api/projects/${route.id}`).then((project) => setContentWizard({ project, existingId: item.id }));
        }}
      />
    ) : (
      <ProjectsPage onEdit={(project) => setProjectDialog(project ?? "new")} />
    );
  if (route.page === "imports") content = <ImportsPage />;
  if (route.page === "settings") content = <SettingsPage onOpenAsset={setAsset} />;
  return (
    <Shell route={route} onSearch={() => setSearchOpen(true)}>
      {content}
      {asset && <AssetDrawer asset={asset} onClose={() => setAsset(null)} />}
      {searchOpen && <SearchDialog onClose={() => setSearchOpen(false)} />}
      {projectDialog !== false && (
        <ProjectDialog
          project={projectDialog === "new" ? undefined : projectDialog}
          onClose={() => setProjectDialog(false)}
          onSaved={(saved) => {
            setProjectRefresh((value) => value + 1);
            if (saved) navigate(`/project/${saved.id}`);
          }}
        />
      )}
      {contentWizard && <ContentWizard project={contentWizard.project} existingId={contentWizard.existingId} onClose={() => setContentWizard(null)} onSaved={() => setProjectRefresh((value) => value + 1)} />}
    </Shell>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
