"""Step 5c - register every footage cut-out to the fitted body (work dir: register.json).

The body is fitted to all four cameras at once, and where the cameras agree it lands on each cut-out to a
few pixels. Where a camera's calibration is weakest - the person a metre or two from a wide-angle lens, or
entering / leaving at the edge of its frame - the projected body and that camera's cut-out are tens of
pixels apart (up to ~200 px for cam1 at the door). Footage projected onto the body then lands on the
wrong part of it, and the outline shows the person twice.

For every cut-out this finds the similarity of that camera's image (scale about the body's centre, then a
shift) that makes the projected body - plus a carried object, when the matte contains it - agree best with
the matte, measured by IoU inside the part of the frame where the matte is authoritative:

    p_footage = c + s (p_model - c) + d

The search is exhaustive: IoU for every shift within +-240 px comes from two FFT cross-correlations
(intersection, and model area inside the known region), over a small set of scales. A view keeps the
identity unless the gain is clear, the result is median-filtered over time, and a view that still disagrees
with the body afterwards is switched off (`use` false): the viewer then draws the body from the other
cameras and the fused texture at that instant instead of showing misplaced footage.

export.py copies the result into avatar.json (`projection.register`); the viewer moves the cut-out, not
the body, so the body stays where all cameras put it.

A matte that contains the carried object rarely contains all of it: the panels of the chair are there, its
thin legs only in part. Next to a camera the viewer cuts the object to that camera's matte, which would
remove every leg the matte lacks. So with each registration this also records which pieces of the object
(chair_model.PIECES: the two panels, every leg in short lengths) the matte really shows (`shown_pieces`);
the viewer cuts those to the matte and draws the others from the proxy (avatar.json `props[].frames.cut`).

    python register.py --clip clip02          # ~1 minute on 3 cores
"""
import argparse, hashlib, json, os, time
from multiprocessing import Pool

import cv2
import numpy as np
from scipy.ndimage import median_filter
from scipy.spatial.transform import Rotation as Rot

import chair_model as CM
import shape as S
from common import CAMS, H, W, load_json, project, work_dir
from render import front_facing, raster_mask

D_MAX = 240                                    # largest shift searched (px)
SCALES = tuple(round(0.7 + 0.05 * i, 2) for i in range(13))        # 0.7 ... 1.3
LAMBDA_PX = 2e-4                               # IoU a shift must earn per pixel
LAMBDA_S = 0.2                                 # IoU a scale must earn per unit of |s - 1|
GOOD_IOU = 0.9                                 # a shift that reaches this needs no scale
SCALE_IOU = 0.8                                # a scale is believed only when the result is this good (a body half
                                               # behind furniture gains IoU by shrinking onto what is visible)
MIN_GAIN = 0.03                                # below this gain in IoU the identity is kept ...
MIN_RESULT = 0.6                               # ... and when the registered view is still this poor (hidden behind furniture)
MIN_MOVE = 6.0                                 # ... and when no part of the body moves this far (px): the viewer's outline
                                               # handling absorbs a few pixels, and a carried object's rougher pose can fake them
MIN_IOU = 0.5                                  # a registered view below this is not used ...
MIN_RECALL = 0.72                              # ... nor one whose matte lies this little on the body
MIN_SHARE = 0.25                               # ... nor one that shows less than this share of the body (frame edge):
                                               # the registration of a sliver is not stable from frame to frame
HARD_RECALL = 0.6                              # below this a view is off whatever its neighbours say
PIECE_REACH_M = 0.05                           # a matte shows a piece of a carried object when it lies within this of the
PIECE_REACH_PX = (4, 14)                       # piece (the object's pose is good to a few cm), at least / at most this many px
PIECE_SHARE = 0.5                              # ... along this share of the piece
PIECE_CLEAR = 0.3                              # a piece with less than this share clear of the person is not judged

P = {}


def known_rect(e):
    """Where the matte of entry e is authoritative, inside the frame (x0, y0, x1, y1)."""
    if e["method"].startswith("sam2.1 ("):              # segmented on the whole frame, never clipped to a box
        return 0, 0, W, H
    x0, y0, x1, y1 = e["known"]
    return max(int(x0), 0), max(int(y0), 0), min(int(x1), W), min(int(y1), H)


