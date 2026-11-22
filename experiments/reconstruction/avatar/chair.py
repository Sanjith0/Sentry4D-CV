"""Step 8 - the chair the subject picks up and carries: one rigid proxy, one 6-DoF pose per frame.

Output: public/reconstruction/<clip>/avatar/chair-01.glb (static proxy in its own frame, see
chair_model.py) and data/<clip>/avatar/prop_chair.json (pose of that frame for every master frame,
in the coordinates of the fit: X_fit = R(quat[k]) v_local + pos[k]; the viewer adds (0, lift[k], 0)).

Evidence (chair_masks.py): the chair pixels of every camera and frame from background
subtraction, minus the fitted body; plus what hides the chair (the body, the scanned furniture).

Model fit. Every silhouette term is a two-sided distance in metres at the chair, bounded so that
clutter (reflections, a shirt hem) cannot pull:
  A  points spread over the proxy must project onto chair pixels; where the body or scanned
     furniture is in front of them or they leave the frame they cost a constant instead, less
     than a visible miss and more than a visible hit;
  B  chair pixels must lie inside the outline of the proxy (exact distance to its convex pieces).
Image k of camera c shows master frame k - 15 dt_c; the fits use each view for the nearest master
frame (at most 0.3 frames off), shifted by what the hands move in between; the checks of
chair_review.py interpolate the pose to that time.

  1 standing   position on the floor, yaw and the nine dimensions of the proxy, from the views in
               which the chair stands alone (early minus late background); yaw by multi-start.
  2 touch      the first frame at which a palm rests on the chair. Until then it stands; from then
               on it is tracked (in clip02 he holds it by the backrest for three seconds, puts a
               laptop on the seat, and then lifts it with both hands).
  3 grip       how he carries it. The carried chair is found in a frame that two cameras see well,
               without a guess of the grip (centre from the masks, attitude by multi-start, both
               palms on the chair), in three such frames; the pose that, moved on with the hands,
               fits the other two best is then held rigidly in the frame of the two hands and
               adjusted to the images of all carried frames at once.
  4 track      carried frames: what each frame's own images add to that grip (bounded; median over
               nine frames, so a frame with poor evidence follows its neighbours and the hands;
               frames no camera sees from his front take what the nearest seen frame adds), then
               moved out of the fitted body where the smoothed pose enters it.
               Pick-up: from the first carried frame back to the touch the pose is passed on frame
               by frame (a lifted chair turns with the two hands that hold it, a standing one is
               shifted with the palms on it) and fitted to each frame's images, kept out of the
               fitted body and above the floor; the first frames after the touch ease out of the
               standing pose.

The track is cached (chair_track.npz, --refit to redo); chair_review.py measures it against the
masks and draws the review sheets.

Run: python chair.py --clip clip02 [--refit] [--review DIR]
"""
import argparse, json, os, time
import cv2
import numpy as np
from scipy.ndimage import median_filter
from scipy.optimize import least_squares
from scipy.spatial import cKDTree
from scipy.spatial.transform import Rotation as Rot

import chair_masks as CM
import chair_model as M
import chair_review as CR
from body import Body
from common import CAMS, H, W, load_cameras, project, public_dir, work_dir
from gltf_io import vertex_normals
from render import Poser, bilinear, raster_ids
from room import fit_floor, fit_lift, sample_floor, smooth

SIGMA = 0.01                 # m: unit of the silhouette, grip and contact residuals
N_MASK = 250                 # chair pixels sampled per view for term B
HIDE = 0.5                   # a proxy point no camera can check costs this share of the cap (hiding the proxy is not free)
LEG_POINTS, LEG_WEIGHT = 60, 0.5         # the thin metal legs are often missing in a mask: their points count less in term A
GATE = 0.75                  # m around the hands (or the standing place) in which mask pixels are taken for the chair
AWAY = 0.70                  # m: hands that stay this far from the place of the standing chair carry it
STEP, TURN = 0.05, np.radians(15)       # m and rad a per-frame fit is expected to add to its start at most (1 sigma)
HOLD = 0.10                  # m: a palm (centre) this close to the proxy holds the chair
EASE = 8                     # frames after the touch over which the followed pose takes over from the standing one
GRIP = 0.03                  # m: 1 sigma of a holding palm beyond HOLD
MIN_AREA = 0.03              # m2 of chair a camera must show, from his front, for a carried frame to be fitted on its own
MEDIAN = 9                   # frames: median window over what the carried frames add to the grip (he does not re-grip quickly)
PEN_TOL = 0.02               # m the proxy may enter the fitted body (hands and body are known to a few cm)
DIM_SIGMA = 0.05             # m (and 0.1 rad for the tilt): pull of the dimensions towards chair_model.DIMS
LIFTED, BLEND = 0.03, 12     # m a foot is above where it stood when the chair is off the floor; frames the lift is blended over
NG = len(M.FREE) + 4         # unknowns of the standing fit: dimensions, x, y, z, yaw


