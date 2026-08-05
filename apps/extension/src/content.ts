import { detectBoard, scanBoard, type ScanSettings } from './scanner.js';

let stopRequested = false;
let activeScan = false;

function emit(message: unknown): void {
  void chrome.runtime.sendMessage(message).catch(() => undefined);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'scan-control') return;
  port.onDisconnect.addListener(() => { stopRequested = true; });
});

chrome.runtime.onMessage.addListener((message: { type?: string; settings?: ScanSettings }, _sender, sendResponse) => {
  if (message.type === 'PING') {
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === 'GET_STATUS') {
    sendResponse(detectBoard(document));
    return false;
  }
  if (message.type === 'STOP_SCAN') {
    stopRequested = true;
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === 'START_SCAN' && message.settings) {
    if (activeScan) {
      sendResponse({ accepted: false, error: 'A scan is already running' });
      return false;
    }
    stopRequested = false;
    activeScan = true;
    sendResponse({ accepted: true });
    void scanBoard(document, message.settings, {
      shouldStop: () => stopRequested,
      onProgress: (progress) => emit({ type: 'SCAN_PROGRESS', progress })
    }).then((result) => {
      emit({ type: 'SCAN_COMPLETE', payload: result.payload, progress: result.progress });
    }).catch((error) => {
      emit({ type: 'SCAN_ERROR', error: error instanceof Error ? error.message : 'Scan failed' });
    }).finally(() => {
      activeScan = false;
    });
    return false;
  }
  return false;
});

window.addEventListener('beforeunload', () => { stopRequested = true; });
