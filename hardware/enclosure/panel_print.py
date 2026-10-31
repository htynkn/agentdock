"""面板印刷图 —— AgentDock「星盘」方案（黑底 / 绿·金线条）
=========================================================
运行::

    uv run panel_print.py     # → output/Panel_print_{front,back}.pdf / .svg
                              #   render/panel_print.png（带尺寸的核对图）
                              #   render/panel_print_pairs.png（正面 / 背面并排）

和 ``Panel.dxf`` 的分工：

* ``output/Panel.dxf`` —— **切割**文件，只有外形 + 5 处开孔（激光按它切）
* ``output/Panel_print_front.pdf`` —— **印刷**文件，正面看的图案（1:1，矢量，mm）
* ``output/Panel_print_back.pdf`` —— 同一张图**镜像**后的版本：亚克力背面印刷用，
  印在背面、从正面看才是对的（耐磨、图案封在 1.5 mm 板子里）

设计约束（本文件自己校验，不满足直接报错退出）：

* 所有线条离 5 处开口边 ≥ ``CLEAR_INK``（印到切口边上会崩边、也难看）
* 所有线条离面板外轮廓 ≥ ``CLEAR_INK``（外轮廓是切割边，必须留边）
* 线条最细 0.14 mm、圆点最小 φ0.36 mm（丝印 / UV 打印的下限）
* 文字全部转成**轮廓路径**（不依赖字体，工厂拿到 PDF 不会变字）

配色：黑底 ``#08090A``、翡翠绿 ``#35D98E``、哑金 ``#C9A94E``。
导光孔周围留一圈**不印**的环（r 2.10–3.35），灯亮时 1.5 mm 板体 + 皇冠 #513
白色半透明背胶就是柔光层，光圈会亮起来。
"""
from __future__ import annotations

import sys
from dataclasses import dataclass, field

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.font_manager import FontProperties
from matplotlib.patches import Circle, FancyBboxPatch, PathPatch
from matplotlib.path import Path as MPath
from matplotlib.textpath import TextPath
from matplotlib.transforms import Affine2D

from panel_drawing import OUT, RENDER, panel_layout, setup_cjk

MM = 1.0 / 25.4          # mm → inch
PT = 2.834645669         # mm → point（matplotlib 线宽单位）

# --- 配色 -----------------------------------------------------------------
INK = "#08090A"          # 底色：近黑（纯黑 UV 墨容易积墨，留一点余量）
GREEN = "#35D98E"        # 翡翠绿：主要线条
GOLD = "#C9A94E"         # 哑金：主结构线 / 字标
GREEN_D = "#1E9B62"      # 深绿：细饰线（层次）

# --- 印刷工艺下限 ---------------------------------------------------------
CLEAR_INK = 0.40         # 印线与开口 / 外轮廓的最小间隙
MIN_LW = 0.14            # 最细线宽
MIN_DOT = 0.36           # 最小圆点直径

# --- 版式（全部 mm，可从这里整体调）--------------------------------------
FRAME_INSET = 0.90       # 外框线中心到面板外轮廓
FRAME_LW = 0.22

WORD_CAP = 2.75          # "AgentDock" 字高
WORD_TRACK = 0.22        # 字距
WORD_X, WORD_BASE = 4.90, 36.55

EYE_R1 = 1.55            # 导光孔金色环半径 = 孔半径 + 1.55
EYE_R2 = 2.65            # 绿色环半径 = 孔半径 + 2.65
EYE_GLOW_OUT = 1.55      # 未印刷光圈外径 = 孔半径 + 1.55（内即孔本身）
EYE_TICKS = 8
LABEL_CAP = 1.15         # "STATUS" 字高
LABEL_TRACK = 0.50

KEY_ARC_R = (11.0, 12.3, 13.6)     # 键窗上方的三道弧
KEY_ARC_LW = (0.30, 0.20, 0.16)
KEY_ARC_SPAN = (46.0, 134.0)       # 只画上方一段（左右会和邻键打架，交给自动裁剪）

