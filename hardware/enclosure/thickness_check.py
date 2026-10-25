"""STL 壁厚分析（射线法）— 定位薄壁 / 刀口结构
================================================
在线 3D 打印平台的「模型存在薄壁结构」警告，本质是：某些表面点的**局部壁厚**
（沿内法线打到对面表面的距离）小于工艺下限（通常 0.8 mm，报警阈值 0.5 mm）。

本脚本复现该检测：

1. 把每个三角面按面积细分成若干**面积加权采样点**（每点代表 ``sample_area`` mm²），
   这样细长/巨大三角面不会漏检，也不会被单个大三角形污染统计；
2. 沿内法线投射射线，取首个命中距离 = 该点的局部壁厚；
3. 汇总 < ``--min`` 的采样点，按空间聚类输出包围盒、面积、厚度区间，
   直接定位到具体的建模参数。

用法::

    uv run thickness_check.py output/Lid.stl --min 0.5
    uv run thickness_check.py output/Base.stl --min 0.5 --top 8
    uv run thickness_check.py output/Lid.stl --min 0.5 --json   # 机器可读

``enclosure.py`` 在导出 STL 后调用 :func:`analyze_stl` 做壁厚自检。
"""
from __future__ import annotations

import argparse
import json
import struct
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree


# ---------------------------------------------------------------------------
# STL 读写
# ---------------------------------------------------------------------------
def load_stl(path: Path):
    """读二进制 STL → 三角形顶点 V[n,3,3]。"""
    raw = Path(path).read_bytes()
    n = struct.unpack_from("<I", raw, 80)[0]
    if len(raw) != 84 + n * 50:
        raise ValueError(f"{path} 不是二进制 STL（长度不匹配）")
    rec = np.frombuffer(raw, dtype=np.uint8, count=n * 50, offset=84).reshape(n, 50)
    f = rec[:, :48].copy().view(np.float32).reshape(n, 4, 3).astype(np.float64)
    return f[:, 1:4, :]


def face_normals(V):
    """由顶点环绕方向算几何法线（STL 里存的法线常常不可靠）。"""
    n = np.cross(V[:, 1] - V[:, 0], V[:, 2] - V[:, 0])
    ln = np.linalg.norm(n, axis=1, keepdims=True)
    return n / np.maximum(ln, 1e-12)


def orient_outward(V, N):
    """用「三角形中心相对整体质心」的方向把法线朝外（壳类零件足够）。"""
    C = V.mean(axis=1)
    flip = np.einsum("ij,ij->i", N, C - C.mean(axis=0)) < 0
    N = N.copy()
    N[flip] *= -1
    return N


# ---------------------------------------------------------------------------
# 采样 + 射线
# ---------------------------------------------------------------------------
def sample_surface(V, N, target_area, seed=0):
    """每个三角形按面积均布采样，返回 (点 P, 法线 Np, 每点代表面积 w)。"""
    e1 = V[:, 1] - V[:, 0]
    e2 = V[:, 2] - V[:, 0]
    area = 0.5 * np.linalg.norm(np.cross(e1, e2), axis=1)
    n = np.maximum(1, np.ceil(area / target_area)).astype(np.int64)

    idx = np.repeat(np.arange(len(area)), n)
    rng = np.random.default_rng(seed)
    tot = idx.size
    u, v = rng.random(tot), rng.random(tot)
    over = u + v > 1.0
    u[over], v[over] = 1.0 - u[over], 1.0 - v[over]
    P = V[idx, 0] + u[:, None] * e1[idx] + v[:, None] * e2[idx]
    w = area[idx] / n[idx]
    return P, N[idx], w


def first_hit(V, N, P, max_dist, eps=1e-4):
    """对每个采样点 P 沿 -N 找最近命中距离（跳过自身三角形及其邻面噪声）。"""
    C = V.mean(axis=1)                      # 三角形中心，用作空间索引
    rad = np.max(np.linalg.norm(V - C[:, None, :], axis=2), axis=1)
    tree = cKDTree(C)
    cand = tree.query_ball_point(P, max_dist + float(rad.max()))

    A, e1, e2 = V[:, 0], V[:, 1] - V[:, 0], V[:, 2] - V[:, 0]
    out = np.full(len(P), np.inf)
    for i, js in enumerate(cand):
        if len(js) == 0:
            continue
        js = np.asarray(js, dtype=np.int64)
        # 跳过包含该采样点（就落在其面上）的三角形
        near = np.linalg.norm(C[js] - P[i], axis=1) <= rad[js] + eps
        js = js[~near]
        if js.size == 0:
            continue
        d = -N[i]
        p = np.cross(d, e2[js])
        det = np.einsum("ij,ij->i", e1[js], p)
        ok = np.abs(det) > 1e-12
        if not ok.any():
            continue
        js, p, det = js[ok], p[ok], det[ok]
        inv = 1.0 / det
        tv = P[i] - A[js]
        u = np.einsum("ij,ij->i", tv, p) * inv
        q = np.cross(tv, e1[js])
        v = np.einsum("ij,ij->i", d[None, :], q) * inv
        t = np.einsum("ij,ij->i", e2[js], q) * inv
        m = (u >= -1e-9) & (v >= -1e-9) & (u + v <= 1 + 1e-9) & (t > 1e-6)
        if m.any():
            out[i] = t[m].min()
    return out


