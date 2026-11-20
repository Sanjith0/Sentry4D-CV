"""Step 2 - refine the camera calibration with the person as the calibration target.

The app calibration (src/config/camera-poses.json) was solved from a handful of room
correspondences. It is good to a few pixels near where those were clicked and drifts elsewhere,
which is enough to tear a multi-view body fit apart. Here the 2D keypoints of the walking person
(thousands of 2-4 view correspondences that sweep the room) drive a bundle adjustment over all
four cameras: orientation, position, focal length, one radial term and a per-camera clock offset.

The room frame must not move, so the adjustment is anchored: Gaussian priors keep every camera
near its app calibration (this fixes the 7-DOF gauge) and the lowest foot keypoint of every frame
is tied to the floor plane y = 0 of the LiDAR room.

The app's own calibration file is NOT modified; the result is written to
data/<clip>/avatar/cameras_refined.json and only used to reconstruct the body.

Usage: python calibrate.py --clip clip02
"""
import argparse, json, os
import numpy as np

from common import CAMS, load_app_cameras, project, work_dir
from masks import load_keypoints
from triangulate import triangulate_all

PX_SIGMA = 4.0          # keypoint noise (px)
HUBER_PX = 8.0
# Priors (1 sigma) around the app calibration. The person's keypoints cannot observe the global
# similarity of the rig: left alone, a uniform shrink toward the floor together with longer focal
# lengths fits them slightly better and yields a 1.45 m tall man. So the room frame, the metric scale
# and the lens field of view are taken from the app calibration: orientation, horizontal position and
# focal length get tight priors that are up-weighted by ANCHOR against the ~18k pixel residuals.
# Camera HEIGHT is the exception: it is left almost free and is measured instead by the one thing in
# the footage that is known exactly in room coordinates, the floor the person walks on (y = 0).
ANCHOR = 10.0
PRIOR = {"rot": np.radians(1.5) / ANCHOR, "pos_xz": 0.05 / ANCHOR, "pos_y": 0.25, "logf": 0.03 / ANCHOR,
         "k1": 0.02 / ANCHOR, "dt": 0.03 / ANCHOR}
FLOOR_ANCHOR = 1.0
FLOOR_Y, FLOOR_SIGMA = 0.025, 0.03
FOOT = [17, 18, 19, 20, 21, 22]


def expm(w):
    th = np.linalg.norm(w)
    if th < 1e-12:
        return np.eye(3)
    k = w / th
    K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + np.sin(th) * K + (1 - np.cos(th)) * K @ K


def apply(cam0, p):
    """p = [wx, wy, wz, dCx, dCy, dCz, logf, k1, dt] -> camera dict."""
    R = expm(p[:3]) @ cam0["R"]
    C = cam0["C"] + p[3:6]
    return {"f": cam0["f"] * np.exp(p[6]), "cx": cam0["cx"], "cy": cam0["cy"], "k1": p[7], "R": R, "t": -R @ C, "C": C,
            "dt": p[8]}


def build_obs(kp, X, inl, s_min):
    C, N, K = inl.shape
    # 2D velocity (px / frame) from central differences where both neighbours are confident
    vel = np.zeros((C, N, K, 2))
    ok = kp[..., :K, 2] >= s_min
    both = ok[:, 2:] & ok[:, :-2]
    vel[:, 1:-1] = np.where(both[..., None], (kp[:, 2:, :K, :2] - kp[:, :-2, :K, :2]) / 2.0, 0.0)
    pid = -np.ones((N, K), int)
    good = np.isfinite(X[..., 0]) & (inl.sum(0) >= 2)
    pid[good] = np.arange(good.sum())
    ci, pi, uv, uvd, w = [], [], [], [], []
    for c in range(C):
        n, k = np.nonzero(inl[c] & good)
        ci.append(np.full(len(n), c)); pi.append(pid[n, k]); uv.append(kp[c, n, k, :2]); uvd.append(vel[c, n, k])
        w.append(np.clip(kp[c, n, k, 2] / 4.0, 0.5, 1.5) ** 0.5)
    return (np.concatenate(ci), np.concatenate(pi), np.concatenate(uv), np.concatenate(uvd), np.concatenate(w), pid, good)


