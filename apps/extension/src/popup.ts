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
const boardTitle = $('board-title');
const boardBadge = $('board-badge');
const boardInfo = $('board-info');
const progress = $('progress');
const progressFill = $('progress-fill');
const result = $('result');
const error = $('error');
const stopButton = $('stop-scan') as HTMLButtonElement;
const sendButton = $('send') as HTMLButtonElement;

function setStatus(value: string): void { status.textContent = value; }
function setError(value: string): void { error.textContent = value; }
function setResult(value: string): void { result.textContent = value; }
function setControlState(button: HTMLButtonElement, enabled: boolean, activeClass: 'button-success' | 'button-danger'): void {
  button.disabled = !enabled;
  button.classList.toggle(activeClass, enabled);
  button.classList.toggle('button-quiet', !enabled);
}
function setScanControls(scanning: boolean, payloadReady: boolean): void {
  setControlState(stopButton, scanning, 'button-danger');
  setControlState(sendButton, payloadReady, 'button-success');
}
function setProgress(value: string, percentage = 0): void {
  progress.textContent = value;
  progressFill.style.width = `${Math.max(0, Math.min(100, percentage))}%`;
}

async function loadSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.local.get(defaultSettings);
  return { ...defaultSettings, ...stored } as ExtensionSettings;
}

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) throw new Error('No active browser tab was found.');
  return tab;
}

async function ensureContentScript(tab: chrome.tabs.Tab): Promise<void> {
  if (!tab.id) throw new Error('The active tab has no ID.');
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
    if (currentBoard.isBoard) {
      boardTitle.textContent = currentBoard.name;
      boardBadge.textContent = 'Ready';
      boardBadge.className = 'badge';
      boardInfo.textContent = `${currentBoard.name} · ${currentBoard.url}${currentBoard.externalId ? ` · ID ${currentBoard.externalId}` : ''}`;
      setStatus('Pinterest board detected');
    } else {
      boardTitle.textContent = 'No board detected';
      boardBadge.textContent = 'Check tab';
      boardBadge.className = 'badge badge-blue';
      boardInfo.textContent = 'The current tab does not appear to be a Pinterest board.';
      setStatus('Unsupported page');
    }
  } catch (caught) {
    boardTitle.textContent = 'Unable to inspect tab';
    boardBadge.textContent = 'Offline';
    boardBadge.className = 'badge badge-blue';
    setStatus('Could not inspect active tab');
    setError(caught instanceof Error ? caught.message : 'Open a Pinterest board in the active tab.');
  }
}

function scanSettings(mode: 'visible' | 'full'): ScanSettings {
  return {
    mode,
    maxPins: currentSettings.maxPins,
    maxDurationMs: currentSettings.maxDurationMs,
    noNewRounds: currentSettings.noNewRounds,
    waitMs: mode === 'visible' ? 0 : currentSettings.waitMs,
    scrollRatio: currentSettings.scrollRatio
  };
}

async function startScan(mode: 'visible' | 'full'): Promise<void> {
  setError('');
  setResult('');
  if (!activeTab?.id) await detect();
  if (!activeTab?.id || !currentBoard?.isBoard) {
    setError('The active tab must show a Pinterest board.');
    return;
  }
  await ensureContentScript(activeTab);
  activePort?.disconnect();
  activePort = chrome.tabs.connect(activeTab.id, { name: 'scan-control' });
  setScanControls(true, false);
  setStatus(mode === 'visible' ? 'Scanning visible Pins...' : 'Scanning entire board...');
  setProgress('0 Pins');
  const response = await chrome.tabs.sendMessage(activeTab.id, { type: 'START_SCAN', settings: scanSettings(mode) }) as { accepted: boolean; error?: string };
  if (!response.accepted) {
    setScanControls(false, false);
    setError(response.error ?? 'The scan could not be started.');
  }
}

async function stopScan(): Promise<void> {
  if (activeTab?.id) await chrome.tabs.sendMessage(activeTab.id, { type: 'STOP_SCAN' }).catch(() => undefined);
  setStatus('Stopping scan...');
}

async function sendToApplication(): Promise<void> {
  if (!currentPayload) { setError('Run a scan first.'); return; }
  const url = currentSettings.backendUrl.replace(/\/+$/, '') + '/api/imports/pinterest-board';
  let lastError = 'Could not connect to the backend.';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Local-Integration-Token': currentSettings.token },
        body: JSON.stringify(currentPayload)
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok) {
        setControlState(sendButton, false, 'button-success');
        setStatus('Import complete');
        setResult(`Received: ${body.summary.received} · New: ${body.summary.assetsCreated} · Updated: ${body.summary.assetsUpdated} · Duplicates skipped: ${body.summary.duplicatesSkipped} · Invalid: ${body.summary.invalid}`);
        return;
      }
      lastError = body?.error?.message ?? `Backend responded with ${response.status}.`;
      if (response.status < 500 && response.status !== 408 && response.status !== 429) break;
    } catch (caught) {
      lastError = caught instanceof Error ? caught.message : lastError;
    }
    await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
  }
  setStatus('Import failed');
  setError(lastError);
}

async function testConnection(): Promise<void> {
  try {
    const response = await fetch(currentSettings.backendUrl.replace(/\/+$/, '') + '/api/health');
    if (!response.ok) throw new Error(`Backend responded with ${response.status}.`);
    setStatus('Backend connected');
    setError('');
  } catch (caught) {
    setError(caught instanceof Error ? caught.message : 'Could not connect to the backend.');
  }
}

chrome.runtime.onMessage.addListener((message: { type?: string; progress?: ScanProgress; payload?: IngestionPayload; error?: string }) => {
  if (message.type === 'SCAN_PROGRESS' && message.progress) {
    const percentage = (message.progress.uniquePins / currentSettings.maxPins) * 100;
    setProgress(`${message.progress.uniquePins} Pins · round ${message.progress.rounds} · ${message.progress.phase}`, percentage);
  }
  if (message.type === 'SCAN_COMPLETE' && message.payload) {
    currentPayload = message.payload;
    activePort?.disconnect();
    activePort = undefined;
    setScanControls(false, true);
    setProgress(`${message.payload.pins.length} unique Pins · ${message.progress?.phase ?? 'complete'}`, 100);
    setStatus('Scan ready');
    setResult('Payload ready in memory. Send it to Tokia to import.');
  }
  if (message.type === 'SCAN_ERROR') {
    setScanControls(false, false);
    setError(message.error ?? 'The scan failed.');
  }
});

$('scan-visible').addEventListener('click', () => void startScan('visible'));
$('scan-full').addEventListener('click', () => void startScan('full'));
$('stop-scan').addEventListener('click', () => void stopScan());
$('send').addEventListener('click', () => void sendToApplication());
$('test-connection').addEventListener('click', () => void testConnection());
$('settings').addEventListener('click', () => void chrome.runtime.openOptionsPage());
window.addEventListener('unload', () => activePort?.disconnect());

void (async () => {
  currentSettings = await loadSettings();
  await detect();
})();
