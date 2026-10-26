#!/bin/bash
# Builds the Chrome Web Store upload: dist/snapdust-v<version>.zip, containing only extension/.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f extension/vendor/mediapipe/models/hand_landmarker.task ]; then
  echo "extension/vendor is missing: run 'npm install && npm run vendor' first" >&2
  exit 1
fi

VERSION=$(node -p "require('./extension/manifest.json').version")
OUT="dist/snapdust-v${VERSION}.zip"
mkdir -p dist
rm -f "$OUT"
(cd extension && zip -qr -X "../$OUT" . -x "*.DS_Store" -x "*.map")
echo "Packaged $OUT ($(du -h "$OUT" | cut -f1))"
