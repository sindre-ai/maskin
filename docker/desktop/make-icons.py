#!/usr/bin/env python3
"""Generates the dock icons in icons/: browser.png, files.png, terminal.png.

Run from this directory: `python make-icons.py`. The PNGs are committed.

Each is a 256px rounded-square ("squircle-ish") tile in the macOS dock idiom,
drawn at 4x and downsampled for clean edges. The browser icon is a
Chrome-style multi-colour ring; the VM actually runs Chromium, whose own logo
is the all-blue one.
"""

import math
import os

from PIL import Image, ImageDraw

SIZE = 256
SS = 4
S = SIZE * SS
RADIUS = int(S * 0.225)  # macOS-style corner radius


def tile(fill_top, fill_bottom):
    """A rounded square with a subtle vertical gradient, as an RGBA image."""
    grad = Image.new("RGBA", (S, S))
    px = grad.load()
    for y in range(S):
        t = y / (S - 1)
        c = tuple(int(fill_top[i] + (fill_bottom[i] - fill_top[i]) * t) for i in range(3)) + (255,)
        for x in range(S):
            px[x, y] = c
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, S - 1, S - 1), RADIUS, fill=255)
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    out.paste(grad, (0, 0), mask)
    return out


def finish(img, name):
    os.makedirs("icons", exist_ok=True)
    img.resize((SIZE, SIZE), Image.LANCZOS).save(f"icons/{name}.png", optimize=True)


def browser():
    img = tile((250, 250, 252), (226, 226, 232))
    d = ImageDraw.Draw(img)
    # Hairline edge: the dock is white glass, and a white tile would vanish on it.
    d.rounded_rectangle((2, 2, S - 3, S - 3), RADIUS - 2, outline=(200, 200, 208), width=int(S * 0.012))
    cx = cy = S / 2
    r = S * 0.34
    box = (cx - r, cy - r, cx + r, cy + r)
    # Three 120-degree segments: red top, green lower-left, yellow lower-right.
    d.pieslice(box, 210, 330, fill=(219, 68, 55))
    d.pieslice(box, 330, 90, fill=(244, 180, 0))
    d.pieslice(box, 90, 210, fill=(15, 157, 88))
    # White ring then the blue centre.
    d.ellipse((cx - r * 0.52, cy - r * 0.52, cx + r * 0.52, cy + r * 0.52), fill=(255, 255, 255))
    d.ellipse((cx - r * 0.42, cy - r * 0.42, cx + r * 0.42, cy + r * 0.42), fill=(66, 133, 244))
    finish(img, "browser")


def files():
    img = tile((96, 165, 250), (37, 99, 235))
    d = ImageDraw.Draw(img)
    w, h = S * 0.58, S * 0.40
    x0, y0 = (S - w) / 2, S * 0.34
    # Folder back tab, then body.
    d.rounded_rectangle((x0, y0 - S * 0.07, x0 + w * 0.42, y0 + S * 0.08), S * 0.025, fill=(219, 234, 254))
    d.rounded_rectangle((x0, y0, x0 + w, y0 + h), S * 0.04, fill=(239, 246, 255))
    d.rounded_rectangle((x0, y0 + h * 0.18, x0 + w, y0 + h), S * 0.04, fill=(255, 255, 255))
    finish(img, "files")


def terminal():
    img = tile((63, 63, 70), (24, 24, 27))  # Maskin zinc-700 -> zinc-950
    d = ImageDraw.Draw(img)
    lw = int(S * 0.055)
    # ">" chevron
    x, y, a = S * 0.30, S * 0.50, S * 0.12
    d.line([(x, y - a), (x + a * 1.1, y), (x, y + a)], fill=(255, 255, 255), width=lw, joint="curve")
    # "_" cursor
    d.line([(S * 0.52, y + a * 1.05), (S * 0.70, y + a * 1.05)], fill=(165, 180, 252), width=lw)
    finish(img, "terminal")


if __name__ == "__main__":
    browser()
    files()
    terminal()
    print("wrote icons/{browser,files,terminal}.png")