def fingerprint(e):
    """Identifies the matte a registration was measured on (export.py refuses a stale register.json)."""
    return hashlib.md5(np.ascontiguousarray(e["m"]).tobytes() + bytes(str((e["x0"], e["y0"], e["m"].shape)), "ascii")).hexdigest()[:10]


def carried(clip):
    """The objects the person handles (prop_*.json from chair.py) -> {kind: outline pieces and pose per frame}."""
    wd, out = work_dir(clip), {}
    for name in sorted(os.listdir(wd)):
        if name.startswith("prop_") and name.endswith(".json"):
            p = load_json(os.path.join(wd, name))
            if p.get("kind") == "chair":
                out[p["kind"]] = {"corners": CM.parts(p["dims"]), "pieces": CM.pieces(p["dims"]), "names": CM.PIECES,
                                  "pos": np.asarray(p["frames"]["pos"], float), "rot": Rot.from_quat(np.asarray(p["frames"]["quat"], float))}
    return out


def init(clip, fit_name):
    cv2.setNumThreads(1)
    G = S.setup(clip, fit_name)
    wd = work_dir(clip)
    G["v"] = np.load(os.path.join(wd, "shape.npz"))["v"].astype(np.float64) if os.path.exists(os.path.join(wd, "shape.npz")) else None
    P.clear()
    P.update(carried(clip))


def corr(a, b):
    """C[dy, dx] = sum_x a(x) b(x - d) (circular)."""
    return np.fft.irfft2(np.fft.rfft2(a) * np.conj(np.fft.rfft2(b)), s=a.shape)