PILLAR_OFF = 0.62        # 竖立柱离键窗边的距离
PILLAR_LW = 0.30
PILLAR_TOP = 25.00

DIV_LW = 0.22
DIV_TOP = 22.60

KNOB_R_GOLD = 8.20       # 内金环
KNOB_R_GREEN = 9.00      # 外绿环（离外框 0.78，离开口 2.1）
KNOB_TICKS = 24
ORBIT_R = 11.30          # 旋钮下方的“轨道弧”
ORBIT_SPAN = (250.0, 340.0)   # 只留右下角一段，避开右侧立柱
ORBIT_DOTS = 4

DATUM_Y = 27.20          # 横向刻度基线
DATUM_HALF = 26.00            # 基线半长（对称于三键中心）

# 上半区空档里的八芒星印记（两个正方形叠成，经典罗盘/星盘符号）
SIGIL_C = (56.60, 34.50)
SIGIL_R = 2.40
DATUM_TICK_STEP = 2.50
DATUM_TICK_N = 10             # 中心两侧各 10 格


# ===========================================================================
# 几何工具
# ===========================================================================
def circle_poly(cx, cy, r, step=0.25, a0=0.0, a1=360.0):
    n = max(24, int(abs(np.radians(a1 - a0)) * r / step))
    a = np.radians(np.linspace(a0, a1, n))
    return np.column_stack([cx + r * np.cos(a), cy + r * np.sin(a)])


def rrect_poly(cx, cy, hw, hh, r, step=0.25):
    """圆角矩形（闭合，逆时针）。"""
    r = min(r, hw, hh)
    n = max(4, int(np.pi / 2 * r / step))
    t = np.linspace(0, np.pi / 2, n)
    corners = [(cx + hw - r, cy + hh - r, 0.0),
               (cx - hw + r, cy + hh - r, 90.0),
               (cx - hw + r, cy - hh + r, 180.0),
               (cx + hw - r, cy - hh + r, 270.0)]
    pts = []
    for x, y, deg in corners:
        a = t + np.radians(deg)          # t 已经是弧度，deg 要单独换算
        pts.append(np.column_stack([x + r * np.cos(a), y + r * np.sin(a)]))
    return np.vstack(pts + [pts[0][:1]])


def sdf_circle(p, c, r):
    return np.hypot(p[:, 0] - c[0], p[:, 1] - c[1]) - r


def sdf_rrect(p, c, hw, hh, r):
    q = np.abs(p - np.asarray(c)) - np.array([hw - r, hh - r])
    return (np.hypot(np.maximum(q[:, 0], 0), np.maximum(q[:, 1], 0))
            + np.minimum(np.max(q, axis=1), 0.0) - r)


def text_paths(s, x, y, cap, tracking, prop, valign="baseline"):
    """把字符串转成轮廓路径（逐字排字距），返回 (paths, width)。"""
    cap_unit = TextPath((0, 0), "H", size=1.0, prop=prop).get_extents().height
    size = cap / cap_unit
    glyphs, xcur = [], x
    for ch in s:
        if ch == " ":
            xcur += cap * 0.55 + tracking
            continue
        tp = TextPath((0, 0), ch, size=size, prop=prop)
        b = tp.get_extents()
        glyphs.append(tp.transformed(Affine2D().translate(xcur - b.x0, 0.0)))
        xcur += b.width + tracking
    width = xcur - tracking - x
    if not glyphs:
        return [], width
    bb = MPath.make_compound_path(*glyphs).get_extents()
    dy = y - (bb.y0 if valign == "baseline" else
              (bb.y0 + bb.y1) / 2 if valign == "center" else bb.y1)
    return [g.transformed(Affine2D().translate(0.0, dy)) for g in glyphs], width


# ===========================================================================
# 图形集合（同时保留几何用于间隙自检）
# ===========================================================================
@dataclass
class Item:
    name: str
    kind: str                      # poly | fill
    color: str
    lw: float = 0.0                # 线宽（mm），fill 用半宽代替
    pts: np.ndarray | None = None
    path: MPath | None = None


