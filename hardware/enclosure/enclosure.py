"""AgentDock 外壳 — build123d 参数化建模
=======================================
运行::

    uv run enclosure.py        # 建模 + 导出 STEP/STL + 尺寸自检

设计基准（全部来自 PCB 3D 模型的实测值，见 ``pcb_model.py``）：

* 板框 **91.975 × 42.975 × 1.586**，四角 R2.987，4 × Ø2.7 安装孔
* PCB 局部坐标 → 外壳坐标：``+ (2.587, 2.587, 5.0)``
  即 PCB 底面在外壳 z=5.0，底面四周留 1.0 mm（可左右微调）+ 1.6 mm 壁厚
* 外壳外形 **97.175 × 48.175**，总高 **22.2**
  （底座 18.5 + 顶板 2.0 + 面板凸边框 1.7）

三件式结构：

* **Base**（底座）= 底板 + 四壁 + 4 个 Ø8 螺丝凸台（右侧两只带连接筋）
  + 5 条纵向筋 + 1 条横向筋 + 侧壁开口
  螺丝孔从底面进入：Ø6.0 沉孔 → 45° 导向锥 → Ø3.4 过孔（耐受 ±0.45 的
  PCB 孔位偏差，解决首版「螺丝孔对不齐」）
* **Lid**（顶盖）= 2.0 mm 顶板 + 四周 1.7 mm 凸边框（面板安装口）+ 4 根立柱
  （Ø6，胶粘滚花螺母）+ 3.0 mm 定位止口（立柱处开缺口）+ 键位窗口 / 旋钮孔 /
  阶梯导光孔 + 4 条加强肋（键窗之间的竖肋 + 键窗上方的横向肋），全在顶板底下
* **Panel**（亚克力面板，嘉立创面板下单）= 1.5 mm + 0.2 背胶，嵌在凸边框内圈，
  贴完与边框齐平；开孔（键窗 ×3 / 旋钮 / 导光）全部从外壳参数派生，
  ``output/Panel.dxf`` 可直接下单

在线 3D 打印平台的「模型存在薄壁结构」警告不用猜：``thickness_check.py`` 用射线法
复现同一个判定（局部壁厚 < 0.5 mm），按面积聚类输出包围盒，直接定位到具体参数；
``enclosure.py`` 导出 STL 后会自动跑这道自检。

打印方向：Base 底面贴床、Lid 顶面贴床，**两件都不需要支撑**。
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path

from build123d import (
    Align, Box, Circle, Cone, Cylinder, ExportDXF, Pos, Rectangle,
    RectangleRounded, Rot, export_step, export_stl, extrude, fillet,
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
CLEAR = 1.0                   # 内腔与 PCB 板边的单边间隙
                              # 0.5 → 1.0：首版打印件实测「螺丝孔对不齐，PCB 放上去只
                              # 露半个孔」。原因是 PCB 在腔里只有 ±0.5 的活动量，
                              # 而 Ø2.7 过孔相对 Ø2.5 螺杆只留 ±0.1，再加 FDM 收缩
                              # ≈0.4 %@86 mm ≈0.34 mm，必然错位。放大到 1.0 后：
                              # 装板时可以左右挪，先让 USB-C / 拨柄对齐侧壁开口，
                              # 再用加大的沉孔 + 导向锥吸收残余偏差（见 SCREW_*）。
LID_T = 2.0                   # 顶板厚（1.6 → 2.0，见下方「顶盖加强」）

# --- Z 向尺寸链 -----------------------------------------------------------
Z_PCB_BOT = 5.0               # PCB 底面高度（= 凸台/筋顶面）
Z_KEYS_CLEAR = 0.46           # 键体顶面与顶盖底面的间隙
Z_LID_BOT = Z_PCB_BOT + 13.5  # 顶盖底面 = 底座壁顶 = 18.50
Z_TOP = Z_LID_BOT + LID_T     # 顶板上表面 = 20.50

# --- 顶板凸边框 / 亚克力面板安装口 ---------------------------------------
# 顶部做成一圈 2.6 mm 宽的凸起边框，边框里面就是亚克力面板的位置：面板
# 1.5 mm 厚 + 0.2 mm 背胶，贴上去正好与边框齐平，边框把面板四边包住（既定位
# 又保护边缘，不会磕手）。边框同时是顶板四周的加强筋（见「顶盖加强」）。
RIM_W = 2.6                   # 边框宽度（= 面板到外壳外缘的 inset）
PANEL_T = 1.5                 # 亚克力/PC 面板厚度（嘉立创面板常用 1.5）
PANEL_TAPE = 0.2              # 背胶（3M 双面胶）厚度
RIM_H = PANEL_T + PANEL_TAPE  # 边框高度 = 面板 + 背胶，贴完齐平 = 1.7
Z_RIM_TOP = Z_TOP + RIM_H     # 边框上表面 = 22.20
PANEL_GAP = 0.15               # 面板与边框内壁的单边间隙
PANEL_KEY_PAD = 0.10          # 面板键窗比顶盖键窗单边放大（面板加工公差 ±0.1）
PANEL_KNOB_CUT = 13.8         # 面板旋钮开孔（≥ 顶盖 Ø13.6 旋钮沉台）
PANEL_LED_CUT = 3.6           # 面板导光开孔（≥ 顶盖 Ø3.4 出光孔）

# --- 顶盖加强 -------------------------------------------------------------
# 首版上盖偏软：3 个 19×19 键窗把顶板切成 1.64 mm 宽的窄条，窄条与顶板一样
# 只有 1.6 mm 厚。下面几条都不增加外形高度、也不需要支撑：
#   * LID_T 1.6 → 2.0（弯曲刚度 ∝ t³，+95 %）
#   * 键窗之间的窄条下面加 4 mm 深竖肋 → 窄条变成 6 mm 高的 T 形梁
#   * 键窗上方空档加一条横向肋，把两片区域连起来
#   * 定位止口 LIP_H 1.5 → 3.0，四周变成一圈 3 mm 高的裙边
#   * 顶板四周 2.6 mm 宽的凸边框（即面板安装口）
# 竖肋必须夹在两个键窗的正中间，而且不能伸进键窗（键帽要穿过窗口，按下时还会
# 下沉 ~0.6），所以宽度只能取到 1.0，两侧各留 0.32 安全边。
LID_WEB_W, LID_WEB_H = 1.0, 4.0     # 竖肋：宽 / 从顶板底面往下的深度
LID_WEB_Y1 = 29.0                   # 竖肋的收尾（PCB 局部 Y）
                                    # WS2812 Ø8 集光口下沿在 y = 29.78，让开 0.78
LID_RIB_W, LID_RIB_H = 1.2, 4.0     # 横向肋：宽 / 深度
LID_RIB_Y = 24.5                    # 横向肋的 PCB 局部 Y：键窗上沿 20.93 与编码器
                                    # 套管下沿 28.2 之间的空档，下面没有任何高元件

# --- 紧固系统：M2.5 × 8 圆头 + 胶粘滚花螺母 Ø3.5 × 4.0（通孔螺纹）-------
# 螺丝从**底面**穿入：头部沉孔 z 0–2.2 → 导向锥 2.2–3.5 → 底座凸台 → PCB → 顶盖立柱里的螺母。
# 四角立柱柱脚全部落在 PCB 顶面（z = 6.786），螺母腔口就在柱脚，
# 螺母一推到柱脚就顶住腔底天花板 → 四根柱完全一致，同一螺丝长度。
# （旧版编码器在右上角，金属支架把柱脚顶到 z = 11.29，四柱不等长，
#   螺母腔统一抬高到 11.29 后才够长；2026-10-27 版 PCB 编码器左移 1.53，
#   支架让开了安装孔，这个特殊处理已全部取消。）
# 螺母不是热熔（热压）型：腔体对 Ø3.5 单边留 0.15 胶层，靠 AB 环氧胶固定。
SCREW_LEN = 8                 # M2.5 × 8（M2.5 × 12 现会顶穿螺母腔天花板）
SCREW_D = 2.5                 # 螺杆公称直径（只用于公差链自检）
SCREW_PASS_D = 3.4            # 底座凸台里的螺杆过孔：2.7 → 3.4
                              # 这一圈的松紧决定了 PCB 孔位的容错：Ø2.7 时螺杆被
                              # PCB 安装孔「夹死」，PCB 一偏螺丝就拧不进去；
                              # Ø3.4 单边留 0.45，正好吃掉 PCB 左右微调量
                              # + 打印收缩（0.4 %@86 mm ≈ 0.34）。
HEAD_D, HEAD_T = 6.0, 2.2     # 螺丝头沉孔（从底面进）：M2.5 圆头实际 Ø4.6。
                              # 4.8 → 6.0：Ø4.8 只给头部 ±0.1 的横向余量，等于
                              # 把螺杆位置焊死在凸台轴心；Ø6.0 给到 ±0.7。
                              # 与 Ø8 凸台外圆之间留 1.0 壁（薄壁阈值 0.5 的 2 倍）
HEAD_CONE_H = 1.3             # 沉孔底 → 过孔的 45° 导向锥（Ø6.0 → Ø3.4）：
                              # 螺丝从底面插进来时自动滑向过孔中心
SCREW_HEAD_H = 1.9            # M2.5 圆头实际高度（只用于啮合长度计算）
POST_D = 8.0                  # 底座凸台直径：6.0 → 8.0
                              # 只有加粗才装得下 Ø6.0 沉孔（(8−6)/2 = 1.0 壁），
                              # 同时四根螺丝柱的顶面更大，PCB 压得更稳
LID_POST_D = 6.0              # 顶盖立柱直径（不跟着加粗）：右上角立柱用 Ø8 时，
                              # 柱脚探测半径会碰到编码器金属支架（顶面 z=6.09），
                              # 那根柱子就得到 11.29 才能避开，四根柱脚高度不统一、
                              # 螺母腔跟着抬到 11.49，螺丝根本吃不到牙。保持 Ø6 后
                              # 四根柱脚仍全部落在 PCB 顶面。
NUT_OD = 3.5                  # 滚花铜螺母外径（M2.5 × L4.0，通孔螺纹）
NUT_D, NUT_L = NUT_OD + 0.3, 4.0   # 螺母孔 Ø3.8（对 Ø3.5 螺母留 0.15/边胶层）
NUT_DEPTH = 4.2               # 螺母孔总深（含孔口台阶）
# 螺母孔必须从**柱脚**一路 Ø3.8 通到腔底：原来柱脚到腔口之间留的是
# Ø2.7「螺杆引流孔」，Ø3.5 的螺母根本过不去 → 柱子装不进螺母，螺丝空转。
# 现在腔口就在柱脚（推入行程 0），螺母推到底 = 顶住腔底天花板。
# 孔口引导台阶（位于柱脚，兼作储胶槽）：原为 45° × 0.5 倒角，但倒角锥面与
# Ø6 立柱外圆之间只剩 (6.0 − 4.8)/2 × cos45° ≈ 0.42 mm 的斜壁 → 在线平台判为薄壁。
# 改成 Ø4.4 直角台阶后剩 (6.0 − 4.4)/2 = 0.80 mm，且台阶是水平面
# （打印时是盲孔吊顶上的圆环，Ø4.4 跨距无需支撑）。
# 台阶深度必须 > 0.5：Ø4.4↔Ø3.8 之间那圈 0.3 mm 宽环带的厚度就等于台阶深，
# 取 0.4 时正好被壁厚自检抓到（11.16 mm² @ 0.40），所以取 0.8。
NUT_STEP_D, NUT_STEP_T = 4.4, 0.8   # 孔口引导台阶（位于柱脚，兼作储胶槽）：
                                    # 不用 45° 倒角（锥面与 Ø6 立柱外圆之间只剩
                                    # 0.42 的斜壁 → 判薄壁），直角台阶留 0.8

# --- 加强筋 ---------------------------------------------------------------
Z_RIB_TOP = Z_PCB_BOT         # 筋顶面 = PCB 底面
RIB_W = 2.0                   # 筋宽
RIB_R = 0.0                   # 筋的平面圆角：圆角会让筋端与内壁之间形成
                              # <0.5 mm 的楔形薄壁，直角相交（90°）才干净
GUSSET_W = 2.0                # 右侧凸台 ↔ +X 内壁连接筋的宽度
# 右下角补筋（该区板底全空，原方案漏了）：纵向筋的 PCB 局部 X 范围，
# 上端止于 y = 23.5（编码器本体的板底几何从 y = 24.15 开始，
# 2026-10-27 版编码器左移后该约束不变）。
RIB_EXTRA_X = (81.5, 83.5)
RIB_EXTRA_Y1 = 23.5

# --- 顶盖开口 -------------------------------------------------------------
KEY_WIN = 19.0                # 键位窗口边长（容 1u 键帽下沉）
KEY_WIN_R = 2.0
KNOB_HOLE_D = 8.6             # 编码器 M7 套管过孔：Ø7.0 套管 → 单边 0.8
                              # （原 Ø7.6 只留 0.3/边，打印孔普遍缩水 0.2–0.3，会卡）
KNOB_RECESS_D, KNOB_RECESS_T = 13.6, 0.8   # 旋钮裙边沉台：
                              # 2026-10-27 版编码器左移后，轴心到右上立柱外圆
                              # 8.62 mm → 理论上限 Ø15.6；Ø13.6 按旋钮裙边本身取，
                              # 已不是立柱限制

# --- 编码器按压支撑柱（在 Base 上） ---------------------------------------
# EC11 带按压，按压时力经编码器本体向下顶 PCB。底座在编码器轴心正下方竖
# 一根短柱顶住 PCB 底面，把力传到地板，而不是让 PCB 局部弯曲去拉焊脚。
# 直径取 Ø7（r = 3.5，偏向保守）：STEP 里的 3D 体不包含焊锡堆，插件焊脚
# 底部实际会有锡包，留出余量避免柱子顶到焊点/拉锡。
BASE_ENC_POST_D = 7.0

# --- WS2812 导光孔 --------------------------------------------------------
# 原设计是 Ø9 → Ø3.2 的浅锥漏斗，锥面与顶面夹角仅 ~30°，孔口一圈是刀口
# （局部壁厚 0.08–0.40 mm），在线检测直接报「模型存在薄壁结构」。
# 现改为两级直角台阶沉台：侧面 90°、台阶水平，最薄处是顶板上 0.8 mm 余料。
LED_PORT_SHIFT = 0.0          # 孔轴相对 LED1 本体中心的偏移，PCB 局部坐标
                              # （旧版 LED 在键窗旁，需要让开 1.0；现在 LED1 在
                              #   (35.31, 33.78)，离键窗 9.8 mm，保持同心即可）
LED_PORT_D0, LED_PORT_T0 = 8.0, 0.4        # 内侧第 1 级（集光口）
LED_PORT_D1, LED_PORT_T1 = 5.2, 0.4        # 内侧第 2 级
LED_EXIT_D = 3.4                           # 出光孔（顶板余料 0.8 mm）

# --- 顶盖定位止口 ---------------------------------------------------------
LIP_T, LIP_H, LIP_GAP = 1.2, 3.0, 0.15     # 止口厚 / 高 / 与内腔单边间隙
                              # 高 1.5 → 3.0：止口是顶盖四周的裙边，加深一倍后
                              # 顶板边缘的抗弯刚度显著提高，同时插进底座更深、
                              # 盖上去不容易错缝
LIP_NOTCH = 2.6               # 止口在 4 根立柱周围让开的径向余量：
                              # 立柱外圆与止口内壁离得很近，直接相交会切出刀口状
                              # 薄楔形；notch 半径 = LID_POST_D/2 + LIP_NOTCH = 5.6，
                              # 必须大于「立柱轴心 → 止口外表面」的距离（右侧
                              # 5.19），否则会在立柱旁边残留一条锥形薄壁

# --- Type-C 面板开口 ------------------------------------------------------
# 真实 Type-C 插头是 8.25 × 2.4，插座空腔实测 8.40 × 2.66（几乎无余量），
# 因此面板开口必须以**空腔轴线**为中心对称放大：单边留 0.6，得到 9.6 × 3.86。
# 旧版用座体包围盒中心定位，而包围盒包含向下的固定脚，中心比插头轴线低
# 0.48 mm → 开口上沿只剩 0.19 mm 余量，插头会顶到上方。
USB_WIN_PAD = 0.6             # 面板开口相对空腔的单边余量 mm
USB_WIN_R = 1.4               # 开口圆角

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
    """圆角矩形板：XY 范围 [x0,x1]×[y0,y1]，Z 范围 [z0,z1]。

    ``r=0`` 时必须用真正的矩形（``Rectangle``），不能用 ``RectangleRounded(w, d, 0.001)``：
    那会在每个角上留下 4 条长约 0.0016 mm 的退化边和一堆微米级弧面，
    STEP 导入树脂打印平台后会直接报「模型存在坏边」（SLA 校验比 FDM 严）。
    """
    w, d = x1 - x0, y1 - y0
    sk = RectangleRounded(w, d, r) if r > 0 else Rectangle(w, d)
    return Pos((x0 + x1) / 2, (y0 + y1) / 2, z0) * extrude(sk, z1 - z0)


def cyl(x, y, z0, z1, r):
    return Pos(x, y, z0) * Cylinder(r, z1 - z0,
                                    align=(Align.CENTER, Align.CENTER, Align.MIN))


def cone(x, y, z0, z1, r0, r1):
    """截锥：z0 处半径 r0，z1 处半径 r1（用于螺丝沉孔→过孔的导向锥）。"""
    return Pos(x, y, z0) * Cone(r0, r1, z1 - z0,
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

    # 4.2 四角螺丝凸台
    for hx, hy, _ in m.mount_holes:
        x, y = L.XY(hx, hy)
        base += cyl(x, y, FLOOR, Z_PCB_BOT, POST_D / 2)

    # 4.2b 悬空凸台 ↔ 内壁的连接筋
    #      PCB 安装孔左右不对称：左孔距板边 1.64（Ø6 凸台直接并进左壁），
    #      右孔距板边 4.34 → 凸台外缘离 +X 内壁还有 1.84 mm 悬空，两侧外观
    #      与刚度都不一致。这里给「没贴到壁」的凸台补一条从轴心铺到内壁、
    #      宽 GUSSET_W 的筋（高度与其它筋同高，不进入 PCB 底面以上）。
    for hx, hy, _ in m.mount_holes:
        x, y = L.XY(hx, hy)
        if 0.05 < cx1 - (x + POST_D / 2) <= 3.0:
            base += plate(x, y - GUSSET_W / 2, cx1, y + GUSSET_W / 2,
                          FLOOR, Z_RIB_TOP, RIB_R)

    # 4.2c 螺丝过孔 + 头部沉孔 + 导向锥 —— 必须在加完筋之后切：
    #      筋从凸台轴心铺到内壁，会覆盖过孔/沉孔所在的区域；先切后加筋会把
    #      右侧两个螺丝的过孔和沉孔重新填掉一半，螺丝就装不进去。
    #      从底面看依次是：Ø6.0 沉孔（2.2 深）→ 45° 导向锥（1.3 高）→ Ø3.4 过孔。
    for hx, hy, _ in m.mount_holes:
        x, y = L.XY(hx, hy)
        base -= cyl(x, y, -0.5, Z_PCB_BOT, SCREW_PASS_D / 2)
        base -= cyl(x, y, -0.5, HEAD_T, HEAD_D / 2)
        base -= cone(x, y, HEAD_T, HEAD_T + HEAD_CONE_H,
                     HEAD_D / 2, SCREW_PASS_D / 2)

    # 4.3 加强筋：5 条纵向 + 1 条横向，只铺在「板底无元件」的走廊里
    #     板底最低点为销脚 z=-1.91，故筋只出现在这些空档：
    #       X 走廊: 7.0–8.9（USB 与 SW1 之间）/ 30–32 / 50.5–52.5 / 70.5–72.5
    #                / 81.5–83.5（右下角补筋，上端止于 y=23.5 让开编码器本体）
    #       Y 走廊: 20.2–22.2（键体 y≤19.23 与编码器 y≥24.15 之间）
    for lx0, lx1 in ((7.0, 8.9), (30.0, 32.0), (50.5, 52.5), (70.5, 72.5),
                     RIB_EXTRA_X):
        y1 = L.Y(RIB_EXTRA_Y1) if (lx0, lx1) == RIB_EXTRA_X else cy1
        base += plate(L.X(lx0), cy0, L.X(lx1), y1, FLOOR, Z_RIB_TOP, RIB_R)
    # 横向筋铺满到右内壁：y 20.2–22.2 这条走廊底面整条都是空的，
    # 原来只铺到 x=74.5，导致右侧 20 mm 宽的地板无筋。
    base += plate(cx0, L.Y(20.2), cx1, L.Y(22.2), FLOOR, Z_RIB_TOP, RIB_R)

    # 4.3b 编码器按压支撑柱：在编码器轴心正下方，从地板顶到 PCB 底面。
    #      EC11 带按压时力经编码器本体顶 PCB，这根柱子顶住 PCB 底面，
    #      把力直接传给地板，避免 PCB 局部下弯拉扯焊脚。
    base += cyl(L.X(m.encoder["center"][0]), L.Y(m.encoder["center"][1]),
                FLOOR, Z_PCB_BOT, BASE_ENC_POST_D / 2)

    # 4.4 侧壁开口
    # --- USB-C（-X 端壁）：以「插头空腔」定位，而不是座体包围盒
    usb = m.parts["usb"]
    cv = m.parts["usb_cavity"]
    base -= slot_x(-0.3, L.X(usb[3]) - 0.3,
                   L.Y((cv[1] + cv[4]) / 2), L.Z((cv[2] + cv[5]) / 2),
                   y_span=(cv[4] - cv[1]) + 2 * USB_WIN_PAD,
                   z_span=(cv[5] - cv[2]) + 2 * USB_WIN_PAD, r=USB_WIN_R)

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

    2026-10-27 版 PCB：编码器左移后，四个角的探针半径内最高点都是 PCB
    顶面 1.586（编码器金属支架已让开右上角），四根柱脚全部落在 z=1.786。
    仍用 max_z_near 实测而不写死数值：以后 PCB 再把高元件挪到某个角下面，
    对应立柱会自动缩短。"""
    return max(m.z_top, m.max_z_near(hx, hy, LID_POST_D / 2 + 0.3) + 0.2)