def soft_cap(d, c):
    """Residual that grows like d and saturates at c."""
    return d / np.sqrt(1.0 + (d / c) ** 2)


def dims_of(g):
    d = dict(zip(M.FREE, g[:len(M.FREE)]))
    d["back_tilt"] = float(np.degrees(d["back_tilt"]))
    return d


def geometry(g, _cache={}):
    key = tuple(np.round(g[:len(M.FREE)], 9))
    if key not in _cache:
        if len(_cache) > 64:
            _cache.clear()
        d = dims_of(g)
        _cache[key] = (M.parts(d),) + M.samples(d)
    return _cache[key]


def continuous(q):
    """Quaternions (N, 4) of a track with the signs chosen so that neighbours are close."""
    q = q.copy()
    for k in range(1, len(q)):
        if q[k] @ q[k - 1] < 0:
            q[k] = -q[k]
    return q


def standing_pose(g):
    n = len(M.FREE)
    return Rot.from_euler("y", g[n + 3]).as_matrix(), g[n:n + 3]


# ---------------------------------------------------------------- scene and views
class Scene:
    """Cameras, fitted body, hands and the image evidence of a clip."""

    def __init__(self, clip):
        self.clip, self.wd = clip, work_dir(clip)
        self.cams = load_cameras(clip)
        self.fit = np.load(os.path.join(self.wd, "fit.npz"))
        self.N = len(self.fit["root_pos"])
        self.body = Body()
        self.poser = Poser(self.body, self.fit)
        self.v = np.load(os.path.join(self.wd, "shape.npz"))["v"].astype(np.float64)
        self.faces = self.body.faces.numpy()
        lab = np.array(self.body.labels)[self.body.wi.numpy()[:, 0]]
        self.trunk = np.nonzero(~np.char.count(lab, "Arm").astype(bool) & ~np.char.count(lab, "Hand").astype(bool))[0]
        self.palm = [np.nonzero(lab == s + "Hand")[0] for s in ("Right", "Left")]
        self.bg = CM.backgrounds(clip, self.N, self.N - 53)
        self.scan = CM.scan_depth(clip, self.cams)
        self._posed = {}

    def posed(self, k):
        """Clothed body surface at (fractional) frame k."""
        key = round(float(k), 3)
        if key not in self._posed:
            if len(self._posed) > 400:
                self._posed.clear()
            self._posed[key] = self.poser.pose(k, self.v)
        return self._posed[key]

    def hands(self, k):
        P = self.posed(k)
        return np.stack([P[i].mean(0) for i in self.palm])            # right, left

    def body_view(self, c, k, box):
        """Silhouette (0/1) and depth (m, 1e3 = no body) of the fitted body in a window of image k of camera c."""
        x0, y0, x1, y1 = box
        P = self.posed(k - self.cams[c]["dt"] * 15)
        px, z = project(self.cams[c], P)
        ids = raster_ids(px, z, self.faces, (y1 - y0, x1 - x0), (x0, y0))
        return (ids >= 0).astype(np.uint8), np.where(ids >= 0, z[self.faces].mean(1)[np.maximum(ids, 0)], 1e3).astype(np.float32)


def make_view(sc, c, k, box, mask, centres, body=None, zbody=None, in_body=True):
    """Everything term A / B needs from one image window. Term A reads the whole mask (it must not
    miss chair pixels); term B samples it only within GATE of `centres` and off the uncertain rim
    of the body outline (there it must not contain anything but chair pixels). `in_body`: the
    chair is on the camera's side of the man, so that light pixels inside his outline are chair."""
    x0, y0, x1, y1 = box
    cam = sc.cams[c]
    px, z = project(cam, np.atleast_2d(centres))
    vw = {"cam": c, "k": k, "kf": k - cam["dt"] * 15, "box": box, "mask": mask,
          "scan": sc.scan[c][y0:y1, x0:x1], "scale": float(z[0] / cam["f"]), "body": None, "front": in_body}
    vw["closed"] = CM.closed(mask, vw["scale"])
    vw["dtm"] = cv2.distanceTransform(1 - vw["closed"], cv2.DIST_L2, 5)
    yy, xx = np.mgrid[y0:y1, x0:x1]
    use = (mask > 0) & (np.hypot(xx[..., None] - px[:, 0], yy[..., None] - px[:, 1]) < GATE * cam["f"] / z).any(-1)
    if body is not None:
        pad = np.ones((2 * CM.BODY_PAD + 1,) * 2, np.uint8)
        grown = cv2.dilate(body, pad)
        vw["sil"] = body
        vw["body"] = cv2.GaussianBlur(grown.astype(np.float32), (0, 0), 1.5)
        vw["zbody"] = cv2.erode(zbody, np.ones((2 * CM.BODY_PAD + 5,) * 2, np.uint8))       # nearest body depth around
        use &= (grown == 0) | ((cv2.erode(body, pad) > 0) & in_body)
    ys, xs = np.nonzero(use)
    vw["area"] = len(xs) * vw["scale"] ** 2                       # m2 of chair this view shows
    if len(xs) > N_MASK:
        sel = np.random.default_rng(k).choice(len(xs), N_MASK, replace=False)
        ys, xs = ys[sel], xs[sel]
    vw["pts"] = np.zeros((N_MASK, 2)); vw["wp"] = np.zeros(N_MASK)
    vw["pts"][:len(xs)] = np.stack([xs + x0, ys + y0], 1); vw["wp"][:len(xs)] = 1.0
    return vw


