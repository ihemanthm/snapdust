# Chrome Web Store listing — SnapDust

> Last updated: 2026-10-26. Everything the developer dashboard asks for, ready to paste.

## Store listing

**Extension name**
SnapDust

**Short description** (manifest `description`, 91/132 characters)
Snap your fingers on a Google Meet call to crumble into dust, then snap again to come back.

**Detailed description** (paste as plain text; the store ignores Markdown)

```
Snap your fingers on a Google Meet call and crumble into dust in front of everyone. Snap again and fly back together in a swirl of gold.

FEATURES
• Snap to vanish: your body flakes away into drifting ash, leaving the empty room behind you.
• Snap to come back: the same dust flies back in glowing gold and you rebuild.
• Recognises a snap by its sound and your hand together, so typing and talking don't set it off.
• Only you vanish. Anyone else in the picture stays visible.
• Works with your normal camera. No virtual camera or extra software.
• Buttons and keyboard shortcuts too (Alt+Shift+V, Alt+Shift+B), if you'd rather not snap.

HOW TO USE
1. Open (or reload) a Google Meet tab and turn your camera on.
2. Click the SnapDust icon, then "Capture empty room", and step aside for a few seconds so it can see the room behind you.
3. Hold your hand up, thumb and middle finger together, and snap.
4. Snap again to come back.

PRIVACY
Everything happens on your computer. SnapDust does not record, save or send any video, audio or personal data, and uses no analytics or third-party services. To hear snaps while you are muted in Meet it keeps listening to Meet's microphone, which can keep your microphone indicator on; choose "Hand only" in the popup to not use the microphone at all.
Privacy policy: https://ihemanthm.github.io/snapdust/privacy

PERMISSIONS
• "Read and change your data on meet.google.com": needed to apply the effect to your own camera image inside Google Meet. SnapDust runs on no other site.
• Storage: remembers your settings (detection mode, sensitivity) on this computer.

FEEDBACK
This is a free, open-source project and criticism is welcome. Report bugs or ideas at https://github.com/ihemanthm/snapdust/issues

SnapDust is an independent project and is not affiliated with or endorsed by Google.

Version 1.0.0: first public release.
```

**Category**
Fun

**Language**
English

## Single purpose (dashboard → Privacy practices)

Adds a finger-snap-triggered effect to the user's own camera image in Google Meet that dissolves them into dust and brings them back.

## Graphics & assets

| Asset | Size | Status | File |
|---|---|---|---|
| Store icon | 128×128 (96×96 art + padding) | ✅ | `store-assets/store-icon-128.png` |
| Screenshot 1 | 1280×800 | ⬜ needs a real call | mid-dust, from your Meet self-view |
| Screenshot 2 | 1280×800 | ⬜ needs a real call | mid gold return |
| Screenshot 3 | 1280×800 | ⬜ needs a real call | the popup open on a Meet tab |
| Small promo tile | 440×280 | ✅ | `store-assets/promo-small-440x280.png` |

Screenshots must show the real extension. Take them on a call (macOS: ⌘⇧4, then Space to grab a window), then fit each to 1280×800:

```bash
python3 scripts/frame-screenshot.py ~/Desktop/shot.png store-assets/screenshot-1.png
```

Don't put film titles, characters or logos in screenshots or text (trademark rejections).

## Permission justifications (dashboard → Privacy practices)

| Permission | Justification |
|---|---|
| `storage` | Saves the user's SnapDust settings (detection mode, sensitivity, who vanishes) locally so they persist between calls. Nothing else is stored. |
| Host access: `https://meet.google.com/*` (content scripts) | The effect is applied to the user's own camera image inside Google Meet, so the extension must run on Meet pages to process the camera stream before Meet sends it. It runs on no other site. |
| Web-accessible resources (`segmenter/*`, `vendor/mediapipe/*`) | A hidden extension page embedded in the Meet tab runs the bundled person- and hand-detection models, which Meet's page security rules don't allow to load directly. |

**Are you using remote code?** No. All code and models are bundled in the package.

## Data usage (dashboard → Privacy practices)

Tick **none** of the data types: SnapDust collects no user data. Camera and microphone are processed on-device only and never stored or transmitted; settings stay in local extension storage.

Certify all three:
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** https://ihemanthm.github.io/snapdust/privacy

## Distribution

- Visibility: **Public** (or **Unlisted** for a soft launch: only people with the link can install)
- Regions: all

## Developer info

- Publisher name: your choice (shown on the listing)
- Contact email: the developer account's email, verified in the dashboard; shown publicly
- Support URL: https://github.com/ihemanthm/snapdust/issues
- Homepage: https://ihemanthm.github.io/snapdust/

## Version history

| Version | Date | Changes | Status |
|---|---|---|---|
| 1.0.0 | 2026-10-26 | First public release | Draft |

## Review notes

**Known limitations**
- Only Google Meet in Chrome (desktop).
- Needs a decent GPU; on slow machines the effect may drop frames.
- Two people touching in the picture are treated as one.

**Rejection history**

| Date | Reason | Fix | Resubmitted |
|---|---|---|---|
