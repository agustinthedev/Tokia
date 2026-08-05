interface ExtensionSettings {
  backendUrl: string;
  token: string;
  maxPins: number;
  maxDurationMs: number;
  noNewRounds: number;
  waitMs: number;
  scrollRatio: number;
}

const defaults: ExtensionSettings = {
  backendUrl: 'http://localhost:3000',
  token: 'tokia-local-dev-token',
  maxPins: 2_000,
  maxDurationMs: 600_000,
  noNewRounds: 5,
  waitMs: 1_500,
  scrollRatio: 0.75
};

const form = document.querySelector('form')!;
const message = document.getElementById('message')!;

async function load(): Promise<void> {
  const settings = { ...defaults, ...(await chrome.storage.local.get(defaults)) } as ExtensionSettings;
  (document.getElementById('backend-url') as HTMLInputElement).value = settings.backendUrl;
  (document.getElementById('token') as HTMLInputElement).value = settings.token;
  (document.getElementById('max-pins') as HTMLInputElement).value = String(settings.maxPins);
  (document.getElementById('max-duration') as HTMLInputElement).value = String(settings.maxDurationMs / 60_000);
  (document.getElementById('no-new-rounds') as HTMLInputElement).value = String(settings.noNewRounds);
  (document.getElementById('wait-ms') as HTMLInputElement).value = String(settings.waitMs);
  (document.getElementById('scroll-ratio') as HTMLInputElement).value = String(settings.scrollRatio);
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const settings: ExtensionSettings = {
    backendUrl: (document.getElementById('backend-url') as HTMLInputElement).value.trim().replace(/\/+$/, ''),
    token: (document.getElementById('token') as HTMLInputElement).value.trim(),
    maxPins: Number((document.getElementById('max-pins') as HTMLInputElement).value),
    maxDurationMs: Number((document.getElementById('max-duration') as HTMLInputElement).value) * 60_000,
    noNewRounds: Number((document.getElementById('no-new-rounds') as HTMLInputElement).value),
    waitMs: Number((document.getElementById('wait-ms') as HTMLInputElement).value),
    scrollRatio: Number((document.getElementById('scroll-ratio') as HTMLInputElement).value)
  };
  void chrome.storage.local.set(settings).then(() => { message.textContent = 'Configuración guardada.'; });
});

void load();
