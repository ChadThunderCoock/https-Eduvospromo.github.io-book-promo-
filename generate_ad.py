#!/usr/bin/env python3
"""
NEXT GEN — vertical (9:16) reel / TikTok video-ad generator.

Pure standard library only (no ffmpeg, no PIL, no numpy). Renders animated
frames into an indexed-color buffer and encodes them as a looping animated
GIF, the open/free delivery format for short-form vertical ads.

Usage:  python3 generate_ad.py [output.gif]
"""

import sys
import struct
import zlib  # stdlib, only used indirectly-free; LZW is hand-rolled below

# ---------------------------------------------------------------------------
# Canvas / timing  (9:16 vertical, the reel & TikTok aspect ratio)
# ---------------------------------------------------------------------------
W, H = 540, 960
FPS = 12
DELAY = 8  # GIF frame delay in 1/100s  (~0.08s -> 12fps)

# ---------------------------------------------------------------------------
# Brand palette (max 16 entries -> GIF global color table)
# ---------------------------------------------------------------------------
PALETTE = [
    (0x0A, 0x0A, 0x0B),  # 0  background near-black
    (0x14, 0x14, 0x17),  # 1  panel
    (0x20, 0x20, 0x25),  # 2  panel light
    (0xFF, 0x5A, 0x1F),  # 3  brand orange
    (0xFF, 0x84, 0x47),  # 4  orange light
    (0xC2, 0x3D, 0x0E),  # 5  orange dark
    (0xFF, 0xFF, 0xFF),  # 6  white
    (0xB6, 0xB6, 0xC0),  # 7  gray text
    (0x2C, 0x2C, 0x33),  # 8  hairline
    (0xFF, 0xCF, 0xB0),  # 9  warm tint
    (0x00, 0x00, 0x00),  # 10 pure black
    (0x3A, 0x18, 0x08),  # 11 orange shadow
    (0x7A, 0x7A, 0x84),  # 12 dim gray
    (0xFF, 0xA0, 0x6E),  # 13 orange pale
    (0x16, 0x16, 0x1A),  # 14 bg alt
    (0x05, 0x05, 0x06),  # 15 deepest
]
BG, PANEL, PANEL2, ORANGE, ORANGEL, ORANGED, WHITE, GRAY, LINE, WARM, \
    BLACK, OSHADOW, DIMGRAY, OPALE, BGALT, DEEP = range(16)

# ---------------------------------------------------------------------------
# 5x7 bitmap font (uppercase + digits + a few symbols)
# ---------------------------------------------------------------------------
FONT = {
    "A": ".###.|#...#|#...#|#####|#...#|#...#|#...#",
    "B": "####.|#...#|#...#|####.|#...#|#...#|####.",
    "C": ".####|#....|#....|#....|#....|#....|.####",
    "D": "####.|#...#|#...#|#...#|#...#|#...#|####.",
    "E": "#####|#....|#....|####.|#....|#....|#####",
    "F": "#####|#....|#....|####.|#....|#....|#....",
    "G": ".####|#....|#....|#.###|#...#|#...#|.####",
    "H": "#...#|#...#|#...#|#####|#...#|#...#|#...#",
    "I": "#####|..#..|..#..|..#..|..#..|..#..|#####",
    "J": "#####|...#.|...#.|...#.|...#.|#..#.|.##..",
    "K": "#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#",
    "L": "#....|#....|#....|#....|#....|#....|#####",
    "M": "#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#",
    "N": "#...#|##..#|#.#.#|#.#.#|#..##|#...#|#...#",
    "O": ".###.|#...#|#...#|#...#|#...#|#...#|.###.",
    "P": "####.|#...#|#...#|####.|#....|#....|#....",
    "Q": ".###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#",
    "R": "####.|#...#|#...#|####.|#.#..|#..#.|#...#",
    "S": ".####|#....|#....|.###.|....#|....#|####.",
    "T": "#####|..#..|..#..|..#..|..#..|..#..|..#..",
    "U": "#...#|#...#|#...#|#...#|#...#|#...#|.###.",
    "V": "#...#|#...#|#...#|#...#|#...#|.#.#.|..#..",
    "W": "#...#|#...#|#...#|#.#.#|#.#.#|##.##|#...#",
    "X": "#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#",
    "Y": "#...#|#...#|.#.#.|..#..|..#..|..#..|..#..",
    "Z": "#####|....#|...#.|..#..|.#...|#....|#####",
    "0": ".###.|#...#|#..##|#.#.#|##..#|#...#|.###.",
    "1": "..#..|.##..|..#..|..#..|..#..|..#..|#####",
    "2": ".###.|#...#|....#|..##.|.#...|#....|#####",
    "3": "####.|....#|....#|.###.|....#|....#|####.",
    "4": "#...#|#...#|#...#|#####|....#|....#|....#",
    "5": "#####|#....|#....|####.|....#|#...#|.###.",
    "6": ".###.|#....|#....|####.|#...#|#...#|.###.",
    "7": "#####|....#|...#.|..#..|.#...|.#...|.#...",
    "8": ".###.|#...#|#...#|.###.|#...#|#...#|.###.",
    "9": ".###.|#...#|#...#|.####|....#|....#|.###.",
    " ": ".....|.....|.....|.....|.....|.....|.....",
    ".": ".....|.....|.....|.....|.....|.##..|.##..",
    ",": ".....|.....|.....|.....|.##..|.##..|.#...",
    "!": "..#..|..#..|..#..|..#..|..#..|.....|..#..",
    "'": "..#..|..#..|..#..|.....|.....|.....|.....",
    "-": ".....|.....|.....|#####|.....|.....|.....",
    ":": ".....|.##..|.##..|.....|.##..|.##..|.....",
    "/": "....#|....#|...#.|..#..|.#...|#....|#....",
    "&": ".##..|#..#.|#..#.|.##..|#.#.#|#..#.|.##.#",
}
GLYPH_W, GLYPH_H = 5, 7

