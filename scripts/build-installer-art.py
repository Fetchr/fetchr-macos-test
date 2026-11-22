"""
Картинки окна NSIS-установщика из финального кадра интро «Проявка».

  sidebar.bmp 164x314 — страницы «Добро пожаловать» и «Готово»
  header.bmp  150x57  — шапка остальных страниц

NSIS принимает только BMP, поэтому всё рисуется здесь, без браузера:
контуры знака и слова — те же, что в src/ui/redesign/brand/FetchrBrand.tsx,
ASCII-поле — упрощённый asciiBackdrop.ts с тем же упорядоченным дизерингом.

Запуск: python scripts/build-installer-art.py
"""

import math
import re
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src-tauri" / "installer"
SS = 4  # суперсэмплинг

BODY = "M18 14H87Q91 14 91 18V29Q91 33 87 33H34V48H43Q47 48 47 52V63Q47 67 43 67H34V80Q34 84 30 84H18Q14 84 14 80V18Q14 14 18 14Z"
FRAG = "M71 48H87Q91 48 91 52V63Q91 67 87 67H71Q67 67 67 63V52Q67 48 71 48Z"
WORD = (
    "M135.32 88.18C147.42 88.18 157.02 81.17 158.98 71.03H147.42C146 75.44 141.83 78.43 135.61 78.43C127.28 78.43 122.48 72.79 122.19 64.37H159.62V60.98C159.62 45.11 149.72 34.09 134.83 34.09C120.33 34.09 110.09 45.45 110.09 61.18C110.09 76.86 119.79 88.18 135.32 88.18Z"
    "M122.29 55.84C123.12 48.44 127.87 43.89 135.02 43.89C142.18 43.89 146.98 48.44 147.76 55.84Z"
    "M176 22H189V39H205L202 50H189V68Q189 75 197 75H204V84Q199 88 192 88Q175 88 175 70V50H166V39H176Z"
    "M232.37 88.18C245.45 88.18 254.95 79.75 255.83 68.43H243.64C242.46 74.16 238.98 77.89 232.51 77.89C224.38 77.89 219.58 71.37 219.58 61.18C219.58 50.94 224.43 44.38 232.51 44.38C238.93 44.38 242.8 48.25 243.73 53.78H255.83C254.76 42.27 245.35 34.09 232.37 34.09C217.23 34.09 207.09 45.21 207.09 61.18C207.09 77.15 217.23 88.18 232.37 88.18Z"
    "M267 14H281V46Q290 37 302 37Q324 37 324 63V87H310V65Q310 51 299 51Q287 51 281 65V87H267Z"
    "M337 38H351V47Q360 36 372 37Q377 37 381 39L377 52Q373 51 369 51Q351 52 351 71V87H337Z"
)
ACCENT = (61, 125, 255)
TEXT = (243, 246, 251)
CANVAS = (6, 7, 10)
RAMP = " .:-=+*#%@"
BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]]
PALETTE = [(16, 28, 58), (32, 64, 150), (61, 125, 255), (150, 190, 255), (225, 238, 255)]


