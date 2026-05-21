"""Render DeskFox Plugins icon variants to PNG (4x supersample → downscale)."""
from PIL import Image, ImageDraw
from pathlib import Path

OUT = Path(__file__).parent
SCALE = 4
SIZE = 128
S = SIZE * SCALE  # 512

# Brand palette
BG_TOP = (0x24, 0x33, 0x53)
BG_BOT = (0x17, 0x22, 0x38)
FACE_TOP = (0x9D, 0xBB, 0xE3)
FACE_BOT = (0x72, 0x95, 0xC4)
EAR_OUTER = (0x72, 0x95, 0xC4)
EAR_INNER = (0xFF, 0x9A, 0x7A)  # coral
WHITE = (0xF4, 0xF7, 0xFB)
DARK = (0x17, 0x22, 0x38)


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def vertical_gradient(size, top, bot):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    px = img.load()
    for y in range(size):
        t = y / (size - 1)
        r, g, b = lerp(top, bot, t)
        for x in range(size):
            px[x, y] = (r, g, b, 255)
    return img


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def make_base(rx=56):
    """Brand-standard dark navy gradient with rounded corners.
    rx is in logical (256-canvas) units to match brand SVG; we scale to 128 canvas.
    """
    bg = vertical_gradient(S, BG_TOP, BG_BOT)
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    # rx is given in 256-canvas units, convert to 128-canvas, then supersample
    rx_local = rx * 0.5  # 128-canvas
    out.paste(bg, (0, 0), rounded_mask(S, int(rx_local * SCALE)))
    return out


def to_ss(pts, cx_local, cy_local, scale_factor):
    """Transform fox-local coords (centered at 0,0 in 256-canvas) to supersampled pixel coords.

    Original SVG: 256×256 canvas, fox at translate(128, 133) scale(1.4).
    We render at 128×128 (halved). So translate (cx_local*0.5, cy_local*0.5), scale 1.4*0.5 = 0.7.
    Then ×SCALE for supersampling.
    """
    out = []
    for (x, y) in pts:
        gx = (cx_local * 0.5 + x * scale_factor * 0.5) * SCALE
        gy = (cy_local * 0.5 + y * scale_factor * 0.5) * SCALE
        out.append((gx, gy))
    return out


def draw_fox(img, cx256=128, cy256=133, scale_factor=1.4):
    """Draw the standard DeskFox fox. cx256/cy256 are positions in 256-canvas units."""
    d = ImageDraw.Draw(img, "RGBA")
    # Face — needs a vertical gradient fill; simulate by painting gradient then masking to face polygon
    face_poly = to_ss([(-68, -10), (68, -10), (0, 68)], cx256, cy256, scale_factor)

    # Draw face via masked gradient (small region, so do it manually)
    # Compute bounding box for the face
    xs = [p[0] for p in face_poly]
    ys = [p[1] for p in face_poly]
    x0, x1 = int(min(xs)) - 2, int(max(xs)) + 2
    y0, y1 = int(min(ys)) - 2, int(max(ys)) + 2
    w = x1 - x0
    h = y1 - y0
    face_grad = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    fpx = face_grad.load()
    for yy in range(h):
        t = yy / max(h - 1, 1)
        r, g, b = lerp(FACE_TOP, FACE_BOT, t)
        for xx in range(w):
            fpx[xx, yy] = (r, g, b, 255)
    face_mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(face_mask).polygon([(p[0] - x0, p[1] - y0) for p in face_poly], fill=255)
    img.paste(face_grad, (x0, y0), face_mask)

    # Ears (outer + inner)
    d.polygon(to_ss([(-68, -10), (-36, -72), (-18, -12)], cx256, cy256, scale_factor), fill=EAR_OUTER)
    d.polygon(to_ss([(-56, -20), (-38, -56), (-28, -22)], cx256, cy256, scale_factor), fill=EAR_INNER)
    d.polygon(to_ss([(68, -10), (36, -72), (18, -12)], cx256, cy256, scale_factor), fill=EAR_OUTER)
    d.polygon(to_ss([(56, -20), (38, -56), (28, -22)], cx256, cy256, scale_factor), fill=EAR_INNER)

    # Mouth
    d.polygon(to_ss([(-22, 18), (22, 18), (0, 52)], cx256, cy256, scale_factor), fill=WHITE)

    # Eyes (in fox-local coords, centered at (±22, 4) with r=5)
    for ex_local in (-22, 22):
        gx = (cx256 * 0.5 + ex_local * scale_factor * 0.5) * SCALE
        gy = (cy256 * 0.5 + 4 * scale_factor * 0.5) * SCALE
        r_ss = 5 * scale_factor * 0.5 * SCALE
        d.ellipse([gx - r_ss, gy - r_ss, gx + r_ss, gy + r_ss], fill=DARK)


