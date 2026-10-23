#!/usr/bin/env python3
"""Generates wallpaper.png, the workspace desktop background.

Run from this directory: `python make-wallpaper.py`. The PNG is committed, so the
image build does not need Pillow; this script is here so the picture can be
changed deliberately rather than replaced by an unreproducible file.

Style: Maskin v2 (.claude/skills/maskin-design/tokens/colors.css) — pale zinc
surface, one indigo accent. Two quiet layers: a soft indigo bloom and a fine dot
grid (the product's canvas). Nothing to read, nothing that competes with the
windows on top.
"""

import numpy as np
from PIL import Image

W, H = 1280, 720
SS = 3  # supersample so the dots stay crisp and anti-aliased

ZINC_50 = np.array([250, 250, 250], dtype=np.float64)
ZINC_100 = np.array([244, 244, 245], dtype=np.float64)
ZINC_300 = np.array([212, 212, 216], dtype=np.float64)
INDIGO_100 = np.array([224, 231, 255], dtype=np.float64)
INDIGO_500 = np.array([99, 102, 241], dtype=np.float64)


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def over(base, colour, alpha):
    """Alpha-composite one colour over an (h, w, 3) image; alpha is (h, w)."""
    return base + (colour - base) * alpha[..., None]


def render():
    w, h = W * SS, H * SS
    y, x = np.mgrid[0:h, 0:w].astype(np.float64)
    px = x / SS  # coordinates in final-image pixels
    py = y / SS
    u, v = px / W, py / H

    # Surface: zinc-50 fading to zinc-100 toward the bottom.
    img = ZINC_50 + (ZINC_100 - ZINC_50) * smoothstep(0.0, 1.0, v)[..., None]

    # Indigo bloom, upper right: the single accent, kept very faint.
    cx, cy = 0.74 * W, 0.34 * H
    d = np.hypot(px - cx, py - cy)
    img = over(img, INDIGO_100, 0.85 * np.exp(-((d / (0.46 * H)) ** 2)))
    img = over(img, INDIGO_500, 0.05 * np.exp(-((d / (0.22 * H)) ** 2)))

    # Dot grid, every 32px, a little lighter toward the bloom so the glow stays
    # clean.
    cell = 32.0
    gx = (px % cell) - cell / 2
    gy = (py % cell) - cell / 2
    dots = smoothstep(1.6, 0.9, np.hypot(gx, gy))
    grid_fade = 0.55 + 0.45 * smoothstep(0.1, 0.9, np.hypot(u - 0.74, (v - 0.34) * H / W) * 2.2)
    img = over(img, ZINC_300, 0.75 * dots * grid_fade)

    out = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).resize((W, H), Image.LANCZOS)
    arr = np.asarray(out, dtype=np.float64)

    # Fixed-seed dither hides 8-bit banding in the gradients.
    rng = np.random.default_rng(7)
    arr = arr + rng.normal(0, 0.6, (H, W, 1))
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


if __name__ == "__main__":
    render().save("wallpaper.png", optimize=True)
    print("wrote wallpaper.png")
