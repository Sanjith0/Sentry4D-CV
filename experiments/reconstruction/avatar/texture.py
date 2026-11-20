"""Step 5 - multi-view, multi-frame texture.

Every texel of the body's UV atlas is a fixed point on the subject. For each (camera, frame) the
posed mesh is z-buffered at footage resolution, every visible texel is projected into the frame and
its colour is accumulated with a weight (viewing angle, pixel footprint, SAM 2 alpha, occlusion
edges). Colours are fused over all frames and cameras in passes:

  1.  weighted mean per camera -> per-camera colour maps (the phones white-balance differently)
  1b. mean of the clean views  -> starting consensus from the frames before anything is carried, so a
                                  laptop or chair held in front of the body cannot become clothing
  2.  robust consensus         -> outvotes carried objects, mask leaks and pose errors
  3.  sharpened robust fusion  -> the best (most frontal / closest) views dominate, keeping detail

Texels no camera ever saw (soles, inner thighs, under the arms) are filled by harmonic diffusion
over the mesh, seeded from the mirrored side where that was observed, and are reported as inferred.
"""
import argparse, json, os, time
from multiprocessing import Pool

import cv2
import numpy as np
import scipy.sparse as sp
import scipy.sparse.linalg as spla
from scipy import ndimage

from body import Body
from common import CAMS, H, W, clip_dir, load_cameras, load_json, project, public_dir, work_dir
from masks import load_masks
from render import Poser, face_normals, raster_ids

G = {}


def build_atlas(body, S):
    """Texel centre -> (face, barycentric) of the UV layout (no overlaps in the Anny atlas)."""
    uv = body.uv.numpy(); fuv = body.face_uv.numpy()
    tri = uv[fuv]
    p = np.stack([tri[..., 0] * S, (1 - tri[..., 1]) * S], -1)
    tf = -np.ones((S, S), np.int32); tb = np.zeros((S, S, 3), np.float32)
    for fi, t in enumerate(p):
        x0, y0 = np.floor(t.min(0)).astype(int); x1, y1 = np.ceil(t.max(0)).astype(int) + 1
        x0, y0 = max(x0, 0), max(y0, 0); x1, y1 = min(x1, S), min(y1, S)
        if x1 <= x0 or y1 <= y0:
            continue
        xs, ys = np.meshgrid(np.arange(x0, x1) + 0.5, np.arange(y0, y1) + 0.5)
        a, b, c = t
        den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
        if abs(den) < 1e-12:
            continue
        l0 = ((b[1] - c[1]) * (xs - c[0]) + (c[0] - b[0]) * (ys - c[1])) / den
        l1 = ((c[1] - a[1]) * (xs - c[0]) + (a[0] - c[0]) * (ys - c[1])) / den
        l2 = 1 - l0 - l1
        ins = (l0 >= -1e-4) & (l1 >= -1e-4) & (l2 >= -1e-4)
        sub = tf[y0:y1, x0:x1]
        new = ins & (sub < 0)
        sub[new] = fi
        tb[y0:y1, x0:x1][new] = np.stack([l0, l1, l2], -1)[new]
    return tf, tb


def setup(clip, S, fit_name="fit.npz"):
    wd = work_dir(clip)
    fit = np.load(os.path.join(wd, fit_name))
    body = Body()
    poser = Poser(body, fit)
    sp_ = os.path.join(wd, "shape.npz")
    v = np.load(sp_)["v"].astype(np.float64) if os.path.exists(sp_) else poser.v0
    tf, tb = build_atlas(body, S)
    ty, tx = np.nonzero(tf >= 0)
    t_face = tf[ty, tx]; t_bary = tb[ty, tx].astype(np.float64)
    order = np.argsort(t_face, kind="stable")
    starts = np.searchsorted(t_face[order], np.arange(len(body.faces) + 1))
    G.update(clip=clip, body=body, fit=fit, poser=poser, v=v, cams=load_cameras(clip), faces=body.faces.numpy(), S=S,
             masks=load_masks(clip), fps=float(load_json(os.path.join(public_dir(clip), "manifest.json"))["fps"]),
             tf=tf, ty=ty, tx=tx, t_face=t_face, t_bary=t_bary, f_order=order, f_starts=starts, mu=None, gains=np.ones((4, 3)),
             offs=np.zeros((4, 3)),
             power=1.0, sigma=40.0)
    return G


