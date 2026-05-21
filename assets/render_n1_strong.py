"""N1 路线 A：暴力加宽缝隙 + 把脸细分成 4 块 tangram。"""
from PIL import Image, ImageDraw
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent))
from render_icon import (
    SCALE, SIZE, S,
    BG_TOP, BG_BOT, FACE_TOP, FACE_BOT, EAR_OUTER, EAR_INNER, WHITE, DARK,
    lerp, make_base, to_ss,
)
from render_n1_puzzle import shrink_pts, paste_gradient_polygon

OUT = Path(__file__).parent


def draw_tangram_fox(img, cx256=128, cy256=133, scale_factor=1.5,
                     shrink=0.88,
                     face_colors=None,
                     ear_colors=None,
                     mouth_color=WHITE):
    """狐脸的"脸"细分为 4 块 tangram（3 角 + 中心倒三角）。"""
    d = ImageDraw.Draw(img, "RGBA")

    if ear_colors is None:
        ear_colors = (EAR_OUTER, EAR_OUTER, EAR_INNER, EAR_INNER)
    eo_L, eo_R, ei_L, ei_R = ear_colors

    if face_colors is None:
        face_colors = [(FACE_TOP, FACE_BOT)] * 4

    def tri(pts_local, fill):
        pts = to_ss(pts_local, cx256, cy256, scale_factor)
        d.polygon(shrink_pts(pts, shrink), fill=fill)

    def grad_tri(pts_local, top, bot):
        pts = to_ss(pts_local, cx256, cy256, scale_factor)
        paste_gradient_polygon(img, shrink_pts(pts, shrink), top, bot)

    # 双耳
    tri([(-68, -10), (-36, -72), (-18, -12)], eo_L)
    tri([(-56, -20), (-38, -56), (-28, -22)], ei_L)
    tri([(68, -10), (36, -72), (18, -12)], eo_R)
    tri([(56, -20), (38, -56), (28, -22)], ei_R)

    # 脸 → 4 块 tangram
    # A 顶点(-68,-10), B 顶点(68,-10), C 顶点(0,68)
    # 中点: M_AB(0,-10), M_AC(-34,29), M_BC(34,29)
    corner_A = [(-68, -10), (0, -10), (-34, 29)]   # 左上角块
    corner_B = [(0, -10), (68, -10), (34, 29)]      # 右上角块
    corner_C = [(-34, 29), (34, 29), (0, 68)]       # 底尖块
    center   = [(0, -10), (34, 29), (-34, 29)]      # 中心倒三角

    grad_tri(corner_A, *face_colors[0])
    grad_tri(corner_B, *face_colors[1])
    grad_tri(corner_C, *face_colors[2])
    grad_tri(center, *face_colors[3])

    # 嘴（覆盖在脸块之上）
    tri([(-22, 18), (22, 18), (0, 52)], mouth_color)

    # 眼（不缩，保持识别）
    for ex_local in (-22, 22):
        gx = (cx256 * 0.5 + ex_local * scale_factor * 0.5) * SCALE
        gy = (cy256 * 0.5 + 4 * scale_factor * 0.5) * SCALE
        r_ss = 5 * scale_factor * 0.5 * SCALE
        d.ellipse([gx - r_ss, gy - r_ss, gx + r_ss, gy + r_ss], fill=DARK)


# ---------- 4 个变体 ----------

def render_a1_mid_blues():
    """A1: 中等缝（shrink 0.88）+ 4 块全蓝渐变（含色相变化）"""
    img = make_base()
    face_colors = [
        ((0xB2, 0xCE, 0xEC), (0x8A, 0xAC, 0xD4)),  # 左上 - 最亮
        ((0x98, 0xB6, 0xDE), (0x70, 0x93, 0xC2)),  # 右上 - 中等
        ((0x76, 0x96, 0xC2), (0x52, 0x76, 0xA4)),  # 底尖 - 最深
        ((0x88, 0xA6, 0xD2), (0x62, 0x84, 0xB4)),  # 中心 - 中深
    ]
    draw_tangram_fox(img, scale_factor=1.50, shrink=0.88, face_colors=face_colors)
    return img


def render_a2_strong_contrast():
    """A2: 大缝（shrink 0.85）+ 4 块强对比"""
    img = make_base()
    face_colors = [
        ((0xC0, 0xD8, 0xF0), (0x90, 0xB2, 0xD8)),  # 左上 - 极亮
        ((0x88, 0xA8, 0xD0), (0x60, 0x82, 0xB0)),  # 右上 - 偏深
        ((0x4E, 0x70, 0x9C), (0x36, 0x52, 0x80)),  # 底尖 - 深
        ((0xA2, 0xC0, 0xE4), (0x7A, 0x9C, 0xC8)),  # 中心 - 偏亮
    ]
    draw_tangram_fox(img, scale_factor=1.55, shrink=0.85, face_colors=face_colors)
    return img


def render_a3_coral_center():
    """A3: 中缝 + 中心倒三角换珊瑚（"已插入的插件"高亮）"""
    img = make_base()
    face_colors = [
        ((0xA8, 0xC6, 0xEA), (0x80, 0xA4, 0xD0)),  # 左上 - 浅蓝
        ((0xA8, 0xC6, 0xEA), (0x80, 0xA4, 0xD0)),  # 右上 - 浅蓝（对称）
        ((0x80, 0xA0, 0xC8), (0x5C, 0x80, 0xAC)),  # 底尖 - 中深蓝
        ((0xFF, 0xB0, 0x90), (0xF0, 0x88, 0x68)),  # 中心 - 珊瑚（高亮）
    ]
    draw_tangram_fox(img, scale_factor=1.50, shrink=0.88, face_colors=face_colors)
    return img


def render_a4_two_tone():
    """A4: 双色对角拼图（左上+底尖 = 浅蓝，右上+中心 = 深蓝），最"几何对照"感"""
    img = make_base()
    light = ((0xA8, 0xC6, 0xEA), (0x80, 0xA4, 0xD0))
    deep  = ((0x70, 0x90, 0xB8), (0x48, 0x68, 0x94))
    face_colors = [light, deep, light, deep]
    # 双耳也做对应的明暗对照
    ear_colors = (
        (0x82, 0xA1, 0xCC),  # 左外 - 亮
        (0x5E, 0x80, 0xAC),  # 右外 - 深
        (0xFF, 0xA8, 0x88),  # 左内
        (0xF0, 0x88, 0x68),  # 右内
    )
    draw_tangram_fox(img, scale_factor=1.50, shrink=0.88,
                     face_colors=face_colors, ear_colors=ear_colors)
    return img


def main():
    variants = [
        ("a1-mid-blues", render_a1_mid_blues),
        ("a2-strong-contrast", render_a2_strong_contrast),
        ("a3-coral-center", render_a3_coral_center),
        ("a4-two-tone", render_a4_two_tone),
    ]
    for name, fn in variants:
        img = fn()
        for sz in (128, 256, 512):
            img.resize((sz, sz), Image.LANCZOS).save(OUT / f"icon-n1A-{name}-{sz}.png")
        print(f"{name} rendered")


if __name__ == "__main__":
    main()
