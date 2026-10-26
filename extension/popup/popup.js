const DEFAULTS = {
  enabled: true,
  snapEnabled: true,
  snapMode: 'both',
  snapSensitivity: 0.5,
  vanishWho: 'me',
};
const CHECKBOXES = ['enabled', 'snapEnabled'];
const VALUES = ['snapMode', 'vanishWho'];
const NUMBERS = ['snapSensitivity'];

const controls = Object.fromEntries(
  [...CHECKBOXES, ...VALUES, ...NUMBERS].map((id) => [id, document.getElementById(id)]),
);
const vanishBtn = document.getElementById('vanish');
const captureBtn = document.getElementById('capture');
const statusEl = document.getElementById('status');
const snapStatusEl = document.getElementById('snapStatus');

let tabId = null;

async function loadSettings() {
  const cfg = await chrome.storage.local.get(DEFAULTS);
  for (const id of CHECKBOXES) controls[id].checked = cfg[id];
  for (const id of [...VALUES, ...NUMBERS]) controls[id].value = cfg[id];
}

async function saveSettings() {
  const cfg = Object.fromEntries(CHECKBOXES.map((id) => [id, controls[id].checked]));
  for (const id of VALUES) cfg[id] = controls[id].value;
  for (const id of NUMBERS) cfg[id] = Number(controls[id].value);
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

// One plain sentence about what SnapDust is doing, and what to do next.
function describe(s) {
  if (!controls.enabled.checked) return ['SnapDust is off. Turn it on under More.'];
  if (s.intercepted === 0) return ['Turn your camera on in Meet.'];
  if (s.segmenter === 'error') return ["Couldn't start. Reload the Meet tab and try again.", 'bad'];
  if (s.segmenter !== 'ready') return ['Getting ready…'];
  if (s.background === 'capturing') return ['Capturing the room. Step aside so it can see behind you.'];
  const snapping = s.snap?.mode && s.snap.mode !== 'off';
  if (s.vanished) return [snapping ? "You're gone. Snap to come back." : "You're gone."];
  if (s.background !== 'captured' && s.backgroundKnown < 0.9) {
    return ['Ready. For the cleanest vanish, capture the empty room first.'];
  }
  return [snapping ? 'Ready. Snap to vanish.' : 'Ready.', 'ok'];
}

const MODE_HINTS = {
  both: 'Hold your hand up, thumb and middle finger together, and snap.',
  sound: 'Snap near your mic. Sharp clicks like typing can set it off.',
  hand: 'Hold your hand up, thumb and middle finger together, and snap.',
};

function renderSnap(snap) {
  if (!controls.snapEnabled.checked) return (snapStatusEl.textContent = '');
  if (!snap) return (snapStatusEl.textContent = MODE_HINTS[controls.snapMode.value]);
  if (snap.mode === 'off') {
    return (snapStatusEl.textContent = "Meet's microphone is off, so sound can't be used. Pick another mode.");
  }
  const lines = [MODE_HINTS[snap.mode]];
  if (controls.snapMode.value === 'both' && snap.mode === 'hand') lines.push("Meet's mic is off: using your hand only.");
  if (snap.mode !== 'sound') {
    if (snap.handsModel === 'error') lines.push("Hand tracking couldn't start.");
    else if (snap.handsModel === 'ready') lines.push(snap.handInView ? 'Hand in view ✓' : 'Hand not in view.');
  }
  snapStatusEl.textContent = lines.join('\n');
}

function render(s) {
  const ready = !!s && s.intercepted > 0 && controls.enabled.checked;
  vanishBtn.disabled = captureBtn.disabled = !ready;
  if (!s) {
    showStatus('Reload this Meet tab to start SnapDust.', 'bad');
    return renderSnap(null);
  }
  vanishBtn.textContent = s.vanished ? 'Come back' : 'Vanish';
  showStatus(...describe(s));
  renderSnap(s.snap);
}

async function refreshStatus() {
  try {
    const response = await send({ type: 'snapdust:get-status' });
    render(response?.status);
  } catch {
    vanishBtn.disabled = captureBtn.disabled = true;
    showStatus('Open a Google Meet call to use SnapDust.');
    renderSnap(null);
  }
}

async function command(name) {
  try {
    const response = await send({ type: 'snapdust:command', command: name });
    render(response?.status);
  } catch {
    showStatus('Reload this Meet tab to start SnapDust.', 'bad');
  }
}

try {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;
  await loadSettings();
} catch {
  showStatus("Couldn't load your settings.", 'bad');
}

for (const el of Object.values(controls)) {
  el.addEventListener(el.type === 'range' ? 'input' : 'change', async () => {
    try {
      await saveSettings();
      refreshStatus();
    } catch {
      showStatus("Couldn't save your settings.", 'bad');
    }
  });
}

vanishBtn.addEventListener('click', () => command('toggle-vanish'));
captureBtn.addEventListener('click', () => command('capture-background'));

await refreshStatus();
setInterval(refreshStatus, 1000);
