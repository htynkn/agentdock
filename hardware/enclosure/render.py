"""渲染脚本：读 output/ 的 STL + PCB STEP，matplotlib 出四视图 + 爆炸图。"""
import sys, time
from pathlib import Path
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d.art3d import Poly3DCollection

HERE = Path(__file__).resolve().parent
OUT = HERE / "output"
RENDER = HERE / "render"
RENDER.mkdir(exist_ok=True)

# PCB 局部 → 外壳坐标的平移量，直接从生成好的 pcb_report.json + 建模参数算，
# 不要在渲染脚本里硬编码（CLEAR 一改，这里跟着自动变）。
import json
import sys as _sys
_sys.path.insert(0, str(HERE))
from enclosure import CLEAR, WALL, Z_PCB_BOT   # noqa: E402
_bb = json.loads((OUT / "pcb_report.json").read_text())["board"]["bbox"]
DX = WALL + CLEAR - _bb[0]
DY = WALL + CLEAR - _bb[1]
Z_PCB = Z_PCB_BOT


def setup_cjk() -> bool:
    from matplotlib import font_manager
    for p in ["/System/Library/Fonts/PingFang.ttc",
              "/System/Library/Fonts/Hiragino Sans GB.ttc",
              "/System/Library/Fonts/STHeiti Light.ttc",
              "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
              "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc"]:
        try:
            if not Path(p).exists():
                continue
            font_manager.fontManager.addfont(p)
            name = font_manager.FontProperties(fname=p).get_name()
            plt.rcParams["font.family"] = [name, "DejaVu Sans"]
            return True
        except Exception:
            continue
    return False


CJK = setup_cjk()
def T(zh: str, en: str) -> str:
    return zh if CJK else en


def load_stl(path, min_area=0.0):
    data = open(path, "rb").read()
    if b"facet normal" in data[:2000]:
        toks = data.decode("ascii", "ignore").split()
        idx = [i for i, t in enumerate(toks) if t == "vertex"]
        v = np.array([[float(toks[i+1]), float(toks[i+2]), float(toks[i+3])]
                      for i in idx])
        verts = v.reshape(-1, 3, 3)
    else:
        n = np.frombuffer(data[80:84], dtype="<u4")[0]
        rec = np.frombuffer(data[84:84 + n * 50], dtype=np.dtype([
            ("n", "<f4", 3), ("v", "<f4", (3, 3)), ("attr", "<u2")]))
        verts = rec["v"].astype(np.float64)
    if min_area > 0:
        area = 0.5 * np.linalg.norm(
            np.cross(verts[:, 1] - verts[:, 0], verts[:, 2] - verts[:, 0]), axis=1)
        verts = verts[area >= min_area]
    print(f"  {Path(path).name:22s} {len(verts):7d} 三角形")
    return verts


def load_pcb_stl():
    """从 STEP 现场网格化 PCB（世界坐标），缓存为 STL。"""
    cache = OUT / "PCB_world.stl"
    if not cache.exists():
        from build123d import import_step, export_stl
        shape = import_step(str(HERE.parent / "pcb" / "PCB.step"))
        export_stl(shape, str(cache), tolerance=0.3, angular_tolerance=0.4)
    return load_stl(cache, min_area=0.05)


def light_dir(elev, azim):
    el, az = np.radians(elev), np.radians(azim)
    d = np.array([np.cos(el)*np.cos(az), np.cos(el)*np.sin(az), np.sin(el)])
    return (d + np.array([0.15, 0.1, 0.45])) / np.linalg.norm(d + np.array([0.15, 0.1, 0.45]))


def shade(verts, rgb, light):
    n = np.cross(verts[:, 1] - verts[:, 0], verts[:, 2] - verts[:, 0])
    n = n / (np.linalg.norm(n, axis=1, keepdims=True) + 1e-12)
    d = n @ light
    spec = np.clip(d, 0, 1) ** 60 * 0.30
    k = np.clip(0.35 + 0.62 * np.abs(d) + spec, 0, 1.08)
    return np.clip(np.asarray(rgb)[None, :] * k[:, None], 0, 1)