def run_ba(cams0, kp, X, inl, s_min, fps, verbose=True, free=("rot", "pos", "logf", "k1", "dt"), iters=80):
    """Levenberg-Marquardt with the points eliminated by a Schur complement (4 x 9 camera unknowns,
    thousands of 3-vector points), Huber IRLS on the pixel residuals."""
    ci, pi, uv, uvd, w, pid, good = build_obs(kp, X, inl, s_min)
    M = int(good.sum())
    pts = X[good].copy()
    fl = []
    for n in range(X.shape[0]):
        cand = [(X[n, k, 1], pid[n, k]) for k in FOOT if pid[n, k] >= 0 and inl[:, n, k].sum() >= 2]
        if cand:
            fl.append(min(cand)[1])
    fl = np.array(sorted(set(fl)), int)
    nc = len(CAMS)
    mask = np.zeros(9, bool)
    mask[:3] = "rot" in free; mask[3:6] = "pos" in free; mask[6] = "logf" in free; mask[7] = "k1" in free; mask[8] = "dt" in free
    sig = np.array([PRIOR["rot"]] * 3 + [PRIOR["pos_xz"], PRIOR["pos_y"], PRIOR["pos_xz"]] + [PRIOR["logf"], PRIOR["k1"], PRIOR["dt"]])
    pr_w = PX_SIGMA / HUBER_PX
    fl_w = FLOOR_ANCHOR * PX_SIGMA / HUBER_PX
    eps_c = np.array([1e-6] * 3 + [1e-5] * 3 + [1e-6, 1e-6, 1e-5])
    cp = np.zeros((nc, 9))

    def res(cp_, pts_, c=None):
        """Scaled pixel residuals (O, 2); only camera c's rows when c is given."""
        out = np.zeros((len(ci), 2))
        for cc in (range(nc) if c is None else [c]):
            cam = apply(cams0[CAMS[cc]], cp_[cc])
            m = ci == cc
            p, _ = project(cam, pts_[pi[m]])
            out[m] = (p - uv[m] - cam["dt"] * fps * uvd[m]) * w[m, None] / HUBER_PX
        return out

    def cost_of(cp_, pts_):
        r = res(cp_, pts_)
        n = np.linalg.norm(r, axis=1)
        rho = np.where(n <= 1, 0.5 * n ** 2, n - 0.5)
        rf = fl_w * (pts_[fl, 1] - FLOOR_Y) / FLOOR_SIGMA
        rhof = np.where(np.abs(rf) <= 1, 0.5 * rf ** 2, np.abs(rf) - 0.5)
        rp = pr_w * (cp_ / sig)
        return rho.sum() + rhof.sum() + 0.5 * (rp ** 2).sum(), r

    lam = 1e-3
    cost, r = cost_of(cp, pts)
    for it in range(iters):
        # Jacobians by forward differences (vectorised over observations)
        Jc = np.zeros((len(ci), 2, 9))
        for j in range(9):
            if not mask[j]:
                continue
            d = cp.copy(); d[:, j] += eps_c[j]
            Jc[:, :, j] = (res(d, pts) - r) / eps_c[j]
        Jp = np.zeros((len(ci), 2, 3))
        for a in range(3):
            d = pts.copy(); d[:, a] += 1e-5
            Jp[:, :, a] = (res(cp, d) - r) / 1e-5
        n = np.linalg.norm(r, axis=1)
        sw = np.sqrt(np.where(n <= 1, 1.0, 1.0 / np.maximum(n, 1e-9)))
        rw, Jcw, Jpw = r * sw[:, None], Jc * sw[:, None, None], Jp * sw[:, None, None]
        Hcc = np.zeros((nc, 9, 9)); gc = np.zeros((nc, 9))
        np.add.at(Hcc, ci, np.einsum("oai,oaj->oij", Jcw, Jcw))
        np.add.at(gc, ci, np.einsum("oai,oa->oi", Jcw, rw))
        Hpp = np.zeros((M, 3, 3)); gp = np.zeros((M, 3))
        np.add.at(Hpp, pi, np.einsum("oai,oaj->oij", Jpw, Jpw))
        np.add.at(gp, pi, np.einsum("oai,oa->oi", Jpw, rw))
        Wcp = np.zeros((M, nc, 9, 3))
        np.add.at(Wcp, (pi, ci), np.einsum("oai,oaj->oij", Jcw, Jpw))
        rf = fl_w * (pts[fl, 1] - FLOOR_Y) / FLOOR_SIGMA
        wf = np.where(np.abs(rf) <= 1, 1.0, 1.0 / np.maximum(np.abs(rf), 1e-9))
        kf = fl_w / FLOOR_SIGMA
        Hpp[fl, 1, 1] += wf * kf * kf
        gp[fl, 1] += wf * kf * rf
        Hc = np.zeros((nc * 9, nc * 9))
        for c in range(nc):
            Hc[c * 9:(c + 1) * 9, c * 9:(c + 1) * 9] = Hcc[c]
        Hc[np.arange(nc * 9), np.arange(nc * 9)] += np.tile((pr_w / sig) ** 2, nc)
        g = gc.ravel() + np.tile((pr_w / sig) ** 2, nc) * cp.ravel()
        fixed = ~np.tile(mask, nc)
        Wf = Wcp.reshape(M, nc * 9, 3)
        improved = False
        for _ in range(8):
            Hp = Hpp + lam * (Hpp * np.eye(3)[None]) + 1e-9 * np.eye(3)[None]
            Hpi = np.linalg.inv(Hp)
            WH = np.einsum("pij,pjk->pik", Wf, Hpi)
            S = Hc + lam * np.diag(np.diag(Hc)) - np.einsum("pik,pjk->ij", WH, Wf)
            b = -g + np.einsum("pik,pk->i", WH, gp)
            S[fixed] = 0; S[:, fixed] = 0; S[fixed, fixed] = 1; b[fixed] = 0
            dc = np.linalg.solve(S, b)
            dp = -np.einsum("pij,pj->pi", Hpi, gp + np.einsum("pik,i->pk", Wf, dc))
            cp_new, pts_new = cp + dc.reshape(nc, 9), pts + dp
            cost_new, r_new = cost_of(cp_new, pts_new)
            if cost_new < cost:
                rel = (cost - cost_new) / cost
                cp, pts, cost, r = cp_new, pts_new, cost_new, r_new
                lam = max(lam / 3, 1e-7)
                improved = True
                break
            lam *= 4
        if verbose and (it % 10 == 0 or not improved):
            print(f"   LM it {it}: cost {cost:.2f} lambda {lam:.1e}")
        if not improved or rel < 1e-7:
            break
    cams = {CAMS[c]: apply(cams0[CAMS[c]], cp[c]) for c in range(nc)}
    return cams, cp, len(ci), len(fl)


