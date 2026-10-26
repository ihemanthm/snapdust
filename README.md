# SnapDust

Snap your fingers on a Google Meet call and crumble into dust. Snap again and fly back together in a swirl of gold.

A Chrome extension. Everything runs on your computer: nothing is recorded or sent anywhere ([privacy policy](https://ihemanthm.github.io/snapdust/privacy)).

## Use it

1. Install SnapDust and open (or reload) a Google Meet tab with your camera on.
2. Click the SnapDust icon, then **Capture empty room**, and step aside for a few seconds so it can see the room behind you.
3. Hold your hand up, thumb and middle finger together, and snap. You turn to dust.
4. Snap again to come back.

There are also **Vanish** / **Capture** buttons in the popup and keyboard shortcuts: <kbd>⌥⇧V</kbd> (Alt+Shift+V) and <kbd>⌥⇧B</kbd>.

### Settings

- **Detect by.** *Sound + hand* (default) needs both the snap's sound and your hand in snap pose, so typing and talking don't set it off. *Sound only* works with your hand out of shot. *Hand only* doesn't use the microphone.
- **Sensitivity.** Raise it if quiet snaps are missed, lower it if other clicks trigger it.
- **Who vanishes** (under More). *Just me* (default) vanishes the person nearest the camera; *Everyone in frame* vanishes everyone.

### Good to know

- To hear snaps while you're muted in Meet, SnapDust keeps listening to Meet's microphone, so your mic indicator can stay on. Choose *Hand only* to avoid this.
- If you move the camera or the lighting changes a lot, capture the room again.
- Two people touching in the picture count as one.
- Only Google Meet in desktop Chrome.

## Feedback

Bugs, ideas and criticism are welcome: [open an issue](https://github.com/ihemanthm/snapdust/issues).

## Build from source

```bash
npm install
npm run vendor    # copies the vision models into extension/vendor
npm test          # snap detection tests
npm run package   # dist/snapdust-v<version>.zip for the Chrome Web Store
```

To try it unpacked: `chrome://extensions` → Developer mode → **Load unpacked** → pick `extension/`.

| Path | What |
|---|---|
| `extension/content/inject.js` | Takes over Meet's camera stream; person outline, room picture, effect timeline |
| `extension/content/dust.js` | WebGL dust and gold-return effect |
| `extension/content/snap.js` | Snap detection from sound and hand movement |
| `extension/segmenter/` | Hidden extension page running the bundled person and hand models |
| `extension/popup/` | The toolbar popup |
| `docs/` | Project page and privacy policy (GitHub Pages) |
| `CHROMEWEBSTORE.md` | Chrome Web Store listing text and answers |

SnapDust is an independent project and is not affiliated with or endorsed by Google. It bundles MediaPipe (Apache-2.0); see `extension/THIRD_PARTY_NOTICES.txt`.
