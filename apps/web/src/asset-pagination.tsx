import { useCallback, useEffect, useRef, useState, type ReactElement, type RefObject } from 'react';

interface Pagination { page: number; pageSize: number; total: number; totalPages: number }
interface PageResponse<T> { items: T[]; pagination: Pagination }

function parsePageResponse<T>(value: unknown): PageResponse<T> {
  if (!value || typeof value !== 'object') {
    throw new Error('The media response was empty. Try again.');
  }

  const page = value as Partial<PageResponse<T>>;
  if (!Array.isArray(page.items) || !page.pagination || typeof page.pagination !== 'object') {
    throw new Error('The media response was invalid. Try again.');
  }

  return page as PageResponse<T>;
}

export interface InfiniteAssetsState<T> {
  items: T[];
  pagination: Pagination | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  sentinelRef: RefObject<HTMLDivElement | null>;
}

const PAGE_SIZE = 36;
const API_BASE = (import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');

function pageUrl(basePath: string, page: number): string {
  const target = /^https?:\/\//.test(basePath) ? basePath : `${API_BASE}${basePath}`;
  const separator = target.includes('?') ? '&' : '?';
  return `${target}${separator}page=${page}&pageSize=${PAGE_SIZE}`;
}

export function useInfiniteAssets<T>(basePath: string, refresh = 0): InfiniteAssetsState<T> {
  const [items, setItems] = useState<T[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const requestVersion = useRef(0);

  const fetchPage = useCallback(async (nextPage: number): Promise<PageResponse<T>> => {
    const response = await fetch(pageUrl(basePath, nextPage));
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error?.message ?? `Request failed (${response.status})`);
    return parsePageResponse<T>(body);
  }, [basePath]);

  useEffect(() => {
    let active = true;
    const version = requestVersion.current + 1;
    requestVersion.current = version;
    setItems([]);
    setPagination(null);
    setPage(0);
    setLoadingMore(false);
    setError(null);
    setLoading(true);
    void fetchPage(1).then((response) => {
      if (!active || requestVersion.current !== version) return;
      setItems(response.items);
      setPagination(response.pagination);
      setPage(1);
    }).catch((caught) => {
      if (active && requestVersion.current === version) setError(caught instanceof Error ? caught.message : 'Could not load media');
    }).finally(() => {
      if (active && requestVersion.current === version) setLoading(false);
    });
    return () => { active = false; };
  }, [fetchPage, refresh]);

  const hasMore = Boolean(pagination && items.length < pagination.total);
  const loadMore = useCallback(async (): Promise<void> => {
    if (loading || loadingMore || !pagination || items.length >= pagination.total) return;
    setLoadingMore(true);
    setError(null);
    const version = requestVersion.current;
    try {
      const response = await fetchPage(page + 1);
      if (requestVersion.current !== version) return;
      setItems((current) => [...current, ...response.items]);
      setPagination(response.pagination);
      setPage((current) => current + 1);
    } catch (caught) {
      if (requestVersion.current === version) setError(caught instanceof Error ? caught.message : 'Could not load more media');
    } finally {
      if (requestVersion.current === version) setLoadingMore(false);
    }
  }, [fetchPage, items.length, loading, loadingMore, page, pagination]);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasMore) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) void loadMore();
    }, { rootMargin: '700px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loadMore]);

  return { items, pagination, loading, loadingMore, error, hasMore, sentinelRef };
}

export function InfiniteAssetFooter<T>({ state }: { state: InfiniteAssetsState<T> | null | undefined }): ReactElement | null {
  if (!state?.items?.length) return null;
  return <div ref={state.sentinelRef} className="asset-load-more">
    {state.loadingMore && <><span className="spinner" /> Loading more media…</>}
    {!state.loadingMore && state.error && <span className="inline-error">{state.error}</span>}
    {!state.loadingMore && !state.error && state.hasMore && <span>Scroll to load more media</span>}
    {!state.loadingMore && !state.error && !state.hasMore && <span>All media loaded</span>}
  </div>;
}