def visible(sc, vw, px, z):
    """How much of each projected proxy point the camera can see (0..1): inside the frame, not behind
    scanned furniture that stands within 1.5 m in front of it, not behind the body."""
    x0, y0, x1, y1 = vw["box"]
    q = px - [x0, y0]
    qc = np.clip(q, 0, [x1 - x0 - 1.001, y1 - y0 - 1.001])
    free = ((px[:, 0] > 0) & (px[:, 0] < W - 1) & (px[:, 1] > 0) & (px[:, 1] < H - 1)).astype(float)
    qi = np.round(qc).astype(int)
    zs = vw["scan"][qi[:, 1], qi[:, 0]]
    free *= ~((zs < z - 0.15) & (zs > z - 1.5))
    if vw["body"] is not None:
        behind = 1.0 / (1.0 + np.exp(-np.clip((z - bilinear(vw["zbody"], qc) - 0.03) / 0.03, -30, 30)))
        free *= 1.0 - bilinear(vw["body"], qc) * behind
    return free, q, qc


def view_residuals(sc, vw, Xc, Xs, cap):
    """Terms A and B of one view for the proxy corners Xc (6, 8, 3) and sample points Xs (n, 3) in fit
    coordinates (the last LEG_POINTS of them on the legs, which count LEG_WEIGHT in term A)."""
    cam = sc.cams[vw["cam"]]
    px, z = project(cam, Xs)
    free, q, qc = visible(sc, vw, px, z)
    d = (bilinear(vw["dtm"], qc) + np.linalg.norm(q - qc, axis=1)) * z / cam["f"]
    rA = np.sqrt(free * soft_cap(d, cap) ** 2 + (1 - free) * (HIDE * cap) ** 2) / np.sqrt(len(Xs))
    rA[-LEG_POINTS:] *= LEG_WEIGHT
    rB = np.zeros(N_MASK)
    if vw["wp"].any():
        rB = soft_cap(M.hull_distance(vw["pts"], M.hulls(cam, Xc)) * vw["scale"], cap) * vw["wp"] / np.sqrt(N_MASK)
    return np.concatenate([rA, rB]) / SIGMA


def standing_views(sc, pos):
    out = []
    for c in CAMS:
        box = CM.window(sc.cams[c], pos + [0, 0.45, 0], 0.8)
        if (box[2] - box[0]) * (box[3] - box[1]) > 2000:
            out.append(make_view(sc, c, 0, box, CM.standing_mask(sc.bg[c], box), pos + [0, 0.45, 0]))
    return out


def moving_views(sc, ks, stand_pos, carried_from):
    """Views of the frames `ks` in every camera that has the hands in frame (before `carried_from` the
    window also holds the place where the chair stood); cached."""
    path = os.path.join(sc.wd, "chair_views.npz")
    cache = dict(np.load(path)) if os.path.exists(path) else {}
    out, new = [], False
    for k in ks:
        hands = sc.hands(k)
        centre = hands.mean(0) - [0, 0.2, 0]
        hip = sc.fit["kp3"][k, [5, 6, 11, 12]].mean(0)
        for c in CAMS:
            cam = sc.cams[c]
            px, z = project(cam, centre)
            if not (-150 < px[0] < W + 150 and -150 < px[1] < H + 150):
                continue
            centres = np.stack([centre, stand_pos + [0, 0.45, 0]]) if k < carried_from else centre[None]
            box = CM.window(cam, centres)
            if (box[2] - box[0]) * (box[3] - box[1]) < 2000:
                continue
            key = f"{c}_{k}"
            if key + "_m" not in cache or tuple(cache[key + "_box"]) != box:
                body, zb = sc.body_view(c, k, box)
                m, _ = CM.moving_mask(CM.frame(sc.clip, c, k), sc.bg[c], box, body)
                cache[key + "_m"], cache[key + "_b"], cache[key + "_z"] = np.packbits(m), np.packbits(body), zb.astype(np.float16)
                cache[key + "_box"] = np.array(box); new = True
            sh = (box[3] - box[1], box[2] - box[0])
            m = np.unpackbits(cache[key + "_m"])[:sh[0] * sh[1]].reshape(sh)
            body = np.unpackbits(cache[key + "_b"])[:sh[0] * sh[1]].reshape(sh)
            # light pixels inside the body outline are the chair only if the chair is on the camera's side of the man
            front = project(cam, centre)[1] < project(cam, hip)[1] + 0.05
            out.append(make_view(sc, c, k, box, m, centres, body, cache[key + "_z"].astype(np.float32), in_body=bool(front)))
    if new:
        np.savez_compressed(path, **cache)
    return out


