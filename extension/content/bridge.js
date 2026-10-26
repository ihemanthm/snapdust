// Isolated-world content script: relays settings and commands into the page and status back out.
const DEFAULTS = {
  enabled: true,
  effect: 'none',
  badge: false,
  mirror: false,
  showMask: false,
  snapEnabled: true,
  snapMode: 'both',
  snapSensitivity: 0.5,
  vanishWho: 'me',
};
const SEGMENTER_URL = chrome.runtime.getURL('segmenter/segmenter.html');
let lastStatus = null;

async function pushConfig() {
  try {
    const cfg = await chrome.storage.local.get(DEFAULTS);
    cfg.segmenterUrl = SEGMENTER_URL;
    window.dispatchEvent(new CustomEvent('snapdust:config', { detail: JSON.stringify(cfg) }));
  } catch (err) {
    console.warn('[SnapDust] could not read settings', err);
  }
}

// inject.js may load before or after this script; cover both orders.
window.addEventListener('snapdust:hello', pushConfig);
pushConfig();

window.addEventListener('snapdust:status', (event) => {
  try {
    lastStatus = JSON.parse(event.detail);
  } catch {
    lastStatus = null;
  }
});

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') pushConfig();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'snapdust:command') {
    window.dispatchEvent(
      new CustomEvent('snapdust:command', { detail: JSON.stringify({ command: message.command }) }),
    );
  } else if (message?.type !== 'snapdust:get-status') {
    return;
  }
  // Event dispatch is synchronous, so inject.js has replied by the next line.
  window.dispatchEvent(new CustomEvent('snapdust:get-status'));
  sendResponse({ status: lastStatus });
});
