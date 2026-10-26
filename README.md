# SnapDust for Google Meet

Snap your fingers on a Meet call to turn to dust like in Infinity War, and snap again to come back like the Endgame return.

## Status

| Phase | What | State |
|---|---|---|
| 0 | Take over the Meet camera feed | ✅ confirmed from a second device |
| 1 | Person detection + room picture + "Vanish" | ✅ confirmed on a real call |
| 2 | WebGL dust dissolve | ✅ confirmed on a real call |
| 3 | Gold return (the dust played backwards) | ✅ built, works on the test page; needs a real-call check |
| 4 | Snap detection (sound + hand gesture) | ✅ built, works on the test page; needs a real snap |
| 5 | Polish, settings, packaging | |

## Load it

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick the `extension/` folder. If it's already loaded, click its reload icon.
3. Reload any open Meet tab. The hook only installs on page load.
4. Turn off Meet's own background effects.

`extension/vendor/` is generated. On a fresh clone, run `npm install` and `npm run vendor` first.

## Try it

1. Join a call (or just open the pre-join screen) and open the SnapDust popup.
2. Wait for **Person detection: ready (GPU), ~30 fps**.
3. Click **Capture empty room** (or press <kbd>⌥⇧B</kbd>), then step aside within 3 seconds. The video shows "Capturing room… N%"; it stops at 97% of the room seen, or after 12 s.
4. Sit back down, then click **Vanish** (or press <kbd>⌥⇧V</kbd>). You crumble into ash from one side and blow away, leaving the room (about 3 s, plus the last ash drifting off).
5. Press it again to come back: the same dust plays backwards in gold, flakes flying back along the paths they left on, and you rebuild (about 3.7 s). Switching mid-effect reverses from that point.

The capture only takes the room where you aren't, so it works even if you stay in frame, but stepping aside lets it see behind you. Spots it never sees are filled with a blur of the surrounding room.

A captured room is kept as-is; SnapDust only corrects its brightness to follow your camera's auto-exposure. If you move the camera or the light changes a lot (a lamp switched on, the sun moving), capture again.

Dark frames (the camera warming up, lights off) are ignored, so the room picture never starts out black.

If Meet has the camera open more than once (e.g. preview + call), the popup shows each stream's size. Each stream gets its own outline and room picture; captures apply to all of them.

Turning your camera off and on (or Meet changing resolution) keeps the captured room, and if you were vanished you stay vanished, with no dust replay.

**Others in frame:** by default only you vanish: the largest person in view (on a webcam, whoever is nearest), plus anything touching you, such as a raised hand. Anyone else stays visible. Two people touching or overlapping in the picture count as one. Settings → "Who vanishes" → "Everyone in frame" changes this.

Without a capture, SnapDust still learns the room as you move around. The popup shows how much of the room it has seen ("% known"); any part it has never seen without you in front is filled with a blur of the surrounding room.

**Settings (in the popup):** "Show detection outline" tints what the model thinks is you, which is useful for checking detection in your lighting. "Flip my video for others" mirrors what other people see.

## Snapping

Snap your fingers to vanish; snap again to come back. Settings are in the popup.

- **Sound + hand** (default): the click must sound like a snap *and* the camera must see thumb and middle finger press together, then fly apart, within 0.4 s. Fewest false triggers.
- **Sound only**: works with your hand out of shot, but a sharp keyboard click can trigger it.
- **Hand only**: no microphone needed.
- **Sensitivity**: how far above the room's noise a click must jump (24 dB at the low end, 12 dB at the high end).

The popup shows what it hears ("Last click: snap-like ✓ / too dull / too long") and whether your hand is in view, to help tune it.

To hear snaps while you're muted in Meet, SnapDust listens to its own copy of Meet's mic, so your Mac's mic indicator may stay on while muted. Nothing is recorded or sent anywhere. If Meet closes the mic, SnapDust lets go too and "sound + hand" falls back to the hand alone.

## How it works

```
Meet page (MAIN world)                      extension iframe (hidden)
──────────────────────                      ─────────────────────────
getUserMedia ─► inject.js compositor        segmenter.js
                 │  256px copy of frame ───►  MediaPipe selfie segmenter
                 │  ◄── person mask ───────   (GPU, falls back to CPU)
                 ├─ room picture: learns where you're not
                 └─ output = live frame, with your silhouette
                    swapped for the room picture when vanished
```

The segmenter runs in an extension-owned iframe because Meet enforces Trusted Types, which blocks MediaPipe's script loader inside the Meet page.

## Test page (no Meet needed)

```bash
npm run serve
```

Then open http://127.0.0.1:8765/test/harness.html.

It runs the same hook against a fake camera (a room plus MediaPipe's public-domain test portrait in `test/assets/`), or your real camera if you tick the box. The server sends the extension's own CSP for the segmenter page, so the test runs under the same security rules.

Unit tests for snap detection (synthetic snaps, claps, knocks, speech, hand movements): `npm test`.

## Layout

```
extension/
  manifest.json
  background.js        keyboard shortcuts → active Meet tab
  content/inject.js    page hook: wraps getUserMedia, compositor, vanish
  content/bridge.js    relays settings/commands in, status out
  segmenter/           hidden iframe running MediaPipe
  popup/               Vanish / Capture buttons, status, settings
  vendor/mediapipe/    MediaPipe runtime + selfie model (generated)
scripts/vendor.mjs     copies MediaPipe into extension/vendor
test/                  harness page + server
```
