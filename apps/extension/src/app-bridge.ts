const extensionMessageSource = 'tokia-browser-extension';
const webMessageSource = 'tokia-web-app';

function postMessage(message: Record<string, unknown>): void {
  window.postMessage({ source: extensionMessageSource, ...message }, window.location.origin);
}

function announceExtensionId(): void {
  postMessage({ type: 'EXTENSION_ID', extensionId: chrome.runtime.id });
}

function normalizeBackendUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

async function configureBackend(value: unknown): Promise<void> {
  const backendUrl = normalizeBackendUrl(value);
  if (!backendUrl) {
    postMessage({ type: 'EXTENSION_CONFIGURED', extensionId: chrome.runtime.id, ok: false, error: 'The backend URL is invalid.' });
    return;
  }
  try {
    await chrome.storage.local.set({ backendUrl });
    postMessage({ type: 'EXTENSION_CONFIGURED', extensionId: chrome.runtime.id, ok: true, backendUrl });
  } catch {
    postMessage({ type: 'EXTENSION_CONFIGURED', extensionId: chrome.runtime.id, ok: false, error: 'The extension settings could not be saved.' });
  }
}

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const data = event.data as { source?: string; type?: string; backendUrl?: unknown } | undefined;
  if (data?.source !== webMessageSource) return;
  if (data.type === 'REQUEST_EXTENSION_ID') announceExtensionId();
  if (data.type === 'CONFIGURE_EXTENSION') void configureBackend(data.backendUrl);
});

announceExtensionId();