def search(m, kn, sil, radius, step):
    """Best shift of `sil` (0/1 float images on one canvas whose border of `radius` px is empty in `sil`) ->
    (iou at the best shift, (dx, dy), iou at no shift), on a grid of `step` px."""
    if step > 1:
        size = (m.shape[1] // step, m.shape[0] // step)
        m, kn, sil = (cv2.resize(x, size, interpolation=cv2.INTER_AREA) for x in (m, kn, sil))
    area = float(m.sum())
    I, A = corr(m, sil), corr(kn, sil)
    iou = I / np.maximum(area + A - I, 1e-3)
    hh, ww = iou.shape
    dy = np.fft.fftfreq(hh, 1.0 / hh)[:, None] * step
    dx = np.fft.fftfreq(ww, 1.0 / ww)[None, :] * step
    score = np.where((np.abs(dy) <= radius) & (np.abs(dx) <= radius), iou - LAMBDA_PX * np.hypot(dx, dy), -1.0)
    j = np.unravel_index(int(np.argmax(score)), score.shape)
    return float(iou[j]), (float(dx[0, j[1]]), float(dy[j[0], 0])), float(iou[0, 0])


def scaled(sil, c, s, d=(0.0, 0.0)):
    """Silhouette image scaled by s about the canvas point c, then shifted by d."""
    if s == 1.0 and d[0] == 0 and d[1] == 0:
        return sil
    A = np.array([[s, 0, c[0] * (1 - s) + d[0]], [0, s, c[1] * (1 - s) + d[1]]])
    return cv2.warpAffine(sil, A, (sil.shape[1], sil.shape[0]), flags=cv2.INTER_LINEAR)


def one(key):
    """One cut-out -> its registration and how well body and matte agree before / after."""
    ci, k = key
    G = S.G
    cam = G["cams"][CAMS[ci]]
    e = G["masks"][key]
    kf = k - cam["dt"] * G["fps"]
    X = G["poser"].pose(kf, G["v"])
    px, z = project(cam, X)
    ok = z > 0.3
    if ok.mean() < 0.5 or not e["m"].any():
        return ci, k, {"skip": True, "id": fingerprint(e)}
    ff, _ = front_facing(X, G["faces"], cam["C"])
    fsel = G["faces"][ff & ok[G["faces"]].all(1)]
    pxs = np.where(ok[:, None], px, -1e4)
    polys = []
    for kind, p in P.items():                           # a carried object the matte contains belongs to the outline
        if f"carried:{kind}" in e["method"]:
            k0 = int(np.clip(np.floor(kf), 0, len(p["pos"]) - 2)); a = float(np.clip(kf - k0, 0, 1))
            R = Rot.from_rotvec((1 - a) * p["rot"][k0].as_rotvec() + a * p["rot"][k0 + 1].as_rotvec()) if a > 1e-6 else p["rot"][k0]
            Xp = R.apply(p["corners"].reshape(-1, 3)).reshape(-1, 8, 3) + ((1 - a) * p["pos"][k0] + a * p["pos"][k0 + 1])
            if (project(cam, Xp)[1] > 0.3).all():
                polys = CM.hulls(cam, Xp)
    h, w = e["m"].shape
    lo = np.minimum(pxs[ok].min(0), [e["x0"], e["y0"]]); hi = np.maximum(pxs[ok].max(0), [e["x0"] + w, e["y0"] + h])
    for q in polys:
        lo, hi = np.minimum(lo, q.min(0)), np.maximum(hi, q.max(0))
    # canvas: everything that can end up inside the frame for shifts up to D_MAX, and D_MAX of nothing around
    # it (the correlation is circular)
    pad = D_MAX + 8
    x0, y0 = int(np.floor(max(lo[0], -D_MAX))) - pad, int(np.floor(max(lo[1], -D_MAX))) - pad
    x1, y1 = int(np.ceil(min(hi[0], W + D_MAX))) + pad, int(np.ceil(min(hi[1], H + D_MAX))) + pad
    x1 += (x1 - x0) % 4; y1 += (y1 - y0) % 4
    shp = (y1 - y0, x1 - x0)
    sil = raster_mask(pxs, fsel, shp, (x0, y0))
    if polys:
        sil |= CM.raster(polys, shp, (x0, y0))
    whole = float(sil.sum())                             # the body as far as the canvas shows it (frame + D_MAX)
    sil = sil.astype(np.float32)
    sil[:pad] = 0; sil[-pad:] = 0; sil[:, :pad] = 0; sil[:, -pad:] = 0
    kx0, ky0, kx1, ky1 = known_rect(e)
    kn = np.zeros(shp, np.float32)
    kn[max(ky0 - y0, 0):max(ky1 - y0, 0), max(kx0 - x0, 0):max(kx1 - x0, 0)] = 1
    m = np.zeros(shp, np.float32)
    m[e["y0"] - y0:e["y0"] - y0 + h, e["x0"] - x0:e["x0"] - x0 + w] = e["m"]
    m *= kn
    if m.sum() < 16:
        return ci, k, {"skip": True, "id": fingerprint(e)}
    c = np.array([float(pxs[ok, 0].mean()), float(pxs[ok, 1].mean())])        # scale centre (frame px)
    cc = c - [x0, y0]
    def fine(s0, d0, scales, r=8):
        """Best (score, s, d, iou) on a 1 px grid within r px of d0, on a canvas cropped to what matters."""
        ys, xs = np.nonzero(m)
        best = None
        for s in scales:
            t = scaled(sil, cc, s, d0)
            ty, tx = np.nonzero(t > 0.5)
            if not len(tx):
                continue
            a0, b0 = max(min(xs.min(), tx.min()) - 2 * r, 0), max(min(ys.min(), ty.min()) - 2 * r, 0)
            a1, b1 = min(max(xs.max(), tx.max()) + 1 + 2 * r, shp[1]), min(max(ys.max(), ty.max()) + 1 + 2 * r, shp[0])
            a1 -= (a1 - a0) % 2; b1 -= (b1 - b0) % 2
            tt = t[b0:b1, a0:a1].copy()
            tt[:r] = 0; tt[-r:] = 0; tt[:, :r] = 0; tt[:, -r:] = 0
            iou, d, _ = search(m[b0:b1, a0:a1], kn[b0:b1, a0:a1], tt, r, 1)
            d = (d0[0] + d[0], d0[1] + d[1])
            score = iou - LAMBDA_PX * np.hypot(*d) - LAMBDA_S * abs(s - 1)
            if best is None or score > best[0]:
                best = (score, s, d, iou)
        return best

    # shift alone: every shift on a 4 px grid, then 1 px around the best
    _, d0, _ = search(m, kn, sil, D_MAX, 4)
    shift = fine(1.0, d0, (1.0,))
    pick = shift
    if shift is None or shift[3] < GOOD_IOU:
        # with a scale: every scale and shift on the 4 px grid, then 1 px and +-0.025 around the best
        coarse = None
        for s in SCALES:
            if s == 1.0:
                continue
            iou, d, _ = search(m, kn, scaled(sil, cc, s), D_MAX, 4)
            score = iou - LAMBDA_PX * np.hypot(*d) - LAMBDA_S * abs(s - 1)
            if coarse is None or score > coarse[0]:
                coarse = (score, s, d)
        both = fine(coarse[1], coarse[2], (coarse[1] - 0.025, coarse[1], coarse[1] + 0.025))
        if both is not None and both[3] >= SCALE_IOU and (shift is None or both[0] > shift[0]):
            pick = both
    ident = (sil > 0.5)
    i0 = float((m * ident).sum()); a0_ = float((kn * ident).sum()); am = float(m.sum())
    iou0 = i0 / max(am + a0_ - i0, 1e-3)
    out = {"iou0": iou0, "recall0": i0 / am, "precision0": i0 / max(a0_, 1.0), "share0": a0_ / max(whole, 1.0), "c": c.tolist(),
           "carried": bool(polys), "s": 1.0, "d": [0.0, 0.0], "iou1": iou0, "id": fingerprint(e),
           "box": [float(v) for v in (*pxs[ok].min(0), *pxs[ok].max(0))]}
    if pick is not None:
        out.update(s=float(pick[1]), d=[float(pick[2][0]), float(pick[2][1])], iou1=float(pick[3]))
    return ci, k, out


def shown_pieces(matte, body, hulls, names, reach, origin=(0, 0), detail=None):
    """Which pieces of a carried object does a matte show? -> bit mask over the pieces (bit j = piece j).

    matte, body: the matte and the silhouette of the person, 0/1 images of the part of the frame where the
    matte is authoritative, whose pixel (0, 0) is frame pixel `origin`; hulls: image outline of every piece;
    reach: px.

    A piece is shown when, along at least PIECE_SHARE of it, there is matte within `reach` that the person
    does not explain. For a leg the panels do not count either: the seat next to a leg is not that leg.
    Only what lies clear of the person (and, for a leg, of the panels) is judged; a piece that is mostly
    in front of or behind them keeps the matte's outline, which is theirs there."""
    disc = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * reach + 1, 2 * reach + 1))
    rast = [CM.raster([h], matte.shape, origin) for h in hulls]
    leg = [n.startswith("leg") for n in names]
    panels = np.zeros_like(matte)
    for r, is_leg in zip(rast, leg):
        if not is_leg:
            panels |= r
    taken = {False: cv2.dilate(body, disc), True: cv2.dilate(body | panels, disc)}       # explained for a panel / for a leg
    near = {key: cv2.dilate(matte & (1 - t), disc) for key, t in taken.items()}
    bits = 0
    for j, (r, is_leg) in enumerate(zip(rast, leg)):
        clear = r & (1 - taken[is_leg])
        n, nc = int(r.sum()), int(clear.sum())
        share = float((clear & near[is_leg]).sum()) / nc if nc else None
        on = share >= PIECE_SHARE if nc >= max(PIECE_CLEAR * n, 1) else True
        bits |= int(on) << j
        if detail is not None:
            detail.append({"name": names[j], "px": n, "clear": nc, "share": share, "shown": bool(on)})
    return bits


