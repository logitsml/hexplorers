#!/usr/bin/env python3
"""Converts generated PNG art in art-src/originals/ (gen_art.py's output, git-ignored) to web-sized
WebP in public/art/.

Run with: uv run --no-project --with pillow python scripts/art/optimize.py [folder ...] [--only name ...]

With folders named, only those are converted, and --only narrows them to the named files (stems,
without .png): a new batch re-encodes only itself, so the art that shipped before it doesn't churn.
"""
import argparse
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(ROOT, "art-src", "originals")
DST = os.path.join(ROOT, "public", "art")
# Longest side in pixels. The expansions' paintings are shown smaller than the development cards
# (a thumbnail in the venture hand, the Almanac's card beside the roll, a card under a banner).
SIZES = {"cards": 720, "icons": 160, "avatars": 256, "awards": 480, "ventures": 400, "muster": 400, "happenings": 480}

def defringe(im):
    """Remove coloured halos on the alpha edge by eroding barely-opaque pixels."""
    if im.mode != "RGBA":
        return im
    r, g, b, a = im.split()
    a = a.point(lambda v: 0 if v < 24 else v)
    return Image.merge("RGBA", (r, g, b, a))

ap = argparse.ArgumentParser()
ap.add_argument("folders", nargs="*")
ap.add_argument("--only", nargs="*", default=[])
args = ap.parse_args()
unknown = [f for f in args.folders if f not in SIZES]
if unknown:
    ap.error(f"unknown folders: {unknown}")

for folder, size in SIZES.items():
    if args.folders and folder not in args.folders:
        continue
    for name in sorted(os.listdir(os.path.join(SRC, folder))):
        if not name.endswith(".png") or (args.only and name[:-4] not in args.only):
            continue
        im = Image.open(os.path.join(SRC, folder, name))
        im = defringe(im.convert("RGBA")) if im.mode in ("RGBA", "LA", "P") else im.convert("RGB")
        im.thumbnail((size, size), Image.LANCZOS)
        os.makedirs(os.path.join(DST, folder), exist_ok=True)
        out = os.path.join(DST, folder, name.replace(".png", ".webp"))
        im.save(out, "WEBP", quality=88, method=6)
        print(f"{folder}/{name}: {im.size} -> {os.path.getsize(out)//1024} KB")