@dataclass
class Art:
    items: list[Item] = field(default_factory=list)

    def line(self, name, pts, color, lw):
        self.items.append(Item(name, "poly", color, lw, pts=np.asarray(pts, float)))

    def dot(self, name, c, d, color):
        self.items.append(Item(name, "fill", color, d / 2,
                               pts=circle_poly(c[0], c[1], d / 2)))

    def fill(self, name, path, color, half=0.0):
        self.items.append(Item(name, "fill", color, half, path=path))


def _compound(polys, forward_flags):
    """把若干多边形拼成一个 Path；forward=False 的段反向（nonzero 规则挖洞）。"""
    verts, codes = [], []
    for poly, fwd in zip(polys, forward_flags):
        p = np.asarray(poly, float)
        if not fwd:
            p = p[::-1]
        verts.append(p)
        c = np.full(len(p), MPath.LINETO)
        c[0] = MPath.MOVETO
        c[-1] = MPath.CLOSEPOLY
        codes.append(c)
    return MPath(np.vstack(verts), np.concatenate(codes))


def trim_runs(pts, need_fn, need):
    """按间隙要求裁剪折线，返回若干连续段（弧线钻到开口附近时自动断开）。"""
    keep = need_fn(pts) >= need
    runs, cur = [], []
    for pt, ok in zip(pts, keep):
        if ok:
            cur.append(pt)
        elif cur:
            runs.append(np.asarray(cur, float))
            cur = []
    if cur:
        runs.append(np.asarray(cur, float))
    return [r for r in runs if len(r) >= 2]


