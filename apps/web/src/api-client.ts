const DEFAULT_API_BASE = "http://127.0.0.1:3000";
function normalizeApiBase(value: string): string {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return DEFAULT_API_BASE;
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return DEFAULT_API_BASE;
  }
}
function storedApiBase(): string {
  try {
    return normalizeApiBase(window.localStorage.getItem('tokia-api-base') ?? DEFAULT_API_BASE);
  } catch {
    return DEFAULT_API_BASE;
  }
}

export let API_BASE = typeof window === 'undefined' ? DEFAULT_API_BASE : storedApiBase();
export function setApiBase(value: string): void {
  API_BASE = normalizeApiBase(value);
  try {
    window.localStorage.setItem('tokia-api-base', API_BASE);
  } catch {
    // Storage may be unavailable in a restricted browser context.
  }
}

let integrationToken = "";
let integrationTokenRequest: Promise<string> | null = null;

async function loadIntegrationToken(): Promise<string> {
  if (integrationToken) return integrationToken;
  integrationTokenRequest ??= fetch(`${API_BASE}/api/settings/bootstrap`)
    .then(async (response) => {
      const body = await response.json().catch(() => null) as { integrationToken?: unknown; backendBaseUrl?: unknown } | null;
      if (!response.ok || typeof body?.integrationToken !== "string" || !body.integrationToken) {
        throw new Error("The local integration token could not be loaded.");
      }
      if (typeof body.backendBaseUrl === "string") setApiBase(body.backendBaseUrl);
      integrationToken = body.integrationToken;
      return integrationToken;
    })
    .finally(() => {
      integrationTokenRequest = null;
    });
  return integrationTokenRequest;
}

export function setIntegrationToken(value: string): void {
  integrationToken = value.trim();
}

export async function getIntegrationToken(): Promise<string> {
  return loadIntegrationToken();
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await loadIntegrationToken();
  const headers = new Headers(init?.headers);
  if (init?.method && init.method !== "GET") {
    headers.set("X-Local-Integration-Token", token);
  }
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error?.message ?? `Request failed (${response.status})`);
  }
  return body as T;
}
