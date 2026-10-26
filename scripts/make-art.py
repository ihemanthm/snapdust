"""Draws the extension icons and Chrome Web Store promo art.

The mark: a warm gold orb (you) crumbling into flakes that drift off to the upper right.
Run with: python3 scripts/make-art.py [path/to/Inter-ExtraBold.ttf] [path/to/Inter-Medium.ttf]
The fonts are only needed for the promo tile (Inter, SIL Open Font License).
"""
import math
import random
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "extension/icons"
STORE = ROOT / "store-assets"

BG_TOP = (44, 30, 66)
BG_BOTTOM = (18, 13, 28)
GOLD = (255, 184, 82)
ASH = (196, 176, 150)


def gradient(size, top, bottom):
    w, h = size
    img = Image.new("RGB", size)
    px = img.load()
    for y in range(h):
        k = y / max(1, h - 1)
        row = tuple(round(a + (b - a) * k) for a, b in zip(top, bottom))
        for x in range(w):
            px[x, y] = row
    return img


def mark(size, detail=True):
    """The orb-turning-to-dust mark on a transparent square of `size` px (drawn at 4x)."""
    s = size * 4
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, cy, r = s * 0.40, s * 0.58, s * 0.27

    # Soft glow behind the orb.
    glow = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse([cx - r * 1.35, cy - r * 1.35, cx + r * 1.35, cy + r * 1.35], fill=GOLD + (90,))
    img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(s * 0.05)))

    # The orb, with its upper-right edge eaten away.
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=GOLD + (255,))
    rng = random.Random(7)
    bite = Image.new("L", (s, s), 0)
    bd = ImageDraw.Draw(bite)
    for _ in range(110 if detail else 24):
        a = rng.uniform(-1.3, 0.35)  # towards the upper right
        dist = r * rng.uniform(0.82, 1.05)  # only the edge crumbles
        x, y = cx + math.cos(a) * dist, cy + math.sin(a) * dist
        q = s * rng.uniform(0.01, 0.026)
        bd.rectangle([x - q, y - q, x + q, y + q], fill=255)
    img.putalpha(Image.composite(Image.new("L", (s, s), 0), img.getchannel("A"), bite))

    # Flakes drifting off, smaller and fainter the further they go.
    flakes = 70 if detail else 9
    for i in range(flakes):
        t = (i + rng.random()) / flakes
        a = rng.uniform(-1.25, -0.15)
        dist = r * (0.95 + 1.35 * t)
        x = cx + math.cos(a) * dist + s * 0.05 * t
        y = cy + math.sin(a) * dist - s * 0.08 * t
        q = s * (0.032 - 0.02 * t) * (1.6 if not detail else 1)
        colour = tuple(round(g + (a2 - g) * t) for g, a2 in zip(GOLD, ASH))
        alpha = round(255 * (1 - 0.75 * t))
        d.rectangle([x - q, y - q, x + q, y + q], fill=colour + (alpha,))
    return img.resize((size, size), Image.LANCZOS)


def icon(size):
    """App icon: the mark on a rounded dark tile."""
    s = size * 4
    tile = gradient((s, s), BG_TOP, BG_BOTTOM).convert("RGBA")
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=s * 0.22, fill=255)
    tile.putalpha(mask)
    tile = tile.resize((size, size), Image.LANCZOS)
    tile.alpha_composite(mark(size, detail=size >= 48))
    return tile


def main():
    ICONS.mkdir(parents=True, exist_ok=True)
    STORE.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48, 128):
        icon(size).save(ICONS / f"icon-{size}.png")
        print(f"extension/icons/icon-{size}.png")

    # Store icon: 96x96 artwork centred in 128x128, as the store's guidelines ask.
    store_icon = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
    store_icon.alpha_composite(icon(96), (16, 16))
    store_icon.save(STORE / "store-icon-128.png")
    print("store-assets/store-icon-128.png")

    if len(sys.argv) < 3:
        print("(no fonts given: skipping the promo tile)")
        return
    bold = lambda px: ImageFont.truetype(sys.argv[1], px)
    medium = lambda px: ImageFont.truetype(sys.argv[2], px)

    # Small promo tile, 440x280.
    tile = gradient((440, 280), BG_TOP, BG_BOTTOM).convert("RGBA")
    tile.alpha_composite(mark(190), (-10, 70))
    d = ImageDraw.Draw(tile)
    d.text((212, 92), "SnapDust", font=bold(46), fill=(255, 241, 222))
    d.text((214, 149), "Snap to vanish.", font=medium(21), fill=GOLD)
    d.text((214, 177), "Snap to come back.", font=medium(21), fill=(220, 205, 185))
    tile.convert("RGB").save(STORE / "promo-small-440x280.png")
    print("store-assets/promo-small-440x280.png")


if __name__ == "__main__":
    main()