def nut_bottom_local(m: pcb_model.PcbModel) -> float:
    """四角螺母盲孔底面（PCB 局部 Z，统一高度）= 四角接触点最高者。

    本版四角接触点相同（1.786）→ 螺母腔口就在柱脚，螺母推到底即就位。
    保留 max() 是为了一个角被高元件顶住时仍能用同一长度螺丝装四颗螺母。"""
    return max(contact_z_local(m, hx, hy)
               for hx, hy, _ in m.mount_holes)


def build_lid(L: Layout) -> "Part":
    m = L.m
    cx0, cy0, cx1, cy1 = L.cav
    z_nut = L.Z(nut_bottom_local(m))       # 四个螺母孔底面（外壳坐标，统一）

    # 5.1 顶板 + 四周凸边框（面板安装口）+ 一圈定位止口
    #     凸边框：顶面外圈抬高 RIM_H = 面板 + 背胶，面板贴进去后与边框齐平，
    #     边框同时是顶板四周的一圈加强梁。边框内壁就是面板的定位尺寸。
    #     止口在 4 根立柱周围开缺口：止口内壁离立柱外圆很近，直接相交会
    #     切出刀口状薄楔形；开缺口后止口只在四面直壁中段起定位作用。
    lid = plate(0, 0, L.out_w, L.out_d, Z_LID_BOT, Z_TOP, L.out_r)
    rim_sk = (RectangleRounded(L.out_w, L.out_d, L.out_r)
              - RectangleRounded(L.out_w - 2 * RIM_W, L.out_d - 2 * RIM_W,
                                 max(L.out_r - RIM_W, 0.5)))
    # 往下多长 0.5 是为了和顶板重叠，避免共面布尔
    lid += Pos(L.out_w / 2, L.out_d / 2, Z_TOP - 0.5) * extrude(rim_sk, RIM_H + 0.5)

    r_out = L.cav_r - LIP_GAP
    lip = plate(cx0 + LIP_GAP, cy0 + LIP_GAP, cx1 - LIP_GAP, cy1 - LIP_GAP,
                Z_LID_BOT - LIP_H, Z_LID_BOT + 0.1, r_out)
    lip -= plate(cx0 + LIP_GAP + LIP_T, cy0 + LIP_GAP + LIP_T,
                 cx1 - LIP_GAP - LIP_T, cy1 - LIP_GAP - LIP_T,
                 Z_LID_BOT - LIP_H - 1.0, Z_LID_BOT + 1.0,
                 max(r_out - LIP_T, 0.5))
    for hx, hy, _ in m.mount_holes:
        x, y = L.XY(hx, hy)
        lip -= cyl(x, y, Z_LID_BOT - LIP_H - 1.0, Z_LID_BOT + 1.0,
                   LID_POST_D / 2 + LIP_NOTCH)
    lid += lip

    # 5.2 四根立柱：柱脚全部落到 PCB 顶面 + 0.2（z = 6.786，编码器已让开
    #     右上角）；螺母腔口就在柱脚（Ø3.8 × 4.2），螺母推到底（0 行程）即顶住
    #     腔底；孔口 Ø5.0 × 0.8 台阶兼当导入喇叭口 / 储胶槽。
    #     四根柱子因此完全一致：同一长度螺丝、同一种螺母。
    for hx, hy, _ in m.mount_holes:
        x, y = L.XY(hx, hy)
        foot = L.Z(contact_z_local(m, hx, hy))
        lid += cyl(x, y, foot, Z_LID_BOT + 0.2, LID_POST_D / 2)
        lid -= cyl(x, y, foot - 0.5, z_nut + NUT_DEPTH, NUT_D / 2)   # 螺母孔
        lid -= cyl(x, y, foot - 0.5, foot + NUT_STEP_T,               # 孔口台阶（柱脚处）
                   NUT_STEP_D / 2)

    # 5.3 键位窗口：3 × 19×19，圆心 = 键轴心（容 1u 键帽穿入）
    for k in m.keys:
        x, y = L.XY(*k["center"])
        lid -= plate(x - KEY_WIN / 2, y - KEY_WIN / 2,
                     x + KEY_WIN / 2, y + KEY_WIN / 2,
                     Z_LID_BOT - 0.5, Z_TOP + 0.5, KEY_WIN_R)

    # 5.4 编码器：Ø8.6 过孔 + Ø13.6 旋钮裙边沉台
    #     （按压支撑在 Base 的 BASE_ENC_POST_D 柱子上，不在盖子这边）
    ex, ey = L.XY(*m.encoder["center"])
    lid -= cyl(ex, ey, Z_LID_BOT - 0.5, Z_TOP + 0.5, KNOB_HOLE_D / 2)
    lid -= cyl(ex, ey, Z_TOP - KNOB_RECESS_T, Z_TOP + 0.5, KNOB_RECESS_D / 2)

    # 5.5 WS2812 导光孔：两级阶梯沉台（内侧集光）+ Ø3.4 出光孔
    #     孔轴 = LED1 封装体中心（pcb_model 按 5.4×5.0×1.57 的封装体识别，
    #     不会误取 4.5 mm 的功率电感）。LED 本体 5.4×5.0 完全落在 Ø8 集光口内。
    lx, ly = L.XY((m.parts["led"][0] + m.parts["led"][3]) / 2,
                  (m.parts["led"][1] + m.parts["led"][4]) / 2 + LED_PORT_SHIFT)
    z_in = Z_LID_BOT - 0.1
    lid -= cyl(lx, ly, z_in, z_in + 0.1 + LED_PORT_T0, LED_PORT_D0 / 2)
    lid -= cyl(lx, ly, z_in, z_in + 0.1 + LED_PORT_T0 + LED_PORT_T1,
               LED_PORT_D1 / 2)
    lid -= cyl(lx, ly, z_in, Z_TOP + 0.5, LED_EXIT_D / 2)

    # 5.6 顶盖加强肋（都在顶板底下，上面看不见）
    #     竖肋：夹在两个键窗正中间的那条 1.64 mm 窄条下面。肋只有 1.2 宽，
    #     不碰到键窗（键帽要穿过窗口，按下时还会下沉 ~0.6），却把窄条从
    #     2.0 mm 平板变成 6 mm 高的 T 形梁——上盖“发软”的主要根源就在这里。
    #     横向肋：键窗上方那条没有元件的空档，把左右两片区域连成整体。
    z_web_bot = Z_LID_BOT - LID_WEB_H
    z_rib_bot = Z_LID_BOT - LID_RIB_H
    kc = sorted(k["center"][0] for k in m.keys)
    for x_l in ((kc[0] + kc[1]) / 2, (kc[1] + kc[2]) / 2):
        lid += plate(L.X(x_l - LID_WEB_W / 2), cy0 + LIP_GAP,
                     L.X(x_l + LID_WEB_W / 2), L.Y(LID_WEB_Y1),
                     z_web_bot, Z_LID_BOT + 0.1)
    lid += plate(cx0 + LIP_GAP, L.Y(LID_RIB_Y - LID_RIB_W / 2),
                 cx1 - LIP_GAP, L.Y(LID_RIB_Y + LID_RIB_W / 2),
                 z_rib_bot, Z_LID_BOT + 0.1)
    return lid


