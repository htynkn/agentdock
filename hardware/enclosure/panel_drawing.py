"""亚克力面板尺寸图（下单核对用）
=====================================
运行::

    uv run panel_drawing.py      # → render/panel_drawing.png

``output/Panel.dxf`` 是给嘉立创面板的**切割文件**（1:1、mm、只含切割线）；
这张图是给人看的：所有尺寸都从零件本体标出，方便下单时核对外形、圆角、开孔
位置和孔径。数值全部由 ``pcb_report.json`` + ``enclosure.py`` 的参数算出，
不重复硬编码，改参数后重跑即可。

坐标约定：面板**自己的左下角**为原点（不是外壳原点），跟 DXF 里的标注习惯一致。
"""
from __future__ import annotations

import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Circle, FancyBboxPatch

from enclosure import (
    CLEAR, KEY_WIN, KEY_WIN_R, LED_PORT_D0, LED_PORT_SHIFT, KNOB_HOLE_D,
    KNOB_RECESS_D, PANEL_GAP, PANEL_KEY_PAD, PANEL_KNOB_CUT, PANEL_LED_CUT,
    PANEL_T, PANEL_TAPE, RIM_W, WALL,
)

HERE = Path(__file__).resolve().parent
OUT = HERE / "output"
RENDER = HERE / "render"
RENDER.mkdir(exist_ok=True)


def setup_cjk() -> None:
    from matplotlib import font_manager
    for p in ["/System/Library/Fonts/PingFang.ttc",
              "/System/Library/Fonts/Hiragino Sans GB.ttc",
              "/System/Library/Fonts/STHeiti Light.ttc",
              "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
              "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc"]:
        if not Path(p).exists():
            continue
        try:
            font_manager.fontManager.addfont(p)
            name = font_manager.FontProperties(fname=p).get_name()
            plt.rcParams["font.family"] = [name, "DejaVu Sans"]
            return
        except Exception:
            continue


