"""Step 4 - clothing layer.

The fitted Anny body is an unclothed statistical body. The subject wears a hoodie, joggers, trainers
and a hair bun, so the unclothed surface sits a few centimetres inside the SAM 2 silhouettes. This
step estimates ONE static offset per vertex along the (smoothed) rest normal, shared by all 315
frames and all four cameras, so that the posed surface explains every silhouette:

  * for every (camera, frame) the posed mesh is rasterised, its outer-contour vertices are found,
    and each is compared with the signed distance field of the mask -> "move d_i by r / a";
  * observations are robustly averaged per vertex (Geman-McClure, graduated scale), so furniture
    occlusions, carried objects, mask leaks and single-frame pose errors are outvoted;
  * a sparse linear solve adds membrane smoothness, left/right symmetry and anatomical bounds
    (skin stays skin: hands and face barely move; soles are set so the shoes rest on the floor).

Because the offsets live in the rest pose and are skinned with the body, the clothing is the same
object in every frame - there is nothing per-frame that could flicker.
"""
import argparse, json, os, time
from multiprocessing import Pool

import cv2
import numpy as np
import scipy.sparse as sp
import scipy.sparse.linalg as spla
from scipy.sparse.csgraph import connected_components
from scipy.spatial import cKDTree

from body import Body
from common import CAMS, H, W, load_cameras, load_json, project, public_dir, work_dir
from gltf_io import vertex_normals
from masks import in_known, load_masks, paste
from render import Poser, bilinear, front_facing, raster_mask, sdf

G = {}


def setup(clip, fit_name="fit.npz"):
    wd = work_dir(clip)
    fit = np.load(os.path.join(wd, fit_name))
    body = Body()
    G.update(clip=clip, body=body, fit=fit, poser=Poser(body, fit), cams=load_cameras(clip), faces=body.faces.numpy(),
             masks=load_masks(clip), fps=float(load_json(os.path.join(public_dir(clip), "manifest.json"))["fps"]))
    return G


def window(e, px, pad=8):
    """Working window = mask box U model box, padded, clipped to the image.
    -> box, mask, known (1 where the mask is authoritative, see masks.clip_boxes)."""
    h, w = e["m"].shape
    ok = np.isfinite(px).all(1)
    x0 = int(np.floor(min(e["x0"], px[ok, 0].min()))) - pad; y0 = int(np.floor(min(e["y0"], px[ok, 1].min()))) - pad
    x1 = int(np.ceil(max(e["x0"] + w, px[ok, 0].max()))) + pad; y1 = int(np.ceil(max(e["y0"] + h, px[ok, 1].max()))) + pad
    x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, W), min(y1, H)
    m, known = paste(e, x0, y0, x1, y1)
    return (x0, y0, x1, y1), m, known


def silhouette(ci, k, v, n=None):
    """Posed + projected surface and its rasterised silhouette inside the mask window."""
    cam = G["cams"][CAMS[ci]]
    kf = k - cam["dt"] * G["fps"]                   # image k of this camera shows master time k - dt*fps
    out = G["poser"].pose(kf, v, n)
    P, Nn = out if n is not None else (out, None)
    px, z = project(cam, P)
    if (z < 0.3).mean() > 0.5:
        return None
    px = np.where((z > 0.3)[:, None], px, np.nan)
    ff, _ = front_facing(P, G["faces"], cam["C"])
    fsel = G["faces"][ff & (z[G["faces"]] > 0.3).all(1)]
    (x0, y0, x1, y1), m, known = window(G["masks"][(ci, k)], px)
    S = raster_mask(np.nan_to_num(px, nan=-1e4), fsel, m.shape, (x0, y0))
    # "Sk": the model silhouette where the mask can be compared with it
    return {"cam": cam, "P": P, "N": Nn, "px": px, "z": z, "S": S, "Sk": S & known, "m": m, "known": known, "box": (x0, y0, x1, y1)}