# ---------------------------------------------------------------- 1 standing
def fit_standing(sc, guess_xz, log):
    """Pose on the floor and dimensions from the views in which the chair stands alone -> globals vector."""
    n = len(M.FREE)
    g0 = np.zeros(NG)
    g0[:n] = [np.radians(M.DIMS[f]) if f == "back_tilt" else M.DIMS[f] for f in M.FREE]
    top = M.parts(M.DIMS)[1][[6, 7]].mean(0)                      # top edge of the backrest, where the hand rests
    views = standing_views(sc, np.array([guess_xz[0], 0.0, guess_xz[1]]))

    def fun(x, idx, g, cap):
        gg = g.copy(); gg[idx] = x
        C, S, _ = geometry(gg)
        R, p = standing_pose(gg)
        res = [view_residuals(sc, vw, C @ R.T + p, S @ R.T + p, cap) for vw in views]
        return np.concatenate(res + [(gg[:n] - g0[:n]) / np.where(np.array(M.FREE) == "back_tilt", 0.1, DIM_SIGMA)])

    def solve(g, idx, cap):
        sol = least_squares(fun, g[idx], args=(idx, g, cap), diff_step=1e-3, max_nfev=40)
        g[idx] = sol.x
        return sol.cost
    best = None
    for yaw in np.radians(np.arange(0, 360, 45)):                 # the far views do not tell front from back by gradient
        g = g0.copy()
        xz = guess_xz - (Rot.from_euler("y", yaw).as_matrix() @ top)[[0, 2]]
        g[n:n + 4] = [xz[0], 0.0, xz[1], yaw]
        for cap in (0.30, 0.10):
            cost = solve(g, np.arange(n, n + 4), cap)
        log(f"  yaw start {np.degrees(yaw):5.0f} deg -> cost {cost:8.2f}  yaw {np.degrees(g[n + 3]) % 360:6.1f}  pos {np.round(g[n:n + 3], 3)}")
        if best is None or cost < best[0]:
            best = (cost, g)
    g = best[1]
    R, p = standing_pose(g)
    for vw in views:                                              # what else changed around the chair is not the chair
        vw["wp"] *= M.hull_distance(vw["pts"], M.hulls(sc.cams[vw["cam"]], geometry(g)[0] @ R.T + p)) * vw["scale"] < 0.15
    for cap in (0.10, 0.04):
        cost = solve(g, np.arange(n + 4), cap)
    log(f"  standing: cost {cost:.2f}, yaw {np.degrees(g[n + 3]) % 360:.1f} deg, pos {np.round(g[n:n + 3], 3)}")
    return g


# ---------------------------------------------------------------- 2 touch
def find_touch(sc, g):
    """-> first frame at which a palm is on the standing chair (within HOLD), first frame from which
    the hands stay further than AWAY (horizontally) from the place of its seat."""
    R, p = standing_pose(g)
    tree = cKDTree(geometry(g)[1] @ R.T + p)
    Hd = np.stack([sc.hands(k) for k in range(sc.N)])
    near = tree.query(Hd)[0].min(1) < HOLD
    far = np.linalg.norm(Hd.mean(1)[:, [0, 2]] - p[[0, 2]], axis=1) > AWAY
    touch = int(np.argmax(near))
    away = touch + int(np.argmax(np.cumsum(~far[touch:][::-1])[::-1] == 0))
    return touch, away


# ---------------------------------------------------------------- 3 + 4 track
def hand_frames(sc, ks):
    """Per frame: palms (2, 3) and a frame carried by the two hands: origin between them, z from the
    right to the left palm (over five frames: the palms are known to a few cm, and the feet of a
    chair held by them would swing with that), y as upright as that allows."""
    Hd = np.stack([sc.hands(k) for k in ks])
    z = smooth(Hd[:, 1] - Hd[:, 0], 5); z /= np.linalg.norm(z, axis=1, keepdims=True)
    y = np.array([0, 1.0, 0]) - z * z[:, 1:2]; y /= np.linalg.norm(y, axis=1, keepdims=True)
    return Hd, np.stack([np.cross(y, z), y, z], -1), Hd.mean(1)