# ---------------------------------------------------------------------------
# Frame buffer helpers (indexed color)
# ---------------------------------------------------------------------------
def new_frame(color=BG):
    return bytearray([color]) * (W * H)


def fill_rect(buf, x, y, w, h, c):
    x0 = max(0, x); y0 = max(0, y)
    x1 = min(W, x + w); y1 = min(H, y + h)
    if x1 <= x0 or y1 <= y0:
        return
    row = bytes([c]) * (x1 - x0)
    for yy in range(y0, y1):
        i = yy * W + x0
        buf[i:i + (x1 - x0)] = row


def text_width(s, scale, sp):
    return len(s) * (GLYPH_W * scale + sp) - sp if s else 0


def draw_text(buf, x, y, s, scale, c, sp=None):
    if sp is None:
        sp = scale
    cx = x
    for ch in s.upper():
        g = FONT.get(ch, FONT[" "])
        rows = g.split("|")
        for ry, row in enumerate(rows):
            for rx, px in enumerate(row):
                if px == "#":
                    fill_rect(buf, cx + rx * scale, y + ry * scale, scale, scale, c)
        cx += GLYPH_W * scale + sp


def fit_scale(s, max_w, max_scale, min_scale=2):
    """Largest scale (sp == scale) so the string fits within max_w."""
    for sc in range(max_scale, min_scale - 1, -1):
        if text_width(s, sc, sc) <= max_w:
            return sc
    return min_scale