def pair_obs(args):
    ci, k, v, n, c_rob = args
    e = G["masks"][(ci, k)]
    r = silhouette(ci, k, v, n)
    if r is None:
        return None
    S, Sk, m, px, z, P, Nn, cam = r["S"], r["Sk"], r["m"], r["px"], r["z"], r["P"], r["N"], r["cam"]
    x0, y0, x1, y1 = r["box"]
    inter, union = int((Sk & m).sum()), int((Sk | m).sum())
    stat = {"ci": ci, "k": k, "iou": inter / max(union, 1), "model": int(Sk.sum()), "mask": int(m.sum()),
            "outside": int((Sk & (1 - m)).sum()), "carried": e["carried"]}
    if e["carried"] or stat["mask"] < 1200 or stat["iou"] < 0.45:
        return stat, None
    # outer-contour vertices of the model
    q = px - [x0, y0]
    hh, ww = m.shape
    ok = np.isfinite(q).all(1) & (q[:, 0] > 3) & (q[:, 1] > 3) & (q[:, 0] < ww - 4) & (q[:, 1] < hh - 4)
    ok &= in_known(e, np.nan_to_num(px, nan=-1e4), 4)      # no contour at the image border or where the mask was clipped
    idx = np.nonzero(ok)[0]
    din = cv2.distanceTransform(S, cv2.DIST_L2, 3)
    qi = np.round(q[idx]).astype(np.int64)
    idx = idx[din[qi[:, 1], qi[:, 0]] <= 1.9]
    if len(idx) < 30:
        return stat, None
    view = P[idx] - cam["C"]; view /= np.linalg.norm(view, axis=1, keepdims=True)
    nn = Nn[idx] / np.maximum(np.linalg.norm(Nn[idx], axis=1, keepdims=True), 1e-9)
    idx = idx[np.abs((nn * view).sum(1)) < 0.55]
    # image motion of each vertex per metre of offset
    eps = 2e-3
    p1, _ = project(cam, P[idx] + eps * Nn[idx])
    jn = (p1 - px[idx]) / eps                                   # (n, 2) px per metre
    jl = np.linalg.norm(jn, axis=1)
    phi = sdf(np.maximum(m, 1 - r["known"]))               # the straight cut of a clipped mask is not an outline
    phis = cv2.GaussianBlur(phi, (0, 0), 1.0)
    gy, gx = np.gradient(phis)
    qv = q[idx]
    f = bilinear(phi, qv)
    g = np.stack([bilinear(gx, qv), bilinear(gy, qv)], 1)
    g /= np.maximum(np.linalg.norm(g, axis=1, keepdims=True), 1e-6)
    a = (g * jn).sum(1)                                         # d(phi)/d(offset)  [px / m]
    cosn = a / np.maximum(jl, 1e-6)
    good = (cosn > 0.45) & (jl > 30)
    idx, f, a, jl, cosn = idx[good], f[good], a[good], jl[good], cosn[good]
    r_m = f / jl                                                # signed residual in metres (+ = model outside mask)
    wgt = 1.0 / (1.0 + (r_m / c_rob) ** 2) ** 2
    wgt *= (np.abs(r_m) < 0.16) * cosn ** 2 * np.clip(jl / 150.0, 0.3, 1.5)
    step = -f / a
    return stat, (idx.astype(np.int32), step.astype(np.float32), wgt.astype(np.float32))


