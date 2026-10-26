"""Fits any screenshot into the 1280x800 frame the Chrome Web Store requires.

Usage: python3 scripts/frame-screenshot.py <input image> <output.png>
The image is scaled to fit (never cropped) and centred on the extension's dark background.
"""
import sys

from PIL import Image

W, H = 1280, 800
BG = (24, 17, 36)

src = Image.open(sys.argv[1]).convert("RGB")
scale = min(W / src.width, H / src.height)
size = (round(src.width * scale), round(src.height * scale))
frame = Image.new("RGB", (W, H), BG)
frame.paste(src.resize(size, Image.LANCZOS), ((W - size[0]) // 2, (H - size[1]) // 2))
frame.save(sys.argv[2])
print(f"{sys.argv[2]}: {W}x{H}")