def agreement(key, s, d, detail=None):
    """IoU, recall (matte on the body), precision (body in the matte) and share of the body inside the
    known part of the frame for the registration (s, d) of one cut-out, and the pieces of a carried object
    its matte shows (`detail`: a dict that receives what that was decided on, for review)."""
    ci, k = key
    G = S.G
    cam = G["cams"][CAMS[ci]]
    e = G["masks"][key]
    kf = k - cam["dt"] * G["fps"]
    X = G["poser"].pose(kf, G["v"])
    px, z = project(cam, X)
    ok = z > 0.3
    ff, _ = front_facing(X, G["faces"], cam["C"])
    fsel = G["faces"][ff & ok[G["faces"]].all(1)]
    c = px[ok].mean(0)
    q = np.where(ok[:, None], c + s * (px - c) + np.asarray(d), -1e4)
    polys, held = [], None
    for kind, p in P.items():
        if f"carried:{kind}" in e["method"]:
            k0 = int(np.clip(np.floor(kf), 0, len(p["pos"]) - 2)); a = float(np.clip(kf - k0, 0, 1))
            R = Rot.from_rotvec((1 - a) * p["rot"][k0].as_rotvec() + a * p["rot"][k0 + 1].as_rotvec()) if a > 1e-6 else p["rot"][k0]
            T = (1 - a) * p["pos"][k0] + a * p["pos"][k0 + 1]
            Xp = R.apply(p["corners"].reshape(-1, 3)).reshape(-1, 8, 3) + T
            zp = project(cam, Xp)[1]
            if (zp > 0.3).all():
                polys = [c + s * (h - c) + np.asarray(d) for h in CM.hulls(cam, Xp)]
                Xq = R.apply(p["pieces"].reshape(-1, 3)).reshape(-1, 8, 3) + T
                held = (kind, p["names"], [c + s * (h - c) + np.asarray(d) for h in CM.hulls(cam, Xq)],
                        int(np.clip(round(cam["f"] * s * PIECE_REACH_M / float(zp.mean())), *PIECE_REACH_PX)))
    lo, hi = q[ok].min(0), q[ok].max(0)
    for h in polys:
        lo, hi = np.minimum(lo, h.min(0)), np.maximum(hi, h.max(0))
    x0, y0 = int(np.floor(max(lo[0], -2 * W))) - 2, int(np.floor(max(lo[1], -2 * H))) - 2
    x1, y1 = int(np.ceil(min(hi[0], 3 * W))) + 2, int(np.ceil(min(hi[1], 3 * H))) + 2
    sil = raster_mask(q, fsel, (y1 - y0, x1 - x0), (x0, y0))
    body = sil.copy() if held else None
    if polys:
        sil |= CM.raster(polys, sil.shape, (x0, y0))
    whole = float(sil.sum())
    kx0, ky0, kx1, ky1 = known_rect(e)
    inn = sil[max(ky0 - y0, 0):max(ky1 - y0, 0), max(kx0 - x0, 0):max(kx1 - x0, 0)]
    A = float(inn.sum())
    h, w = e["m"].shape
    mm = np.zeros(sil.shape, np.uint8)
    ax0, ay0, ax1, ay1 = max(e["x0"], x0, kx0), max(e["y0"], y0, ky0), min(e["x0"] + w, x1, kx1), min(e["y0"] + h, y1, ky1)
    if ax1 > ax0 and ay1 > ay0:
        mm[ay0 - y0:ay1 - y0, ax0 - x0:ax1 - x0] = e["m"][ay0 - e["y0"]:ay1 - e["y0"], ax0 - e["x0"]:ax1 - e["x0"]]
    I = float((mm & sil).sum())
    kb = np.zeros_like(e["m"])
    kb[max(ky0 - e["y0"], 0):max(ky1 - e["y0"], 0), max(kx0 - e["x0"], 0):max(kx1 - e["x0"], 0)] = 1
    am = float((e["m"] & kb).sum())
    out = {"iou": I / max(am + A - I, 1e-3), "recall": I / max(am, 1.0), "precision": I / max(A, 1.0), "share": A / max(whole, 1.0)}
    if held:                                            # which pieces of the carried object this matte shows
        kind, names, hulls, reach = held
        ys, xs = slice(max(ky0 - y0, 0), max(ky1 - y0, 0)), slice(max(kx0 - x0, 0), max(kx1 - x0, 0))
        if body[ys, xs].size:
            rows = [] if detail is not None else None
            out["pieces"] = {kind: shown_pieces(mm[ys, xs], body[ys, xs], hulls, names, reach, (x0 + xs.start, y0 + ys.start), rows)}
            if detail is not None:
                detail.update(origin=(x0 + xs.start, y0 + ys.start), matte=mm[ys, xs], body=body[ys, xs], hulls=hulls, reach=reach, pieces=rows)
    return out


