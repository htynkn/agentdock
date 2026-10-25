"""装配动画：Base → PCB 落入 → Lid 盖上，同时绕 Z 轴旋转
=========================================================
运行::

    uv run animate.py            # 输出 render/assembly.mp4 + assembly.gif

原理：与 render.py 相同的 matplotlib 三角形渲染，逐帧改变
PCB / Lid 的 Z 偏移与整体方位角，用 ffmpeg（或 Pillow）合成。
"""
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager
from mpl_toolkits.mplot3d.art3d import Poly3DCollection

HERE = Path(__file__).resolve().parent
OUT = HERE / "output"
RENDER = HERE / "render"
RENDER.mkdir(exist_ok=True)


def setup_cjk() -> bool:
    for p in ["/System/Library/Fonts/PingFang.ttc",
              "/System/Library/Fonts/Hiragino Sans GB.ttc",
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
def T(zh, en):
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
    return verts


def rot_z(verts, deg):
    """绕装配体中心 (cx, cy) 旋转（numpy 网格层旋转，不碰 STEP）。"""
    a = np.radians(deg)
    cx, cy = 48.09, 23.59
    w = verts.copy()
    x, y = w[:, :, 0] - cx, w[:, :, 1] - cy
    w[:, :, 0] = cx + x * np.cos(a) - y * np.sin(a)
    w[:, :, 1] = cy + x * np.sin(a) + y * np.cos(a)
    return w


def shade(verts, rgb):
    n = np.cross(verts[:, 1] - verts[:, 0], verts[:, 2] - verts[:, 0])
    n = n / (np.linalg.norm(n, axis=1, keepdims=True) + 1e-12)
    light = np.array([0.45, 0.35, 0.82])
    light = light / np.linalg.norm(light)
    d = n @ light
    spec = np.clip(d, 0, 1) ** 60 * 0.30
    k = np.clip(0.35 + 0.62 * np.abs(d) + spec, 0, 1.08)
    return np.clip(np.asarray(rgb)[None, :] * k[:, None], 0, 1)


ORANGE = (0.96, 0.47, 0.16)
BLUE = (0.25, 0.46, 0.72)
GREEN = (0.15, 0.55, 0.30)

print("载入 STL ...")
base = load_stl(OUT / "Base_lowres.stl")
lid = load_stl(OUT / "Lid_lowres.stl")
pcb = load_stl(OUT / "PCB_world.stl", min_area=0.05)

# 关键 Z：PCB 装配位 5.0（世界）；Lid 底 18.5；爆炸起点再抬 45
Z_PCB, Z_LID = 5.0, 18.5

# 帧脚本：(进度 t∈[0,1]) -> (pcb_z_offset, lid_z_offset, 角度)
FPS = 30
frames = []
# 阶段1 0.0-0.25: 全爆炸旋转
for i in range(int(FPS * 1.6)):
    t = i / (FPS * 1.6)
    frames.append((28 * (1 - t) ** 2 + 17, 60 * (1 - t) ** 2 + 42, -60 + 120 * t))
# 阶段2 0.25-0.55: PCB 降落
n2 = int(FPS * 1.8)
for i in range(n2):
    t = i / n2
    e = 1 - (1 - t) ** 3                      # ease-out cubic
    frames.append((17 * (1 - e), 42, 60))
# 阶段3 0.55-0.85: Lid 降落
n3 = int(FPS * 1.8)
for i in range(n3):
    t = i / n3
    e = 1 - (1 - t) ** 3
    frames.append((0, 42 * (1 - e), 60))
# 阶段4 0.85-1.0: 定格旋转一圈的 30°
n4 = int(FPS * 1.2)
for i in range(n4):
    frames.append((0, 0, 60 + 30 * i / n4))

print(f"共 {len(frames)} 帧 @ {FPS} fps")
t0 = time.time()
pngs = []
fig = plt.figure(figsize=(8, 6), dpi=110, facecolor="white")
ax = fig.add_subplot(111, projection="3d")
ax.set_axis_off()
ax.view_init(elev=22, azim=0)
ax.set_proj_type("persp")

# 固定视野（装配体世界包围盒 + 爆炸余量）
cx, cy, cz = 48.09, 23.59, 40
r = 62
ax.set_xlim(cx - r, cx + r); ax.set_ylim(cy - r, cy + r); ax.set_zlim(cz - r, cz + r)
ax.set_box_aspect((1, 1, 1))

for i, (dz_p, dz_l, ang) in enumerate(frames):
    parts = [
        (rot_z(base, ang), ORANGE),
        (rot_z(pcb + np.array([0, 0, Z_PCB + dz_p]), ang), GREEN),
        (rot_z(lid + np.array([0, 0, Z_LID + dz_l]), ang), BLUE),
    ]
    faces, cols = [], []
    for verts, rgb in parts:
        faces.append(verts)
        cols.append(shade(verts, rgb))
    verts = np.concatenate(faces); cols = np.concatenate(cols)
    pc = Poly3DCollection(verts, facecolors=cols, edgecolors="none")
    ax.add_collection3d(pc)
    title = T("AgentDock 装配动画", "AgentDock assembly")
    phase = (T("旋转检视", "orbit") if dz_p > 0.1 and dz_l > 0.1 else
             T("PCB 落入底座", "dropping PCB") if dz_p > 0.1 else
             T("顶盖合上", "closing lid") if dz_l > 0.1 else
             T("装配完成", "assembled"))
    ax.set_title(f"{title} — {phase}", fontsize=13, pad=0, y=0.98)
    p = RENDER / f"_anim_{i:04d}.png"
    fig.savefig(p, facecolor="white")
    pngs.append(p)
    pc.remove()

print(f"帧渲染完成 {time.time()-t0:.1f}s，合成视频 ...")

mp4 = RENDER / "assembly.mp4"
gif = RENDER / "assembly.gif"
have_ffmpeg = subprocess.run(["which", "ffmpeg"], capture_output=True).returncode == 0
if have_ffmpeg:
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error",
                    "-framerate", str(FPS),
                    "-i", str(RENDER / "_anim_%04d.png"),
                    "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    "-crf", "23", str(mp4)], check=True)
    print(f"  {mp4}")
# GIF（Pillow，无 ffmpeg 也能出）
from PIL import Image
imgs = [Image.open(p).convert("P", palette=Image.ADAPTIVE) for p in pngs]
imgs[0].save(gif, save_all=True, append_images=imgs[1:],
             duration=int(1000 / FPS), loop=0)
for p in pngs:
    p.unlink()
print(f"  {gif}")
print(f"完成 {time.time()-t0:.1f}s")
