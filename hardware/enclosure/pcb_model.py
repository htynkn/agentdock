"""AgentDock PCB 3D 模型解析层
============================
数据来源：嘉立创 EDA 专业版导出的 STEP（规范化文件名 ``../pcb/PCB.step``）

本模块**不建模**，只把 STEP 里的几何事实提取成结构化锚点：

* 板框（外形尺寸、板厚、四角圆角）
* 4 个 Ø2.7 安装孔
* 3 个键轴的轴心 / 底面轮廓 / 最高点
* EC11 编码器轴心、Ø7 螺纹套管、Ø6 轴
* 各连接器（USB-C、拨动开关、排针）与高元件（蜂鸣器、WS2812）的包围盒

``enclosure.py`` 用这些锚点做参数化建模；同时每个锚点都会和下面的 ``EXPECT``
表比对（容差 0.02 mm）。**PCB 一旦改版，这里会第一时间报错**，而不是默默
生成一个装不进去的外壳。

所有坐标都是 **PCB 局部坐标**：原点 = 板框左下角附近的 STEP 原点，
Z=0 = PCB 底面，Z=+1.586 = PCB 顶面（元件朝 +Z）。
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from build123d import GeomType, import_step

HERE = Path(__file__).resolve().parent
PCB_STEP = HERE.parent / "pcb" / "PCB.step"

# ---------------------------------------------------------------------------
# 期望值（2026-10-25 版 PCB 实测）。任何一项对不上就报错，提示重新核对外壳。
# ---------------------------------------------------------------------------
EXPECT = {
    "board_size": (91.974, 42.974),          # X × Y
    "board_thickness": 1.586,
    "corner_radius": 2.987,
    "mount_holes": [(1.65, 3.00), (87.65, 3.00), (1.65, 40.00), (87.65, 40.00)],
    "mount_hole_r": 1.35,                    # Ø2.7
    "key_centers": [(20.96, 11.43), (41.66, 11.43), (62.37, 11.43)],
    "key_footprint": (14.00, 15.60),         # 键体（含 MX 侧卡扣）包围盒
    "key_body_top": 13.04,
    "key_stem_top": 17.54,
    "encoder_center": (80.90, 31.75),
    "encoder_bushing_r": 3.50,               # M7
    "encoder_bushing_z": (6.59, 15.59),
    "usb_bbox": (0.07, 13.18, 0.59, 6.87, 22.12, 4.75),
    # 2026-10-25(2) 版 PCB：1×6 排针已删除，只余焊盘（板体铜箔，无 3D 几何）
    "sw1_body_bbox": (10.06, 36.43, -1.91, 22.96, 42.03, 7.74),
    "sw1_lever_bbox": (16.41, 41.63, 3.81, 19.91, 46.63, 6.31),
    "buzzer_bbox": (79.34, 7.72, 1.59, 88.04, 16.42, 5.61),
    "led_bbox": (15.78, 23.01, 1.59, 20.28, 27.53, 3.10),
}
TOL = 0.02

# 低于板底（Z<0）的元件高度上限（销脚），用于确定底板与 PCB 之间所需净空
EXPECT["below_board_min_z"] = -1.91


def _bb(solid):
    b = solid.bounding_box()
    return (b.min.X, b.min.Y, b.min.Z, b.max.X, b.max.Y, b.max.Z)


def _size(solid):
    b = solid.bounding_box()
    return (b.size.X, b.size.Y, b.size.Z)


def _center_xy(solid):
    b = solid.bounding_box()
    return ((b.min.X + b.max.X) / 2, (b.min.Y + b.max.Y) / 2)


def _close(a, b, tol=TOL):
    return abs(a - b) <= tol


def _bbox_close(got, want, tol=TOL):
    return all(_close(g, w, tol) for g, w in zip(got, want))


@dataclass
class PcbModel:
    """PCB 的几何事实（全部为 PCB 局部坐标，单位 mm）。"""

    path: Path
    board: tuple            # (x0, y0, z0, x1, y1, z1)
    corner_radius: float
    mount_holes: list       # [(x, y, r)]
    keys: list              # [ {center:(x,y), footprint:(w,d), z0, body_top, stem_top} ]
    encoder: dict           # {center, bushing_r, bushing_z0, bushing_z1, shaft_r, shaft_top}
    parts: dict             # {name: bbox(x0,y0,z0,x1,y1,z1)}
    tall_parts: list        # [(bbox, volume)] 顶面高于板顶 1 mm 的元件
    below_board_min_z: float
    n_solids: int
    solids: list = field(default_factory=list, repr=False)
    warnings: list = field(default_factory=list)

    # -- 便捷属性 ----------------------------------------------------------
    @property
    def size(self):
        x0, y0, _, x1, y1, _ = self.board
        return (x1 - x0, y1 - y0)

    @property
    def thickness(self):
        return self.board[5] - self.board[2]

    @property
    def z_top(self):
        return self.board[5]

    def check(self) -> list:
        """与 EXPECT 表比对，返回问题列表（空 = 全部通过）。"""
        bad = []
        e = EXPECT
        if not _close(self.size[0], e["board_size"][0]) or not _close(
                self.size[1], e["board_size"][1]):
            bad.append(f"板框 {self.size} ≠ 期望 {e['board_size']}")
        if not _close(self.thickness, e["board_thickness"]):
            bad.append(f"板厚 {self.thickness:.3f} ≠ {e['board_thickness']}")
        if not _close(self.corner_radius, e["corner_radius"]):
            bad.append(f"板角 R{self.corner_radius:.3f} ≠ {e['corner_radius']}")

        got = sorted((round(x, 2), round(y, 2)) for x, y, _ in self.mount_holes)
        want = sorted((round(x, 2), round(y, 2)) for x, y in e["mount_holes"])
        if got != want:
            bad.append(f"安装孔 {got} ≠ 期望 {want}")
        for _, _, r in self.mount_holes:
            if not _close(r, e["mount_hole_r"]):
                bad.append(f"安装孔半径 {r:.3f} ≠ {e['mount_hole_r']}")

        got = sorted((k["center"][0], k["center"][1]) for k in self.keys)
        want = sorted(e["key_centers"])
        if len(got) != len(want) or any(
                not (_close(g[0], w[0]) and _close(g[1], w[1]))
                for g, w in zip(got, want)):
            bad.append(f"键轴轴心 {got} ≠ 期望 {want}")
        for k in self.keys:
            if not _close(k["footprint"][0], e["key_footprint"][0], 0.15) or not _close(
                    k["footprint"][1], e["key_footprint"][1], 0.15):
                bad.append(f"键体轮廓 {k['footprint']} ≠ {e['key_footprint']}")
            if not _close(k["body_top"], e["key_body_top"], 0.05):
                bad.append(f"键体顶面 {k['body_top']:.2f} ≠ {e['key_body_top']}")
            if not _close(k["stem_top"], e["key_stem_top"], 0.05):
                bad.append(f"键轴顶面 {k['stem_top']:.2f} ≠ {e['key_stem_top']}")

        enc = self.encoder
        if not _close(enc["center"][0], e["encoder_center"][0]) or not _close(
                enc["center"][1], e["encoder_center"][1]):
            bad.append(f"编码器轴心 {enc['center']} ≠ {e['encoder_center']}")
        if not _close(enc["bushing_r"], e["encoder_bushing_r"], 0.05):
            bad.append(f"编码器套管 R{enc['bushing_r']:.2f} ≠ R{e['encoder_bushing_r']}")
        if not _close(enc["bushing_z0"], e["encoder_bushing_z"][0], 0.05) or not _close(
                enc["bushing_z1"], e["encoder_bushing_z"][1], 0.05):
            bad.append(f"编码器套管 Z{enc['bushing_z0']:.2f}..{enc['bushing_z1']:.2f} "
                       f"≠ {e['encoder_bushing_z']}")

        for name in ("usb", "sw1_body", "sw1_lever", "buzzer", "led"):
            want = e[f"{name}_bbox"]
            if not _bbox_close(self.parts[name], want):
                bad.append(f"{name} 包围盒 {tuple(round(v, 2) for v in self.parts[name])} "
                           f"≠ 期望 {want}")
        if not _close(self.below_board_min_z, e["below_board_min_z"], 0.05):
            bad.append(f"板底最低点 {self.below_board_min_z:.2f} "
                       f"≠ {e['below_board_min_z']}")
        return bad

    def max_z_near(self, x: float, y: float, radius: float) -> float:
        """(x,y) 附近 radius 半径圆柱内，PCB 上最高的实际几何点 Z（局部坐标）。

        用真实几何求交而不是包围盒——EasyEDA 的一体化实体经常把
        低矮的座子与高大的套管包在同一个包围盒里，用 bbox 会过于保守。
        """
        from build123d import Align, Cylinder, Pos

        zs = []
        probe = None
        matches = []
        for s in self.solids:
            bb = _bb(s)
            dx = max(bb[0] - x, 0.0, x - bb[3])
            dy = max(bb[1] - y, 0.0, y - bb[4])
            if (dx * dx + dy * dy) ** 0.5 >= radius:
                continue
            matches.append((s, bb))
        if not matches:
            return self.z_top
        # 探针 Z 范围必须覆盖全部命中实体的包围盒（首个命中者可能很矮，
        # 例如贴片电容 z≤2，而真正的高点是旁边的编码器支架 z=6.09）
        z0 = min(bb[2] for _, bb in matches) - 2.0
        z1 = max(bb[5] for _, bb in matches) + 2.0
        probe = Pos(x, y, z0) * Cylinder(
            radius, z1 - z0, align=(Align.CENTER, Align.CENTER, Align.MIN))
        for s, _ in matches:
            part = s & probe
            if part is None:
                continue
            zs.extend(v.Z for v in part.vertices())
        return max(zs) if zs else self.z_top

    def report(self) -> dict:
        return {
            "source": str(self.path),
            "solids": self.n_solids,
            "board": {
                "bbox": self.board,
                "size": self.size,
                "thickness": round(self.thickness, 4),
                "corner_radius": round(self.corner_radius, 4),
            },
            "mount_holes": self.mount_holes,
            "keys": self.keys,
            "encoder": self.encoder,
            "parts": self.parts,
            "below_board_min_z": round(self.below_board_min_z, 3),
            "tall_parts": [{"bbox": [round(v, 2) for v in bb], "volume": round(v, 2)}
                           for bb, v in self.tall_parts],
            "warnings": self.warnings,
        }


# ---------------------------------------------------------------------------
# 解析
# ---------------------------------------------------------------------------
def load(path: Path | None = None, verbose: bool = True) -> PcbModel:
    path = Path(path) if path else PCB_STEP
    if not path.exists():
        raise FileNotFoundError(f"找不到 PCB STEP：{path}")

    compound = import_step(str(path))
    solids = [s for s in compound.solids() if s.volume > 0.5]
    if verbose:
        print(f"STEP: {path.name}  实体 {len(solids)} 个（已滤除零体积碎片）")

    # ---- 1. 找板体：XY 面积最大且很薄的实体 ------------------------------
    def xy_area(s):
        sx, sy, _ = _size(s)
        return sx * sy

    thin = [s for s in solids if _size(s)[2] < 4.0 and xy_area(s) > 1000]
    if not thin:
        raise RuntimeError("STEP 里没找到板体（薄且 XY 面积大的实体）")
    board = max(thin, key=xy_area)
    board_bb = _bb(board)

    # ---- 2. 板角圆角：底面的外圈圆边 -------------------------------------
    bottom = min(board.faces(), key=lambda f: f.center().Z)
    corner_r = None
    for e in bottom.outer_wire().edges():
        if e.geom_type == GeomType.CIRCLE and getattr(e, "radius", None):
            corner_r = e.radius
    if corner_r is None:
        raise RuntimeError("无法从板框外圈读出圆角半径")

    # ---- 3. 安装孔：顶面内圈里的 Ø2.7 圆 --------------------------------
    top = max((f for f in board.faces() if f.normal_at().Z > 0.99),
              key=lambda f: f.area)
    holes = []
    for w in top.inner_wires():
        edges = w.edges()
        # EasyEDA 导出的圆孔一般是 2 段半圆，所以要求“全部是圆边 + 方形包围盒”
        if not edges or any(e.geom_type != GeomType.CIRCLE for e in edges):
            continue
        fb = w.bounding_box()
        if not _close(fb.size.X, fb.size.Y, 0.01):
            continue
        r = fb.size.X / 2
        if 1.2 < r < 1.5:                      # Ø2.7 → r=1.35
            c = w.center()
            holes.append((round(c.X, 3), round(c.Y, 3), round(r, 4)))
    holes.sort()

    # ---- 4. 键轴：14.0 × 15.6 的方块（MX 键体） -------------------------
    keys = []
    for s in solids:
        sx, sy, _ = _size(s)
        bb = _bb(s)
        if _close(sx, EXPECT["key_footprint"][0], 0.15) and _close(
                sy, EXPECT["key_footprint"][1], 0.15) and bb[5] > 10.0:
            cx, cy = _center_xy(s)
            # 该键位footprint 内最高的实体 = 键轴（十字柱）
            patch = [t for t in solids
                     if _bb(t)[0] >= bb[0] - 0.2 and _bb(t)[3] <= bb[3] + 0.2
                     and _bb(t)[1] >= bb[1] - 0.2 and _bb(t)[4] <= bb[4] + 0.2]
            stem_top = max((_bb(t)[5] for t in patch), default=bb[5])
            keys.append({
                "center": (round(cx, 3), round(cy, 3)),
                "footprint": (round(sx, 3), round(sy, 3)),
                "body_top": round(bb[5], 3),
                "stem_top": round(stem_top, 3),
            })
    keys.sort(key=lambda k: k["center"][0])

    # ---- 5. 编码器：Ø6 轴（6×6 方包围盒）+ Ø7 套管圆面 -------------------
    shaft = None
    for s in solids:
        sx, sy, sz = _size(s)
        if _close(sx, 6.0, 0.05) and _close(sy, 6.0, 0.05) and sz > 8.0:
            shaft = s
    if shaft is None:
        raise RuntimeError("找不到编码器 Ø6 轴（6×6 包围盒、Z 跨度 >8）")
    enc_c = _center_xy(shaft)
    shaft_top = _bb(shaft)[5]

    bushing = None
    for s in solids:
        for f in s.faces():
            if f.geom_type != GeomType.CYLINDER:
                continue
            r = getattr(f, "radius", None)
            if r is None or not _close(r, EXPECT["encoder_bushing_r"], 0.05):
                continue
            fb = f.bounding_box()
            # 圆柱侧面可能是半圆柱（被剖成两半），X 方向的两个极值仍关于轴心对称；
            # Y 方向只保证轴心落在包围盒内（半圆的一侧即轴心）。
            if fb.max.Z - fb.min.Z > 5.0 and \
                    _close((fb.min.X + fb.max.X) / 2, enc_c[0], 0.1) and \
                    fb.min.Y - 0.1 <= enc_c[1] <= fb.max.Y + 0.1:
                if bushing is None or fb.max.Z > bushing[1]:
                    bushing = (fb.min.Z, fb.max.Z)
    if bushing is None:
        raise RuntimeError("找不到编码器 Ø7 螺纹套管")
    encoder = {
        "center": (round(enc_c[0], 3), round(enc_c[1], 3)),
        "bushing_r": EXPECT["encoder_bushing_r"],
        "bushing_z0": round(bushing[0], 3),
        "bushing_z1": round(bushing[1], 3),
        "shaft_r": 3.0,
        "shaft_top": round(shaft_top, 3),
    }

    # ---- 6. 各连接器 / 高元件包围盒 --------------------------------------
    def find(pred, name):
        for s in solids:
            bb = _bb(s)
            sx, sy, sz = _size(s)
            if pred(bb, sx, sy, sz):
                return bb
        raise RuntimeError(f"找不到 {name}")

    parts = {}
    parts["usb"] = find(
        lambda bb, sx, sy, sz: bb[0] < 1.0 and 8.5 < sy < 9.5 and 3.5 < sz < 5.0,
        "USB-C 座")
    # 1×6 排针已于 2026-10-25(2) 版删除；若未来重新加装，恢复 EXPECT 表
    # 中的 header_bbox 与下方查找规则即可。
    parts["buzzer"] = find(
        lambda bb, sx, sy, sz: 8.4 < sx < 9.0 and 8.4 < sy < 9.0 and bb[0] > 60,
        "蜂鸣器")
    parts["led"] = find(
        lambda bb, sx, sy, sz: 4.3 < sx < 4.7 and 4.3 < sy < 4.7 and bb[2] < 2.0,
        "WS2812")
    parts["sw1_body"] = find(
        lambda bb, sx, sy, sz: 12.5 < sx < 13.5 and 5.2 < sy < 6.0 and sz > 9.0,
        "拨动开关本体")
    parts["sw1_lever"] = find(
        lambda bb, sx, sy, sz: bb[4] > board_bb[4] + 0.5 and sz < 3.0,
        "拨动开关拨柄")

    # ---- 7. 其它：板底最低点、顶面高元件 ---------------------------------
    below_min = min(_bb(s)[2] for s in solids if s is not board)
    tall = []
    for s in solids:
        if s is board:
            continue
        bb = _bb(s)
        if bb[5] > board_bb[5] + 1.0 and s.volume > 0.4:
            tall.append((bb, s.volume))
    tall.sort(key=lambda t: -t[0][5])

    m = PcbModel(
        path=path,
        board=tuple(round(v, 4) for v in board_bb),
        corner_radius=round(corner_r, 4),
        mount_holes=holes,
        keys=keys,
        encoder=encoder,
        parts={k: tuple(round(v, 3) for v in bb) for k, bb in parts.items()},
        tall_parts=tall,
        below_board_min_z=round(below_min, 3),
        n_solids=len(solids),
        solids=solids,
    )
    problems = m.check()
    if problems:
        m.warnings.extend(problems)
        raise AssertionError(
            "PCB 与外壳的设计基准不一致，请先更新 enclosure.py 的参数：\n  - "
            + "\n  - ".join(problems))
    return m


def dump(m: PcbModel, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(m.report(), ensure_ascii=False, indent=2) + "\n",
                   encoding="utf-8")


if __name__ == "__main__":
    model = load()
    print(json.dumps(model.report(), ensure_ascii=False, indent=2))
    print("\n✓ 全部锚点与 EXPECT 表一致")