def build_static(body, v0):
    """Mesh operators and anatomical priors (all in the rest pose)."""
    F = body.faces.numpy(); V = len(v0)
    A = sp.coo_matrix((np.ones(F.size), (F.reshape(-1), F[:, [1, 2, 0]].reshape(-1))), shape=(V, V)).tocsr()
    A = ((A + A.T) > 0).astype(np.float64)
    ncomp, lab = connected_components(A, directed=False)
    main = lab == np.argmax(np.bincount(lab))
    # cotangent membrane
    I, J, Wc = [], [], []
    for a, b, c in ((0, 1, 2), (1, 2, 0), (2, 0, 1)):
        e1, e2 = v0[F[:, a]] - v0[F[:, c]], v0[F[:, b]] - v0[F[:, c]]
        cot = (e1 * e2).sum(1) / np.maximum(np.linalg.norm(np.cross(e1, e2), axis=1), 1e-12)
        I.append(F[:, a]); J.append(F[:, b]); Wc.append(np.clip(0.5 * cot, 0.02, 3.0))
    I, J, Wc = np.concatenate(I), np.concatenate(J), np.concatenate(Wc)
    Wm = sp.coo_matrix((Wc, (I, J)), shape=(V, V)).tocsr(); Wm = Wm + Wm.T
    L = sp.diags(np.asarray(Wm.sum(1)).ravel()) - Wm
    area = np.zeros(V)
    fa = 0.5 * np.linalg.norm(np.cross(v0[F[:, 1]] - v0[F[:, 0]], v0[F[:, 2]] - v0[F[:, 0]]), axis=1)
    for i in range(3):
        np.add.at(area, F[:, i], fa / 3)
    # displacement directions: smoothed rest normals
    n = vertex_normals(v0, F)
    Dinv = sp.diags(1.0 / np.maximum(np.asarray(A.sum(1)).ravel(), 1))
    for _ in range(6):
        n = 0.5 * n + 0.5 * (Dinv @ (A @ n))
        n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-9)
    # left/right mirror map
    tree = cKDTree(v0)
    dm, mirror = tree.query(v0 * [-1, 1, 1])
    mirror = np.where(dm < 0.004, mirror, np.arange(V))
    # free space in front of each vertex (keeps opposite surfaces from passing through each other)
    gap = np.full(V, 1.0)
    nb = tree.query_ball_point(v0, 0.16)
    for i in range(V):
        j = np.asarray(nb[i]); dv = v0[j] - v0[i]
        along = dv @ n[i]
        lat = np.linalg.norm(dv - along[:, None] * n[i], axis=1)
        sel = (along > 0.004) & (lat < 0.6 * along + 0.01) & ((n[j] @ n[i]) < -0.2)
        if sel.any():
            gap[i] = along[sel].min()
    dom = body.wi[:, 0].numpy()
    lbl = np.array(body.labels)[dom]
    hand = np.array([("Hand" in s) for s in lbl])
    foot = np.array([("Foot" in s or "Toe" in s) for s in lbl])
    head = np.array([s in ("Head",) for s in lbl])
    neck = np.array([s in ("Neck",) for s in lbl])
    nr = vertex_normals(v0, F)
    ymin = v0[:, 1].min()
    sole = foot & (nr[:, 1] < -0.6) & (v0[:, 1] < ymin + 0.035)
    hy0, hy1 = v0[head, 1].min(), v0[head, 1].max()
    yrel = (v0[:, 1] - hy0) / (hy1 - hy0)
    face = head & (nr[:, 2] > 0.25) & (yrel > 0.12) & (yrel < 0.80)          # forehead .. chin, front
    lo = np.full(V, -0.012); hi = np.full(V, 0.10)
    lo[hand], hi[hand] = -0.002, 0.004
    lo[face], hi[face] = -0.004, 0.006
    lo[foot], hi[foot] = 0.0, 0.035
    hi[head & ~face] = 0.09
    hi = np.minimum(hi, np.maximum(0.42 * gap, 0.003))
    # shoes: the upper is at least 6 mm thick everywhere and is not limited by the gaps between the bare
    # toes, so the toes merge into one toe box instead of showing through
    upper = foot & ~sole
    lo[upper], hi[upper] = 0.006, 0.035
    d0 = np.full(V, 0.012); d0[hand] = 0.0; d0[face] = 0.0; d0[foot] = 0.012
    lam0 = np.full(V, 0.02); lam0[hand] = 3.0; lam0[face] = 2.0
    return {"A": A, "L": L, "area": area, "n": n, "mirror": mirror, "gap": gap, "main": main, "lab": lab, "lo": lo, "hi": hi,
            "d0": d0, "lam0": lam0, "sole": sole, "hand": hand, "foot": foot, "face": face, "head": head}


def solve(st, tgt, wsum, sole_d, lam_smooth, lam_sym=0.4):
    V = len(tgt)
    area = st["area"] / st["area"].mean()
    wn = wsum / max(np.median(wsum[wsum > 0]), 1e-9)
    wn = np.clip(wn, 0, 3.0) * st["main"]
    lam0 = st["lam0"].copy(); d0 = st["d0"].copy()
    lam0[st["sole"]] = 50.0; d0[st["sole"]] = sole_d
    lam0[~st["main"]] = 100.0; d0[~st["main"]] = 0.0
    Pm = sp.coo_matrix((np.ones(V), (np.arange(V), st["mirror"])), shape=(V, V)).tocsr()
    Sm = sp.identity(V) - Pm
    scale = lam_smooth / st["area"].mean()                       # membrane in the same units as the area-weighted data term
    Asys = sp.diags(area * (wn + lam0)) + scale * st["L"] + lam_sym * (Sm.T @ sp.diags(area) @ Sm)
    rhs = area * (wn * tgt + lam0 * d0)
    d = spla.spsolve(Asys.tocsc(), rhs)
    for _ in range(2):                                           # bounds: clamp, pin, re-solve
        viol = (d < st["lo"]) | (d > st["hi"])
        if not viol.any():
            break
        dc = np.clip(d, st["lo"], st["hi"])
        pin = np.where(viol, 30.0, 0.0)
        d = spla.spsolve((Asys + sp.diags(area * pin)).tocsc(), rhs + area * pin * dc)
    return np.clip(d, st["lo"], st["hi"])


