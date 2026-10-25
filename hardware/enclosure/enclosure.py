"""AgentDock 外壳 — build123d 参数化建模
=======================================
运行::

    uv run enclosure.py        # 建模 + 导出 STEP/STL + 尺寸自检

设计基准（全部来自 PCB 3D 模型的实测值，见 ``pcb_model.py``）：

* 板框 **91.975 × 42.975 × 1.586**，四角 R2.987，4 × Ø2.7 安装孔
* PCB 局部坐标 → 外壳坐标：``+ (2.087, 2.087, 5.0)``
  即 PCB 底面在外壳 z=5.0，底面四周留 0.5 mm + 1.6 mm 壁厚
* 外壳外形 **96.175 × 47.175**，总高 **20.1**（底座 18.5 + 顶盖 1.6）

两件式结构：

* **Base**（底座）= 底板 + 四壁 + 4 个螺丝凸台 + 4 条纵向筋 + 1 条横向筋 + 侧壁开口
* **Lid**（顶盖）= 1.6 mm 顶板 + 4 根带热熔螺母盲孔的立柱 + 一圈定位止口 + 键位窗口 / 旋钮孔 / 导光孔

打印方向：Base 底面贴床、Lid 顶面贴床，**两件都不需要支撑**。
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path

from build123d import (
    Align, Box, Cone, Cylinder, Pos, Rot, RectangleRounded, export_step,
    export_stl, extrude, fillet,
)

import pcb_model


def log(msg: str):
    """即时输出（CI 日志可能缓冲，必须 flush 才能实时看到进度）。"""
    print(msg, flush=True)


# ===========================================================================
# 1. 参数（单位 mm）
# ===========================================================================
# --- 壳体基本尺寸 ---------------------------------------------------------
WALL = 1.6                    # 壁厚
FLOOR = 1.6                   # 底板厚
CLEAR = 0.5                   # 内腔与 PCB 板边的单边间隙
LID_T = 1.6                   # 顶板厚

# --- Z 向尺寸链 -----------------------------------------------------------
Z_PCB_BOT = 5.0               # PCB 底面高度（= 凸台/筋顶面）
Z_KEYS_CLEAR = 0.46           # 键体顶面与顶盖底面的间隙
Z_LID_BOT = Z_PCB_BOT + 13.5  # 顶盖底面 = 底座壁顶 = 18.50
Z_TOP = Z_LID_BOT + LID_T     # 顶面上表面 = 20.10

# --- 紧固系统：M2.5 × 12 圆头 + 热熔螺母 Ø3.5 × 4.0 ------------------------
# 螺丝从**底面**穿入：头部沉孔 z 0–2.0 → 底座凸台 → PCB → 顶盖立柱里的螺母。
# 四角螺母孔统一抬高到 Z_NUT_BOT（受编码器金属支架限制），
# 立柱下方用 Ø2.7 过孔引流 → 4 根立柱同一高度、同一螺丝长度。
SCREW_LEN = 12                # M2.5 × 12
SCREW_PASS_D = 2.7            # 螺杆过孔 = PCB 安装孔
HEAD_D, HEAD_T = 5.0, 2.0     # 螺丝头沉孔（从底面进）
POST_D = 6.0                  # 凸台 / 立柱直径
NUT_D, NUT_L = 3.8, 4.0       # 螺母盲孔 Ø3.8（对 Ø3.5 螺母留胶层）
NUT_DEPTH = 4.2               # 盲孔总深（含倒角）
NUT_CH = 0.5                  # 孔口 45° 引导倒角

# --- 加强筋 ---------------------------------------------------------------
Z_RIB_TOP = Z_PCB_BOT         # 筋顶面 = PCB 底面
RIB_W = 2.0                   # 筋宽

# --- 顶盖开口 -------------------------------------------------------------
KEY_WIN = 19.0                # 键位窗口边长（容 1u 键帽下沉）
KEY_WIN_R = 2.0
KNOB_HOLE_D = 7.6             # 编码器 M7 套管过孔
KNOB_RECESS_D, KNOB_RECESS_T = 13.0, 0.8   # 旋钮裙边沉台
LED_FUNNEL_R0, LED_FUNNEL_R1 = 4.5, 1.6    # 导光漏斗（下大上小）

# --- 侧壁开口（数值来自 PCB 实测包围盒，见下方 opening 段） --------------

OUT = Path(__file__).resolve().parent / "output"
HERE = Path(__file__).resolve().parent


# ===========================================================================
# 2. 布局：把 PCB 局部坐标换算到外壳坐标
# ===========================================================================
@dataclass
class Layout:
    m: pcb_model.PcbModel

    def __post_init__(self):
        x0, y0, _, x1, y1, _ = self.m.board
        self.dx = WALL + CLEAR - x0        # PCB 局部 X → 外壳 X
        self.dy = WALL + CLEAR - y0        # PCB 局部 Y → 外壳 Y
        self.dz = Z_PCB_BOT                # PCB 局部 Z → 外壳 Z
        self.out_w = (x1 - x0) + 2 * (WALL + CLEAR)
        self.out_d = (y1 - y0) + 2 * (WALL + CLEAR)
        self.cav_r = self.m.corner_radius + CLEAR
        self.out_r = self.cav_r + WALL
        self.z_pcb1 = self.dz + self.m.thickness

    def X(self, x):  return x + self.dx
    def Y(self, y):  return y + self.dy
    def Z(self, z):  return z + self.dz
    def XY(self, x, y): return (x + self.dx, y + self.dy)

    # 内腔边界（外壳坐标）
    @property
    def cav(self):
        return (WALL, WALL, self.out_w - WALL, self.out_d - WALL)


# ===========================================================================
# 3. 造型小工具
# ===========================================================================
def plate(x0, y0, x1, y1, z0, z1, r=0.0):
    """圆角矩形板：XY 范围 [x0,x1]×[y0,y1]，Z 范围 [z0,z1]。"""
    w, d = x1 - x0, y1 - y0
    sk = RectangleRounded(w, d, r) if r > 0 else RectangleRounded(w, d, 0.001)
    return Pos((x0 + x1) / 2, (y0 + y1) / 2, z0) * extrude(sk, z1 - z0)


def cyl(x, y, z0, z1, r):
    return Pos(x, y, z0) * Cylinder(r, z1 - z0,
                                    align=(Align.CENTER, Align.CENTER, Align.MIN))


def cone(x, y, z0, h, r_bot, r_top):
    return Pos(x, y, z0) * Cone(r_bot, r_top, h,
                                align=(Align.CENTER, Align.CENTER, Align.MIN))


def slot_x(x0, x1, y_c, z_c, y_span, z_span, r):
    """在**法线沿 X** 的墙上开圆角矩形槽（从 x0 挖到 x1）。

    草图宽 → 世界 Z，草图高 → 世界 Y（Rot(0,90,0) 把 +Z 拉伸转到 +X）。
    """
    return (Pos(x0, y_c, z_c) * Rot(0, 90, 0)
            * extrude(RectangleRounded(z_span, y_span, r), x1 - x0))


def slot_y(y0, y1, x_c, z_c, x_span, z_span, r):
    """在**法线沿 Y** 的墙上开圆角矩形槽（从 y0 挖到 y1）。

    草图宽 → 世界 X，草图高 → 世界 Z（Rot(-90,0,0) 把 +Z 拉伸转到 +Y）。
    """
    return (Pos(x_c, y0, z_c) * Rot(-90, 0, 0)
            * extrude(RectangleRounded(x_span, z_span, r), y1 - y0))


# 自检：朝向映射写错的话后面所有开口都会偏 → 先断言
_chk = Pos(0, 0, 0) * Rot(-90, 0, 0) * extrude(RectangleRounded(11.5, 3.5, 1.5), 3.0)
assert abs(_chk.bounding_box().max.Y - 3.0) < 1e-6, "Rot(-90,0,0) 映射错误"
assert abs(_chk.bounding_box().max.X - 5.75) < 1e-6, "槽口草图宽高映射错误"


# ===========================================================================
# 4. 底座
# ===========================================================================
def build_base(L: Layout) -> "Part":
    m = L.m
    cx0, cy0, cx1, cy1 = L.cav

    # 4.1 外壳：外形圆角矩形 → 挖内腔
    base = plate(0, 0, L.out_w, L.out_d, 0, Z_LID_BOT, L.out_r)
    base -= plate(cx0, cy0, cx1, cy1, FLOOR, Z_LID_BOT + 1.0, L.cav_r)

    # 4.2 四角螺丝凸台 + Ø2.7 过孔 + 螺丝头沉孔
    for hx, hy, _ in m.mount_holes:
        x, y = L.XY(hx, hy)
        base += cyl(x, y, FLOOR, Z_PCB_BOT, POST_D / 2)
        base -= cyl(x, y, -0.5, Z_PCB_BOT, SCREW_PASS_D / 2)
        base -= cyl(x, y, -0.5, HEAD_T, HEAD_D / 2)

    # 4.3 加强筋：4 条纵向 + 1 条横向，只铺在「板底无元件」的走廊里
    #     板底最低点为销脚 z=-1.91，故筋只出现在这些空档：
    #       X 走廊: 7.0–8.9（USB 与 SW1 之间）/ 30–32 / 50.5–52.5 / 70.5–72.5
    #       Y 走廊: 20.2–22.2（键体 y≤19.23 与编码器 y≥24.15 之间）
    for lx0, lx1 in ((7.0, 8.9), (30.0, 32.0), (50.5, 52.5), (70.5, 72.5)):
        base += plate(L.X(lx0), cy0, L.X(lx1), cy1, FLOOR, Z_RIB_TOP, 0.4)
    base += plate(cx0, L.Y(20.2), L.X(74.5), L.Y(22.2), FLOOR, Z_RIB_TOP, 0.4)

    # 4.4 侧壁开口
    # --- USB-C（-X 端壁）：座体局部 x 0.07–6.87, y 13.18–22.12, z 0.59–4.75
    usb = m.parts["usb"]
    base -= slot_x(-0.3, L.X(usb[3]) - 0.3,
                   L.Y((usb[1] + usb[4]) / 2), L.Z((usb[2] + usb[5]) / 2),
                   y_span=(usb[4] - usb[1]) + 0.6, z_span=3.6, r=1.4)

    # --- 拨动开关拨柄（+Y 端壁）：SK-12E12 拨柄长 ~5mm，可拨 ±20°，
    #     柄尖横向扫过约 ±2.2mm 且会微上翘 → 槽宽 9.0、高度上下各留余量
    lv = m.parts["sw1_lever"]
    base -= slot_y(L.out_d - Y_SLOT_DEPTH, L.out_d + 0.5,
                   L.Y((lv[0] + lv[3]) / 2), L.Z((lv[2] + lv[5]) / 2) + 0.3,
                   x_span=9.0, z_span=(lv[5] - lv[2]) + 1.3, r=1.2)

    # --- 蜂鸣器出声孔（+X 端壁）：4 条竖槽，正对蜂鸣器
    bz = m.parts["buzzer"]
    by0, by1 = bz[1], bz[4]
    for i in range(4):
        yc = L.Y(by0 + (by1 - by0) * (i + 0.5) / 4)
        base -= slot_x(L.out_w - WALL - 0.5, L.out_w + 0.5,
                       yc, L.Z((bz[2] + bz[5]) / 2) + 0.4,
                       y_span=1.5, z_span=3.4, r=0.6)

    # --- ESP32 天线区透气槽（+Y 端壁）：4 条，正对模组后缘
    mod = next((bb for bb in (t[0] for t in m.tall_parts)
                if bb[3] - bb[0] > 11.0 and bb[4] - bb[1] > 19.0), None)
    if mod is not None:
        for i in range(4):
            xc = L.X(mod[0] + (mod[3] - mod[0]) * (i + 0.5) / 4)
            base -= slot_y(L.out_d - Y_SLOT_DEPTH, L.out_d + 0.5,
                           xc, L.Z((mod[2] + mod[5]) / 2) + 0.6,
                           x_span=1.5, z_span=3.2, r=0.6)
    return base


Y_SLOT_DEPTH = WALL + 1.0     # 从 +Y 壁外侧往里挖的深度（穿透 1.6 壁）


# ===========================================================================
# 5. 顶盖
# ===========================================================================
def contact_z_local(m: pcb_model.PcbModel, hx: float, hy: float) -> float:
    """立柱脚能落到的高度（PCB 局部 Z）= 该角半径内最高点 + 0.2。
    无障碍的三个角落在 PCB 顶面上；右上角落在编码器金属支架 + 0.2 上。"""
    return max(m.z_top, m.max_z_near(hx, hy, POST_D / 2 + 0.3) + 0.2)


def nut_bottom_local(m: pcb_model.PcbModel) -> float:
    """四角螺母盲孔底面（PCB 局部 Z，统一高度）= 四角接触点最高者。
    右上角被编码器金属支架抬到 6.09，因此四角螺母孔统一在这一高度；
    其余三根立柱用 Ø2.7 套管从 PCB 顶面延伸上来。"""
    return max(contact_z_local(m, hx, hy)
               for hx, hy, _ in m.mount_holes)


def build_lid(L: Layout) -> "Part":
    m = L.m
    cx0, cy0, cx1, cy1 = L.cav
    z_nut = L.Z(nut_bottom_local(m))       # 四个螺母孔底面（外壳坐标，统一）

    # 5.1 顶板 + 一圈定位止口（插进底座内腔口，单边 0.15 间隙）
    lid = plate(0, 0, L.out_w, L.out_d, Z_LID_BOT, Z_TOP, L.out_r)
    ring_t, ring_h, ring_gap = 1.2, 1.5, 0.15
    lid += plate(cx0 + ring_gap, cy0 + ring_gap, cx1 - ring_gap, cy1 - ring_gap,
                 Z_LID_BOT - ring_h, Z_LID_BOT + 0.1, L.cav_r - ring_gap)
    lid -= plate(cx0 + ring_gap + ring_t, cy0 + ring_gap + ring_t,
                 cx1 - ring_gap - ring_t, cy1 - ring_gap - ring_t,
                 Z_LID_BOT - ring_h - 1.0, Z_LID_BOT + 1.0,
                 max(L.cav_r - ring_gap - ring_t, 0.5))

    # 5.2 四根立柱：柱脚落到各自接触高度（3 根压 PCB，右上角落在
    #     编码器金属支架 +0.2 上）；螺母孔四角统一高度；
    #     柱脚 → 螺母孔底面之间是 Ø2.7 螺杆过孔套管（环壁 1.65）。
    for hx, hy, _ in m.mount_holes:
        x, y = L.XY(hx, hy)
        foot = L.Z(contact_z_local(m, hx, hy))
        lid += cyl(x, y, foot, Z_LID_BOT + 0.2, POST_D / 2)
        lid -= cyl(x, y, foot - 0.5, z_nut, SCREW_PASS_D / 2)     # 螺杆引流孔
        lid -= cone(x, y, z_nut, NUT_CH, (NUT_D + 2 * NUT_CH) / 2, NUT_D / 2)
        lid -= cyl(x, y, z_nut + NUT_CH, z_nut + NUT_DEPTH, NUT_D / 2)

    # 5.3 键位窗口：3 × 19×19，圆心 = 键轴心（容 1u 键帽穿入）
    for k in m.keys:
        x, y = L.XY(*k["center"])
        lid -= plate(x - KEY_WIN / 2, y - KEY_WIN / 2,
                     x + KEY_WIN / 2, y + KEY_WIN / 2,
                     Z_LID_BOT - 0.5, Z_TOP + 0.5, KEY_WIN_R)

    # 5.4 编码器：Ø7.6 过孔 + Ø13 旋钮裙边沉台
    ex, ey = L.XY(*m.encoder["center"])
    lid -= cyl(ex, ey, Z_LID_BOT - 0.5, Z_TOP + 0.5, KNOB_HOLE_D / 2)
    lid -= cyl(ex, ey, Z_TOP - KNOB_RECESS_T, Z_TOP + 0.5, KNOB_RECESS_D / 2)

    # 5.5 WS2812 导光漏斗：Ø9 收集 → Ø3.2 出光
    lx, ly = L.XY((m.parts["led"][0] + m.parts["led"][3]) / 2,
                  (m.parts["led"][1] + m.parts["led"][4]) / 2)
    h = Z_TOP - (Z_LID_BOT - 0.1)
    slope = (LED_FUNNEL_R0 - LED_FUNNEL_R1) / h
    lid -= cone(lx, ly, Z_LID_BOT - 0.1, h + 0.2,
                LED_FUNNEL_R0, LED_FUNNEL_R1 - 0.2 * slope)
    return lid


# ===========================================================================
# 6. 主流程
# ===========================================================================
def build(verbose: bool = True):
    m = pcb_model.load(verbose=verbose)
    L = Layout(m)
    t0 = time.time()
    if verbose:
        log(f"[{time.time() - t0:6.1f}s] build_base ...")
    base = build_base(L)
    if verbose:
        log(f"[{time.time() - t0:6.1f}s] build_base 完成，build_lid ...")
    lid = build_lid(L)
    if verbose:
        log(f"[{time.time() - t0:6.1f}s] build_lid 完成（建模总耗时 {time.time() - t0:.1f}s）")
    return m, L, base, lid


def main():
    t0 = time.time()
    m, L, base, lid = build()
    OUT.mkdir(exist_ok=True)

    exports = [
        ("Base.step", lambda: export_step(base, str(OUT / "Base.step"))),
        ("Lid.step", lambda: export_step(lid, str(OUT / "Lid.step"))),
        ("Base.stl", lambda: export_stl(base, str(OUT / "Base.stl"))),
        ("Lid.stl", lambda: export_stl(lid, str(OUT / "Lid.stl"))),
        ("Base_lowres.stl", lambda: export_stl(base, str(OUT / "Base_lowres.stl"),
                                               tolerance=0.1, angular_tolerance=0.3)),
        ("Lid_lowres.stl", lambda: export_stl(lid, str(OUT / "Lid_lowres.stl"),
                                              tolerance=0.1, angular_tolerance=0.3)),
    ]
    for name, fn in exports:
        t = time.time()
        fn()
        log(f"  导出 {name:16s} {time.time() - t:5.1f}s")
    pcb_model.dump(m, OUT / "pcb_report.json")

    # ---- 自检 ------------------------------------------------------------
    log("\n========== 尺寸自检 ==========")
    ok = True

    def chk(name, got, want, tol=0.01):
        nonlocal ok
        good = abs(got - want) <= tol
        ok &= good
        print(f"  {'✓' if good else '✗'} {name:22s} {got:9.3f}  (设计 {want:9.3f})", flush=True)

    bb = base.bounding_box()
    chk("Base X", bb.size.X, L.out_w)
    chk("Base Y", bb.size.Y, L.out_d)
    chk("Base Z", bb.max.Z, Z_LID_BOT)
    chk("Base 实体数", len(base.solids()), 1)
    bb = lid.bounding_box()
    chk("Lid X", bb.size.X, L.out_w)
    chk("Lid Y", bb.size.Y, L.out_d)
    chk("Lid 最低柱脚", bb.min.Z, L.Z(min(
        contact_z_local(m, hx, hy) for hx, hy, _ in m.mount_holes)))
    chk("Lid 顶面", bb.max.Z, Z_TOP)
    chk("Lid 实体数", len(lid.solids()), 1)

    # PCB 与两件的精确干涉（把壳体逆平移到 PCB 局部坐标后求交）。
    # 整 compound 直接布尔交在 CI 的 2 核 runner 上极慢（曾 >5min 超时被杀），
    # 所以先用包围盒粗筛，只对可能接触壳体的实体逐个求交：
    # 包围盒不相交 => 交集必为空，结果与整compound布尔完全等价。
    back = Pos(-L.dx, -L.dy, -L.dz)
    pcb = pcb_model.import_step(str(m.path))
    pcb_solids = pcb.solids()
    for name, part in (("Base", base), ("Lid", lid)):
        t = time.time()
        log(f"  干涉检查 PCB ∩ {name} ...")
        pb = (back * part).bounding_box()
        v, n_hit = 0.0, 0
        for s in pcb_solids:
            sb = s.bounding_box()
            if (sb.min.X <= pb.max.X and pb.min.X <= sb.max.X
                    and sb.min.Y <= pb.max.Y and pb.min.Y <= sb.max.Y
                    and sb.min.Z <= pb.max.Z and pb.min.Z <= sb.max.Z):
                n_hit += 1
                inter = s & (back * part)
                if inter is not None:
                    v += sum(x.volume for x in inter.solids())
        log(f"    包围盒粗筛: {n_hit}/{len(pcb_solids)} 实体参与布尔")
        good = v < 0.01
        ok &= good
        print(f"  {'✓' if good else '✗'} PCB ∩ {name:17s} {v:9.4f} mm³"
              f"  （{time.time() - t:.0f}s）", flush=True)

    log(f"\n  Base 体积 {base.volume:9.1f} mm³")
    print(f"  Lid  体积 {lid.volume:9.1f} mm³")
    print(f"  外壳外形 {L.out_w:.3f} × {L.out_d:.3f} × {Z_TOP:.2f} mm")
    print(f"  内腔     {L.cav[2] - L.cav[0]:.3f} × {L.cav[3] - L.cav[1]:.3f} mm"
          f" R{L.cav_r:.3f}")
    log("\n导出:")
    for f in sorted(OUT.iterdir()):
        log(f"  {f.name:20s} {f.stat().st_size / 1024:9.1f} KB")
    log(f"\n总耗时 {time.time() - t0:.1f}s")
    if not ok:
        raise SystemExit("✗ 自检未通过")
    log("✓ 全部自检通过")


if __name__ == "__main__":
    main()
