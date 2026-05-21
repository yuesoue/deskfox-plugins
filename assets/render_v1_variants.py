"""V1 方向（狐脸 + 角标）的 6 个风格变体。"""
from PIL import Image, ImageDraw
from pathlib import Path
import sys

# 复用已有的渲染基建
sys.path.insert(0, str(Path(__file__).parent))
from render_icon import (
    SCALE, SIZE, S,
    BG_TOP, BG_BOT, FACE_TOP, FACE_BOT, EAR_OUTER, EAR_INNER, WHITE, DARK,
    make_base, draw_fox,
)

OUT = Path(__file__).parent

# 角标默认位置（128-canvas 坐标），统一锁定在右上角
BADGE_CX_128 = 100
BADGE_CY_128 = 28
BADGE_BG_R_128 = 16  # 圆形/方形底盘的半径


def ss(x):
    """logical(128) → supersampled pixel."""
    return x * SCALE


def ss_pt(x, y):
    return (x * SCALE, y * SCALE)


def draw_circle_bg(img, cx, cy, r, color=DARK):
    d = ImageDraw.Draw(img, "RGBA")
    d.ellipse([ss(cx - r), ss(cy - r), ss(cx + r), ss(cy + r)], fill=color)


def draw_rounded_bg(img, cx, cy, r, color=DARK):
    d = ImageDraw.Draw(img, "RGBA")
    rad = r * 0.35
    d.rounded_rectangle(
        [ss(cx - r), ss(cy - r), ss(cx + r), ss(cy + r)],
        radius=ss(rad), fill=color,
    )


# ---------- 6 个变体 ----------

def render_a_plus_in_circle():
    """A: 清晰的"+"（矩形构成）+ 深色圆底盘"""
    img = make_base()
    draw_fox(img, cx256=116, cy256=140, scale_factor=1.28)
    draw_circle_bg(img, BADGE_CX_128, BADGE_CY_128, BADGE_BG_R_128)
    d = ImageDraw.Draw(img, "RGBA")
    bar_len = 18
    bar_w = 5
    cx, cy = BADGE_CX_128, BADGE_CY_128
    # 横条
    d.rounded_rectangle(
        [ss(cx - bar_len / 2), ss(cy - bar_w / 2), ss(cx + bar_len / 2), ss(cy + bar_w / 2)],
        radius=ss(bar_w / 2), fill=EAR_INNER,
    )
    # 竖条
    d.rounded_rectangle(
        [ss(cx - bar_w / 2), ss(cy - bar_len / 2), ss(cx + bar_w / 2), ss(cy + bar_len / 2)],
        radius=ss(bar_w / 2), fill=EAR_INNER,
    )
    return img


def render_b_sparkle_naked():
    """B: AI 火花（4 点 pinched star）裸贴在底色上，无底盘"""
    img = make_base()
    draw_fox(img, cx256=116, cy256=140, scale_factor=1.28)
    d = ImageDraw.Draw(img, "RGBA")
    cx, cy = BADGE_CX_128, BADGE_CY_128
    r = 14
    # 大火花
    pts = sparkle_poly(cx, cy, r)
    d.polygon([ss_pt(x, y) for x, y in pts], fill=EAR_INNER)
    # 副火花
    pts2 = sparkle_poly(cx + 14, cy - 12, 4)
    d.polygon([ss_pt(x, y) for x, y in pts2], fill=EAR_INNER)
    return img


def render_c_puzzle_in_circle():
    """C: 抽象拼图块（三角拼图）+ 深色圆底盘"""
    img = make_base()
    draw_fox(img, cx256=116, cy256=140, scale_factor=1.28)
    draw_circle_bg(img, BADGE_CX_128, BADGE_CY_128, BADGE_BG_R_128)
    d = ImageDraw.Draw(img, "RGBA")
    cx, cy = BADGE_CX_128, BADGE_CY_128
    # 拼图（2 块互锁的三角形：一块珊瑚 + 一块浅蓝，错开）
    # 块 1（左下三角）
    d.polygon([ss_pt(cx - 9, cy - 9), ss_pt(cx + 3, cy - 9), ss_pt(cx - 9, cy + 3)], fill=EAR_INNER)
    # 块 2（右上三角，互补）
    d.polygon([ss_pt(cx + 9, cy + 9), ss_pt(cx - 3, cy + 9), ss_pt(cx + 9, cy - 3)], fill=EAR_INNER)
    # 中心连接点（浅蓝小方）
    d.polygon([ss_pt(cx - 3, cy - 3), ss_pt(cx + 3, cy - 3), ss_pt(cx + 3, cy + 3)], fill=FACE_TOP)
    d.polygon([ss_pt(cx - 3, cy - 3), ss_pt(cx - 3, cy + 3), ss_pt(cx + 3, cy + 3)], fill=FACE_TOP)
    return img


