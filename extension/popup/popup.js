const DEFAULTS = {
  enabled: true,
  effect: 'none',
  badge: false,
  mirror: false,
  showMask: false,
  snapEnabled: true,
  snapMode: 'both',
  snapSensitivity: 0.5,
};
const CHECKBOXES = ['enabled', 'badge', 'mirror', 'showMask', 'snapEnabled'];
const VALUES = ['effect', 'snapMode'];
const NUMBERS = ['snapSensitivity'];

const controls = Object.fromEntries(
  [...CHECKBOXES, ...VALUES, ...NUMBERS].map((id) => [id, document.getElementById(id)]),
);
const vanishBtn = document.getElementById('vanish');
const captureBtn = document.getElementById('capture');
const statusEl = document.getElementById('status');
const snapStatusEl = document.getElementById('snapStatus');
let config = { ...DEFAULTS };

let tabId = null;

async function loadSettings() {
  const cfg = await chrome.storage.local.get(DEFAULTS);
  config = cfg;
  for (const id of CHECKBOXES) controls[id].checked = cfg[id];
  for (const id of [...VALUES, ...NUMBERS]) controls[id].value = cfg[id];
}

async function saveSettings() {
  const cfg = Object.fromEntries(CHECKBOXES.map((id) => [id, controls[id].checked]));
  for (const id of VALUES) cfg[id] = controls[id].value;
  for (const id of NUMBERS) cfg[id] = Number(controls[id].value);
  config = cfg;
  await chrome.storage.local.set(cfg);
}

function showStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = kind ?? '';
}

async function send(message) {
  if (!tabId) throw new Error('no tab');
  return chrome.tabs.sendMessage(tabId, message);
}

const BACKGROUND_LABELS = {
  none: 'not started',
  learning: 'learning while you move',
  capturing: 'capturing…',
  captured: 'captured',
};

function render(s) {
  vanishBtn.disabled = captureBtn.disabled = !s || s.intercepted === 0;
  if (!s) return showStatus('Extension loaded, but the page hook has not reported yet. Reload the Meet tab.', 'bad');
  if (s.intercepted === 0) return showStatus('Hook installed.\nWaiting for Meet to open the camera…');

  vanishBtn.textContent = s.vanished ? 'Reappear' : 'Vanish';
  const known = Math.round(s.backgroundKnown * 100);
  const streams = s.streams?.length > 1 ? ` — ${s.streams.length} streams: ${s.streams.join(', ')}` : '';
  const lines = [
    `Camera intercepted ✓ (${s.pipeline})${streams}`,
    `Person detection: ${s.segmenter}${s.maskFps ? `, ${s.maskFps} fps` : ''}`,
    `Room picture: ${BACKGROUND_LABELS[s.background] ?? s.background}, ${known}% known`,
  ];
  if (s.background !== 'captured' && known < 90) {
    lines.push('Tip: capture the empty room so nothing of you is left behind.');
  }
  if (s.lastError) lines.push(`Last error: ${s.lastError}`);
  showStatus(lines.join('\n'), s.lastError || s.segmenter === 'error' ? 'bad' : 'ok');
  renderSnap(s.snap);
}

const MODE_LABELS = { both: 'sound + hand', sound: 'sound only', hand: 'hand only' };

// What snap detection hears and sees right now, to help tune it.
function renderSnap(snap) {
  if (!snap) return (snapStatusEl.textContent = '');
  if (snap.mode === 'off') {
    snapStatusEl.textContent = controls.snapEnabled.checked
      ? 'No mic from Meet yet, so "sound only" can\'t listen. Unmute once, or pick another mode.'
      : 'Off. Use the buttons or shortcuts.';
    return;
  }
  const lines = [`Listening for: ${MODE_LABELS[snap.mode]}`];
  if (config.snapMode === 'both' && snap.mode === 'hand') lines[0] += ' (Meet has no mic open)';
  if (snap.mode !== 'sound') {
    const hands = { off: 'starting…', loading: 'loading…', ready: '', error: 'failed to load' }[snap.handsModel];
    lines.push(`Hand: ${hands || (snap.handInView ? 'in view ✓' : 'not in view')}`);
  }
  if (snap.mode !== 'hand' && snap.lastSound) {
    const l = snap.lastSound;
    lines.push(`Last click: ${l.snap ? 'snap-like ✓' : l.verdict}, ${l.secondsAgo}s ago`);
  }
  if (snap.lastSnap) lines.push(`Last snap: ${snap.lastSnap.secondsAgo}s ago (${snap.lastSnap.by})`);
  snapStatusEl.textContent = lines.join('\n');
}

async function refreshStatus() {
  try {
    const response = await send({ type: 'snapdust:get-status' });
    render(response?.status);
  } catch {
    vanishBtn.disabled = captureBtn.disabled = true;
    showStatus('Open a Google Meet tab (reload it if it was open before installing).', 'bad');
  }
}

async function command(name) {
  try {
    const response = await send({ type: 'snapdust:command', command: name });
    render(response?.status);
  } catch (err) {
    showStatus(`Could not reach the Meet tab: ${err}`, 'bad');
  }
}

try {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;
  await loadSettings();
} catch (err) {
  showStatus(`Could not load settings: ${err}`, 'bad');
}

for (const el of Object.values(controls)) {
  el.addEventListener(el.type === 'range' ? 'input' : 'change', async () => {
    try {
      await saveSettings();
    } catch (err) {
      showStatus(`Could not save settings: ${err}`, 'bad');
    }
  });
}

vanishBtn.addEventListener('click', () => command('toggle-vanish'));
captureBtn.addEventListener('click', () => command('capture-background'));

await refreshStatus();
setInterval(refreshStatus, 1000);