class Track:
    """Steps 3 and 4: the chair from the first touch to the end of the clip (frames `ks`)."""

    def __init__(self, sc, ks, carried_from, views, g, log):
        self.sc, self.ks, self.n, self.log = sc, np.asarray(ks), len(ks), log
        self.Hd, self.A, self.mid = hand_frames(sc, ks)
        self.trees, self.bodyP, self.bodyN = [], [], []
        for k in ks:
            P = sc.posed(k)
            self.bodyP.append(P[sc.trunk]); self.bodyN.append(vertex_normals(P, sc.faces)[sc.trunk])
            self.trees.append(cKDTree(self.bodyP[-1]))
        self.carried = self.ks >= carried_from                     # frames in which both hands hold the chair
        self.mine = [[] for _ in ks]                               # the views of each frame, and how far the hands
        for vw in views:                                           # move between the frame and the instant of the view
            i = int(np.clip(round(vw["kf"]) - ks[0], 0, self.n - 1))
            self.mine[i].append((vw, np.gradient(self.mid, axis=0)[i] * (vw["kf"] - ks[i])))
        self.C, self.S, _ = geometry(g)
        self.feet = np.argsort(self.S[:, 1])[:4]
        Rs, self.ps = standing_pose(g)
        self.Rs = Rot.from_matrix(Rs)

    def inside(self, i, X):
        """Residuals for the points X of the proxy that are inside the trunk or legs of the body of frame i."""
        dist, j = self.trees[i].query(X)
        depth = -((X - self.bodyP[i][j]) * self.bodyN[i][j]).sum(1)
        return np.where(dist < 0.15, np.maximum(0, depth - PEN_TOL), 0) / SIGMA / np.sqrt(len(X) / 20)

    def holding(self, i, P, R):
        """Which palms (right, left) rest on the proxy posed (P, R) in frame i."""
        return cKDTree(R.apply(self.S) + P).query(self.Hd[i])[0] < HOLD

    def carry(self, i, j, P, R):
        """Pose (P, R) of frame i moved on to frame j by the palms that rest on the chair in frame i:
        two hands turn a chair that is off the floor with them; otherwise it is shifted with the
        palms on it (a chair on the floor is not turned by a hand that reaches for it)
        -> P, R, holding palms."""
        hold = self.holding(i, P, R)
        if hold.all() and (R.apply(self.S[self.feet]) + P)[:, 1].min() > self.ps[1] + LIFTED:
            turn = Rot.from_matrix(self.A[j] @ self.A[i].T)
            return self.mid[j] + turn.apply(P - self.mid[i]), turn * R, hold
        return P + ((self.Hd[j] - self.Hd[i])[hold].mean(0) if hold.any() else 0), R, hold

    def fit_frame(self, i, P, R, hold, caps, prior=True, nfev=15, images=True):
        """Pose of frame i from its own images (terms A + B; none with images=False), starting at
        (P, R): out of the body, feet above the floor, the palms `hold` on the chair; with `prior`,
        close to the start -> P, R, cost without the prior."""
        def fun(x, cap, prior):
            Rm, p = (R * Rot.from_rotvec(x[3:])).as_matrix(), P + x[:3]
            X = self.S @ Rm.T + p
            res = [view_residuals(self.sc, vw, self.C @ Rm.T + p + (hold.any() * dp), X + hold.any() * dp, cap)
                   for vw, dp in self.mine[i] if images]
            res += [self.inside(i, X), np.minimum(0, X[self.feet, 1] - self.ps[1]) / SIGMA,
                    np.maximum(0, cKDTree(X).query(self.Hd[i][hold])[0] - HOLD) / GRIP]
            return np.concatenate(res + ([x[:3] / STEP, x[3:] / TURN] if prior else []))
        x = np.zeros(6)
        for cap in caps:
            x = least_squares(fun, x, args=(cap, prior), diff_step=1e-3, max_nfev=nfev).x
        return P + x[:3], R * Rot.from_rotvec(x[3:]), 0.5 * (fun(x, caps[-1], False) ** 2).sum()

    def anchor(self):
        """The pose of the carried chair in a frame that two cameras see well, without any guess of how
        he holds it: centre from the masks, attitude by multi-start, both palms on the chair. Done in
        three such frames; the one whose pose, moved on with the hands, fits the other two best wins
        -> frame index, P, R."""
        area = np.array([sorted([vw["area"] for vw, _ in m] + [0, 0])[-2] for m in self.mine]) * self.carried
        keys = []
        for i in np.argsort(-area):
            if area[i] > 0 and len(keys) < 3 and all(abs(i - j) >= 8 for j in keys):
                keys.append(int(i))
        both = np.array([True, True])
        tilts = [np.zeros(3)] + [np.radians(35) * np.array(v) for v in ((1, 0, 0), (-1, 0, 0), (0, 0, 1), (0, 0, -1))]
        found = []
        for i in keys:
            seen = [vw for vw, _ in self.mine[i] if vw["area"] >= 0.5 * area[i]]
            mid = least_squares(lambda X: np.concatenate([(project(self.sc.cams[vw["cam"]], X)[0] - vw["pts"][vw["wp"] > 0].mean(0)) * vw["scale"]
                                                          for vw in seen]), self.mid[i]).x
            fits = []
            for yaw in range(0, 360, 45):
                for tilt in tilts:
                    R = Rot.from_euler("y", yaw, degrees=True) * Rot.from_rotvec(tilt)
                    fits.append(self.fit_frame(i, mid - R.apply(self.S.mean(0)), R, both, (0.30,), prior=False, nfev=12))
            fits = [self.fit_frame(i, P, R, both, (0.10, 0.04), prior=False, nfev=30) for P, R, _ in sorted(fits, key=lambda f: f[2])[:3]]
            found.append(min(fits, key=lambda f: f[2]))
            self.log(f"  frame {self.ks[i]}: costs of the three best attitudes {np.round(sorted(f[2] for f in fits), 1)}")
        total = [sum(self.fit_frame(j, *self.carry(i, j, P, R), (0.10,), nfev=1)[2] for j in keys if j != i) for i, (P, R, _) in zip(keys, found)]
        best = int(np.argmin(total))
        self.log(f"  moved on to the other frames: costs {np.round(total, 1)} -> anchor frame {self.ks[keys[best]]}")
        return keys[best], found[best][0], found[best][1]

    def fit_grip(self, t, r):
        """The one pose (t, r) of the chair in the hand frame that fits the images of all carried frames
        best, starting from the given one -> t, r."""
        idx = np.nonzero(self.carried)[0][::2]

        def fun(x, cap):
            out = []
            for i in idx:
                P, R = self.gripped(i, t + x[:3], r * Rot.from_rotvec(x[3:]))
                Rm = R.as_matrix()
                X = self.S @ Rm.T + P
                out += [view_residuals(self.sc, vw, self.C @ Rm.T + P + dp, X + dp, cap) for vw, dp in self.mine[i]] + [self.inside(i, X)]
            return np.concatenate(out)
        x = np.zeros(6)
        for cap in (0.15, 0.05):
            x = least_squares(fun, x, args=(cap,), diff_step=1e-3, max_nfev=12).x
        return t + x[:3], r * Rot.from_rotvec(x[3:])

    def gripped(self, i, t, r):
        """Pose in frame i of a chair that is at (t, r) in the hand frame."""
        return self.mid[i] + self.A[i] @ t, Rot.from_matrix(self.A[i]) * r

    def follow(self, i, P, R, frames):
        """From the pose (P, R) of frame i through the neighbouring `frames`, one after the other: each
        pose starts where the last one ended, moved on with the hands, and is fitted to the images of
        its own frame -> {frame: (P, R)}."""
        out = {}
        for j in frames:
            P, R, hold = self.carry(i, j, P, R)
            P, R, _ = self.fit_frame(j, P, R, hold, (0.15, 0.05))
            out[j], i = (P, R), j
        return out

    def run(self):
        """-> positions (n, 3) and rotations of the frames, grip points (2, 3) of the palms in the chair."""
        n, c0, both = self.n, int(np.argmax(self.carried)), np.array([True, True])
        self.log("3 grip")
        ia, Pa, Ra = self.anchor()
        t, r = self.fit_grip(self.A[ia].T @ (Pa - self.mid[ia]), Rot.from_matrix(self.A[ia]).inv() * Ra)
        self.log(f"  the chair in the hand frame: at {np.round(t, 2)} m, turned {np.round(np.degrees(r.as_rotvec()))} deg")
        self.log("4 track")
        dev, ok = np.zeros((n, 6)), np.zeros(n, bool)             # carried: what each frame adds to the grip
        for i in range(c0, n):
            if max((vw["area"] for vw, _ in self.mine[i] if vw["front"]), default=0) >= MIN_AREA:
                P, R = self.gripped(i, t, r)
                Pf, Rf, _ = self.fit_frame(i, P, R, both, (0.10, 0.04))
                dev[i], ok[i] = np.concatenate([self.A[i].T @ (Pf - P), (R.inv() * Rf).as_rotvec()]), True
        seen = np.nonzero(ok)[0]
        dev = dev[seen[np.abs(np.arange(c0, n)[:, None] - seen).argmin(1)]]         # unseen frames: as the nearest seen one
        dev = smooth(median_filter(dev, (MEDIAN, 1), mode="nearest"), 5)
        self.log(f"  {ok.sum()} of {n - c0} carried frames fitted; they add up to {np.abs(dev[:, :3]).max():.2f} m and "
                 f"{np.degrees(np.linalg.norm(dev[:, 3:], axis=1).max()):.0f} deg to the grip")
        got = {i: self.gripped(i, t + d[:3], r * Rot.from_rotvec(d[3:])) for i, d in zip(range(c0, n), dev)}
        hit = [i for i in range(c0, n) if self.inside(i, got[i][1].apply(self.S) + got[i][0]).any()]
        for i in hit:                                             # the smoothed grip must not enter the body
            got[i] = self.fit_frame(i, *got[i], both, (0.04,), images=False)[:2]
        self.log(f"  {len(hit)} carried frames moved out of the body")
        got.update(self.follow(c0, *got[c0], range(c0 - 1, 1, -1)))
        gap = np.linalg.norm(got[2][0] - self.ps), np.degrees((self.Rs.inv() * got[2][1]).magnitude())
        self.log(f"  followed back to the touch: {gap[0]:.3f} m and {gap[1]:.1f} deg from the standing pose")
        for i in range(EASE + 2):                                 # the track leaves the standing pose smoothly
            w = np.clip((i - 1) / EASE, 0, 1) ** 2 * (3 - 2 * np.clip((i - 1) / EASE, 0, 1))
            Pi, Ri = got.get(i, (self.ps, self.Rs))
            got[i] = (1 - w) * self.ps + w * Pi, self.Rs * Rot.from_rotvec(w * (self.Rs.inv() * Ri).as_rotvec())
        P, R = np.stack([got[i][0] for i in range(n)]), Rot.concatenate([got[i][1] for i in range(n)])
        q = continuous(R.as_quat())
        P[:c0], q[:c0] = smooth(P, 5)[:c0], smooth(q, 5)[:c0]     # the pick-up was fitted frame by frame
        R = Rot.from_quat(q / np.linalg.norm(q, axis=1, keepdims=True))
        grips = np.stack([np.median(R[c0:].inv().apply(self.Hd[c0:, h] - P[c0:]), 0) for h in (0, 1)])
        self.log(f"  the palms in the chair: right {np.round(grips[0], 2)}, left {np.round(grips[1], 2)}")
        return P, R, grips