def stats(tag, cams, kp, s_min, tau):
    X, inl, err = triangulate_all(cams, kp, s_min=s_min, tau=tau)
    nv = inl.sum(0)
    out = {}
    for c, name in enumerate(CAMS):
        e = err[c][np.isfinite(err[c]) & (nv >= 3)]
        out[name] = {"n": int(len(e)), "median": float(np.median(e)), "p90": float(np.percentile(e, 90))}
    lo = np.array([np.nanmin(X[n, FOOT, 1]) if np.isfinite(X[n, FOOT, 1]).any() else np.nan for n in range(X.shape[0])])
    print(f"[{tag}] reprojection px (points seen by >=3 cameras): " + "  ".join(
        f"{c} med {v['median']:.1f} p90 {v['p90']:.1f} (n={v['n']})" for c, v in out.items()))
    print(f"[{tag}] lowest foot keypoint height (m): p10 {np.nanpercentile(lo, 10):.3f}  median {np.nanmedian(lo):.3f}  p90 {np.nanpercentile(lo, 90):.3f}")
    return X, inl, err, out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clip", default="clip02")
    ap.add_argument("--s-min", type=float, default=3.0)
    a = ap.parse_args()
    wd = work_dir(a.clip)
    kp, _, _, hidden = load_keypoints(a.clip)         # guesses for limbs hidden behind furniture are not targets
    print("keypoints dropped because they are not on the visible person:", hidden[:, :, :23].sum((1, 2)).tolist())
    fps = 15.0
    cams0 = load_app_cameras()
    for c in cams0.values():
        c["k1"] = 0.0
    X, inl, err, before = stats("app calibration", cams0, kp, a.s_min, 40.0)
    cams = cams0
    for it, tau in enumerate([40.0, 20.0, 14.0]):
        if it:
            X, inl, err, _ = stats(f"pass {it}", cams, kp, a.s_min, tau)
        # every pass restarts from the app calibration (the priors are relative to it), warm-started points
        cams, cp, n_obs, n_floor = run_ba(cams0, kp, X, inl, a.s_min, fps)
        print(f"pass {it + 1}: {n_obs} observations, {n_floor} floor anchors")
    X, inl, err, after = stats("refined", cams, kp, a.s_min, 14.0)
    out = {"clip": a.clip, "note": "Keypoint bundle adjustment anchored to the app calibration; used only by the avatar pipeline.",
           "cameras": {}, "delta": {}, "reprojectionPx": {"before": before, "after": after}}
    for c, name in enumerate(CAMS):
        cam = cams[name]
        out["cameras"][name] = {"f": cam["f"], "cx": cam["cx"], "cy": cam["cy"], "k1": cam["k1"], "dt": cam["dt"],
                                "R": cam["R"].tolist(), "t": cam["t"].tolist(), "C": cam["C"].tolist()}
        ang = np.degrees(np.linalg.norm(cp[c][:3]))
        out["delta"][name] = {"rotationDeg": float(ang), "positionM": float(np.linalg.norm(cp[c][3:6])),
                              "focalPct": float(100 * (np.exp(cp[c][6]) - 1)), "k1": float(cp[c][7]), "dtS": float(cp[c][8])}
        print(name, {k: round(v, 4) for k, v in out["delta"][name].items()})
    with open(os.path.join(wd, "cameras_refined.json"), "w") as fh:
        json.dump(out, fh, indent=1)
    print("wrote", os.path.join(wd, "cameras_refined.json"))


if __name__ == "__main__":
    main()
