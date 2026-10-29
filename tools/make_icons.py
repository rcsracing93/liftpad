#!/usr/bin/env python3
"""LiftPad app icons from ONE description of the mark (HANDOFF 18, C9). Python 3 standard library only.

What it does: draws the LiftPad mark (three diagonal stripes, #E8742A #F2B824 #D9412B) from one list of polygons and writes
  public/icon.svg                       the mark on #1B1D1F, rounded (icon I2)
  public/icons/favicon-16.png, favicon-32.png, apple-touch-icon.png (180), icon-192.png, icon-512.png
  public/icons/icon-maskable-512.png    full-bleed square, the stripes inside the 80% safe zone
  The same polygons are inline in public/index.html (the header chip); a test compares the numbers.
How to run:  python3 -I /abs/path/tools/make_icons.py /abs/path/public
What it changes: only the files named above, under the folder you give. No network. The PNGs are drawn with exact horizontal
coverage and 4 sub-rows per pixel, so the edges are smooth.
"""
import os
import struct
import sys
import zlib

BG = (0x1B, 0x1D, 0x1F)
STRIPES = [((0xE8, 0x74, 0x2A), 0), ((0xF2, 0xB8, 0x24), 18), ((0xD9, 0x41, 0x2B), 36)]   # (colour, x shift)
# One stripe in a 100 x 100 box: top edge x 36..50 at y 16, bottom edge x 14..28 at y 84; each next stripe is 18 further right.
BASE = [(36, 16), (50, 16), (28, 84), (14, 84)]
ROUND = 22      # corner radius of the rounded icon, in 100 units
SAFE = 0.80     # the maskable icon keeps the mark inside this share of the width


def polys():
    return [(c, [(x + dx, y) for x, y in BASE]) for c, dx in STRIPES]


def svg():
    p = "".join('<polygon points="%s" fill="#%02X%02X%02X"/>' % (" ".join("%d,%d" % q for q in pts), *c) for c, pts in polys())
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="%d" fill="#%02X%02X%02X"/>%s</svg>\n'
            % (ROUND, *BG, p))


def quad_span(pts, y):
    """x interval of a convex polygon at height y, or None."""
    xs = []
    n = len(pts)
    for i in range(n):
        (x1, y1), (x2, y2) = pts[i], pts[(i + 1) % n]
        if y1 == y2:
            continue
        if min(y1, y2) <= y < max(y1, y2):
            xs.append(x1 + (x2 - x1) * (y - y1) / (y2 - y1))
    return (min(xs), max(xs)) if len(xs) >= 2 else None


def rrect_span(size, r, y):
    if y < 0 or y >= size:
        return None
    d = r - y if y < r else (y - (size - r) if y > size - r else 0)
    if d <= 0:
        return (0.0, float(size))
    off = r - (r * r - d * d) ** 0.5
    return (off, size - off)


def render(size, rounded, scale=1.0):
    """RGBA bytes. scale < 1 shrinks the mark about the centre (maskable safe zone)."""
    k = size / 100.0
    layers = []   # (colour, span function in pixel units)
    if rounded:
        layers.append((BG, lambda y: rrect_span(size, ROUND * k, y)))
    else:
        layers.append((BG, lambda y: (0.0, float(size)) if 0 <= y < size else None))
    for c, pts in polys():
        q = [((x - 50) * scale + 50, (y - 50) * scale + 50) for x, y in pts]
        q = [(x * k, y * k) for x, y in q]
        layers.append((c, lambda y, q=q: quad_span(q, y)))
    rows = bytearray()
    sub = 4
    for py in range(size):
        px = [[0.0, 0.0, 0.0, 0.0] for _ in range(size)]   # r, g, b, a (premultiplied by coverage later)
        for ci, (col, span) in enumerate(layers):
            cov = [0.0] * size
            for s in range(sub):
                sp = span(py + (s + 0.5) / sub)
                if not sp:
                    continue
                lo, hi = max(sp[0], 0.0), min(sp[1], float(size))
                if hi <= lo:
                    continue
                for x in range(int(lo), min(int(hi) + 1, size)):
                    cov[x] += max(0.0, min(hi, x + 1) - max(lo, x)) / sub
            for x in range(size):
                c = min(cov[x], 1.0)
                if c <= 0:
                    continue
                p = px[x]
                for i in range(3):
                    p[i] = p[i] * (1 - c) + col[i] * c
                p[3] = p[3] * (1 - c) + c
        rows.append(0)
        for x in range(size):
            p = px[x]
            a = p[3]
            if a > 0:
                rows += bytes([int(round(min(255, p[0] / a))), int(round(min(255, p[1] / a))), int(round(min(255, p[2] / a))), int(round(a * 255))])
            else:
                rows += b"\0\0\0\0"
    return bytes(rows)


def png(size, raw):
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def main(argv):
    if len(argv) != 2:
        print(__doc__)
        return 2
    pub = argv[1]
    os.makedirs(os.path.join(pub, "icons"), exist_ok=True)
    with open(os.path.join(pub, "icon.svg"), "w") as f:
        f.write(svg())
    for name, size, rounded, scale in [("favicon-16.png", 16, True, 1.0), ("favicon-32.png", 32, True, 1.0), ("apple-touch-icon.png", 180, False, 1.0),
                                       ("icon-192.png", 192, True, 1.0), ("icon-512.png", 512, True, 1.0), ("icon-maskable-512.png", 512, False, SAFE)]:
        with open(os.path.join(pub, "icons", name), "wb") as f:
            f.write(png(size, render(size, rounded, scale)))
        print("wrote", name)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