def view_obs(pair):
    """Visible texels of one (camera, frame): indices into the valid-texel list, BGR colours, weights."""
    ci, k = pair
    e = G["masks"][(ci, k)]
    cam = G["cams"][CAMS[ci]]
    faces = G["faces"]
    P = G["poser"].pose(k - cam["dt"] * G["fps"], G["v"])
    px, z = project(cam, P)
    if (z < 0.3).any():
        return None
    h, w = e["m"].shape
    x0, y0 = e["x0"], e["y0"]
    fn = face_normals(P, faces)
    fc = P[faces].mean(1)
    view = cam["C"][None] - fc
    dist = np.linalg.norm(view, axis=1)
    cosv = (fn * view).sum(1) / np.maximum(np.linalg.norm(fn, axis=1) * dist, 1e-12)
    fpx = px[faces]
    inb = (fpx[..., 0].max(1) > x0) & (fpx[..., 0].min(1) < x0 + w) & (fpx[..., 1].max(1) > y0) & (fpx[..., 1].min(1) < y0 + h)
    sel = np.nonzero((cosv > 0) & inb)[0]
    if len(sel) < 50:
        return None
    ids = raster_ids(px, z, faces[sel], (h, w), (x0, y0), face_ids=sel)
    zf = z[faces].mean(1)
    D = np.where(ids >= 0, zf[np.maximum(ids, 0)], 50.0).astype(np.float32)
    ker = np.ones((5, 5), np.uint8)
    edge = (cv2.dilate(D, ker) - cv2.erode(D, ker)) > 0.07                      # occlusion boundaries (incl. outline)
    m_er = cv2.erode(e["m"], np.ones((3, 3), np.uint8), iterations=2)
    usable = (ids >= 0) & (m_er > 0) & ~edge
    vis_faces = np.unique(ids[usable])
    vis_faces = vis_faces[(vis_faces >= 0)]
    vis_faces = vis_faces[cosv[vis_faces] > 0.2]
    if len(vis_faces) == 0:
        return None
    st, od = G["f_starts"], G["f_order"]
    cnt = st[vis_faces + 1] - st[vis_faces]
    tidx = od[np.concatenate([np.arange(st[f], st[f + 1]) for f in vis_faces])] if cnt.sum() else np.zeros(0, np.int64)
    if len(tidx) == 0:
        return None
    tfc = G["t_face"][tidx]; bary = G["t_bary"][tidx]
    X = (P[faces[tfc]] * bary[..., None]).sum(1)
    q, zt = project(cam, X)
    qx, qy = q[:, 0] - x0, q[:, 1] - y0
    ix, iy = np.floor(qx + 0.5).astype(np.int64), np.floor(qy + 0.5).astype(np.int64)
    ok = (ix >= 1) & (iy >= 1) & (ix < w - 1) & (iy < h - 1)
    ok[ok] &= usable[iy[ok], ix[ok]]
    ok[ok] &= np.abs(zt[ok] - D[iy[ok], ix[ok]]) < 0.04
    if not ok.any():
        return None
    tidx, tfc, qx, qy, zt = tidx[ok], tfc[ok], qx[ok], qy[ok], zt[ok]
    img = G["frame_cache"](ci, k)
    crop = img[y0:y0 + h, x0:x0 + w].astype(np.float32)
    fx, fy = np.clip(qx, 0, w - 1.001), np.clip(qy, 0, h - 1.001)
    jx, jy = np.floor(fx).astype(np.int64), np.floor(fy).astype(np.int64)
    ax, ay = (fx - jx)[:, None], (fy - jy)[:, None]
    col = (crop[jy, jx] * (1 - ax) * (1 - ay) + crop[jy, jx + 1] * ax * (1 - ay) + crop[jy + 1, jx] * (1 - ax) * ay + crop[jy + 1, jx + 1] * ax * ay)
    c = cosv[tfc]
    res = cam["f"] / zt                                                         # footage pixels per metre at the texel
    wgt = np.clip((c - 0.2) / 0.8, 0, 1) ** 1.5 * np.clip(res / 250.0, 0.15, 2.0) ** 2
    if e["carried"]:
        wgt *= 0.35
    col = np.clip(col * G["gains"][ci][None] + G["offs"][ci][None], 0, 255)
    if G["mu"] is not None:                                                     # robust re-weighting around the consensus
        dlt = np.linalg.norm(col - G["mu"][tidx], axis=1)
        known = G["mu_w"][tidx] > 0
        rob = np.where(known, 1.0 / (1.0 + (dlt / G["sigma"]) ** 2) ** 2, 1.0)
        wgt = wgt ** G["power"] * rob
    return ci, tidx.astype(np.int32), col.astype(np.float32), wgt.astype(np.float32)