def _agree(args):
    return args[0], agreement(*args)


def smooth(rows, N):
    """Per camera: keep the identity where the gain is unclear, then a median of 5 and a mean of 3 over each
    run of consecutive cut-outs, so the footage does not jump between frames. rows: {k: result} ->
    (s, dx, dy) arrays (N,), NaN where the camera has no cut-out."""
    par = np.full((N, 3), np.nan)
    for k, r in rows.items():
        x0, y0, x1, y1 = r["box"]
        corners = np.array([[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) - r["c"]
        move = np.linalg.norm((r["s"] - 1) * corners + r["d"], axis=1).max()
        keep = r["iou1"] - r["iou0"] >= MIN_GAIN and r["iou1"] >= MIN_RESULT and move >= MIN_MOVE
        par[k] = (r["s"], r["d"][0], r["d"][1]) if keep else (1.0, 0.0, 0.0)
    out = par.copy()
    have = np.isfinite(par[:, 0])
    k = 0
    while k < N:
        if not have[k]:
            k += 1
            continue
        j = k
        while j < N and have[j]:
            j += 1
        seg = par[k:j]
        if j - k >= 3:
            seg = median_filter(seg, size=(5, 1), mode="nearest")
            pad = np.concatenate([seg[:1], seg, seg[-1:]])
            seg = (pad[:-2] + 2 * pad[1:-1] + pad[2:]) / 4
        out[k:j] = seg
        k = j
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clip", default="clip02")
    ap.add_argument("--fit", default="fit.npz")
    ap.add_argument("--procs", type=int, default=3)
    ap.add_argument("--only", default="", help="debug: 'cam1:13-51;cam4:99-110' (prints, writes nothing)")
    a = ap.parse_args()
    from masks import load_masks
    keys = sorted(load_masks(a.clip).keys())
    N = len(np.load(os.path.join(work_dir(a.clip), a.fit))["root_pos"])
    if a.only:
        sel = set()
        for sp in a.only.split(";"):
            c, r = sp.split(":")
            lo, hi = (r.split("-") + [r])[:2]
            sel |= {(CAMS.index(c), k) for k in range(int(lo), int(hi) + 1)}
        keys = [x for x in keys if x in sel]
    t0 = time.time()
    with Pool(a.procs, initializer=init, initargs=(a.clip, a.fit)) as pool:
        res = pool.map(one, keys, chunksize=4)
        rows = {c: {} for c in CAMS}
        skipped = {c: {} for c in CAMS}                  # nothing to compare (body behind the camera, empty matte)
        for ci, k, r in res:
            (skipped if r.get("skip") else rows)[CAMS[ci]][k] = r
        par = {c: smooth(rows[c], N) for c in CAMS}
        jobs = [((ci, k), float(par[CAMS[ci]][k, 0]), (float(par[CAMS[ci]][k, 1]), float(par[CAMS[ci]][k, 2]))) for ci, k in keys if k in rows[CAMS[ci]]]
        after = dict(pool.map(_agree, jobs, chunksize=4))
    P.update(carried(a.clip))                            # (here only for the names of their pieces)
    out = {"clip": a.clip, "frame": [W, H], "note": "p_footage = c + s (p_model - c) + d; use: false = cut-out not shown on the body; "
           "shown: per carried object, bit j set = the matte shows piece j of `pieces`",
           "pieces": {kind: list(p["names"]) for kind, p in P.items()}, "cameras": {}}
    for ci, cam in enumerate(CAMS):
        reg, use, stats, ids = [None] * N, [None] * N, [None] * N, [None] * N
        shown = {kind: [None] * N for kind in P}
        for k, r in rows[cam].items():
            s, dx, dy = par[cam][k]
            ag = after[(ci, k)]
            for kind, bits in ag.get("pieces", {}).items():
                shown[kind][k] = bits
            good = ag["iou"] >= MIN_IOU or ag["recall"] >= 0.9                    # (a body half behind furniture has a low IoU and a high recall)
            good = good and ag["recall"] >= MIN_RECALL and ag["share"] >= MIN_SHARE
            ident = abs(s - 1) < 1e-3 and abs(dx) < 0.5 and abs(dy) < 0.5
            reg[k] = None if ident else [round(float(s), 4), round(float(dx), 2), round(float(dy), 2), round(r["c"][0], 2), round(r["c"][1], 2)]
            use[k] = bool(good)
            ids[k] = r["id"]
            stats[k] = [round(r["iou0"], 3), round(ag["iou"], 3), round(ag["recall"], 3), round(ag["precision"], 3), round(ag["share"], 3)]
        # a camera that drops out for a frame and comes back flickers: majority of 5 within each run of
        # cut-outs, except that a view whose matte is mostly off the body stays off
        raw = list(use)
        for k in rows[cam]:
            near = [raw[j] for j in range(k - 2, k + 3) if 0 <= j < N and raw[j] is not None]
            use[k] = bool(sum(near) * 2 > len(near)) and stats[k][2] >= HARD_RECALL and stats[k][4] >= 0.5 * MIN_SHARE
        for k, r in skipped[cam].items():
            use[k], ids[k] = False, r["id"]
        out["cameras"][cam] = {"register": reg, "use": use, "stats": stats, "id": ids, "shown": shown}
        for kind, row in shown.items():
            got = [b for b in row if b is not None]
            if got:
                n = len(P[kind]["names"])
                per = np.array([[b >> j & 1 for j in range(n)] for b in got]).mean(0)
                print(f"   {kind} in {len(got)} mattes; shown: " + ", ".join(
                    f"{g} {per[[j for j, nm in enumerate(P[kind]['names']) if nm.startswith(g)]].mean():.0%}" for g in sorted({nm.rsplit('_', 1)[0] if nm.startswith('leg') else nm for nm in P[kind]['names']})))
        ks = sorted(rows[cam])
        moved = [k for k in ks if reg[k] is not None]
        off = [k for k in ks if not use[k]]
        i0 = np.array([rows[cam][k]["iou0"] for k in ks]); i1 = np.array([after[(ci, k)]["iou"] for k in ks])
        print(f"{cam}: {len(ks)} cut-outs, {len(moved)} registered (largest shift {max([np.hypot(reg[k][1], reg[k][2]) for k in moved], default=0):.0f} px), "
              f"{len(off)} not used; IoU median {np.median(i0):.3f} -> {np.median(i1):.3f}, worst decile {np.percentile(i0, 10):.3f} -> {np.percentile(i1, 10):.3f}")
        if off:
            print(f"   not used: {runs(off)}")
        if a.only:
            for k in ks:
                st = stats[k]
                print(f"   k{k}: iou {st[0]:.2f} -> {st[1]:.2f} recall {st[2]:.2f} precision {st[3]:.2f} share {st[4]:.2f}  raw s={rows[cam][k]['s']:.3f} d=({rows[cam][k]['d'][0]:+.0f},{rows[cam][k]['d'][1]:+.0f})"
                      f"  applied {reg[k][:3] if reg[k] else '-'} {'' if use[k] else 'NOT USED'}{' +prop' if rows[cam][k]['carried'] else ''}")
    print(f"{len(keys)} cut-outs in {time.time() - t0:.0f} s")
    if not a.only:
        path = os.path.join(work_dir(a.clip), "register.json")
        with open(path, "w") as fh:
            json.dump(out, fh, separators=(",", ":"))
        print("wrote", path)


def runs(ks):
    """[3, 4, 5, 9] -> '3-5, 9'."""
    out, i = [], 0
    while i < len(ks):
        j = i
        while j + 1 < len(ks) and ks[j + 1] == ks[j] + 1:
            j += 1
        out.append(f"{ks[i]}-{ks[j]}" if j > i else f"{ks[i]}")
        i = j + 1
    return ", ".join(out)


if __name__ == "__main__":
    main()
