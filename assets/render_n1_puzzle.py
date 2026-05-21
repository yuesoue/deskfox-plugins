"""N1 方向 · 拼图狐：让 DeskFox 9 个三角的"拼装"显式可见。"""
from PIL import Image, ImageDraw
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent))
from render_icon import (
    SCALE, SIZE, S,
    BG_TOP, BG_BOT, FACE_TOP, FACE_BOT, EAR_OUTER, EAR_INNER, WHITE, DARK,
    lerp, make_base, to_ss,
)

OUT = Path(__file__).parent


# ---------- Helpers ----------

def shrink_pts(pts, factor):
    """Shrink a polygon's vertices toward its centroid by factor (1.0 = no shrink)."""
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    return [(cx + (p[0] - cx) * factor, cy + (p[1] - cy) * factor) for p in pts]


def paste_gradient_polygon(img, pts_ss, top_color, bot_color):
    """Fill a polygon (already in supersampled pixel coords) with vertical gradient."""
    xs = [p[0] for p in pts_ss]
    ys = [p[1] for p in pts_ss]
    x0, x1 = int(min(xs)) - 2, int(max(xs)) + 2
    y0, y1 = int(min(ys)) - 2, int(max(ys)) + 2
    w, h = x1 - x0, y1 - y0
    if w <= 0 or h <= 0:
        return
    grad = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gpx = grad.load()
    for yy in range(h):
        t = yy / max(h - 1, 1)
        r, g, b = lerp(top_color, bot_color, t)
        for xx in range(w):
            gpx[xx, yy] = (r, g, b, 255)
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).polygon([(p[0] - x0, p[1] - y0) for p in pts_ss], fill=255)
    img.paste(grad, (x0, y0), mask)


# ---------- Puzzle fox ----------

def draw_puzzle_fox(img, cx256=128, cy256=133, scale_factor=1.4,
                    shrink=0.94, face_split=False, color_variation=False):
    """Draw the DeskFox fox with each triangle shrunk toward its centroid → visible seams."""
    d = ImageDraw.Draw(img, "RGBA")

    # Colors (with optional per-piece variation)
    if color_variation:
        ear_outer_L = (0x82, 0xA1, 0xCC)
        ear_outer_R = (0x66, 0x88, 0xBA)
        ear_inner_L = (0xFF, 0xA8, 0x88)
        ear_inner_R = (0xF0, 0x8A, 0x6C)
        face_L = (FACE_TOP, FACE_BOT)
        face_R = ((0x90, 0xAE, 0xD8), (0x68, 0x88, 0xBA))
        mouth_color = (0xF4, 0xF7, 0xFB)
    else:
        ear_outer_L = ear_outer_R = EAR_OUTER
        ear_inner_L = ear_inner_R = EAR_INNER
        face_L = (FACE_TOP, FACE_BOT)
        face_R = (FACE_TOP, FACE_BOT)
        mouth_color = WHITE

    def tri(pts_local, fill):
        pts = to_ss(pts_local, cx256, cy256, scale_factor)
        d.polygon(shrink_pts(pts, shrink), fill=fill)

    # Ears
    tri([(-68, -10), (-36, -72), (-18, -12)], ear_outer_L)
    tri([(-56, -20), (-38, -56), (-28, -22)], ear_inner_L)
    tri([(68, -10), (36, -72), (18, -12)], ear_outer_R)
    tri([(56, -20), (38, -56), (28, -22)], ear_inner_R)

    # Face (one or split)
    if face_split:
        face_L_ss = to_ss([(-68, -10), (0, -10), (0, 68)], cx256, cy256, scale_factor)
        face_R_ss = to_ss([(0, -10), (68, -10), (0, 68)], cx256, cy256, scale_factor)
        paste_gradient_polygon(img, shrink_pts(face_L_ss, shrink), face_L[0], face_L[1])
        paste_gradient_polygon(img, shrink_pts(face_R_ss, shrink), face_R[0], face_R[1])
    else:
        face_ss = to_ss([(-68, -10), (68, -10), (0, 68)], cx256, cy256, scale_factor)
        paste_gradient_polygon(img, shrink_pts(face_ss, shrink), face_L[0], face_L[1])

    # Mouth
    tri([(-22, 18), (22, 18), (0, 52)], mouth_color)

    # Eyes (don't shrink — keep readable)
    for ex_local in (-22, 22):
        gx = (cx256 * 0.5 + ex_local * scale_factor * 0.5) * SCALE
        gy = (cy256 * 0.5 + 4 * scale_factor * 0.5) * SCALE
        r_ss = 5 * scale_factor * 0.5 * SCALE
        d.ellipse([gx - r_ss, gy - r_ss, gx + r_ss, gy + r_ss], fill=DARK)


# ---------- Variants ----------

def render_n1a_subtle():
    """微缝（最克制）"""
    img = make_base()
    draw_puzzle_fox(img, scale_factor=1.46, shrink=0.96, face_split=False, color_variation=False)
    return img


def render_n1b_clear():
    """明缝 + 每块微调色相"""
    img = make_base()
    draw_puzzle_fox(img, scale_factor=1.48, shrink=0.93, face_split=False, color_variation=True)
    return img


def render_n1c_split():
    """明缝 + 拆脸 + 调色（最大拼图感）"""
    img = make_base()
    draw_puzzle_fox(img, scale_factor=1.48, shrink=0.93, face_split=True, color_variation=True)
    return img


def main():
    variants = [
        ("n1a-subtle", render_n1a_subtle),
        ("n1b-clear", render_n1b_clear),
        ("n1c-split", render_n1c_split),
    ]
    for name, fn in variants:
        img = fn()
        for sz in (128, 256, 512):
            img.resize((sz, sz), Image.LANCZOS).save(OUT / f"icon-{name}-{sz}.png")
        print(f"{name} rendered")


if __name__ == "__main__":
    main()
