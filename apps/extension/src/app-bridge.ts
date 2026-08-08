const extensionMessageSource = 'tokia-browser-extension';
const webMessageSource = 'tokia-web-app';

function announceExtensionId(): void {
  window.postMessage(
    {
      source: extensionMessageSource,
      type: 'EXTENSION_ID',
      extensionId: chrome.runtime.id,
    },
    window.location.origin,
  );
}

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const data = event.data as { source?: string; type?: string } | undefined;
  if (data?.source === webMessageSource && data.type === 'REQUEST_EXTENSION_ID') {
    announceExtensionId();
  }
});

announceExtensionId();
