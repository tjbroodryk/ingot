#!/usr/bin/env python3
"""Rasterise `src/app/icon.svg` into the favicon and the Apple touch icon.

    python3 scripts/render-icon.py            # writes into src/app/
    python3 scripts/render-icon.py --preview  # also a 512 to look at

Next serves `icon.svg` directly to anything that will take it, which is every
browser worth naming; the `.ico` is for the ones that will not, and for the
bookmark bars and Windows shortcuts that still ask for one. Neither can be
generated at build time — Next does not rasterise — so they are committed, and
this is what regenerates them when the artwork changes.

The geometry is duplicated from the SVG rather than parsed out of it: it is
four elements of straight lines, and a parser for the one path syntax they use
would be more code than the shapes are. The SVG is the source of truth and this
has to agree with it — change one, run this, commit both.

Deliberately no dependencies. Cairo and Pillow both do this properly and
neither is worth adding to a repo that draws four polygons once a year.
"""

import struct
import sys
import zlib
from pathlib import Path

W = 64  # the SVG's viewBox, and the coordinate space below
SS = 8  # supersampling factor, which is where the antialiasing comes from

INK = (0x20, 0x1E, 0x1D)
FACES = [
    # (polygon, fill) — painted in the SVG's order, back to front
    ([(14, 24), (42, 24), (50, 16), (22, 16)], (0x8F, 0xB3, 0xD9)),  # top
    ([(8, 48), (48, 48), (42, 24), (14, 24)], (0x30, 0x5D, 0x8F)),  # front
    ([(42, 24), (50, 16), (56, 36), (48, 48)], (0x1F, 0x3D, 0x5E)),  # side
]


def inside(poly, x, y):
    """Even-odd fill, which is what SVG does by default."""
    hit = False
    n = len(poly)
    for i in range(n):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % n]
        if (y0 > y) != (y1 > y):
            if x < x0 + (y - y0) * (x1 - x0) / (y1 - y0):
                hit = not hit
    return hit


def render(size):
    """One RGBA row per scanline, sampled SS x SS per pixel and averaged.

    Opaque throughout — the icon has a ground rather than a cut-out — but RGBA
    rather than RGB all the same, because Next's ICO decoder rejects anything
    else outright ("The PNG is not in RGBA format!") when it reads
    `src/app/favicon.ico` at build time.
    """
    scale = W / (size * SS)
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            r = g = b = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = (px * SS + sx + 0.5) * scale
                    y = (py * SS + sy + 0.5) * scale
                    colour = INK
                    for poly, fill in FACES:
                        if inside(poly, x, y):
                            colour = fill
                    r += colour[0]
                    g += colour[1]
                    b += colour[2]
            n = SS * SS
            row += bytes((r // n, g // n, b // n, 255))
        rows.append(bytes(row))
    return rows


def png(size):
    raw = b"".join(b"\x00" + row for row in render(size))  # filter 0 per scanline

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))  # 6 = RGBA
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def ico(sizes):
    """PNG-in-ICO. Every browser since IE11 reads it, and it is a third the size
    of the equivalent BMP directory."""
    images = [png(s) for s in sizes]
    entries, blobs = b"", b""
    offset = 6 + 16 * len(sizes)
    for size, data in zip(sizes, images):
        byte = size if size < 256 else 0  # 0 means 256 in this field
        entries += struct.pack("<BBBBHHII", byte, byte, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
        blobs += data
    return struct.pack("<HHH", 0, 1, len(sizes)) + entries + blobs


if __name__ == "__main__":
    app = Path(__file__).resolve().parent.parent / "src" / "app"
    (app / "favicon.ico").write_bytes(ico([16, 32, 48]))
    (app / "apple-icon.png").write_bytes(png(180))
    print(f"wrote {app}/favicon.ico and {app}/apple-icon.png")
    if "--preview" in sys.argv:
        out = Path.cwd() / "icon-preview.png"
        out.write_bytes(png(512))
        print(f"wrote {out}")