def main() -> None:
    setup_cjk()
    rep = json.loads((OUT / "pcb_report.json").read_text())
    bb = rep["board"]["bbox"]
    dx, dy = WALL + CLEAR - bb[0], WALL + CLEAR - bb[1]     # PCB 局部 → 外壳
    out_w = bb[3] - bb[0] + 2 * (WALL + CLEAR)
    out_d = bb[4] - bb[1] + 2 * (WALL + CLEAR)

    # 面板在外壳坐标里的左下角 = 边框内圈 + 单边间隙
    px0 = py0 = RIM_W + PANEL_GAP
    W = out_w - 2 * px0
    H = out_d - 2 * py0
    R = out_w / 2 - 0  # 占位，下面用真实外圆角
    R = (rep["board"]["corner_radius"] + CLEAR + WALL) - RIM_W - PANEL_GAP

    kw = KEY_WIN + 2 * PANEL_KEY_PAD
    kr = KEY_WIN_R + PANEL_KEY_PAD
    keys = [(k["center"][0] + dx - px0, k["center"][1] + dy - py0) for k in rep["keys"]]
    knob = (rep["encoder"]["center"][0] + dx - px0,
            rep["encoder"]["center"][1] + dy - py0)
    led_bb = rep["parts"]["led"]
    led = ((led_bb[0] + led_bb[3]) / 2 + dx - px0,
           (led_bb[1] + led_bb[4]) / 2 + LED_PORT_SHIFT + dy - py0)

    fig, ax = plt.subplots(figsize=(13.5, 7.6), dpi=160)
    ax.set_aspect("equal")
    ax.axis("off")
    ax.add_patch(FancyBboxPatch((0, 0), W, H,
                                boxstyle=f"round,pad=0,rounding_size={R}",
                                fc="#dbe7f5", ec="#1b4f8a", lw=2.2))
    for x, y in keys:
        ax.add_patch(FancyBboxPatch((x - kw / 2, y - kw / 2), kw, kw,
                                    boxstyle=f"round,pad=0,rounding_size={kr}",
                                    fc="white", ec="#c0392b", lw=1.8))
    ax.add_patch(Circle(knob, PANEL_KNOB_CUT / 2, fc="white", ec="#c0392b", lw=1.8))
    ax.add_patch(Circle(led, PANEL_LED_CUT / 2, fc="white", ec="#c0392b", lw=1.8))

    green = "#0b6b2f"

    def hdim(x0, x1, y, text, fs=10, outside=0.0):
        ax.annotate("", (x0, y), (x1, y),
                    arrowprops=dict(arrowstyle="<->", color=green, lw=1.2))
        ax.text((x0 + x1) / 2, y + outside, text, ha="center",
                va="bottom" if outside >= 0 else "top", fontsize=fs, color=green,
                bbox=dict(fc="white", ec="none", pad=0.8))

    def vdim(y0, y1, x, text, fs=10, outside=0.0):
        ax.annotate("", (x, y0), (x, y1),
                    arrowprops=dict(arrowstyle="<->", color=green, lw=1.2))
        ax.text(x + outside, (y0 + y1) / 2, text, ha="center", va="center",
                rotation=90, fontsize=fs, color=green,
                bbox=dict(fc="white", ec="none", pad=0.8))

    # --- 外形 ----------------------------------------------------------------
    hdim(0, W, -13.0, f"{W:.2f}", fs=11, outside=0.8)
    vdim(0, H, -8.0, f"{H:.2f}", fs=11, outside=-2.2)
    # --- 键窗 ---------------------------------------------------------------
    hdim(0, keys[0][0], -3.0, f"{keys[0][0]:.2f}", fs=9, outside=0.6)
    hdim(keys[0][0] + kw / 2, keys[1][0] - kw / 2, H + 5.0, "键距 20.64", fs=9, outside=0.8)
    hdim(0, keys[0][0] - kw / 2, H + 5.0, f"{keys[0][0] - kw / 2:.2f}", fs=9, outside=0.8)
    vdim(0, keys[0][1], W + 4.0, f"{keys[0][1]:.2f}", fs=9, outside=2.6)
    # --- 旋钮 / 导光 ---------------------------------------------------------
    hdim(W, knob[0], -3.0, f"{W - knob[0]:.2f}", fs=9, outside=0.6)
    vdim(0, knob[1], W + 9.0, f"{knob[1]:.2f}", fs=9, outside=2.6)
    vdim(0, led[1], W + 14.0, f"{led[1]:.2f}", fs=9, outside=2.6)
    hdim(0, led[0], -8.0, f"{led[0]:.2f}", fs=9, outside=0.6)

    ax.text(knob[0], knob[1], f"φ{PANEL_KNOB_CUT}", ha="center", va="center",
            fontsize=10, color="#c0392b")
    ax.text(led[0] + PANEL_LED_CUT / 2 + 1.5, led[1], f"φ{PANEL_LED_CUT}",
            ha="left", va="center", fontsize=10, color="#c0392b")
    ax.text(keys[1][0], keys[1][1], f"{kw:.1f} × {kw:.1f}\nR{kr}", ha="center",
            va="center", fontsize=9.5, color="#c0392b")
    ax.text(0, H + 12.0, f"面板 Panel.dxf  ·  1:1 / mm  ·  layer PANEL（只含切割线）",
            fontsize=10.5, color="#555")
    ax.text(W / 2, -21.5,
            f"亚克力面板 {W:.2f} × {H:.2f} × {PANEL_T:.1f} mm"
            f"（另加 {PANEL_TAPE:.1f} mm 背胶）  ·  外圆角 R{R:.2f}  ·  5 处开孔",
            ha="center", fontsize=12.5, color="#123")
    ax.text(W / 2, -26.0,
            f"顶盖对应开口：键窗 {KEY_WIN:.1f}×{KEY_WIN:.1f} R{KEY_WIN_R:.1f}"
            f"  ·  旋钮沉台 φ{KNOB_RECESS_D:.1f} / 过孔 φ{KNOB_HOLE_D:.1f}"
            f"  ·  导光集光口 φ{LED_PORT_D0:.1f}",
            ha="center", fontsize=10, color="#777")
    ax.set_xlim(-16, W + 26)
    ax.set_ylim(-31, H + 15)
    fig.savefig(RENDER / "panel_drawing.png", bbox_inches="tight", facecolor="white")
    print(f"面板尺寸图 → {RENDER / 'panel_drawing.png'}")
    print(f"  外形 {W:.2f} × {H:.2f} × {PANEL_T:.1f} mm  R{R:.2f}")
    print(f"  键窗 {kw:.1f} × {kw:.1f} R{kr}  @ " +
          " ".join(f"({x:.2f},{y:.2f})" for x, y in keys))
    print(f"  旋钮 φ{PANEL_KNOB_CUT} @ ({knob[0]:.2f},{knob[1]:.2f})"
          f"   导光 φ{PANEL_LED_CUT} @ ({led[0]:.2f},{led[1]:.2f})")


if __name__ == "__main__":
    main()