def draw_text_center_x(buf, y, s, scale, c, sp=None):
    if sp is None:
        sp = scale
    tw = text_width(s, scale, sp)
    draw_text(buf, (W - tw) // 2, y, s, scale, c, sp)


def draw_fit_center(buf, y, s, c, max_scale, margin=40):
    sc = fit_scale(s, W - 2 * margin, max_scale)
    draw_text_center_x(buf, y, s, sc, c, sc)
    return sc


# ---------------------------------------------------------------------------
# Decorative elements
# ---------------------------------------------------------------------------
def bg_base(buf, t):
    """Subtle moving accent bands behind everything."""
    for i in range(W * H):
        buf[i] = BG
    # top + bottom brand bars
    fill_rect(buf, 0, 0, W, 10, ORANGE)
    fill_rect(buf, 0, H - 10, W, 10, ORANGE)
    # faint diagonal sweep that drifts with time
    off = int((t * 70) % (W + H))
    for k in (-2, 0, 2):
        xx = off + k * 60 - 120
        for yy in range(0, H, 6):
            x = xx - yy
            if 0 <= x < W:
                fill_rect(buf, x, yy, 3, 6, BGALT)


def ng_logo(buf, cx, cy, s, glow):
    """Stylized NG badge: orange rounded square + 'NG'."""
    half = 9 * s // 2
    fill_rect(buf, cx - half - 4, cy - half - 4, half * 2 + 8, half * 2 + 8,
              ORANGEL if glow else ORANGED)
    fill_rect(buf, cx - half, cy - half, half * 2, half * 2, ORANGE)
    inset = 2 * s
    iw = half * 2 - 2 * inset
    fill_rect(buf, cx - half + inset, cy - half + inset, iw, iw, BG)
    txt = "NG"
    gsc = max(2, min(iw // 11, iw // (GLYPH_H + 1)))
    tw = text_width(txt, gsc, gsc)
    draw_text(buf, cx - tw // 2, cy - (GLYPH_H * gsc) // 2, txt, gsc,
              ORANGE, gsc)


def progress_bar(buf, frame, total):
    y = H - 26
    fill_rect(buf, 30, y, W - 60, 6, PANEL2)
    w = int((W - 60) * (frame / max(1, total - 1)))
    fill_rect(buf, 30, y, w, 6, ORANGE)


# ---------------------------------------------------------------------------
# Scene timeline
# ---------------------------------------------------------------------------
SERVICES = [
    "LOGO DESIGN", "BRAND IDENTITY", "POSTERS & FLYERS", "WEBSITE DESIGN",
    "WHATSAPP BOTS", "SOCIAL MEDIA", "BUSINESS PROFILES", "BRAND STRATEGY",
]
VALUES = ["MODERN", "PROFESSIONAL", "CUSTOM BUILT", "GROWTH FOCUSED"]


def ease(p):
    p = max(0.0, min(1.0, p))
    return 1 - (1 - p) * (1 - p)


def scene_intro(buf, lf, ln):
    p = ease(lf / ln)
    cy = int(H * 0.40)
    ng_logo(buf, W // 2, cy, 8, glow=(lf % 4 < 2))
    if lf > ln * 0.25:
        draw_text_center_x(buf, cy + 110, "NEXT GEN", 9, WHITE, 9)
    if lf > ln * 0.45:
        draw_text_center_x(buf, cy + 200, "BUSINESS ENTERPRISE", 4, ORANGE, 4)
    if lf > ln * 0.6:
        bw = int((W - 160) * ease((lf - ln * 0.6) / (ln * 0.4)))
        fill_rect(buf, (W - bw) // 2, cy + 250, bw, 5, ORANGE)
    if lf > ln * 0.75:
        draw_text_center_x(buf, cy + 290, "DESIGN  BRANDING  DIGITAL", 3, GRAY, 3)


def scene_hook(buf, lf, ln):
    lines = ["WE HELP", "SMALL", "BUSINESSES", "LOOK", "EXPENSIVE."]
    maxsc = [8, 11, 8, 9, 10]
    colors = [WHITE, WHITE, WHITE, WHITE, ORANGE]
    fitted = [fit_scale(t, W - 80, m) for t, m in zip(lines, maxsc)]
    y = 150
    per = ln / (len(lines) + 1)
    for i, (txt, sc, col) in enumerate(zip(lines, fitted, colors)):
        appear = (i + 0.5) * per
        if lf >= appear:
            slide = int(40 * (1 - ease((lf - appear) / per)))
            draw_text_center_x(buf, y - slide, txt, sc, col, sc)
        y += GLYPH_H * sc + 26
    if lf > ln * 0.8:
        draw_text_center_x(buf, H - 150,
                           "SERIOUS  MODERN  READY TO GROW", 3, GRAY, 3)


def scene_services(buf, lf, ln):
    draw_text_center_x(buf, 110, "OUR SERVICES", 6, ORANGE, 6)
    fill_rect(buf, W // 2 - 70, 190, 140, 5, ORANGE)
    top = 250
    rowh = 78
    per = ln / (len(SERVICES) + 2)
    for i, name in enumerate(SERVICES):
        appear = i * per
        if lf < appear:
            continue
        prog = ease((lf - appear) / per)
        slide = int(60 * (1 - prog))
        y = top + i * rowh
        fill_rect(buf, 40 - slide, y, W - 80, rowh - 16, PANEL)
        fill_rect(buf, 40 - slide, y, 8, rowh - 16, ORANGE)
        nsc = fit_scale(name, W - 80 - 60, 5)
        draw_text(buf, 70 - slide, y + 14, name, nsc, WHITE, nsc)


def scene_values(buf, lf, ln):
    draw_text_center_x(buf, 110, "WHY NEXT GEN", 6, ORANGE, 6)
    fill_rect(buf, W // 2 - 70, 190, 140, 5, ORANGE)
    top = 270
    cellh = 150
    per = ln / (len(VALUES) + 2)
    for i, v in enumerate(VALUES):
        appear = i * per
        if lf < appear:
            continue
        prog = ease((lf - appear) / per)
        y = top + i * cellh
        sh = int(10 * prog)
        fill_rect(buf, 50, y + sh, W - 100, cellh - 30, PANEL)
        fill_rect(buf, 50, y + sh, W - 100, 6, ORANGE)
        draw_fit_center(buf, y + 40 + sh, v, WHITE, 7, margin=70)
    if lf > ln * 0.85:
        draw_text_center_x(buf, H - 150, "BUILT TO MAKE YOU LOOK EXPENSIVE",
                           3, GRAY, 3)


def scene_cta(buf, lf, ln):
    pulse = (lf % 8) < 4
    ng_logo(buf, W // 2, 230, 5, glow=pulse)
    draw_fit_center(buf, 360, "LET'S BUILD", WHITE, 9)
    draw_fit_center(buf, 450, "YOUR NEXT MOVE", ORANGE, 8)

    box_y = 580
    fill_rect(buf, 50, box_y, W - 100, 230, PANEL)
    fill_rect(buf, 50, box_y, W - 100, 8, ORANGE)
    draw_text_center_x(buf, box_y + 40, "WHATSAPP", 4, GRAY, 4)
    draw_fit_center(buf, box_y + 90, "069 273 6509", WHITE, 7, margin=70)
    draw_fit_center(buf, box_y + 165, "JOHANNESBURG, SOUTH AFRICA",
                    GRAY, 3, margin=55)

    btn_c, txt_c = (ORANGE, BG) if pulse else (ORANGED, WHITE)
    fill_rect(buf, 70, 850, W - 140, 70, btn_c)
    draw_fit_center(buf, 868, "MESSAGE US TODAY", txt_c, 4, margin=95)


SCENES = [
    (scene_intro, 1.6),
    (scene_hook, 2.4),
    (scene_services, 3.0),
    (scene_values, 2.4),
    (scene_cta, 2.6),
]


def build_frames():
    frames = []
    total = int(sum(d for _, d in SCENES) * FPS)
    fno = 0
    for fn, dur in SCENES:
        n = int(dur * FPS)
        for lf in range(n):
            buf = new_frame()
            bg_base(buf, fno / FPS)
            fn(buf, lf, n)
            progress_bar(buf, fno, total)
            frames.append(buf)
            fno += 1
    return frames


# ---------------------------------------------------------------------------
# GIF89a writer with hand-rolled LZW (animated, infinite loop)
# ---------------------------------------------------------------------------
def lzw_encode(indices, min_code_size):
    clear = 1 << min_code_size
    eoi = clear + 1
    code_size = min_code_size + 1
    table = {bytes([i]): i for i in range(clear)}
    next_code = eoi + 1

    out = bytearray()
    cur = 0
    cur_bits = 0

    def emit(code):
        nonlocal cur, cur_bits
        cur |= code << cur_bits
        cur_bits += code_size
        while cur_bits >= 8:
            out.append(cur & 0xFF)
            cur >>= 8
            cur_bits -= 8

    emit(clear)
    w = b""
    for idx in indices:
        c = bytes([idx])
        wc = w + c
        if wc in table:
            w = wc
        else:
            emit(table[w])
            table[wc] = next_code
            next_code += 1
            if next_code == (1 << code_size) and code_size < 12:
                code_size += 1
            elif next_code > 4095:
                emit(clear)
                table = {bytes([i]): i for i in range(clear)}
                next_code = eoi + 1
                code_size = min_code_size + 1
            w = c
    if w:
        emit(table[w])
    emit(eoi)
    if cur_bits > 0:
        out.append(cur & 0xFF)
    return bytes(out)


def write_gif(path, frames):
    f = open(path, "wb")
    f.write(b"GIF89a")
    f.write(struct.pack("<HH", W, H))
    # global color table: 16 colors -> size field 3
    f.write(bytes([0xF3, 0, 0]))
    for (r, g, b) in PALETTE:
        f.write(bytes([r, g, b]))
    # NETSCAPE2.0 loop forever
    f.write(b"\x21\xFF\x0BNETSCAPE2.0\x03\x01\x00\x00\x00")

    min_code_size = 4  # 16-color palette
    for buf in frames:
        # graphic control extension (delay, no transparency)
        f.write(b"\x21\xF9\x04\x04")
        f.write(struct.pack("<H", DELAY))
        f.write(b"\x00\x00")
        # image descriptor
        f.write(b"\x2C")
        f.write(struct.pack("<HHHH", 0, 0, W, H))
        f.write(b"\x00")
        f.write(bytes([min_code_size]))
        data = lzw_encode(buf, min_code_size)
        for i in range(0, len(data), 255):
            chunk = data[i:i + 255]
            f.write(bytes([len(chunk)]))
            f.write(chunk)
        f.write(b"\x00")
    f.write(b"\x3B")
    f.close()


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "next_gen_ad.gif"
    print("Rendering frames (%dx%d, %d fps)..." % (W, H, FPS))
    frames = build_frames()
    print("Encoding %d frames -> %s" % (len(frames), out))
    write_gif(out, frames)
    import os
    sz = os.path.getsize(out)
    print("Done: %s  (%.1f KB, %.1fs reel)" %
          (out, sz / 1024.0, len(frames) / FPS))


if __name__ == "__main__":
    main()