# ===========================================================================
# 5b. 亚克力面板（嘉立创面板）
# ===========================================================================
# 面板贴在顶板凸边框的内圈里：厚度 PANEL_T + 背胶 PANEL_TAPE，四周单边
# PANEL_GAP。开孔统一从外壳的参数派生，所以面板 DXF 永远和顶盖一致：
#   * 3 个键窗 = 顶盖键窗单边放大 PANEL_KEY_PAD（吸收面板加工公差）
#   * 旋钮 Ø13.8（露出顶盖 Ø13.6 旋钮沉台，旋钮裙边仍能沉下去）
#   * 导光孔 Ø3.6（对准顶盖 Ø3.4 出光孔）
def panel_sketch(L: Layout):
    w = L.out_w - 2 * (RIM_W + PANEL_GAP)
    h = L.out_d - 2 * (RIM_W + PANEL_GAP)
    r = max(L.out_r - RIM_W - PANEL_GAP, 0.5)
    sk = Pos(L.out_w / 2, L.out_d / 2) * RectangleRounded(w, h, r)
    for k in L.m.keys:
        x, y = L.XY(*k["center"])
        a = KEY_WIN + 2 * PANEL_KEY_PAD
        sk -= Pos(x, y) * RectangleRounded(a, a, KEY_WIN_R + PANEL_KEY_PAD)
    ex, ey = L.XY(*L.m.encoder["center"])
    sk -= Pos(ex, ey) * Circle(PANEL_KNOB_CUT / 2)
    led = L.m.parts["led"]
    lx, ly = L.XY((led[0] + led[3]) / 2, (led[1] + led[4]) / 2 + LED_PORT_SHIFT)
    sk -= Pos(lx, ly) * Circle(PANEL_LED_CUT / 2)
    return sk


