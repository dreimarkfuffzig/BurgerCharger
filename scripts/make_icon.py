#!/usr/bin/env python3
"""Erzeugt die App-Icons (Burger mit Blitz) ohne externe Bibliotheken."""
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "icons"
BG = (179, 38, 30)
BUN = (240, 178, 92)
PATTY = (92, 52, 30)
SALAD = (104, 178, 74)
BOLT = (255, 226, 64)

# Blitz als Polygon im Einheitsquadrat
BOLT_POLY = [(0.56, 0.16), (0.36, 0.53), (0.49, 0.53), (0.42, 0.86), (0.66, 0.44), (0.52, 0.44), (0.62, 0.16)]


def in_poly(x, y, poly):
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def rrect(x, y, x0, y0, x1, y1, r):
    if not (x0 <= x <= x1 and y0 <= y <= y1):
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def color_at(x, y):
    if in_poly(x, y, BOLT_POLY):
        return BOLT
    # obere Brötchenhälfte: Halbellipse
    if y <= 0.44 and ((x - 0.5) / 0.33) ** 2 + ((y - 0.44) / 0.22) ** 2 <= 1:
        return BUN
    if rrect(x, y, 0.15, 0.47, 0.85, 0.53, 0.03):
        return SALAD
    if rrect(x, y, 0.17, 0.56, 0.83, 0.66, 0.05):
        return PATTY
    if rrect(x, y, 0.17, 0.69, 0.83, 0.80, 0.055):
        return BUN
    return BG


def render(size, ss=3):
    rows = []
    n = ss * ss
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            r = g = b = 0
            for sy in range(ss):
                for sx in range(ss):
                    c = color_at((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size)
                    r += c[0]; g += c[1]; b += c[2]
            row += bytes((r // n, g // n, b // n))
        rows.append(bytes(row))
    return b"".join(rows)


def png(size):
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(render(size), 9))
            + chunk(b"IEND", b""))


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    for size in (180, 512):
        (OUT / f"icon-{size}.png").write_bytes(png(size))
        print(f"icons/icon-{size}.png")
