#!/usr/bin/env python3
# Draws the Plecks app icons: the "P" mark from make-plecks-brand.ps1 with the
# "Plecks" wordmark under it, so the TV launcher tile says what the app is.
# Needs Pillow + fontTools (with brotli) to read the app's bundled woff2 font.
#   python3 scripts/make-plecks-icon.py
import io, os
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CREAM = (255, 247, 230, 255)
CORAL = (255, 76, 66, 255)
SS = 4  # supersample, then downscale

ttf = TTFont(os.path.join(ROOT, 'app/fonts/barlow-condensed-latin-700-normal.woff2'))
ttf.flavor = None
FONT_BYTES = io.BytesIO(); ttf.save(FONT_BYTES)


def font(px):
    return ImageFont.truetype(io.BytesIO(FONT_BYTES.getvalue()), px)


def draw_icon(size):
    n = size * SS
    u = n / 100.0
    img = Image.new('RGBA', (n, n), (0, 0, 0, 0))

    # Tile: rounded square, vertical gradient, faint cream edge.
    grad = Image.new('RGBA', (1, n))
    for y in range(n):
        t = y / (n - 1)
        grad.putpixel((0, y), tuple(round(a + (b - a) * t) for a, b in zip((44, 48, 60), (16, 18, 24))) + (255,))
    grad = grad.resize((n, n))
    tile = Image.new('L', (n, n), 0)
    ImageDraw.Draw(tile).rounded_rectangle((0, 0, n - 1, n - 1), radius=22 * u, fill=255)
    img.paste(grad, (0, 0), tile)
    ImageDraw.Draw(img).rounded_rectangle((0, 0, n - 1, n - 1), radius=22 * u,
                                          outline=(255, 247, 230, 40), width=max(SS, round(1.2 * u)))

    # The P mark (same 100-unit geometry as the brand script), shrunk into the top of the tile.
    s, cx, top = 0.6, 50, 11
    def X(v): return (cx + (v - 52) * s) * u
    def Y(v): return (top + (v - 18) * s) * u
    def R(v): return v * s * u
    mask = Image.new('L', (n, n), 0)
    m = ImageDraw.Draw(mask)
    m.rectangle((X(27), Y(18), X(53), Y(66)), fill=255)
    m.rectangle((X(27), Y(18), X(41), Y(82)), fill=255)
    m.pieslice((X(53) - R(24), Y(42) - R(24), X(53) + R(24), Y(42) + R(24)), 270, 90, fill=255)
    m.rectangle((X(41), Y(31), X(53), Y(53)), fill=0)
    m.pieslice((X(53) - R(11), Y(42) - R(11), X(53) + R(11), Y(42) + R(11)), 270, 90, fill=0)
    img.paste(Image.new('RGBA', (n, n), CREAM), (0, 0), mask)
    tri = [(X(47.5), Y(35.5)), (X(47.5), Y(48.5)), (X(58.5), Y(42))]
    d = ImageDraw.Draw(img)
    d.polygon(tri, fill=CORAL)
    d.line(tri + [tri[0]], fill=CORAL, width=max(1, round(R(2.2))), joint='curve')

    # Wordmark: cream "Ple" + coral "cks", sized to fill the tile width.
    target_w = 78 * u
    px = 100
    w = d.textlength('Plecks', font=font(px))
    px = int(px * target_w / w)
    f = font(px)
    w1 = d.textlength('Ple', font=f)
    w = d.textlength('Plecks', font=f)
    x0 = (n - w) / 2
    baseline = 88 * u
    d.text((x0, baseline), 'Ple', font=f, fill=CREAM, anchor='ls')
    d.text((x0 + w1, baseline), 'cks', font=f, fill=CORAL, anchor='ls')

    return img.resize((size, size), Image.LANCZOS)


def save(img, rel):
    img.save(os.path.join(ROOT, rel))
    print(f'{rel} {img.width}x{img.height}')


for s in (117, 128, 256, 512, 1024):
    icon = draw_icon(s)
    save(icon, f'assets/icons/app-icon-{s}.png')
    if s == 117:
        save(icon, 'app/icon-plecks.png')
        save(icon, 'assets/tizen/icon-dev-117x117.png')