def _frame(ci, k):
    return cv2.imread(os.path.join(clip_dir(G["clip"]), "frames", CAMS[ci], f"{k:04d}.png"))


def run_pass(pairs, procs, per_cam=False):
    T = len(G["t_face"])
    nacc = 4 if per_cam else 1
    acc = np.zeros((nacc, T, 3), np.float64); wsum = np.zeros((nacc, T), np.float64); nviews = np.zeros(T, np.int32)
    G["frame_cache"] = _frame
    with Pool(procs) as pool:
        for r in pool.imap_unordered(view_obs, pairs, chunksize=4):
            if r is None:
                continue
            ci, tidx, col, wgt = r
            a = ci if per_cam else 0
            acc[a, tidx] += col * wgt[:, None]
            wsum[a, tidx] += wgt
            nviews[tidx] += wgt > 1e-4
    return acc, wsum, nviews


def colour_consensus(mean_c, wsum, iters=4):
    """Per-camera, per-channel affine maps (gain, offset) that bring the cameras' renditions of the
    same texels into agreement; normalised so the weighted average map is the identity (no camera is
    singled out as the reference). Fitted on binned medians, so the dark clothing does not swamp the
    few bright texels (skin, soles, shirt hem)."""
    C = mean_c.shape[0]
    g, o = np.ones((C, 3)), np.zeros((C, 3))
    wn = np.stack([wsum[c] / max(np.median(wsum[c][wsum[c] > 0]), 1e-9) if (wsum[c] > 0).any() else wsum[c] for c in range(C)])
    wn = np.clip(wn, 0, 3)
    good = wn > 0.3
    for _ in range(iters):
        corr = np.clip(mean_c * g[:, None, :] + o[:, None, :], 0, 255)
        for c in range(C):
            others = [k for k in range(C) if k != c]
            wo = np.stack([wn[k] * good[k] for k in others]).sum(0)
            sel = good[c] & (wo > 0.3)
            if sel.sum() < 3000:
                continue
            ref = sum((corr[k] * (wn[k] * good[k])[:, None]) for k in others)[sel] / wo[sel, None]
            x = mean_c[c][sel]
            for ch in range(3):
                edges = np.unique(np.percentile(x[:, ch], np.linspace(0, 100, 15)))
                bx, by, bw = [], [], []
                for lo, hi in zip(edges[:-1], edges[1:]):
                    m = (x[:, ch] >= lo) & (x[:, ch] <= hi)
                    if m.sum() > 50:
                        bx.append(np.median(x[m, ch])); by.append(np.median(ref[m, ch])); bw.append(1.0)
                # extra bins for the bright tail
                for lo, hi in ((90, 130), (130, 180), (180, 256)):
                    m = (x[:, ch] >= lo) & (x[:, ch] < hi)
                    if m.sum() > 150:
                        bx.append(np.median(x[m, ch])); by.append(np.median(ref[m, ch])); bw.append(2.0)
                if len(bx) < 3:
                    continue
                gg, oo = np.polyfit(bx, by, 1, w=np.sqrt(bw))
                g[c, ch] = np.clip(0.5 * g[c, ch] + 0.5 * gg, 0.6, 1.6); o[c, ch] = np.clip(0.5 * o[c, ch] + 0.5 * oo, -30, 30)
        tot = np.array([wn[c].sum() for c in range(C)]); tot = tot / tot.sum()
        ga, oa = (g * tot[:, None]).sum(0), (o * tot[:, None]).sum(0)
        g, o = g / ga, (o - oa) / ga
    return g, o


