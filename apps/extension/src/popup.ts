import type { IngestionPayload } from '@tokia/shared';
import type { DetectedBoard, ScanProgress, ScanSettings } from './scanner.js';

interface ExtensionSettings {
  backendUrl: string;
  token: string;
  maxPins: number;
  maxDurationMs: number;
  noNewRounds: number;
  waitMs: number;
  scrollRatio: number;
}

const defaultSettings: ExtensionSettings = {
  backendUrl: 'http://localhost:3000',
  token: 'tokia-local-dev-token',
  maxPins: 2_000,
  maxDurationMs: 10 * 60 * 1000,
  noNewRounds: 5,
  waitMs: 1_500,
  scrollRatio: 0.75
};

let activeTab: chrome.tabs.Tab | undefined;
let activePort: chrome.runtime.Port | undefined;
let currentPayload: IngestionPayload | undefined;
let currentBoard: DetectedBoard | undefined;
let currentSettings = defaultSettings;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const status = $('status');
const boardInfo = $('board-info');
const progress = $('progress');
const result = $('result');
const error = $('error');

function setStatus(value: string): void { status.textContent = value; }
function setError(value: string): void { error.textContent = value; }
function setResult(value: string): void { result.textContent = value; }

async function loadSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.local.get(defaultSettings);
  return { ...defaultSettings, ...stored } as ExtensionSettings;
}

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) throw new Error('No active browser tab was found');
  return tab;
}

async function ensureContentScript(tab: chrome.tabs.Tab): Promise<void> {
  if (!tab.id) throw new Error('The active tab has no ID');
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  }
}

async function detect(): Promise<void> {
  try {
    activeTab = await getActiveTab();
    await ensureContentScript(activeTab);
    currentBoard = await chrome.tabs.sendMessage(activeTab.id!, { type: 'GET_STATUS' }) as DetectedBoard;
    boardInfo.textContent = currentBoard.isBoard
      ? `${currentBoard.name} · ${currentBoard.url}${currentBoard.externalId ? ` · ID ${currentBoard.externalId}` : ''}`
      : 'La pestaña actual no parece ser un board de Pinterest.';
    setStatus(currentBoard.isBoard ? 'Board detectado' : 'Página no compatible');
  } catch (caught) {
    setStatus('No se pudo inspeccionar la pestaña');
    setError(caught instanceof Error ? caught.message : 'Abrí un board de Pinterest en la pestaña activa.');
  }
}

function scanSettings(mode: 'visible' | 'full'): ScanSettings {
  return { mode, maxPins: currentSettings.maxPins, maxDurationMs: currentSettings.maxDurationMs, noNewRounds: currentSettings.noNewRounds, waitMs: mode === 'visible' ? 0 : currentSettings.waitMs, scrollRatio: currentSettings.scrollRatio };
}

async function startScan(mode: 'visible' | 'full'): Promise<void> {
  setError('');
  setResult('');
  if (!activeTab?.id) await detect();
  if (!activeTab?.id || !currentBoard?.isBoard) { setError('La pestaña activa debe mostrar un board de Pinterest.'); return; }
  await ensureContentScript(activeTab);
  activePort?.disconnect();
  activePort = chrome.tabs.connect(activeTab.id, { name: 'scan-control' });
  setStatus(mode === 'visible' ? 'Escaneando Pins visibles…' : 'Escaneando board completo…');
  progress.textContent = '0 Pins';
  const response = await chrome.tabs.sendMessage(activeTab.id, { type: 'START_SCAN', settings: scanSettings(mode) }) as { accepted: boolean; error?: string };
  if (!response.accepted) setError(response.error ?? 'No se pudo iniciar el scan.');
}

async function stopScan(): Promise<void> {
  if (activeTab?.id) await chrome.tabs.sendMessage(activeTab.id, { type: 'STOP_SCAN' }).catch(() => undefined);
  setStatus('Deteniendo scan…');
}

async function sendToApplication(): Promise<void> {
  if (!currentPayload) { setError('Primero ejecutá un scan.'); return; }
  const url = currentSettings.backendUrl.replace(/\/+$/, '') + '/api/imports/pinterest-board';
  let lastError = 'No se pudo conectar al backend.';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Local-Integration-Token': currentSettings.token },
        body: JSON.stringify(currentPayload)
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok) {
        setStatus('Importación completada');
        setResult(`Recibidos: ${body.summary.received} · Nuevos: ${body.summary.assetsCreated} · Actualizados: ${body.summary.assetsUpdated} · Duplicados: ${body.summary.duplicatesSkipped} · Inválidos: ${body.summary.invalid}`);
        return;
      }
      lastError = body?.error?.message ?? `Backend respondió ${response.status}`;
      if (response.status < 500 && response.status !== 408 && response.status !== 429) break;
    } catch (caught) {
      lastError = caught instanceof Error ? caught.message : lastError;
    }
    await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
  }
  setStatus('Falló la importación');
  setError(lastError);
}

async function testConnection(): Promise<void> {
  try {
    const response = await fetch(currentSettings.backendUrl.replace(/\/+$/, '') + '/api/health');
    if (!response.ok) throw new Error(`Backend respondió ${response.status}`);
    setStatus('Backend conectado');
    setError('');
  } catch (caught) {
    setError(caught instanceof Error ? caught.message : 'No se pudo conectar al backend.');
  }
}

function copyJson(): void {
  if (!currentPayload) { setError('Primero ejecutá un scan.'); return; }
  void navigator.clipboard.writeText(JSON.stringify(currentPayload, null, 2)).then(() => setResult('JSON copiado al portapapeles.'));
}

function downloadJson(): void {
  if (!currentPayload) { setError('Primero ejecutá un scan.'); return; }
  const blob = new Blob([JSON.stringify(currentPayload, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'tokia-pinterest-import.json';
  link.click();
  URL.revokeObjectURL(link.href);
}

chrome.runtime.onMessage.addListener((message: { type?: string; progress?: ScanProgress; payload?: IngestionPayload; error?: string }) => {
  if (message.type === 'SCAN_PROGRESS' && message.progress) {
    progress.textContent = `${message.progress.uniquePins} Pins · ronda ${message.progress.rounds} · ${message.progress.phase}`;
  }
  if (message.type === 'SCAN_COMPLETE' && message.payload) {
    currentPayload = message.payload;
    activePort?.disconnect();
    activePort = undefined;
    progress.textContent = `${message.payload.pins.length} Pins únicos · ${message.progress?.phase ?? 'complete'}`;
    setStatus('Scan listo');
    setResult('Payload generado en memoria. Podés enviarlo o copiarlo.');
  }
  if (message.type === 'SCAN_ERROR') setError(message.error ?? 'El scan falló.');
});

$('scan-visible').addEventListener('click', () => void startScan('visible'));
$('scan-full').addEventListener('click', () => void startScan('full'));
$('stop-scan').addEventListener('click', () => void stopScan());
$('send').addEventListener('click', () => void sendToApplication());
$('copy').addEventListener('click', copyJson);
$('download').addEventListener('click', downloadJson);
$('test-connection').addEventListener('click', () => void testConnection());
$('settings').addEventListener('click', () => void chrome.runtime.openOptionsPage());
window.addEventListener('unload', () => activePort?.disconnect());

void (async () => {
  currentSettings = await loadSettings();
  await detect();
})();
