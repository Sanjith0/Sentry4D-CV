"""Floor of the LiDAR room scan under the subject.

The cameras are calibrated against the room scan and the fit keeps the soles on "the floor". The
scanned floor, however, is not the plane y = 0: phone LiDAR drifts by a few centimetres between
scan patches (here -1 .. +4 cm along the subject's path). A body standing on y = 0 would sink into
the floor the viewer draws, so the floor terms of the fit use the scanned height under the person.

The scan is read straight from public/assets/room.glb and moved into the room frame exactly like
src/scene/RoomModel.tsx does (auto-grounding on the `interior` box of src/config/roomConfig.ts).
"""
import json, os, re, struct
import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree

from common import ROOT as REPO

_COMP = {5121: np.uint8, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
_NUM = {"SCALAR": 1, "VEC2": 2, "VEC3": 3}


def room_offset():
    """Translation RoomModel.tsx applies to the raw scan (scale 1, no rotation, autoGround)."""
    src = open(os.path.join(REPO, "src", "config", "roomConfig.ts")).read()
    cfg = src[src.index("export const roomConfig"):]
    vec = r"\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]"
    if not re.search(r"scale:\s*1\s*,", cfg) or not re.search(r"rotationDeg:\s*\[\s*0\s*,\s*0\s*,\s*0\s*\]", cfg) \
            or not re.search(r"autoGround:\s*true", cfg):
        raise NotImplementedError("roomConfig.transform is no longer scale 1 / no rotation / autoGround")
    m = re.search(r"interior:\s*\{\s*min:\s*" + vec + r"\s*,\s*max:\s*" + vec, cfg)
    if not m:
        raise NotImplementedError("roomConfig.interior not found")
    v = np.array([float(x) for x in m.groups()])
    mn, mx = v[:3], v[3:]
    pos = re.search(r"position:\s*" + vec, cfg)
    extra = np.array([float(x) for x in pos.groups()]) if pos else np.zeros(3)
    return np.array([-(mn[0] + mx[0]) / 2, -mn[1], -(mn[2] + mx[2]) / 2]) + extra


def load_room():
    """Vertices (room frame) and triangles of the scan."""
    with open(os.path.join(REPO, "public", "assets", "room.glb"), "rb") as fh:
        fh.read(12)
        n, _ = struct.unpack("<I4s", fh.read(8))
        js = json.loads(fh.read(n))
        n, _ = struct.unpack("<I4s", fh.read(8))
        buf = fh.read(n)
    if any("matrix" in nd or "translation" in nd or "rotation" in nd or "scale" in nd for nd in js["nodes"]):
        raise NotImplementedError("room.glb has node transforms")

    def acc(i):
        a = js["accessors"][i]; bv = js["bufferViews"][a["bufferView"]]
        k = _NUM[a["type"]]
        arr = np.frombuffer(buf, _COMP[a["componentType"]], a["count"] * k, bv.get("byteOffset", 0) + a.get("byteOffset", 0))
        return arr.reshape(-1, k) if k > 1 else arr

    V, F, base = [], [], 0
    for mesh in js["meshes"]:
        for p in mesh["primitives"]:
            if p.get("mode", 4) != 4:
                continue
            v = acc(p["attributes"]["POSITION"]).astype(np.float64)
            F.append(acc(p["indices"]).astype(np.int64).reshape(-1, 3) + base)
            V.append(v); base += len(v)
    return np.concatenate(V) + room_offset(), np.concatenate(F)


class ScanFloor:
    """Height of the scanned floor at a point: area-weighted median of the near-horizontal scan
    triangles within `radius` that lie within `band` of the nominal floor y = 0."""

    def __init__(self, band=(-0.10, 0.12)):
        V, F = load_room()
        tri = V[F]
        n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
        area = np.linalg.norm(n, axis=1)
        c = tri.mean(1)
        up = (n[:, 1] > 0.9 * np.maximum(area, 1e-12)) & (c[:, 1] > band[0]) & (c[:, 1] < band[1])
        self.xz, self.y, self.w = c[up][:, [0, 2]], c[up, 1], area[up] / 2
        self.tree = cKDTree(self.xz)

    def height(self, xz, radius=0.35):
        out = np.full(len(xz), np.nan)
        for i, idx in enumerate(self.tree.query_ball_point(np.asarray(xz, float), radius)):
            if len(idx) < 8:
                continue
            idx = np.asarray(idx)
            o = np.argsort(self.y[idx]); cw = np.cumsum(self.w[idx][o])
            out[i] = self.y[idx][o][np.searchsorted(cw, 0.5 * cw[-1])]
        return out


def floor_map(path_xz, margin=0.8, cell=0.05, limit=(-0.03, 0.05), sigma=0.15):
    """Smooth height map of the scanned floor around a path of floor points (N, 2) = (x, z).

    Cells within `margin` of the path take the scan height (ScanFloor.height), holes and the cells
    farther away take the nearest measured cell; the map is limited to `limit` (a scan patch that is
    off by more than that is furniture or an error, not floor) and blurred with `sigma` so that a foot
    crossing a seam between scan patches does not step. Returns {"grid": (nz, nx), "origin": [x0, z0, cell]}."""
    path_xz = np.asarray(path_xz, float)
    lo = path_xz.min(0) - margin
    n = np.ceil((path_xz.max(0) + margin - lo) / cell).astype(int) + 1
    X, Z = np.meshgrid(lo[0] + cell * np.arange(n[0]), lo[1] + cell * np.arange(n[1]))
    pts = np.stack([X.ravel(), Z.ravel()], 1)
    near = cKDTree(path_xz).query(pts)[0] < margin
    h = np.full(len(pts), np.nan)
    h[near] = ScanFloor().height(pts[near])
    ok = np.isfinite(h)
    if not ok.any():
        raise FileNotFoundError("no scanned floor under the path")
    h[~ok] = h[ok][cKDTree(pts[ok]).query(pts[~ok])[1]]
    grid = ndimage.gaussian_filter(np.clip(h, *limit).reshape(n[1], n[0]), sigma / cell, mode="nearest")
    return {"grid": grid.astype(np.float32), "origin": np.array([lo[0], lo[1], cell], np.float32)}


def sample_floor(grid, origin, xz):
    """Bilinear lookup of a floor_map at points (..., 2) = (x, z); clamped at the border.
    `grid` None (no map) means the nominal floor plane y = 0."""
    xz = np.asarray(xz, float)
    if grid is None:
        return np.zeros(xz.shape[:-1])
    x0, z0, cell = [float(v) for v in origin]
    nz, nx = grid.shape
    u = np.clip((xz[..., 0] - x0) / cell, 0, nx - 1.001); v = np.clip((xz[..., 1] - z0) / cell, 0, nz - 1.001)
    i, j = np.floor(u).astype(int), np.floor(v).astype(int)
    a, b = u - i, v - j
    return (1 - b) * ((1 - a) * grid[j, i] + a * grid[j, i + 1]) + b * ((1 - a) * grid[j + 1, i] + a * grid[j + 1, i + 1])


def fit_floor(fit):
    """(grid, origin) stored in a fit.npz by refine.py, or (None, None) for a fit on the nominal plane."""
    return (fit["floor_grid"], fit["floor_origin"]) if "floor_grid" in fit.files else (None, None)


def smooth(x, k=5):
    """Hann-weighted moving average over k frames of an (N, D) series."""
    if k <= 1:
        return x
    pad = k // 2
    xp = np.concatenate([np.repeat(x[:1], pad, 0), x, np.repeat(x[-1:], pad, 0)])
    ker = np.hanning(k + 2)[1:-1]; ker /= ker.sum()
    return np.stack([np.convolve(xp[:, i], ker, mode="valid") for i in range(x.shape[1])], 1)


def floor_point(kp3, root, k=5):
    """(N, 2) = (x, z) of the point on the floor under the body: halfway between the pelvis and the
    ankles, smoothed over k frames."""
    return smooth(0.5 * kp3[:, [15, 16]].mean(1)[:, [0, 2]] + 0.5 * np.asarray(root)[:, [0, 2]], k)


def fit_lift(fit):
    """Height (N,) by which each frame of a fit.npz is shown above where the cameras see it, so that it
    stands on the scanned floor (Fitter.set_floor); zeros for a fit on the nominal plane."""
    return fit["lift"].astype(np.float64) if "lift" in fit.files else np.zeros(len(fit["root_pos"]))


def to_room(fit, P):
    """Points (N, ..., 3) of the frames of a fit -> room coordinates (the lift added to y)."""
    P = np.array(P, dtype=np.float64)
    P[..., 1] += fit_lift(fit).reshape((-1,) + (1,) * (P.ndim - 2))
    return P


if __name__ == "__main__":
    import argparse
    from common import work_dir
    ap = argparse.ArgumentParser()
    ap.add_argument("--clip", default="clip02")
    a = ap.parse_args()
    fit = np.load(os.path.join(work_dir(a.clip), "fit.npz"))
    fm = floor_map(fit["root_pos"][:, [0, 2]])
    h = sample_floor(fm["grid"], fm["origin"], floor_point(fit["kp3"], fit["root_pos"]))
    print("floor map", fm["grid"].shape, "cells of", float(fm["origin"][2]), "m")
    print("scanned floor under the subject (m): min %.3f median %.3f max %.3f" % (h.min(), np.median(h), h.max()))
    print(np.round(h[::10], 3).tolist())