def vertex_fill(body, st_v, colour, weight, mirror):
    """Harmonic fill of per-vertex colours where nothing was observed."""
    F = body.faces.numpy(); V = len(st_v)
    A = sp.coo_matrix((np.ones(F.size), (F.reshape(-1), F[:, [1, 2, 0]].reshape(-1))), shape=(V, V)).tocsr()
    A = ((A + A.T) > 0).astype(np.float64)
    L = sp.diags(np.asarray(A.sum(1)).ravel()) - A
    wn = weight / max(np.percentile(weight[weight > 0], 50), 1e-9)
    conf = np.clip(wn, 0, 1)
    # mirrored observation as a weak prior
    mconf = 0.15 * conf[mirror] * (conf < 0.05)
    data_w = conf * 20.0 + mconf
    rhs = (conf * 20.0)[:, None] * colour + mconf[:, None] * colour[mirror]
    Asys = (sp.diags(data_w + 1e-6) + L).tocsc()
    lu = spla.splu(Asys)
    return np.stack([lu.solve(rhs[:, i]) for i in range(3)], 1), conf


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clip", default="clip02")
    ap.add_argument("--size", type=int, default=1024)
    ap.add_argument("--procs", type=int, default=3)
    ap.add_argument("--stride", type=int, default=1)
    ap.add_argument("--fit", default="fit.npz")
    a = ap.parse_args()
    t0 = time.time()
    setup(a.clip, a.size, a.fit)
    wd = work_dir(a.clip)
    body = G["body"]; S = a.size; T = len(G["t_face"])
    pairs = [p for p in sorted(G["masks"].keys()) if p[1] % a.stride == 0]
    print(f"atlas {S}x{S}: {T} texels on the surface ({T / S / S:.1%}); {len(pairs)} views  [{time.time() - t0:.0f}s]", flush=True)

    # pass 1: per-camera means -> per-camera affine colour maps towards the cross-camera consensus
    acc, wsum, nv = run_pass(pairs, a.procs, per_cam=True)
    cover = (wsum > 0).mean(1)
    mean_c = acc / np.maximum(wsum[..., None], 1e-9)
    gains, offs = colour_consensus(mean_c, wsum)
    print(f"pass 1 done [{time.time() - t0:.0f}s]; texel coverage per camera {cover.round(3).tolist()}; "
          f"gains (BGR) {gains.round(3).tolist()} offsets {offs.round(1).tolist()}", flush=True)
    G["gains"], G["offs"] = gains, offs
    corr = np.clip(mean_c * gains[:, None, :] + offs[:, None, :], 0, 255)
    mu = (corr * wsum[..., None]).sum(0) / np.maximum(wsum.sum(0)[:, None], 1e-9)
    mu_w = wsum.sum(0)

    # pass 1b: the views recorded before the subject picks anything up define the starting consensus.
    # Later he carries a laptop and a white chair in front of his body inside the SAM 2 mask; a plain
    # mean would bake them into the clothing, whereas a clean starting point lets the robust passes
    # reject them as outliers. Texels never seen in the clean views keep the all-view mean.
    first_carry = min([k for (ci, k), e in G["masks"].items() if e["carried"]], default=None)
    clean = [p for p in pairs if first_carry is not None and p[1] < first_carry]
    n_clean = 0
    if len(clean) >= 40:
        acc_c, wsum_c, _ = run_pass(clean, a.procs)
        has = wsum_c[0] > 1e-3
        mu = np.where(has[:, None], acc_c[0] / np.maximum(wsum_c[0][:, None], 1e-9), mu)
        n_clean = len(clean)
        print(f"pass 1b done [{time.time() - t0:.0f}s]; {n_clean} clean views (frames < {first_carry}) cover {has.mean():.1%} of the texels", flush=True)
    G["mu"], G["mu_w"] = mu.astype(np.float32), mu_w.astype(np.float32)

    # pass 2: robust consensus
    G["power"], G["sigma"] = 1.0, 45.0
    acc, wsum, nv = run_pass(pairs, a.procs)
    mu = acc[0] / np.maximum(wsum[0][:, None], 1e-9)
    G["mu"], G["mu_w"] = mu.astype(np.float32), wsum[0].astype(np.float32)
    print(f"pass 2 done [{time.time() - t0:.0f}s]", flush=True)

    # pass 3: sharpened, robust
    G["power"], G["sigma"] = 3.0, 30.0
    acc, wsum, nv = run_pass(pairs, a.procs)
    col = acc[0] / np.maximum(wsum[0][:, None], 1e-12)
    wt = wsum[0]
    seen = nv >= 2
    print(f"pass 3 done [{time.time() - t0:.0f}s]; texels observed in >=2 views: {seen.mean():.1%}", flush=True)

    # per-vertex colours -> harmonic fill of unobserved surface
    F = G["faces"]; V = body.V
    vc = np.zeros((V, 3)); vw = np.zeros(V)
    w_obs = np.where(seen, G["mu_w"], 0.0)                         # pass-2 weights (un-sharpened) as confidence
    for i in range(3):
        np.add.at(vc, F[G["t_face"], i], (col * (w_obs * G["t_bary"][:, i])[:, None]))
        np.add.at(vw, F[G["t_face"], i], w_obs * G["t_bary"][:, i])
    vcol = vc / np.maximum(vw[:, None], 1e-12)
    from scipy.spatial import cKDTree
    v0 = G["poser"].v0
    dm, mirror = cKDTree(v0).query(v0 * [-1, 1, 1])
    mirror = np.where(dm < 0.004, mirror, np.arange(V))
    vfill, vconf = vertex_fill(body, v0, vcol, vw, mirror)
    fill = (vfill[F[G["t_face"]]] * G["t_bary"][..., None]).sum(1)
    conf_t = np.clip(w_obs / max(np.percentile(w_obs[w_obs > 0], 20), 1e-9), 0, 1)
    final = conf_t[:, None] * col + (1 - conf_t[:, None]) * fill
    tex = np.zeros((S, S, 3), np.float32)
    tex[G["ty"], G["tx"]] = final
    valid = G["tf"] >= 0
    _, (iy, ix) = ndimage.distance_transform_edt(~valid, return_indices=True)       # gutter: nearest surface texel
    tex = tex[iy, ix]
    tex8 = np.clip(tex + 0.5, 0, 255).astype(np.uint8)
    cv2.imwrite(os.path.join(wd, "texture.png"), tex8)
    cv2.imwrite(os.path.join(wd, "texture.jpg"), tex8, [cv2.IMWRITE_JPEG_QUALITY, 92])
    conf_img = np.zeros((S, S), np.uint8); conf_img[G["ty"], G["tx"]] = (conf_t * 255).astype(np.uint8)
    cv2.imwrite(os.path.join(wd, "texture_confidence.png"), conf_img)
    # surface-area share that is measured vs inferred
    fa = 0.5 * np.linalg.norm(face_normals(v0, F), axis=1)
    cnt = np.bincount(G["t_face"], minlength=len(F)).astype(float)
    area_t = fa[G["t_face"]] / np.maximum(cnt[G["t_face"]], 1)
    observed_area = float((area_t * (conf_t > 0.5)).sum() / area_t.sum())
    stats = {"atlas": S, "views": len(pairs), "cameraGainsBGR": {CAMS[c]: gains[c].round(4).tolist() for c in range(4)},
             "cameraOffsetsBGR": {CAMS[c]: offs[c].round(2).tolist() for c in range(4)}, "surfaceObserved": round(observed_area, 4),
             "texelsObserved": round(float(seen.mean()), 4), "medianViewsPerTexel": int(np.median(nv[seen])) if seen.any() else 0,
             "cleanViews": n_clean}
    with open(os.path.join(wd, "texture_metrics.json"), "w") as fh:
        json.dump(stats, fh, indent=1)
    np.savez_compressed(os.path.join(wd, "texture_vertex.npz"), vcol=vfill.astype(np.float32), vconf=vconf.astype(np.float32))
    print(json.dumps(stats), f"[{time.time() - t0:.0f}s]")


if __name__ == "__main__":
    main()
