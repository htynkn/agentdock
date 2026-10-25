"""把 CAD 模型网格化成演示动画用的高精度 STL。

运行（复用外壳工程的 uv 环境，里面有 build123d）::

    cd promo
    uv run --project ../hardware/enclosure prep_meshes.py

输出 `promo/assets/*.stl`（git 忽略，可随时重建）：

    base.stl      底座（含 USB-C 开口、蜂鸣器孔、拨杆开口）
    lid.stl       顶盖（3 个键窗 + 旋钮孔/沉台 + 导光孔）
    pcb.stl       整板 3D 模型（世界坐标）
    keycap.stl    1u 矮轴键帽（壳体外壳上没有，是配件，这里参数化补上）
    knob.stl      滚花旋钮（同上，EC11 轴帽）
"""
from __future__ import annotations

import time
from pathlib import Path

from build123d import (
    Align, Axis, Box, Cylinder, Pos, RectangleRounded, Rot, export_stl, extrude,
    fillet, import_step, loft, Plane,
)

HERE = Path(__file__).resolve().parent
ASSETS = HERE / "assets"
ASSETS.mkdir(exist_ok=True)
HW = HERE.parent / "hardware"

TOL, ANG = 0.05, 0.12          # 演示用细分：0.05 mm / 0.12 rad


def log(msg: str) -> None:
    print(msg, flush=True)


def tessellate(step: Path, stl: Path) -> None:
    t0 = time.time()
    shape = import_step(str(step))
    export_stl(shape, str(stl), tolerance=TOL, angular_tolerance=ANG)
    log(f"  {stl.name:14s} {stl.stat().st_size / 1e6:6.2f} MB  "
        f"{time.time() - t0:5.1f}s  <- {step.relative_to(HW)}")


# ---------------------------------------------------------------------------
# 1. 外壳 / PCB：直接来自 CAD
# ---------------------------------------------------------------------------
log("网格化 CAD 模型 ...")
tessellate(HW / "enclosure" / "output" / "Base.step", ASSETS / "base.stl")
tessellate(HW / "enclosure" / "output" / "Lid.step", ASSETS / "lid.stl")
if (HW / "enclosure" / "output" / "PCB_world.stl").exists():
    # PCB 已经由 render.py 网格化过（世界坐标，含所有元器件）
    (ASSETS / "pcb.stl").write_bytes(
        (HW / "enclosure" / "output" / "PCB_world.stl").read_bytes())
    log(f"  pcb.stl        {(ASSETS / 'pcb.stl').stat().st_size / 1e6:6.2f} MB  "
        f"<- enclosure/output/PCB_world.stl")


# ---------------------------------------------------------------------------
# 2. 键帽：1u 矮轴（choc）轮廓
#    底面 17.4、顶面 16.2、高 5.1，顶边 R1.1，底部内腔掏空（看不见但省料）
#    坐标：XY 以键帽中心为原点，Z=0 为键帽底面
# ---------------------------------------------------------------------------
log("参数化键帽 ...")
KEY_W, KEY_TOP_W = 17.4, 16.2
KEY_H, KEY_R = 5.1, 1.9
keycap = loft(
    [
        Plane.XY * RectangleRounded(KEY_W, KEY_W, KEY_R),
        Pos(0, 0, KEY_H) * Plane.XY * RectangleRounded(KEY_TOP_W, KEY_TOP_W, KEY_R * 0.85),
    ]
)
top_edges = keycap.faces().sort_by(Axis.Z)[-1].edges()
keycap = fillet(top_edges, 1.1)
# 底部内腔：给轴体让位（Ø14.2 × 3.8 深），开口在底面
keycap -= Pos(0, 0, 0) * extrude(RectangleRounded(14.2, 14.2, 1.6), 3.8)
keycap -= Pos(0, 0, 0) * Cylinder(4.6, 4.4, align=(Align.CENTER, Align.CENTER, Align.MIN))
export_stl(keycap, str(ASSETS / "keycap.stl"), tolerance=0.03, angular_tolerance=0.1)
log(f"  keycap.stl    {(ASSETS / 'keycap.stl').stat().st_size / 1e3:6.1f} kB")


# ---------------------------------------------------------------------------
# 3. 旋钮：Ø15 滚花帽 + Ø13.2 沉台裙边 + Ø6 通孔（EC11 轴穿过）
#    Z=0 为裙边底面（坐进顶盖 Ø13.6 × 0.8 沉台）
# ---------------------------------------------------------------------------
log("参数化旋钮 ...")
SKIRT_D, SKIRT_H = 13.2, 1.0
BODY_D, BODY_H, KNOB_R = 15.0, 6.6, 0.8

knob = Cylinder(SKIRT_D / 2, SKIRT_H, align=(Align.CENTER, Align.CENTER, Align.MIN))
knob += Pos(0, 0, SKIRT_H) * Cylinder(
    BODY_D / 2, BODY_H, align=(Align.CENTER, Align.CENTER, Align.MIN))
knob = fillet(knob.edges().filter_by_position(Axis.Z, SKIRT_H - 1e-6, SKIRT_H + 1e-6), 0.35)
knob = fillet(knob.faces().sort_by(Axis.Z)[-1].edges(), KNOB_R)
# 侧面滚花：24 条竖向圆弧槽
for i in range(24):
    a = i * 360 / 24
    groove = Pos(BODY_D / 2, 0, SKIRT_H + BODY_H / 2 - 0.2) * Rot(0, 0, a) * Cylinder(
        0.85, BODY_H * 0.72, align=(Align.CENTER, Align.CENTER, Align.CENTER))
    knob -= groove
# 轴孔 + 顶部倒角
knob -= Pos(0, 0, -0.5) * Cylinder(3.05, SKIRT_H + BODY_H + 1.0,
                                  align=(Align.CENTER, Align.CENTER, Align.MIN))
export_stl(knob, str(ASSETS / "knob.stl"), tolerance=0.03, angular_tolerance=0.1)
log(f"  knob.stl      {(ASSETS / 'knob.stl').stat().st_size / 1e3:6.1f} kB")
log("完成")