def render_v1_badge():
    img = make_base()
    # Fox slightly down/left to leave room for badge top-right
    draw_fox(img, cx256=120, cy256=138, scale_factor=1.32)
    d = ImageDraw.Draw(img, "RGBA")
    # Badge: dark circle bg + coral "+" of 4 triangles
    # Position in 256-canvas: (204, 52), radius 30 — convert to 128-canvas (102, 26) r 15
    bcx128, bcy128, br128 = 102, 26, 15
    bcx_ss, bcy_ss = bcx128 * SCALE, bcy128 * SCALE
    br_ss = br128 * SCALE
    d.ellipse([bcx_ss - br_ss, bcy_ss - br_ss, bcx_ss + br_ss, bcy_ss + br_ss], fill=DARK)

    # "+" arms — each triangle in 256-canvas relative offset, then convert
    def tri256(*pts):
        return [(bcx128 + x * 0.5, bcy128 + y * 0.5) for (x, y) in pts]

    def to_ss_abs(pts128):
        return [(x * SCALE, y * SCALE) for (x, y) in pts128]

    # Vertical arms
    d.polygon(to_ss_abs(tri256((0, -18), (6, -2), (-6, -2))), fill=EAR_INNER)
    d.polygon(to_ss_abs(tri256((0, 18), (-6, 2), (6, 2))), fill=EAR_INNER)
    # Horizontal arms
    d.polygon(to_ss_abs(tri256((-18, 0), (-2, -6), (-2, 6))), fill=EAR_INNER)
    d.polygon(to_ss_abs(tri256((18, 0), (2, 6), (2, -6))), fill=EAR_INNER)
    # Center square (2 triangles)
    d.polygon(to_ss_abs(tri256((-2, -2), (2, -2), (2, 2))), fill=EAR_INNER)
    d.polygon(to_ss_abs(tri256((-2, -2), (-2, 2), (2, 2))), fill=EAR_INNER)
    return img


def render_v2_modular():
    img = make_base()
    # Shift fox left + shrink slightly to leave canvas room for the modular extras
    draw_fox(img, cx256=108, cy256=138, scale_factor=1.28)
    d = ImageDraw.Draw(img, "RGBA")
    # 2 extra triangles sit just outside the right ear, INSIDE the canvas
    # (fox is at cx=108, scale=1.28; canvas width=256, so right edge available ~148 units)
    extra1 = to_ss([(82, -28), (96, -56), (88, -22)], 108, 138, 1.28)
    extra2 = to_ss([(90, -14), (102, -30), (96, -10)], 108, 138, 1.28)
    d.polygon(extra1, fill=EAR_INNER)
    d.polygon(extra2, fill=FACE_TOP)
    return img


def render_v3_plug():
    img = make_base()
    d = ImageDraw.Draw(img, "RGBA")
    # 128-canvas coords (center 64,64). Use 256-canvas coords for consistency and halve them.
    cx128, cy128 = 64, 64

    def tri256(*pts):
        return [((cx128 + x * 0.5) * SCALE, (cy128 + y * 0.5) * SCALE) for (x, y) in pts]

    # Center square — 2 light triangles
    d.polygon(tri256((-28, -28), (28, -28), (28, 28)), fill=FACE_TOP)
    d.polygon(tri256((-28, -28), (-28, 28), (28, 28)), fill=FACE_BOT)
    # 4 coral arms (up, down, left, right)
    d.polygon(tri256((-28, -28), (28, -28), (0, -72)), fill=EAR_INNER)
    d.polygon(tri256((-28, 28), (28, 28), (0, 72)), fill=EAR_INNER)
    d.polygon(tri256((-28, -28), (-28, 28), (-72, 0)), fill=EAR_INNER)
    d.polygon(tri256((28, -28), (28, 28), (72, 0)), fill=EAR_INNER)
    # Dark center accent
    d.polygon(tri256((-12, -12), (12, -12), (0, 12)), fill=DARK)
    return img


def main():
    variants = [
        ("v1-badge", render_v1_badge),
        ("v2-modular", render_v2_modular),
        ("v3-plug", render_v3_plug),
    ]
    for name, fn in variants:
        img = fn()
        for sz in (128, 256, 512):
            img.resize((sz, sz), Image.LANCZOS).save(OUT / f"icon-{name}-{sz}.png")
        print(f"{name} rendered")


if __name__ == "__main__":
    main()