def draw_view(ax, parts, elev, azim, title):
    light = light_dir(elev, azim)
    faces, cols = [], []
    for verts, rgb in parts:
        faces.append(verts)
        cols.append(shade(verts, rgb, light))
    verts = np.concatenate(faces); cols = np.concatenate(cols)
    pc = Poly3DCollection(verts, facecolors=cols, edgecolors="none")
    ax.add_collection3d(pc)
    allv = verts.reshape(-1, 3)
    mn, mx = allv.min(0), allv.max(0)
    c, r = (mn + mx) / 2, (mx - mn) / 2 * 1.06 + 1.0
    ax.set_xlim(c[0]-r[0], c[0]+r[0]); ax.set_ylim(c[1]-r[1], c[1]+r[1])
    ax.set_zlim(c[2]-r[2], c[2]+r[2])
    ax.set_box_aspect((r[0], r[1], r[2]))
    ax.view_init(elev=elev, azim=azim)
    ax.set_proj_type("persp"); ax.set_axis_off(); ax.set_title(title, fontsize=12, pad=0)


def translate(verts, dxyz):
    w = verts.copy()
    w += np.asarray(dxyz)
    return w


t0 = time.time()
base = load_stl(OUT / "Base_lowres.stl")
lid = load_stl(OUT / "Lid_lowres.stl")
panel = load_stl(OUT / "Panel_lowres.stl") if (OUT / "Panel_lowres.stl").exists() else None
pcb = load_pcb_stl() + np.array([DX, DY, Z_PCB])

ORANGE = (0.96, 0.47, 0.16)
BLUE = (0.25, 0.46, 0.72)
GREEN = (0.15, 0.55, 0.30)
GLASS = (0.70, 0.78, 0.88)

assembled = [(base, ORANGE), (pcb, GREEN), (lid, BLUE)]
if panel is not None:
    assembled.append((panel, GLASS))
exploded = [(base, ORANGE), (translate(pcb, (0, 0, 18)), GREEN),
            (translate(lid, (0, 0, 40)), BLUE)]
if panel is not None:
    exploded.append((translate(panel, (0, 0, 62)), GLASS))

fig = plt.figure(figsize=(15, 11), dpi=160, facecolor="white")
views = [
    (assembled, 24, 135, T("装配等轴（USB 侧）", "Assembled (USB side)")),
    (assembled, 24, 45, T("装配等轴（蜂鸣器侧）", "Assembled (buzzer side)")),
    (exploded, 18, 120, T("爆炸图（含亚克力面板）", "Exploded (+ acrylic panel)")),
    (assembled, 89, -90, T("俯视：面板/键窗/旋钮/导光孔", "Top: panel / keys / knob")),
    ([(lid, BLUE)], -32, -60, T("顶盖内表面：加强肋", "Lid underside: stiffening ribs")),
    ([(base, ORANGE)], -30, -60, T("Base 底面：螺丝沉孔", "Base bottom: counterbores")),
]
for i, (parts, elev, azim, title) in enumerate(views, 1):
    ax = fig.add_subplot(2, 3, i, projection="3d")
    draw_view(ax, parts, elev, azim, title)
fig.suptitle(T("AgentDock 外壳 — Base / PCB / Lid / 面板",
               "AgentDock Enclosure - Base / PCB / Lid / Panel"), fontsize=16)
fig.subplots_adjust(left=0.01, right=0.99, top=0.94, bottom=0.01, wspace=0.0, hspace=0.05)
fig.savefig(RENDER / "enclosure_views.png", facecolor="white")
plt.close(fig)

fig = plt.figure(figsize=(11, 9), dpi=160, facecolor="white")
ax = fig.add_subplot(111, projection="3d")
draw_view(ax, exploded, 20, 130, "")
fig.subplots_adjust(left=0, right=1, top=1, bottom=0)
fig.savefig(RENDER / "enclosure_exploded.png", facecolor="white")
plt.close(fig)

# 底部视图：看底板、筋和进胶/螺丝沉孔
fig = plt.figure(figsize=(6.5, 5), dpi=160, facecolor="white")
ax = fig.add_subplot(111, projection="3d")
draw_view(ax, [(base, ORANGE)], -89, -90, T("Base 底面（螺丝沉孔）", "Base bottom (screw counterbores)"))
fig.tight_layout()
fig.savefig(RENDER / "base_bottom.png", facecolor="white")
plt.close(fig)

print(f"渲染完成 {time.time()-t0:.1f}s → {RENDER}")