# ---------------------------------------------------------------- output
PANEL_PCT, LEG_PCT = 85, 95


def colours(sc, C, P, R, frames):
    """RGB of the slatted metal panels and of the legs over the close views of the carried chair: a high
    percentile of the mask pixels inside their outlines, which is the lit surface (the rest is slat shadow,
    what shows through the gaps and, on the legs, pixels mixed with what is behind them). The 85th for the
    panels; the 95th for the legs, which are 2 cm tubes a few pixels wide, so that most of their pixels are
    such mixtures (their 85th percentile is a darker grey than any leg looks in the footage)."""
    panel, leg = [], []
    for k in frames:
        for c in CAMS:
            cmp = CR.compare(sc, C, P, R, c, k)
            if cmp is not None and CR.score(cmp):
                x0, y0, x1, y1 = cmp["box"]
                img, ok = CM.frame(sc.clip, c, k)[y0:y1, x0:x1], cmp["mask"] & cmp["valid"] & (cmp["body"] == 0)
                panel.append(img[ok & (M.raster(cmp["polys"][:2], ok.shape, (x0, y0)) > 0)])
                leg.append(img[ok & (M.raster(cmp["polys"][2:], ok.shape, (x0, y0)) > 0) & (M.raster(cmp["polys"][:2], ok.shape, (x0, y0)) == 0)])
    return [[int(round(v)) for v in np.percentile(np.concatenate(px), pct, axis=0)[::-1]] for px, pct in ((panel, PANEL_PCT), (leg, LEG_PCT))]


