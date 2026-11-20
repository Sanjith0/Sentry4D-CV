"""Robust multi-view triangulation of the 2D keypoints (used for calibration refinement,
initialisation of the body fit, and diagnostics)."""
import itertools
import numpy as np
from common import CAMS, P_matrix, project, undistort_px


def dlt(Ps, uvs, ws=None):
    A = []
    for i, (P, uv) in enumerate(zip(Ps, uvs)):
        w = 1.0 if ws is None else ws[i]
        A.append(w * (uv[0] * P[2] - P[0]))
        A.append(w * (uv[1] * P[2] - P[1]))
    _, _, vt = np.linalg.svd(np.asarray(A))
    X = vt[-1]
    return X[:3] / X[3]


def refine(cams, idx, uvs, X, ws=None, iters=5):
    """Gauss-Newton on pixel reprojection error (pinhole + k1 through numeric Jacobian)."""
    for _ in range(iters):
        r, J = [], []
        for n, i in enumerate(idx):
            c = cams[i]
            p0, _ = project(c, X)
            w = 1.0 if ws is None else ws[n]
            r.append(w * (p0 - uvs[n]))
            Jn = np.zeros((2, 3))
            for a in range(3):
                d = np.zeros(3); d[a] = 1e-4
                Jn[:, a] = (project(c, X + d)[0] - p0) / 1e-4
            J.append(w * Jn)
        r, J = np.concatenate(r), np.concatenate(J)
        try:
            X = X - np.linalg.solve(J.T @ J + 1e-9 * np.eye(3), J.T @ r)
        except np.linalg.LinAlgError:
            break
    return X


def triangulate_point(cams, uv, score, s_min=2.0, tau=25.0):
    """cams: list of camera dicts; uv (C,2); score (C,). Returns X, inlier mask, per-view error."""
    C = len(cams)
    ok = [i for i in range(C) if score[i] >= s_min]
    if len(ok) < 2:
        return None, np.zeros(C, bool), np.full(C, np.nan)
    Ps = [P_matrix(c) for c in cams]
    und = [undistort_px(cams[i], uv[i]) for i in range(C)]
    best, best_in, best_cost = None, None, None
    cand = [tuple(ok)] if len(ok) == 2 else list(itertools.combinations(ok, 2)) + [tuple(ok)]
    for sub in cand:
        X = dlt([Ps[i] for i in sub], [und[i] for i in sub])
        err = np.array([np.linalg.norm(project(cams[i], X)[0] - uv[i]) if i in ok else np.inf for i in range(C)])
        z_ok = all(project(cams[i], X)[1] > 0.2 for i in sub)
        inl = (err < tau)
        cost = np.minimum(err[ok], tau).sum()
        if z_ok and (best is None or (inl.sum(), -cost) > (best_in.sum(), -best_cost)):
            best, best_in, best_cost = X, inl, cost
    if best is None or best_in.sum() < 2:
        return None, np.zeros(C, bool), np.full(C, np.nan)
    idx = [i for i in range(C) if best_in[i]]
    X = refine(cams, idx, [uv[i] for i in idx], best, ws=[np.sqrt(score[i]) for i in idx])
    err = np.array([np.linalg.norm(project(cams[i], X)[0] - uv[i]) if score[i] >= s_min else np.nan for i in range(C)])
    return X, best_in, err


def triangulate_all(cams, kp, s_min=2.0, tau=25.0, n_kp=23):
    """kp (C, N, K, 3). Returns X (N, K, 3) with NaN where not triangulated, inliers (C, N, K), err (C, N, K)."""
    C, N = kp.shape[:2]
    cl = [cams[c] for c in CAMS]
    X = np.full((N, n_kp, 3), np.nan)
    inl = np.zeros((C, N, n_kp), bool)
    err = np.full((C, N, n_kp), np.nan)
    for n in range(N):
        for k in range(n_kp):
            x, m, e = triangulate_point(cl, kp[:, n, k, :2], kp[:, n, k, 2], s_min, tau)
            if x is not None:
                X[n, k] = x
                inl[:, n, k] = m
            err[:, n, k] = e
    return X, inl, err