# ===========================================================================
# 版面
# ===========================================================================
def build_art(G) -> Art:
    W, H, R = G["W"], G["H"], G["R"]
    kw, kwr = G["key_win"], G["key_r"]
    keys = np.asarray(G["keys"], float)
    knob = np.asarray(G["knob"], float)
    led = np.asarray(G["led"], float)
    kr, lr = G["knob_d"] / 2, G["led_d"] / 2

    plain = FontProperties(family="DejaVu Sans")
    bold = FontProperties(family="DejaVu Sans", weight="bold")
    a = Art()

    # --- 0. 黑底（挖掉 5 处开口）+ 导光孔周围留不印的光圈 ----------------
    # nonzero 规则：正向外形 + 各个反向孔 = 有材料的地方才有墨。
    # 导光孔外侧到 r = 孔半径 + 1.55 全部不印 → 灯亮时板体 + 白色半透明背胶
    # 形成柔光圈（这圈是“印不出来”的，不是印白）。
    flood = _compound(
        [rrect_poly(W / 2, H / 2, W / 2, H / 2, R, step=0.5)]
        + [rrect_poly(k[0], k[1], kw / 2, kw / 2, kwr, step=0.15) for k in keys]
        + [circle_poly(knob[0], knob[1], kr, step=0.15),
           circle_poly(led[0], led[1], lr + EYE_GLOW_OUT, step=0.15)],
        [True] + [False] * (len(keys) + 2))
    a.fill("底色（黑）", flood, INK)

    # --- 1. 外圈细金框 --------------------------------------------------
    a.line("外框", rrect_poly(W / 2, H / 2, W / 2 - FRAME_INSET, H / 2 - FRAME_INSET,
                              R - FRAME_INSET), GOLD, FRAME_LW)

    # --- 2. 字标 AgentDock + 绿细线 --------------------------------
    glyphs, wmark = text_paths("AgentDock", WORD_X, WORD_BASE, WORD_CAP,
                              WORD_TRACK, bold)
    for i, g in enumerate(glyphs):
        a.fill(f"字标[{i}]", g, GOLD)
    y_rule = WORD_BASE - 1.40
    x_rule_end = WORD_X + wmark + 0.60
    a.line("字标下划线", [(WORD_X, y_rule), (x_rule_end, y_rule)], GREEN, 0.18)
    dm = (x_rule_end + 1.05, y_rule)
    a.line("字标菱形", [(dm[0], dm[1] + 0.80), (dm[0] + 0.80, dm[1]),
                      (dm[0], dm[1] - 0.80), (dm[0] - 0.80, dm[1]),
                      (dm[0], dm[1] + 0.80)], GOLD, 0.18)

    # --- 3. 导光孔 STATUS 环（灯亮时光圈）-------------------------------
    a.line("导光金环", circle_poly(led[0], led[1], lr + EYE_R1),
           GOLD, 0.22)
    a.line("导光绿环", circle_poly(led[0], led[1], lr + EYE_R2),
           GREEN, 0.18)
    for i in range(EYE_TICKS):
        ang = np.radians(22.5 + i * 360.0 / EYE_TICKS)
        r0, r1 = lr + 1.90, lr + 2.35
        a.line(f"导光刻度{i}",
               [(led[0] + r0 * np.cos(ang), led[1] + r0 * np.sin(ang)),
                (led[0] + r1 * np.cos(ang), led[1] + r1 * np.sin(ang))],
               GOLD if i % 2 == 0 else GREEN_D, 0.16)
    lab, wlab = text_paths("STATUS", led[0] + lr + EYE_R2 + 1.10, led[1],
                           LABEL_CAP, LABEL_TRACK, plain, valign="center")
    for i, g in enumerate(lab):
        a.fill(f"STATUS[{i}]", g, GOLD)

    # --- 4. 键窗上方的三道弧（无文字，纯环）-----------------------------
    # 弧线会扎进键窗圆角和外轮廓，按间隙要求自动裁剪（只保留安全的一段）
    def _need(p):                       # 自身离开口 / 外轮廓的安全距离
        return np.minimum(holes_sdf(G, p), outline_sdf(G, p))

    for ki, (cx, cy) in enumerate(keys):
        a.dot(f"键{ki + 1}顶星", (cx, cy + KEY_ARC_R[-1] + 0.95), 0.55, GOLD)
        for ai, (rad, lw, col) in enumerate(zip(KEY_ARC_R, KEY_ARC_LW,
                                                (GOLD, GREEN, GOLD))):
            arc = circle_poly(cx, cy, rad, a0=KEY_ARC_SPAN[0], a1=KEY_ARC_SPAN[1])
            for run_i, run in enumerate(trim_runs(arc, _need, CLEAR_INK + lw / 2 + 0.01)):
                a.line(f"键{ki + 1}弧{ai + 1}{'' if run_i == 0 else f'_{run_i}'}",
                       run, col, lw)

    # --- 5. 两侧立柱 + 键间分隔线 ---------------------------------------
    for side, x in (("左", keys[0][0] - kw / 2 - PILLAR_OFF),
                    ("右", keys[2][0] + kw / 2 + PILLAR_OFF)):
        a.line(f"{side}立柱", [(x, FRAME_INSET + FRAME_LW / 2), (x, PILLAR_TOP)],
               GOLD, PILLAR_LW)
        dy = PILLAR_TOP + 0.62
        a.line(f"{side}立柱顶菱形", [(x, dy + 0.62), (x + 0.62, dy),
                                (x, dy - 0.62), (x - 0.62, dy), (x, dy + 0.62)],
               GOLD, 0.18)
    for i in range(len(keys) - 1):
        x = (keys[i][0] + keys[i + 1][0]) / 2
        a.line(f"分隔线{i + 1}", [(x, FRAME_INSET + FRAME_LW / 2), (x, DIV_TOP)],
               GREEN, DIV_LW)
        a.dot(f"分隔点{i + 1}", (x, DIV_TOP + 0.60), 0.72, GREEN)

    # --- 6. 旋钮刻度环（星盘）-------------------------------------------
    a.line("旋钮绿环", circle_poly(knob[0], knob[1], KNOB_R_GREEN), GREEN, 0.20)
    a.line("旋钮金环", circle_poly(knob[0], knob[1], KNOB_R_GOLD), GOLD, 0.30)
    for i in range(KNOB_TICKS):
        ang = np.radians(i * 360.0 / KNOB_TICKS)
        cardinal = i % (KNOB_TICKS // 4) == 0
        r0 = KNOB_R_GOLD + 0.17
        r1 = KNOB_R_GREEN - (0.25 if cardinal else 0.53)
        a.line(f"旋钮刻度{i:02d}",
               [(knob[0] + r0 * np.cos(ang), knob[1] + r0 * np.sin(ang)),
                (knob[0] + r1 * np.cos(ang), knob[1] + r1 * np.sin(ang))],
               GREEN if cardinal else GOLD, 0.24 if cardinal else 0.16)

    # --- 7. 旋钮下方的轨道弧 + 光点 -------------------------------------
    a.line("轨道弧", circle_poly(knob[0], knob[1], ORBIT_R,
                              a0=ORBIT_SPAN[0], a1=ORBIT_SPAN[1]), GREEN_D, 0.18)
    for i in range(ORBIT_DOTS):
        ang = np.radians(ORBIT_SPAN[0] + (i + 0.5) * (ORBIT_SPAN[1] - ORBIT_SPAN[0])
                         / ORBIT_DOTS)
        a.dot(f"轨道点{i + 1}",
              (knob[0] + ORBIT_R * np.cos(ang), knob[1] + ORBIT_R * np.sin(ang)),
              0.50, GOLD)

    # --- 8. 横向刻度线（仪表基线）---------------------------------------
    # --- 8b. 八芒星印记 ---------------------------------------------------
    sc, sr = SIGIL_C, SIGIL_R
    for si, rot in enumerate((0.0, 45.0)):
        ca, sa = np.cos(np.radians(rot)), np.sin(np.radians(rot))
        sq = [(sc[0] + sx * ca - sy * sa, sc[1] + sx * sa + sy * ca)
              for sx, sy in ((-sr, -sr), (sr, -sr), (sr, sr), (-sr, sr), (-sr, -sr))]
        a.line(f"八芒星{si + 1}", sq, GOLD if si == 0 else GREEN, 0.16)
    a.dot("印记中心", sc, 0.80, GREEN)
    for k, ang in enumerate((90, 210, 330)):
        r = sr * 1.55
        a.dot(f"印记星点{k + 1}",
              (sc[0] + r * np.cos(np.radians(ang)), sc[1] + r * np.sin(np.radians(ang))),
              0.44, GOLD)

    cxd = (keys[0][0] + keys[-1][0]) / 2
    a.line("刻度基线", [(cxd - DATUM_HALF, DATUM_Y), (cxd + DATUM_HALF, DATUM_Y)],
           GOLD, 0.16)
    for i in range(-DATUM_TICK_N, DATUM_TICK_N + 1):
        x = cxd + i * DATUM_TICK_STEP
        long = i % 4 == 0
        a.line(f"刻度{i + DATUM_TICK_N:02d}",
               [(x, DATUM_Y), (x, DATUM_Y + (1.00 if long else 0.55))],
               GOLD if long else GREEN_D, 0.16)
    a.line("刻度菱形", [(cxd, DATUM_Y + 0.72), (cxd + 0.72, DATUM_Y),
                      (cxd, DATUM_Y - 0.72), (cxd - 0.72, DATUM_Y),
                      (cxd, DATUM_Y + 0.72)], GOLD, 0.20)
    return a


# ===========================================================================
# 间隙自检
# ===========================================================================
def holes_sdf(G, p):
    kw, kwr = G["key_win"], G["key_r"]
    d = np.full(len(p), 1e9)
    for k in G["keys"]:
        d = np.minimum(d, sdf_rrect(p, k, kw / 2, kw / 2, kwr))
    d = np.minimum(d, sdf_circle(p, G["knob"], G["knob_d"] / 2))
    d = np.minimum(d, sdf_circle(p, G["led"], G["led_d"] / 2))
    return d


def outline_sdf(G, p):
    return -sdf_rrect(p, (G["W"] / 2, G["H"] / 2), G["W"] / 2, G["H"] / 2, G["R"])


def check_clearance(G, art: Art) -> tuple[float, list[str]]:
    worst, rows, bad = 1e9, [], 0
    for it in art.items:
        if it.name.startswith("底色"):
            continue
        pts = it.pts if it.pts is not None else np.vstack(
            [np.asarray(pp, float) for pp in it.path.to_polygons()])
        half = it.lw / 2 if it.kind == "poly" else it.lw
        gap_hole = float(np.min(holes_sdf(G, pts))) - half
        gap_edge = float(np.min(outline_sdf(G, pts))) - half
        gap = min(gap_hole, gap_edge)
        worst = min(worst, gap)
        if gap < CLEAR_INK - 1e-9:
            bad += 1
            rows.append(f"    ✗ {it.name:14s} 离{'开口' if gap_hole < gap_edge else '外轮廓'}"
                        f" {gap:5.2f} mm（要求 ≥ {CLEAR_INK:.2f}）")
        if it.lw and it.kind == "poly" and it.lw < MIN_LW - 1e-9:
            rows.append(f"    ✗ {it.name:14s} 线宽 {it.lw:.2f} mm < {MIN_LW}")
            bad += 1
        if it.kind == "fill" and it.name.startswith(("分隔点", "轨道点")) \
                and it.lw * 2 < MIN_DOT - 1e-9:
            rows.append(f"    ✗ {it.name:14s} 点径 {it.lw * 2:.2f} mm < {MIN_DOT}")
            bad += 1
    return (worst if bad == 0 else -1.0), rows


# ===========================================================================
# 渲染
# ===========================================================================
def draw(ax, art: Art, mirror=False):
    for it in art.items:
        if it.kind == "poly":
            ax.plot(it.pts[:, 0], it.pts[:, 1], color=it.color,
                    lw=max(it.lw, MIN_LW) * PT, solid_capstyle="round",
                    solid_joinstyle="round", antialiased=False)
        else:
            path = it.path if it.path is not None else MPath(it.pts)
            ax.add_patch(PathPatch(path, fc=it.color, ec="none", antialiased=False))


def page_figure(G, art, mirror: bool, pad=0.0):
    """1:1 页面图（无页边距，1 数据单位 = 1 mm）。"""
    W, H = G["W"] + 2 * pad, G["H"] + 2 * pad
    fig = plt.figure(figsize=(W * MM, H * MM))
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(-pad, G["W"] + pad)
    ax.set_ylim(-pad, G["H"] + pad)
    ax.set_aspect("equal")
    ax.axis("off")
    draw(ax, art)
    if mirror:                       # 背面印刷：整页水平镜像
        ax.set_xlim(G["W"] + pad, -pad)
    return fig, ax


def export(G, art, stem: str, mirror: bool):
    fig, _ = page_figure(G, art, mirror)
    OUT.mkdir(exist_ok=True)
    fig.savefig(OUT / f"{stem}.pdf", format="pdf")
    fig.savefig(OUT / f"{stem}.svg", format="svg")
    plt.close(fig)
    return OUT / f"{stem}.pdf"


def preview(G, art, worst, rows):
    """带尺寸标注的核对图（正面视图，开口用红色虚线标出）。"""
    setup_cjk()
    W, H, R = G["W"], G["H"], G["R"]
    kw, kwr = G["key_win"], G["key_r"]
    keys, knob, led = G["keys"], G["knob"], G["led"]
    lr = G["led_d"] / 2
    pad_l, pad_r, pad_t, pad_b = 27.0, 27.0, 17.0, 31.0
    fig = plt.figure(figsize=((W + pad_l + pad_r) * MM, (H + pad_t + pad_b) * MM))
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(-pad_l, W + pad_r)
    ax.set_ylim(-pad_b, H + pad_t)
    ax.set_aspect("equal")
    ax.axis("off")
    ax.add_patch(plt.Rectangle((-pad_l, -pad_b), W + pad_l + pad_r,
                               H + pad_t + pad_b, fc="#f4f5f7", ec="none",
                               zorder=-5))
    draw(ax, art)

    # 开口（激光切割线，来自 Panel.dxf）用红色虚线标出，方便核对是否对位
    red = "#c0392b"
    for kx, ky in keys:
        ax.add_patch(FancyBboxPatch((kx - kw / 2, ky - kw / 2), kw, kw,
                                    boxstyle=f"round,pad=0,rounding_size={kwr}",
                                    fc="none", ec=red, lw=1.0, ls=(0, (3, 2))))
    ax.add_patch(Circle(knob, G["knob_d"] / 2, fc="none", ec=red, lw=1.0,
                        ls=(0, (3, 2))))
    ax.add_patch(Circle(led, G["led_d"] / 2, fc="none", ec=red, lw=1.0,
                        ls=(0, (3, 2))))

    green, red_dim = "#0b6b2f", "#c0392b"

    def hdim(x0, x1, y, text, fs=11, out=0.7, color=None):
        col = color or green
        ax.annotate("", (x0, y), (x1, y),
                    arrowprops=dict(arrowstyle="<->", color=col, lw=1.1))
        ax.text((x0 + x1) / 2, y + out, text, ha="center", va="bottom",
                fontsize=fs, color=col, bbox=dict(fc="white", ec="none", pad=0.6))

    def vdim(y0, y1, x, text, fs=11, out=0.9, color=None):
        col = color or green
        ax.annotate("", (x, y0), (x, y1),
                    arrowprops=dict(arrowstyle="<->", color=col, lw=1.1))
        ax.text(x + out, (y0 + y1) / 2, text, ha="left", va="center",
                rotation=90, fontsize=fs, color=col,
                bbox=dict(fc="white", ec="none", pad=0.6))

    hdim(0, W, -8.6, f"{W:.2f}")
    hdim(0, keys[0][0], -3.6, f"{keys[0][0]:.2f}", fs=10)
    hdim(keys[0][0], keys[1][0], -3.6, f"键距 {keys[1][0] - keys[0][0]:.2f}", fs=10)
    hdim(W, knob[0], -3.6, f"{W - knob[0]:.2f}", fs=10)
    vdim(0, H, -7.4, f"{H:.2f}")
    vdim(0, keys[0][1], W + 5.2, f"{keys[0][1]:.2f}", fs=10)
    vdim(0, led[1], W + 10.6, f"{led[1]:.2f}", fs=10)
    vdim(0, knob[1], W + 16.0, f"{knob[1]:.2f}", fs=10)

    ax.text(-pad_l + 2.5, H + pad_t - 5.4,
            "AgentDock 面板印刷图（正面视图）  ·  1:1 / mm  ·  矢量 PDF + SVG  ·  文字已转轮廓",
            fontsize=12.5, color="#111")
    ax.text(-pad_l + 2.5, H + pad_t - 9.8,
            "output/Panel_print_front.pdf（正面印刷）   output/Panel_print_back.pdf（背面印刷，已镜像）"
            "   ·   黑 #08090A + 翡翠绿 #35D98E + 哑金 #C9A94E",
            fontsize=10, color="#555")
    lines = [
        (12.6, f"面板 {W:.2f} × {H:.2f} × 1.5 mm  ·  外圆角 R{R:.2f}  ·  "
               f"红色虚线 = Panel.dxf 的 5 处开口（激光切割线，印刷图里已挖空）", "#123"),
        (16.8, f"键窗 {kw:.1f} × {kw:.1f} R{kwr:.1f}：无文字，只有三道环弧  ·  "
               f"旋钮 φ{G['knob_d']:.1f} 24 格刻度环 + 外轨道  ·  "
               f"导光孔 φ{G['led_d']:.1f}：未印刷光圈 + STATUS 环", "#555"),
        (21.0, f"印线最小间隙 {worst:.2f} mm（要求 ≥ {CLEAR_INK:.2f}）  ·  最细线 0.16 mm  ·  "
               f"导光孔 r{lr:.1f}–{lr + EYE_GLOW_OUT:.2f} 不印，靠 1.5 mm 板 + 皇冠 #513 白胶做柔光", "#555"),
        (25.2, "正面印刷：UV 直印，图案外露（建议加一层哑光保护）  /  背面印刷：镜像印在背面，"
               "图案封在 1.5 mm 板内，耐磨耐擦", "#555"),
    ]
    for y, txt, col in lines:
        ax.text(-pad_l + 2.5, -y, txt, fontsize=10, color=col)

    RENDER.mkdir(exist_ok=True)
    fig.savefig(RENDER / "panel_print.png", dpi=200, bbox_inches="tight",
                facecolor="white")
    plt.close(fig)


def pairs(G, art):
    """正面 / 背面并排核对图。"""
    setup_cjk()
    W, H = G["W"], G["H"]
    fig = plt.figure(figsize=((2 * W + 34) * MM, (H + 16) * MM))
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(-2.0, 2 * W + 32.0)
    ax.set_ylim(-14.0, H + 2.0)
    ax.set_aspect("equal")
    ax.axis("off")
    ax.add_patch(plt.Rectangle((-2.0, -14.0), 2 * W + 34, H + 16,
                               fc="#f4f5f7", ec="none", zorder=-5))
    for i, (title, mirror) in enumerate((("正面印刷（front）", False),
                                        ("背面印刷（back，已镜像）", True))):
        ox = i * (W + 4.0)
        for it in art.items:
            if it.kind == "poly":
                pts = it.pts.copy()
                if mirror:
                    pts[:, 0] = W - pts[:, 0]
                ax.plot(pts[:, 0] + ox, pts[:, 1] + 1.5, color=it.color,
                        lw=max(it.lw, MIN_LW) * PT, solid_capstyle="round",
                        solid_joinstyle="round", antialiased=False)
            else:
                path = it.path if it.path is not None else MPath(it.pts)
                tr = Affine2D().translate(ox, 1.5)
                if mirror:
                    tr = (Affine2D().translate(-W / 2, 0).scale(-1, 1)
                          .translate(W / 2 + ox, 1.5))
                ax.add_patch(PathPatch(path, fc=it.color, ec="none",
                                       transform=tr + ax.transData, antialiased=False))
        ax.text(ox + W / 2, -3.0, title, ha="center", va="top", fontsize=11,
                color="#222")
        ax.text(ox + W / 2, -8.0,
                "印刷面朝观察者，图案即所见" if not mirror
                else "印在亚克力背面：图上左右镜像，从正面看才正确",
                ha="center", va="top", fontsize=9, color="#666")
    fig.savefig(RENDER / "panel_print_pairs.png", dpi=200, bbox_inches="tight",
                facecolor="white")
    plt.close(fig)


# ===========================================================================
def main() -> None:
    G = panel_layout()
    art = build_art(G)
    worst, rows = check_clearance(G, art)
    print("========== 面板印刷图 ==========")
    print(f"  面板 {G['W']:.2f} × {G['H']:.2f} mm  R{G['R']:.2f}")
    print(f"  图元 {len(art.items)} 个   最细线 {min(i.lw for i in art.items if i.lw):.2f} mm")
    if rows:
        print("\n".join(rows))
    good = worst > 0
    print(f"  {'✓' if good else '✗'} 印线最小间隙 {worst:5.2f} mm（要求 ≥ {CLEAR_INK:.2f}）")

    f1 = export(G, art, "Panel_print_front", mirror=False)
    f2 = export(G, art, "Panel_print_back", mirror=True)
    preview(G, art, max(worst, 0), rows)
    pairs(G, art)
    print(f"  → {f1.name}（正面）   {f2.name}（背面镜像）")
    print(f"  → render/panel_print.png  render/panel_print_pairs.png")
    if not good:
        sys.exit(1)


if __name__ == "__main__":
    main()