def build_panel(L: Layout) -> "Part":
    """面板实体（只用于渲染 / 干涉校验；实际制造看 panel.dxf）。"""
    return Pos(0, 0, Z_TOP + PANEL_TAPE) * extrude(panel_sketch(L), PANEL_T)


def export_panel_dxf(L: Layout, path: Path) -> None:
    """导出面板 2D 轮廓 + 开孔，直插嘉立创面板下单（DXF，单位 mm）。"""
    exp = ExportDXF()
    exp.add_shape(list(panel_sketch(L).faces()), layer="PANEL")
    exp.write(str(path))


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
        log(f"[{time.time() - t0:6.1f}s] build_lid 完成，build_panel ...")
    panel = build_panel(L)
    if verbose:
        log(f"[{time.time() - t0:6.1f}s] build_panel 完成（建模总耗时 {time.time() - t0:.1f}s）")
    return m, L, base, lid, panel


def main():
    t0 = time.time()
    m, L, base, lid, panel = build()
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
        ("Panel.stl", lambda: export_stl(panel, str(OUT / "Panel.stl"),
                                         tolerance=0.05, angular_tolerance=0.2)),
        ("Panel_lowres.stl", lambda: export_stl(panel, str(OUT / "Panel_lowres.stl"),
                                                tolerance=0.1, angular_tolerance=0.3)),
        ("Panel.dxf", lambda: export_panel_dxf(L, OUT / "Panel.dxf")),
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
    chk("Lid 顶面(边框)", bb.max.Z, Z_RIM_TOP)
    chk("Lid 实体数", len(lid.solids()), 1)

    # 亚克力面板：尺寸、贴上去是否与边框齐平、能否落在边框内圈
    pbb = panel.bounding_box()
    chk("Panel X", pbb.size.X, L.out_w - 2 * (RIM_W + PANEL_GAP))
    chk("Panel Y", pbb.size.Y, L.out_d - 2 * (RIM_W + PANEL_GAP))
    chk("Panel 顶面", pbb.max.Z, Z_RIM_TOP)          # 面板 + 背胶 ⇒ 与边框齐平
    chk("Panel 实体数", len(panel.solids()), 1)
    v_panel = (panel & lid).volume                   # 面板与顶盖必须不相交
    good = v_panel < 0.01
    ok &= good
    print(f"  {'✓' if good else '✗'} Lid ∩ Panel          {v_panel:9.4f} mm³"
          f"  （面板嵌在边框内圈，直径间隙 {2 * PANEL_GAP:.2f} mm）", flush=True)

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

    # ---- 螺丝通道自检：过孔 / 头部沉孔必须完全空 ---------------------------
    # 右侧两条筋从凸台轴心铺到内壁，一定会跨过螺丝特征所在的区域；只要切孔
    # 顺序（或后续加料）写错，筋就会把孔填掉一半。这里用比孔小 0.2 的探针
    # 去求交，余料必须为 0。
    log("\n========== 螺丝通道自检 ==========")
    for i, (hx, hy, _) in enumerate(m.mount_holes, 1):
        x, y = L.XY(hx, hy)
        v_head = (cyl(x, y, 0.0, HEAD_T - 0.02, HEAD_D / 2 - 0.1) & base).volume
        v_pass = (cyl(x, y, 0.05, Z_PCB_BOT - 0.05,
                      SCREW_PASS_D / 2 - 0.1) & base).volume
        good = v_head < 0.01 and v_pass < 0.01
        ok &= good
        print(f"  {'✓' if good else '✗'} 螺丝 #{i} @({x:6.2f},{y:6.2f})  "
              f"沉孔余料 {v_head:6.3f} mm³   过孔余料 {v_pass:6.3f} mm³",
              flush=True)

    # ---- 螺母装配自检：Ø3.5 螺母必须能从柱脚推到腔底 -----------------------
    # 只查「孔是否通空」查不出这个错：旧版柱脚到腔口之间是 Ø2.7「引流孔」，
    # 孔确实通，但 Ø3.5 的螺母过不去，柱子实际装不进螺母。
    # 这里直接扫一遍螺母的行程：用比螺母外径小 0.1 的圆柱从柱脚扫到腔底求交，
    # 余料必须为 0，否则报错。行程 = z_seat − foot − NUT_L（即螺母底面推过
    # 柱脚的深度；本版 0.2 mm，几乎与柱脚齐平）。
    log("\n========== 螺母装配自检 ==========")
    z_seat = L.Z(nut_bottom_local(m)) + NUT_DEPTH    # 腔底天花板 = 螺母顶面
    z_nut_bot = z_seat - NUT_L                       # 螺母座到位后的底面
    z_tip = HEAD_T + SCREW_LEN                       # 螺丝尖端（头部坐在沉孔底）
    for i, (hx, hy, _) in enumerate(m.mount_holes, 1):
        x, y = L.XY(hx, hy)
        foot = L.Z(contact_z_local(m, hx, hy))
        v = (cyl(x, y, foot - 1.0, z_seat - 0.02,
                 NUT_OD / 2 - 0.05) & lid).volume
        engage = z_tip - z_nut_bot
        good = v < 0.01 and engage >= 2.0 and z_tip <= z_seat - 0.5
        ok &= good
        print(f"  {'✓' if good else '✗'} 螺母 #{i} @({x:6.2f},{y:6.2f})  "
              f"柱脚 z={foot:5.2f}  推入 {z_seat - foot - NUT_L:4.1f} mm  "
              f"余料 {v:6.3f} mm³  啮合 {engage:4.2f} mm", flush=True)
    print(f"     螺母占 z {z_nut_bot:.2f}–{z_seat:.2f}，螺丝尖端 z {z_tip:.2f}"
          f"（尖端留空 {z_seat - z_tip:.2f} mm，不顶底）", flush=True)

    # ---- 装配公差预算：首次打印件「螺丝孔对不齐」的直接原因 -----------------
    # 拧螺丝时，螺杆的横向位置被**链条上最紧的一环**钉死：PCB 安装孔 Ø2.7 对
    # Ø2.5 螺杆只留 0.1，所以螺杆实际上跟着 PCB 孔走；PCB 孔位相对凸台的偏差
    # （PCB 在腔里的位置 + 打印收缩）必须被底座过孔 / 沉孔 / 螺母腔吃掉。
    log("\n========== 装配公差预算 ==========")
    slack_pass = (SCREW_PASS_D - SCREW_D) / 2
    slack_head = (HEAD_D - 4.6) / 2
    slack_nut = (NUT_D - SCREW_D) / 2
    shrink = 0.004 * 86.0                       # FDM 0.4 % × 螺孔间距 86 mm
    budget_lines = [
        ("底座过孔 Ø%.1f" % SCREW_PASS_D, slack_pass, "吸收 PCB 孔位偏差"),
        ("沉孔 Ø%.1f" % HEAD_D, slack_head, "螺丝头横向余量"),
        ("螺母腔 Ø%.1f" % NUT_D, slack_nut, "螺杆进螺母的余量"),
    ]
    for name, s, why in budget_lines:
        print(f"     {name:12s} 单边 {s:4.2f} mm   {why}", flush=True)
    print(f"     板侧只留 {0.1:.2f} mm（Ø2.7 孔 / Ø2.5 螺杆）→ 螺杆跟着 PCB 孔走", flush=True)
    print(f"     打印收缩估算 0.4 %@86 mm ≈ {shrink:.2f} mm（对称收缩时单侧 ≈ {shrink / 2:.2f}）",
          flush=True)
    good = slack_pass >= 0.35 and slack_head >= 0.35 and slack_nut >= 0.35
    ok &= good
    print(f"  {'✓' if good else '✗'} 允许 PCB 孔位偏差 ±{slack_pass:.2f} mm"
          f"（要求 ≥ 0.35，原版 Ø2.7 只有 0.10）", flush=True)

    # ---- 顶盖加强肋自检：肋不能碰到键窗 / 旋钮孔 / 导光孔 -------------------
    # 肋全部在顶板下面，所以只跟“会钻到顶板下面”的东西冲突：键帽穿过键窗时
    # 按下会下沉，旋钮套管、导光锥都在肋的高度范围内。这里直接算 XY 平面上的
    # 最小间距，要求 ≥ 0.15 mm。
    log("\n========== 顶盖加强肋自检 ==========")
    cx0, cy0, cx1, cy1 = L.cav
    led_bb = m.parts["led"]
    lx, ly = L.XY((led_bb[0] + led_bb[3]) / 2,
                  (led_bb[1] + led_bb[4]) / 2 + LED_PORT_SHIFT)
    kxs = sorted(k["center"][0] for k in m.keys)
    ribs = [(f"竖肋{i + 1}", L.X(x_l - LID_WEB_W / 2), cy0 + LIP_GAP,
             L.X(x_l + LID_WEB_W / 2), L.Y(LID_WEB_Y1), LID_WEB_H)
            for i, x_l in enumerate(((kxs[0] + kxs[1]) / 2, (kxs[1] + kxs[2]) / 2))]
    ribs.append(("横向肋", cx0 + LIP_GAP, L.Y(LID_RIB_Y - LID_RIB_W / 2),
                 cx1 - LIP_GAP, L.Y(LID_RIB_Y + LID_RIB_W / 2), LID_RIB_H))
    obstacles = []
    for k in m.keys:
        x, y = L.XY(*k["center"])
        obstacles.append((f"键窗@{x:.0f}", (x - KEY_WIN / 2, y - KEY_WIN / 2,
                                            x + KEY_WIN / 2, y + KEY_WIN / 2)))
    ex, ey = L.XY(*m.encoder["center"])
    obstacles.append(("旋钮孔", (ex, ey, KNOB_HOLE_D / 2)))
    obstacles.append(("导光孔", (lx, ly, LED_PORT_D0 / 2)))

    def rect_gap(r, ob):
        """矩形到障碍物的距离（len 为 3 = 圆，4 = 矩形），相交返回 -1。"""
        if len(ob) == 3:
            px, py, rad = ob
            qx = min(max(px, r[0]), r[2])
            qy = min(max(py, r[1]), r[3])
            return ((px - qx) ** 2 + (py - qy) ** 2) ** 0.5 - rad
        dx = max(ob[0] - r[2], r[0] - ob[2], 0.0)
        dy = max(ob[1] - r[3], r[1] - ob[3], 0.0)
        return -1.0 if dx == 0.0 and dy == 0.0 else (dx * dx + dy * dy) ** 0.5

    for name, x0, y0, x1, y1, h in ribs:
        g, worst = 1e9, ""
        for oname, ob in obstacles:
            d = rect_gap((x0, y0, x1, y1), ob)
            if d < g:
                g, worst = d, oname
        good = g >= 0.15
        ok &= good
        print(f"  {'✓' if good else '✗'} {name:6s} X {x0:6.2f}…{x1:6.2f}  "
              f"Y {y0:6.2f}…{y1:6.2f}  深 {h:.1f} mm  "
              f"最小间距 {g:5.2f} mm（{worst}）", flush=True)

    # ---- 亚克力面板规格（嘉立创面板下单 + 自检：开孔必须对得上顶盖）---------
    log("\n========== 亚克力面板（output/Panel.dxf）==========")
    pw = L.out_w - 2 * (RIM_W + PANEL_GAP)
    ph = L.out_d - 2 * (RIM_W + PANEL_GAP)
    pr = max(L.out_r - RIM_W - PANEL_GAP, 0.5)
    print(f"  外形 {pw:.2f} × {ph:.2f} mm  R{pr:.2f}  "
          f"厚 {PANEL_T:.1f} mm + 背胶 {PANEL_TAPE:.1f} mm（贴完与边框齐平）", flush=True)
    print(f"  开孔 3 × 键窗 {KEY_WIN + 2 * PANEL_KEY_PAD:.1f}×{KEY_WIN + 2 * PANEL_KEY_PAD:.1f}"
          f" R{KEY_WIN_R + PANEL_KEY_PAD:.1f}   旋钮 Ø{PANEL_KNOB_CUT:.1f}"
          f"   导光 Ø{PANEL_LED_CUT:.1f}", flush=True)
    for k in m.keys:
        x, y = L.XY(*k["center"])
        print(f"    键窗中心 ({x:6.2f}, {y:6.2f})", flush=True)
    print(f"    旋钮中心 ({ex:6.2f}, {ey:6.2f})   导光中心 ({lx:6.2f}, {ly:6.2f})",
          flush=True)
    good = (PANEL_KNOB_CUT >= KNOB_RECESS_D and PANEL_LED_CUT >= LED_EXIT_D
            and PANEL_KEY_PAD > 0)
    ok &= good
    print(f"  {'✓' if good else '✗'} 面板开孔 ≥ 顶盖开口（旋钮 Ø{KNOB_RECESS_D:.1f} / "
          f"导光 Ø{LED_EXIT_D:.1f} / 键窗 {KEY_WIN:.1f}）", flush=True)

    # ---- Type-C 插头通路自检：8.25 × 2.4 的插头外壳必须能从开口插到座腔 ----
    # 这不是“尺寸对不对”的校验，而是直接把插头包络放进模型里求交：
    # 只要开口偏了、小了，或者插头会碰到壁/台肩，余料就 > 0。
    cv = m.parts["usb_cavity"]
    plug_w, plug_h = 8.25, 2.4          # USB-C 插头外壳（公头）实测规格
    yc, zc = L.Y((cv[1] + cv[4]) / 2), L.Z((cv[2] + cv[5]) / 2)
    plug = plate(-2.0, yc - plug_w / 2, L.X(cv[0] + 0.2), yc + plug_w / 2,
                 zc - plug_h / 2, zc + plug_h / 2)
    v = (plug & base).volume
    good = v < 0.01
    ok &= good
    print(f"  {'✓' if good else '✗'} Type-C 插头通路  余料 {v:6.3f} mm³   "
          f"单边余量 Y {(cv[4] - cv[1] + 2 * USB_WIN_PAD - plug_w) / 2:.2f} / "
          f"Z {(cv[5] - cv[2] + 2 * USB_WIN_PAD - plug_h) / 2:.2f} mm", flush=True)

    # 壁厚自检：用射线法复现在线平台的「薄壁」判定（< 0.5 mm）
    import thickness_check as tc
    log("\n========== 壁厚自检（< 0.5 mm = 薄壁）==========")
    for name in ("Base", "Lid"):
        r = tc.analyze_stl(OUT / f"{name}.stl", min_t=0.5)
        good = r["area_below"] < 0.5
        ok &= good
        print(f"  {'✓' if good else '✗'} {name:4s} 最小壁厚 {r['min_wall']:6.3f} mm  "
              f"薄壁面积 {r['area_below']:6.2f} mm²", flush=True)
        for c in r["clusters"][:4]:
            if c["area"] >= 0.3:
                print(f"      ⚠ {c['area']:6.2f} mm² 厚 {c['t_min']}–{c['t_max']}  "
                      f"X {c['bbox'][0][0]}…{c['bbox'][1][0]}  "
                      f"Y {c['bbox'][0][1]}…{c['bbox'][1][1]}  "
                      f"Z {c['bbox'][0][2]}…{c['bbox'][1][2]}", flush=True)

    # ---- 拓扑自检：退化边 / 零面积面 / 实体数 / BRepCheck ----------------
    # 树脂（SLA）平台比 FDM 严：模型里只要有一条 0.001 mm 的边就会报「坏边」。
    # 注意圆柱面的缝合线（seam）是正常拓扑，不在此列（长度正常）。
    log("\n========== 拓扑自检 ==========")
    for name, part in (("Base", base), ("Lid", lid)):
        tiny = [e for e in part.edges() if e.length < 0.02]
        flat = [f for f in part.faces() if f.area < 1e-4]
        good = (not tiny and not flat and len(part.solids()) == 1
                and part.is_valid)
        ok &= good
        print(f"  {'✓' if good else '✗'} {name:4s} 面 {len(part.faces()):4d}  "
              f"边 {len(part.edges()):4d}  最短边 "
              f"{min(e.length for e in part.edges()):8.4f} mm  "
              f"退化边 {len(tiny):2d}  零面积面 {len(flat)}  BRep有效 {part.is_valid}",
              flush=True)
        for e in tiny[:5]:
            c = e.center()
            print(f"      ⚠ 退化边 len={e.length:.5f} @ ({c.X:.2f},{c.Y:.2f},{c.Z:.2f})")

    log(f"\n  Base 体积 {base.volume:9.1f} mm³")
    print(f"  Lid  体积 {lid.volume:9.1f} mm³")
    print(f"  外壳外形 {L.out_w:.3f} × {L.out_d:.3f} × {Z_RIM_TOP:.2f} mm"
          f"（底座 {Z_LID_BOT:.2f} + 顶板 {LID_T:.1f} + 边框 {RIM_H:.1f}）")
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