def write_outputs(sc, g, ks, P, R, grips, touch, away, log):
    """chair-01.glb and prop_chair.json from the track (P, R) of the frames ks; before ks[0] the chair stands."""
    N, fit = sc.N, sc.fit
    C, S, _ = geometry(g)
    Rs, ps = standing_pose(g)
    pos = np.tile(ps, (N, 1)); pos[ks] = P
    rot = Rot.concatenate([Rot.from_matrix(np.tile(Rs, (ks[0], 1, 1))), R])
    quat = continuous(rot.as_quat())
    feet = S[np.argsort(S[:, 1])[:4]]
    low = (rot.as_matrix() @ feet.T)[:, 1].min(1) + pos[:, 1] - ps[1]          # lowest foot above where it stood
    moved = (np.linalg.norm(pos - ps, axis=1) > 0.015) | ((rot[0].inv() * rot).magnitude() > np.radians(2))
    move = int(np.argmax(moved))
    up = N - int(np.argmax((low < LIFTED)[::-1]))                 # first frame from which it stays off the floor
    w = np.clip((np.arange(N) - (up - BLEND // 2)) / BLEND, 0, 1)
    w = w * w * (3 - 2 * w)
    lift = (1 - w) * (sample_floor(*fit_floor(fit), ps[[0, 2]]) - ps[1]) + w * fit_lift(fit)
    rows = CR.evaluate(sc, C, pos, rot, list(range(0, touch, 8)) + list(range(touch, N)))
    seen = {r["k"] for r in rows if r["iou"] >= 0.3}
    fitted = [bool(k < touch or k in seen) for k in range(N)]
    d = dims_of(g)
    box = C.reshape(-1, 3)
    dims = {"width": float(np.ptp(box[:, 0])), "depth": float(np.ptp(box[:, 2])), "height": float(box[:, 1].max()), **d}
    i = ks >= away
    grip = [np.linalg.norm(R[i].apply(grips[h]) + P[i] - np.stack([sc.hands(k) for k in ks[i]])[:, h], axis=1) for h in (0, 1)]
    acc = np.linalg.norm(pos[:-2] - 2 * pos[1:-1] + pos[2:], axis=1)
    turn = np.degrees((rot[:-1].inv() * rot[1:]).magnitude())
    metrics = {"touchFrame": touch, "moveFrame": move, "liftFrame": up, "carriedFrame": away,
               "silhouette": CR.summary(rows, {"standing": (0, touch), "pickUp": (touch, away), "carry": (away, N)}),
               "palmToGripM": {"rightMedian": round(float(np.median(grip[0])), 3), "rightMax": round(float(grip[0].max()), 3),
                               "leftMedian": round(float(np.median(grip[1])), 3), "leftMax": round(float(grip[1].max()), 3)},
               "accelerationMPerFrame2": {"median": round(float(np.median(acc[ks[0]:])), 4), "max": round(float(acc.max()), 4)},
               "turnDegPerFrameMax": round(float(turn.max()), 2)}
    metrics["panelRGB"], metrics["legRGB"] = colours(sc, C, pos, rot, range(away + 4, N, 6))
    os.makedirs(os.path.join(public_dir(sc.clip), "avatar"), exist_ok=True)
    nv, nf = M.write_glb(os.path.join(public_dir(sc.clip), "avatar", "chair-01.glb"), d, metrics["panelRGB"], metrics["legRGB"],
                         {"dims": {k: round(v, 4) for k, v in dims.items()}})
    out = {"id": "chair-01", "kind": "chair", "glb": "avatar/chair-01.glb", "frameCount": N,
           "dims": {k: round(v, 4) for k, v in dims.items()}, "plain": M.PLAIN,
           "frames": {"pos": np.round(pos, 4).tolist(), "quat": np.round(quat, 5).tolist(), "lift": np.round(lift, 4).tolist(),
                      "held": [bool(k >= up) for k in range(N)], "visible": [True] * N, "fitted": fitted},
           "metrics": metrics}
    with open(os.path.join(sc.wd, "prop_chair.json"), "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    log(f"  chair-01.glb ({nv} vertices, {nf} triangles, panels {metrics['panelRGB']}, legs {metrics['legRGB']}), prop_chair.json; "
        f"moves at frame {move}, off the floor at {up}")
    return pos, rot, out


REVIEW = [20, 100, 150, 200, 216, 224, 232, 240, 250, 262, 272, 282, 292, 305]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clip", default="clip02")
    ap.add_argument("--grab", type=int, default=216, help="a frame at which a hand rests on the backrest of the standing chair")
    ap.add_argument("--refit", action="store_true", help="ignore the cached solution (chair_track.npz)")
    ap.add_argument("--review", default="", help="folder for the review sheets")
    a = ap.parse_args()
    t0 = time.time()
    log = lambda s: print(f"[{time.time() - t0:6.0f} s] {s}", flush=True)
    sc = Scene(a.clip)
    path = os.path.join(sc.wd, "chair_track.npz")
    if os.path.exists(path) and not a.refit:
        z = np.load(path)
        g, ks, P, R, grips, touch, away = z["g"], z["ks"], z["P"], Rot.from_rotvec(z["R"]), z["grips"], int(z["touch"]), int(z["away"])
        log(f"track of frames {ks[0]}..{ks[-1]} from {path}")
    else:
        log("1 standing")
        hands = sc.hands(a.grab)
        g = fit_standing(sc, hands[np.argmin(np.abs(hands[:, 1] - M.DIMS["back_h"]))][[0, 2]], log)
        ps = standing_pose(g)[1]
        touch, away = find_touch(sc, g)
        log(f"2 touch: a hand reaches the chair at frame {touch}, the hands carry it away from frame {away}")
        ks = np.arange(touch - 2, sc.N)
        views = moving_views(sc, ks, ps, away)
        log(f"  {len(views)} views of frames {ks[0]}..{ks[-1]}: " + ", ".join(f"{c} {sum(v['cam'] == c for v in views)}" for c in CAMS))
        P, R, grips = Track(sc, ks, away, views, g, log).run()
        np.savez(path, g=g, ks=ks, P=P, R=R.as_rotvec(), grips=grips, touch=touch, away=away)
    log(f"  dims {({k: round(v, 3) for k, v in dims_of(g).items()})}")
    pos, rot, out = write_outputs(sc, g, ks, P, R, grips, touch, away, log)
    for name, m in out["metrics"]["silhouette"].items():
        log(f"  {name} {m['frames']}: " + "; ".join(f"{c} IoU {m[c]['iouMedian']:.2f}, outline {m[c]['outlinePxMedian']:.1f} px, worst {m[c]['worst'][0]}"
                                                 for c in CAMS if c in m))
    if a.review:
        CR.sheets(sc, geometry(g)[0], pos, rot, REVIEW, a.review)
        Rs, ps = standing_pose(g)
        CR.scan_picture(geometry(g)[0], Rs, ps + [0, out["frames"]["lift"][0], 0], os.path.join(a.review, "scan.jpg"))
        log(f"review sheets in {a.review}")


if __name__ == "__main__":
    main()
