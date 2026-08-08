export const API_BASE = "http://127.0.0.1:3000";

let integrationToken = "";
let integrationTokenRequest: Promise<string> | null = null;

async function loadIntegrationToken(): Promise<string> {
  if (integrationToken) return integrationToken;
  integrationTokenRequest ??= fetch(`${API_BASE}/api/settings/bootstrap`)
    .then(async (response) => {
      const body = await response.json().catch(() => null) as { integrationToken?: unknown } | null;
      if (!response.ok || typeof body?.integrationToken !== "string" || !body.integrationToken) {
        throw new Error("The local integration token could not be loaded.");
      }
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