def subpaths(d):
    """Контуры пути (M/H/V/L/Q/C/Z, абсолютные) как списки точек."""
    tokens = re.findall(r"[MHVLQCZ]|-?\d*\.?\d+", d)
    out, cur, i, x, y, cmd = [], [], 0, 0.0, 0.0, None
    num = lambda: float(tokens[i])
    while i < len(tokens):
        if tokens[i].isalpha():
            cmd = tokens[i]
            i += 1
            if cmd == "Z":
                out.append(cur)
                cur = []
                continue
        if cmd == "M":
            x, y = num(), float(tokens[i + 1]); i += 2
            cur = [(x, y)]
            cmd = "L"
        elif cmd == "L":
            x, y = num(), float(tokens[i + 1]); i += 2
            cur.append((x, y))
        elif cmd == "H":
            x = num(); i += 1
            cur.append((x, y))
        elif cmd == "V":
            y = num(); i += 1
            cur.append((x, y))
        elif cmd == "Q":
            cx, cy, ex, ey = (float(tokens[i + k]) for k in range(4)); i += 4
            for s in range(1, 9):
                t = s / 8
                cur.append(((1 - t) ** 2 * x + 2 * (1 - t) * t * cx + t * t * ex,
                            (1 - t) ** 2 * y + 2 * (1 - t) * t * cy + t * t * ey))
            x, y = ex, ey
        elif cmd == "C":
            c1x, c1y, c2x, c2y, ex, ey = (float(tokens[i + k]) for k in range(6)); i += 6
            for s in range(1, 13):
                t = s / 12
                a, b, c, e = (1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t * t, t ** 3
                cur.append((a * x + b * c1x + c * c2x + e * ex, a * y + b * c1y + c * c2y + e * ey))
            x, y = ex, ey
    return out


def fill_path(img, d, color, scale, ox, oy):
    """Заливка с правилом even-odd через маску: так «глазок» у e остаётся дыркой."""
    mask = Image.new("L", img.size, 0)
    for poly in subpaths(d):
        layer = Image.new("L", img.size, 0)
        ImageDraw.Draw(layer).polygon([(ox + px * scale, oy + py * scale) for px, py in poly], fill=255)
        mask = ImageChops.logical_xor(mask.convert("1"), layer.convert("1")).convert("L")
    img.paste(Image.new("RGB", img.size, color), (0, 0), mask)


def hash2(x, y):
    s = math.sin(x * 127.1 + y * 311.7) * 43758.5453
    return s - math.floor(s)


def noise(x, y):
    xi, yi = math.floor(x), math.floor(y)
    xf, yf = x - xi, y - yi
    u, v = xf * xf * (3 - 2 * xf), yf * yf * (3 - 2 * yf)
    a, b, c, d = hash2(xi, yi), hash2(xi + 1, yi), hash2(xi, yi + 1), hash2(xi + 1, yi + 1)
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v


def fbm(x, y):
    return .55 * noise(x, y) + .3 * noise(x * 2.1 + 3.7, y * 2.1 - 1.3) + .15 * noise(x * 4.3 - 2.2, y * 4.3 + 5.1)


def palette(v):
    x = max(0.0, min(.999, v)) * (len(PALETTE) - 1)
    i = int(x)
    f = x - i
    a, b = PALETTE[i], PALETTE[i + 1]
    return tuple(int(a[k] + (b[k] - a[k]) * f) for k in range(3))


def mono_font(px):
    for name in ("consolab.ttf", "consola.ttf", "cour.ttf"):
        try:
            return ImageFont.truetype(f"C:/Windows/Fonts/{name}", px)
        except OSError:
            continue
    return ImageFont.load_default()


def ascii_field(img, rows, intensity, centre, calm_radius, light_bg=False):
    """ASCII-поле с дизерингом, спокойным центром и затенением к краям."""
    w, h = img.size
    ch = h / rows
    cw = ch * .614
    cols = int(w / cw) + 1
    font = mono_font(int(ch * .82))
    draw = ImageDraw.Draw(img)
    aspect = w / h
    for r in range(rows):
        ny = ((r + .5) / rows) * 2 - 1
        for c in range(cols):
            ax = (((c + .5) / cols) * 2 - 1) * aspect
            n = fbm(ax * 1.1 + 1.7, ny * 1.4 + .4)
            light = math.pow(n, 1.7) * .75
            ribbon = math.sin(ax * 1.4 + ny * 2.6 + n * 3.2 + 1.1)
            light += math.pow(max(0.0, ribbon), 6) * .42 * (.6 + .4 * n)
            dist = math.hypot((c + .5) * cw - centre[0], ((r + .5) * ch - centre[1]) * 1.6) / calm_radius
            light *= (.18 + .82 * max(0.0, min(1.0, dist - .55))) * intensity
            light += (BAYER[r & 3][c & 3] / 16 - .5) / len(RAMP)
            idx = int(light * len(RAMP))
            if idx <= 0:
                continue
            if light_bg:
                k = min(1.0, .12 + light * .9)
                col = tuple(int(255 - (255 - v) * k) for v in (150, 175, 230))
            else:
                base = palette(light * 1.05)
                k = min(1.0, .18 + light)
                col = tuple(int(CANVAS[i] + (base[i] - CANVAS[i]) * k) for i in range(3))
            draw.text(((c + .5) * cw, (r + .5) * ch), RAMP[min(len(RAMP) - 1, idx)], font=font, fill=col, anchor="mm")


def glow(img, centre, radius, strength):
    layer = Image.new("RGB", img.size, (0, 0, 0))
    ImageDraw.Draw(layer).ellipse(
        [centre[0] - radius, centre[1] - radius * .7, centre[0] + radius, centre[1] + radius * .7],
        fill=tuple(int(v * strength) for v in ACCENT),
    )
    layer = layer.filter(ImageFilter.GaussianBlur(radius * .5))
    return ImageChops.add(img, layer)


def vignette(img, strength):
    w, h = img.size
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).ellipse([-w * .35, -h * .15, w * 1.35, h * 1.15], fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(w * .18))
    dark = Image.new("RGB", (w, h), (2, 3, 4))
    return Image.composite(img, Image.blend(img, dark, strength), mask)


def lockup(img, cx, cy, width, word_color):
    """Знак и слово: рамка сетки 14…381 по x, 14…89 по y."""
    scale = width / (381 - 14)
    ox = cx - (14 + 381) / 2 * scale
    oy = cy - (14 + 89) / 2 * scale
    fill_path(img, BODY + FRAG, ACCENT, scale, ox, oy)
    fill_path(img, WORD, word_color, scale, ox, oy)


def mark(img, cx, cy, height):
    scale = height / 70
    fill_path(img, BODY + FRAG, ACCENT, scale, cx - 52.5 * scale, cy - 49 * scale)


def save_bmp(img, size, name):
    small = img.resize(size, Image.LANCZOS).convert("RGB")
    OUT.mkdir(parents=True, exist_ok=True)
    small.save(OUT / name, format="BMP")


def sidebar():
    w, h = 164 * SS, 314 * SS
    img = Image.new("RGB", (w, h), CANVAS)
    centre = (w / 2, h * .42)
    ascii_field(img, rows=64, intensity=.62, centre=centre, calm_radius=w * .55)
    img = vignette(img, .55)
    img = glow(img, centre, w * .55, .42)
    lockup(img, centre[0], centre[1], w * .8, TEXT)
    save_bmp(img, (164, 314), "sidebar.bmp")


def header():
    w, h = 150 * SS, 57 * SS
    img = Image.new("RGB", (w, h), (255, 255, 255))
    centre = (w * .78, h / 2)
    ascii_field(img, rows=12, intensity=.5, centre=centre, calm_radius=h * .9, light_bg=True)
    fade = Image.linear_gradient("L").rotate(90).resize((w, h))
    img = Image.composite(Image.new("RGB", (w, h), (255, 255, 255)), img, fade)
    mark(img, centre[0], centre[1], h * .6)
    save_bmp(img, (150, 57), "header.bmp")


if __name__ == "__main__":
    sidebar()
    header()
    print(f"written to {OUT}")