def displaced(st, v0, d):
    """Apply offsets; loose inner parts (eyes, tongue) follow the surrounding skin rigidly."""
    v = v0 + d[:, None] * st["n"]
    main = st["main"]
    if (~main).any():
        tree = cKDTree(v0[main]); mi = np.nonzero(main)[0]
        for c in np.unique(st["lab"][~main]):
            sel = st["lab"] == c
            _, nn = tree.query(v0[sel].mean(0), k=24)
            v[sel] = v0[sel] + (v[mi[nn]] - v0[mi[nn]]).mean(0)
    return v


def evaluate(pool, v, n, pairs):
    res = pool.map(pair_obs, [(ci, k, v, n, 0.05) for ci, k in pairs], chunksize=8)
    return [r[0] for r in res if r is not None]


def summarise(stats):
    out = {}
    for ci, c in enumerate(CAMS):
        s = [x for x in stats if x["ci"] == ci and not x["carried"] and x["mask"] >= 1200]
        if s:
            out[c] = {"n": len(s), "medianIoU": round(float(np.median([x["iou"] for x in s])), 3),
                      "p10IoU": round(float(np.percentile([x["iou"] for x in s], 10)), 3)}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clip", default="clip02")
    ap.add_argument("--fit", default="fit.npz")
    ap.add_argument("--iters", type=int, default=7)
    ap.add_argument("--procs", type=int, default=3)
    ap.add_argument("--out", default="shape.npz")
    a = ap.parse_args()
    t0 = time.time()
    setup(a.clip, a.fit)
    body, poser = G["body"], G["poser"]
    v0 = poser.v0
    st = build_static(body, v0)
    pairs = sorted(G["masks"].keys())
    fit = G["fit"]
    # soles: the pose fit keeps bare soles this far above the floor; the shoe sole fills that gap
    sole_d = float(np.clip(json.load(open(os.path.join(work_dir(a.clip), "fit_metrics.json")))["reprojection"]["soleMinY"]["median"], 0.008, 0.03))
    print(f"static ready in {time.time() - t0:.1f}s; pairs {len(pairs)}; sole offset {sole_d:.3f} m; gap-limited verts {(st['gap'] < 0.2).sum()}", flush=True)
    d = np.zeros(len(v0))
    V = len(v0)
    with Pool(a.procs) as pool:
        base = evaluate(pool, displaced(st, v0, d), st["n"], pairs)
        print("unclothed body:", summarise(base), flush=True)
        d = np.clip(st["d0"], st["lo"], st["hi"]); d[st["sole"]] = sole_d
        for it in range(a.iters):
            c_rob = [0.06, 0.05, 0.04, 0.03, 0.025, 0.02, 0.02, 0.02][min(it, 7)]
            lam = [3e-3, 2e-3, 1.5e-3, 1e-3, 8e-4, 6e-4, 6e-4, 6e-4][min(it, 7)]
            v = displaced(st, v0, d)
            res = pool.map(pair_obs, [(ci, k, v, st["n"], c_rob) for ci, k in pairs], chunksize=8)
            wsum, acc, nobs = np.zeros(V), np.zeros(V), 0
            for r in res:
                if r is None or r[1] is None:
                    continue
                idx, step, wgt = r[1]
                np.add.at(wsum, idx, wgt); np.add.at(acc, idx, wgt * step); nobs += len(idx)
            tgt = d + np.where(wsum > 0, acc / np.maximum(wsum, 1e-9), 0.0)
            d_new = solve(st, tgt, wsum, sole_d, lam)
            stats = [r[0] for r in res if r is not None]
            print(f"it {it}: obs {nobs}, verts with data {(wsum > 0).sum()}, mean |step| {np.abs(d_new - d).mean() * 1000:.2f} mm, "
                  f"d p5/50/95 {np.percentile(d_new, [5, 50, 95]).round(4).tolist()}  {summarise(stats)}  [{time.time() - t0:.0f}s]", flush=True)
            d = d_new
        v = displaced(st, v0, d)
        final = evaluate(pool, v, st["n"], pairs)
    print("clothed body:", summarise(final), flush=True)
    np.savez_compressed(os.path.join(work_dir(a.clip), a.out), v=v.astype(np.float32), d=d.astype(np.float32), n=st["n"].astype(np.float32),
                        wsum=wsum.astype(np.float32))
    with open(os.path.join(work_dir(a.clip), "shape_metrics.json"), "w") as fh:
        json.dump({"unclothed": summarise(base), "clothed": summarise(final),
                   "offsetM": {"p05": float(np.percentile(d, 5)), "median": float(np.median(d)), "p95": float(np.percentile(d, 95)), "max": float(d.max())},
                   "perPair": [{"cam": CAMS[s["ci"]], "k": s["k"], "iou": round(s["iou"], 4), "carried": s["carried"]} for s in final]}, fh)
    print(f"done in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