def render_d_tangram_stack():
    """D: 3 颗珊瑚小三角叠成"模块塔"，无底盘——最 on-brand"""
    img = make_base()
    draw_fox(img, cx256=116, cy256=140, scale_factor=1.28)
    d = ImageDraw.Draw(img, "RGBA")
    cx = BADGE_CX_128
    # 三颗三角，自上而下大小递增
    triangles = [
        # (cy, base_half, height)
        (16, 5, 6),
        (26, 7, 8),
        (38, 9, 10),
    ]
    for (cy_t, bh, ht) in triangles:
        d.polygon([
            ss_pt(cx - bh, cy_t + ht / 2),
            ss_pt(cx + bh, cy_t + ht / 2),
            ss_pt(cx, cy_t - ht / 2),
        ], fill=EAR_INNER)
    return img


def render_e_mini_app_badge():
    """E: 角标本身就是个 mini 圆角方"app"图标，里面一个"+"——"app 的 app"meta 感"""
    img = make_base()
    draw_fox(img, cx256=116, cy256=140, scale_factor=1.28)
    cx, cy = BADGE_CX_128, BADGE_CY_128
    r = 16
    # 珊瑚圆角方底（注意：是角标自己的容器，颜色用珊瑚以从狐脸里跳出来）
    d = ImageDraw.Draw(img, "RGBA")
    d.rounded_rectangle(
        [ss(cx - r), ss(cy - r), ss(cx + r), ss(cy + r)],
        radius=ss(r * 0.35), fill=EAR_INNER,
    )
    # 内嵌"+"（深色），呼应"添加 app"
    bar_len = 18
    bar_w = 5
    d.rounded_rectangle(
        [ss(cx - bar_len / 2), ss(cy - bar_w / 2), ss(cx + bar_len / 2), ss(cy + bar_w / 2)],
        radius=ss(bar_w / 2), fill=DARK,
    )
    d.rounded_rectangle(
        [ss(cx - bar_w / 2), ss(cy - bar_len / 2), ss(cx + bar_w / 2), ss(cy + bar_len / 2)],
        radius=ss(bar_w / 2), fill=DARK,
    )
    return img


def render_f_modules_bars():
    """F: 3 条横线（模块/列表/堆栈），裸贴底色"""
    img = make_base()
    draw_fox(img, cx256=116, cy256=140, scale_factor=1.28)
    d = ImageDraw.Draw(img, "RGBA")
    cx = BADGE_CX_128
    bar_w = 22
    bar_h = 4
    for i, cy_b in enumerate((16, 26, 36)):
        d.rounded_rectangle(
            [ss(cx - bar_w / 2), ss(cy_b - bar_h / 2), ss(cx + bar_w / 2), ss(cy_b + bar_h / 2)],
            radius=ss(bar_h / 2), fill=EAR_INNER,
        )
    return img


# ---------- sparkle helper（B 用） ----------

def sparkle_poly(cx, cy, r, samples=24):
    pts = [(cx, cy - r), (cx + r, cy), (cx, cy + r), (cx - r, cy)]
    poly = []
    for i in range(4):
        p0 = pts[i]
        p1 = pts[(i + 1) % 4]
        pinch = r * 0.42
        t = (r - pinch) / r
        c0 = (p0[0] + (cx - p0[0]) * t, p0[1] + (cy - p0[1]) * t)
        c1 = (p1[0] + (cx - p1[0]) * t, p1[1] + (cy - p1[1]) * t)
        for s in range(samples):
            u = s / samples
            x = ((1 - u) ** 3 * p0[0] + 3 * (1 - u) ** 2 * u * c0[0]
                 + 3 * (1 - u) * u ** 2 * c1[0] + u ** 3 * p1[0])
            y = ((1 - u) ** 3 * p0[1] + 3 * (1 - u) ** 2 * u * c0[1]
                 + 3 * (1 - u) * u ** 2 * c1[1] + u ** 3 * p1[1])
            poly.append((x, y))
    return poly


def main():
    variants = [
        ("a-plus-circle", render_a_plus_in_circle),
        ("b-sparkle", render_b_sparkle_naked),
        ("c-puzzle-circle", render_c_puzzle_in_circle),
        ("d-tangram-stack", render_d_tangram_stack),
        ("e-mini-app", render_e_mini_app_badge),
        ("f-modules-bars", render_f_modules_bars),
    ]
    for name, fn in variants:
        img = fn()
        for sz in (128, 256):
            img.resize((sz, sz), Image.LANCZOS).save(OUT / f"icon-v1-{name}-{sz}.png")
        print(f"{name} rendered")


if __name__ == "__main__":
    main()