def _cluster(P, w, link):
    """按空间邻近聚类，返回 [(lo, hi, n, area, wmin)]。"""
    if len(P) == 0:
        return []
    pairs = cKDTree(P).query_pairs(link, output_type="ndarray")
    parent = np.arange(len(P))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for a, b in pairs:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra
    root = np.array([find(i) for i in range(len(P))])
    out = []
    for r in np.unique(root):
        s = root == r
        g = P[s]
        out.append((g.min(axis=0), g.max(axis=0), int(s.sum()),
                    float(w[s].sum())))
    out.sort(key=lambda t: -t[3])
    return out


# ---------------------------------------------------------------------------
# 主分析
# ---------------------------------------------------------------------------
def analyze_stl(path: Path, min_t=0.5, sample_area=0.5, max_wall=14.0,
                link=1.5, seed=0) -> dict:
    V = load_stl(path)
    N = orient_outward(V, face_normals(V))
    P, Np, w = sample_surface(V, N, sample_area, seed)
    t = first_hit(V, Np, P, max_wall)

    fin = np.isfinite(t)
    thin = fin & (t < min_t)
    thr = {f"{x:.1f}": float(w[fin & (t < x)].sum())
           for x in (0.2, 0.4, 0.5, 0.8, 1.0, 1.2)}

    clusters = []
    Pt, wt, tt = P[thin], w[thin], t[thin]
    for lo, hi, cnt, area in _cluster(Pt, wt, link):
        sel = np.all((Pt >= lo - 1e-9) & (Pt <= hi + 1e-9), axis=1)
        clusters.append({
            "samples": cnt,
            "area": round(area, 2),
            "t_min": round(float(tt[sel].min()), 3),
            "t_max": round(float(tt[sel].max()), 3),
            "bbox": [[round(float(v), 2) for v in lo],
                     [round(float(v), 2) for v in hi]],
        })

    return {
        "file": Path(path).name,
        "triangles": int(len(V)),
        "samples": int(len(P)),
        "min_wall": round(float(t[fin].min()), 3) if fin.any() else None,
        "area_below": round(float(w[thin].sum()), 2),
        "area_by_threshold": thr,
        "clusters": clusters,
    }


def _print(res: dict, min_t: float, top: int):
    print(f"{res['file']}: {res['triangles']} 三角形 / {res['samples']} 采样点  "
          f"最小壁厚 {res['min_wall']} mm", flush=True)
    for k, v in res["area_by_threshold"].items():
        print(f"  壁厚 < {k} mm: {v:8.2f} mm²", flush=True)
    print(f"薄壁面积（< {min_t} mm）= {res['area_below']} mm²，"
          f"{len(res['clusters'])} 个区域", flush=True)
    for k, c in enumerate(res["clusters"][:top], 1):
        (x0, y0, z0), (x1, y1, z1) = c["bbox"]
        print(f"  #{k} {c['area']:7.2f} mm²  {c['samples']:5d} 点  "
              f"厚 {c['t_min']:.3f}–{c['t_max']:.3f}  "
              f"X {x0:6.2f}…{x1:6.2f}  Y {y0:6.2f}…{y1:6.2f}  "
              f"Z {z0:6.2f}…{z1:6.2f}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("stl", type=Path)
    ap.add_argument("--min", type=float, default=0.5, help="薄壁阈值 mm")
    ap.add_argument("--sample-area", type=float, default=0.5, help="每采样点代表面积")
    ap.add_argument("--link", type=float, default=1.5, help="聚类连接距离 mm")
    ap.add_argument("--top", type=int, default=10, help="输出前 N 个薄壁区域")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    res = analyze_stl(args.stl, args.min, args.sample_area, link=args.link)
    if args.json:
        print(json.dumps(res, ensure_ascii=False, indent=2))
    else:
        _print(res, args.min, args.top)


if __name__ == "__main__":
    main()
