"""Step 3 - fit ONE articulated body to all four cameras over the whole clip.

Unknowns: a single body shape (Anny phenotypes + uniform scale) shared by every frame, and per
frame a root position / orientation plus anatomical joint angles (ball joints for spine, neck,
shoulders, hips and ankles; limited hinges for elbows and knees).

Evidence: RTMW 2D keypoints in every camera (robust, confidence-weighted reprojection through the
refined calibration; detections that are not on the visible person are dropped, see
masks.hidden_keypoints), temporal smoothness of the motion, joint limits (hinges for knees and
elbows, the range of the ankle), and the room floor (soles may not sink below it, one foot is always
down, planted feet do not slide).

Usage: python fit.py --clip clip02
Output: data/<clip>/avatar/fit.npz
"""
import argparse, json, os, time
import numpy as np
import torch
import torch.nn.functional as F

from body import Body, PHENOTYPES
from common import CAMS, KP_NAMES, load_cameras, load_json, public_dir, work_dir
from masks import load_keypoints
from posefit import ANKLE_HI, ANKLE_LO, FLIP_PERM, HIP_TWIST, MAX_RATE, OKS, SOLE_Y, Rig, cams_to_torch, gm, project_t, second_diff, twist_angle
from triangulate import triangulate_all

torch.set_num_threads(4)
FOOT_KP = [17, 18, 19, 20, 21, 22]


def log(*a):
    print(*a, flush=True)


class Fitter:
    def __init__(self, clip, body=None, gender=0.0):
        self.clip = clip
        wd = work_dir(clip)
        kp, self.boxes, self.src, hidden = load_keypoints(clip)
        self.kp_np = kp[:, :, :23].copy()                 # (C, N, 23, 3); hidden keypoints have score 0
        self.n_hidden = hidden[:, :, :23].sum((1, 2)).tolist()
        self.C, self.N = self.kp_np.shape[:2]
        self.cams = load_cameras(clip)
        self.ct = cams_to_torch(self.cams)
        self.fps = load_json(os.path.join(public_dir(clip), "manifest.json"))["fps"]
        self.body = body or Body()
        # Anny phenotypes (gender, age, muscle, weight, height, proportions); gender 0 = male, 1 = female.
        self.phen = torch.tensor([float(gender), 0.5, 0.5, 0.5, 0.5, 0.5])
        self.scale = torch.tensor(1.0)
        # the floor the soles rest on: the nominal plane y = 0 here; refine.py replaces it with a height
        # map of the scanned floor of the room model (room.py), see set_floor / floor_at
        self.floor = None
        self.lift = torch.zeros(self.N)
        self.set_rest()
        self.rig = Rig(self.body, self.rest)
        log("finger curl signs", self.rig.calibrate_curl(self.rest))
        self.p = self.rig.new_params(self.N)
        self.R0 = torch.eye(3).repeat(self.N, 1, 1)
        self.prepare_data()

    # ---- data ---------------------------------------------------------------------------
    def prepare_data(self):
        kp = self.kp_np
        bh = self.boxes[..., 3] - self.boxes[..., 1]
        bh = np.where(np.isfinite(bh), bh, 200.0)
        sig = np.maximum(3.0, 0.02 * bh[..., None] * (OKS[None, None] / 0.07))         # px
        w = np.clip((kp[..., 2] - 1.5) / 2.0, 0.0, 1.0) * (self.src[..., None] > 0)
        # clock offsets from the calibration: shift the 2D targets by dt * image velocity
        ok = kp[..., 2] >= 2.5
        vel = np.zeros_like(kp[..., :2])
        both = ok[:, 2:] & ok[:, :-2]
        vel[:, 1:-1] = np.where(both[..., None], (kp[:, 2:, :, :2] - kp[:, :-2, :, :2]) / 2.0, 0.0)
        dts = np.array([self.cams[c].get("dt", 0.0) for c in CAMS])
        uv = kp[..., :2] + dts[:, None, None, None] * self.fps * vel
        self.uv = torch.tensor(uv, dtype=torch.float32)
        self.sig = torch.tensor(sig, dtype=torch.float32)
        self.w2d = torch.tensor(w, dtype=torch.float32)

    def set_rest(self, grad=False):
        if grad:
            self.rest = self.body.rest(self.phen, self.scale)
        else:
            with torch.no_grad():
                self.rest = self.body.rest(self.phen, self.scale)
        self.kp_b = self.body.kp_terms(self.rest)
        v = self.rest["v"].detach()
        # sole vertices: the lowest slice of the vertices skinned to the feet / toes
        if not hasattr(self, "sole"):
            ix = self.body.idx
            self.sole = {}
            for s in ("Left", "Right"):
                wf = self.body.w_dense[:, [ix[f"{s}Foot"], ix[f"{s}ToeBase"]]].sum(1)
                cand = torch.nonzero(wf > 0.9)[:, 0]
                y = v[cand, 1]
                low = cand[y < y.min() + 0.012]
                step = max(1, len(low) // 60)
                self.sole[s] = low[::step]
            self.sole_all = torch.cat([self.sole["Left"], self.sole["Right"]])
            self.n_sole_l = len(self.sole["Left"])

    # ---- floor --------------------------------------------------------------------------
    def set_floor(self, fm, lift):
        """Stand the body on a height map from room.floor_map instead of the plane y = 0.

        The cameras do not see the relief of the scanned floor: triangulated soles sit at the same
        height wherever the scan puts the floor (-1 .. +4 cm along the path of clip02), so the relief is
        drift of the scan against the cameras, not a step in the room. Pushing the body up onto it
        would contradict every image by that much. Instead frame k of the fit stays where the cameras
        see it and is shown `lift[k]` higher, the scanned floor height under the body: the floor
        terms work on the lifted body (room()), everything that is compared with an image does not."""
        self.lift = torch.as_tensor(np.asarray(lift), dtype=torch.float32)
        self.floor = {"grid": torch.tensor(fm["grid"], dtype=torch.float32)[None, None], "origin": [float(v) for v in fm["origin"]],
                      "np": (np.asarray(fm["grid"], np.float32), np.asarray(fm["origin"], np.float32))}

    def floor_at(self, xz):
        """Floor height under points (..., 2) = (x, z): bilinear lookup, clamped at the border of the map.
        The lookup is treated as a constant in the optimisation (the floor is nearly level)."""
        if self.floor is None:
            return torch.zeros(xz.shape[:-1])
        g = self.floor["grid"]
        x0, z0, cell = self.floor["origin"]
        nz, nx = g.shape[-2:]
        q = xz.detach()
        uv = torch.stack([(q[..., 0] - x0) / cell / (nx - 1) * 2 - 1, (q[..., 1] - z0) / cell / (nz - 1) * 2 - 1], -1)
        return F.grid_sample(g, uv.reshape(1, -1, 1, 2), mode="bilinear", padding_mode="border", align_corners=True).reshape(xz.shape[:-1])

    def room(self, P):
        """Points (N, S, 3) of all frames -> where the viewer shows them: lifted onto the scanned floor."""
        return P + torch.stack([torch.zeros_like(self.lift), self.lift, torch.zeros_like(self.lift)], -1)[:, None]

    # ---- forward ------------------------------------------------------------------------
    def forward(self, sl=slice(None)):
        p = {k: v[sl] for k, v in self.p.items()}
        rot = self.rig.assemble(p, self.R0[sl])
        GR, Gp = self.body.fk(rot, p["root_pos"], self.rest["heads"])
        kp3 = self.body.keypoints(GR, Gp, self.kp_b)
        return rot, GR, Gp, kp3

    def loss(self, wts, X3d=None, w3d=None):
        rot, GR, Gp, kp3 = self.forward()
        p = self.p
        out = {}
        if wts.get("kp3d", 0) > 0:
            d2 = ((kp3 - X3d) ** 2).sum(-1) / 0.03 ** 2
            out["kp3d"] = wts["kp3d"] * (w3d * gm(d2, 4.0)).sum() / self.N
        if wts.get("kp2d", 0) > 0:
            px, z = project_t(self.ct, kp3)                                # (C, N, K, 2)
            r2 = ((px - self.uv) ** 2).sum(-1) / self.sig ** 2
            out["kp2d"] = wts["kp2d"] * (self.w2d * gm(r2, wts.get("gm_c", 3.0))).sum() / self.N
        # temporal smoothness
        acc = second_diff(kp3)
        out["acc"] = wts["acc"] * (acc ** 2).sum() / self.N / 0.03 ** 2
        out["root_acc"] = wts["root_acc"] * (second_diff(p["root_pos"]) ** 2).sum() / self.N / 0.01 ** 2
        ang = torch.cat([p[k].reshape(self.N, -1) for k in ("spine", "neck", "clav", "arm", "thigh", "foot")], 1)
        out["ang_vel"] = wts["ang_vel"] * ((ang[1:] - ang[:-1]) ** 2).sum() / self.N / 0.3 ** 2
        out["ang_acc"] = wts["ang_acc"] * (second_diff(ang) ** 2).sum() / self.N / 0.15 ** 2
        Rr = rot[:, 0]
        out["root_rot"] = wts["root_rot"] * (second_diff(Rr) ** 2).sum() / self.N / 0.08 ** 2
        # pose priors
        neutral_arm = torch.stack([self.rig.neutral["LeftArm"], self.rig.neutral["RightArm"]])
        pr = (p["spine"] ** 2).sum() / 0.6 ** 2 + (p["neck"] ** 2).sum() / 0.5 ** 2 + (p["clav"] ** 2).sum() / 0.12 ** 2 \
            + ((p["arm"] - neutral_arm) ** 2).sum() / 1.2 ** 2 + (p["thigh"] ** 2).sum() / 1.2 ** 2 \
            + (p["foot"] ** 2).sum() / 0.35 ** 2 + (p["root_d"] ** 2).sum() / 2.0 ** 2
        out["prior"] = wts["prior"] * pr / self.N
        # twist about the bone axis is unobservable for straight limbs: keep it small
        tw = self.limb_twist(p)
        out["twist"] = wts["prior"] * ((tw["arm"] ** 2).sum() / 0.5 ** 2 + (tw["thigh"] ** 2).sum() / 0.4 ** 2) / self.N
        # joint limits. An ankle and a hip do not leave their anatomical range, whatever a hidden toe is
        # guessed to do: without the second limit the thigh turns by what the ankle no longer can
        over = torch.relu(p["foot"] - torch.tensor(ANKLE_HI)) + torch.relu(torch.tensor(ANKLE_LO) - p["foot"])
        out["ankle"] = wts.get("ankle", 1.0) * (over ** 2).sum() / self.N / 0.05 ** 2
        out["hip"] = wts.get("hip", 1.0) * (torch.relu(tw["thigh"].abs() - HIP_TWIST) ** 2).sum() / self.N / 0.05 ** 2
        # and no joint turns faster than a person can move it
        out["rate"] = wts.get("rate", 1.0) * self.rate_excess(p) / self.N / 0.05 ** 2
        # a frame that no camera observes keeps the pose of the frame next to it (the root coasts on)
        seen = self.w2d.sum((0, 2)) > 0
        if not bool(seen.all()):
            gap = ~(seen[1:] & seen[:-1])
            q = {**{k: p[k] for k in ("spine", "neck", "clav", "arm", "thigh", "foot")}, **self.hinge_angles(p)}
            out["hold"] = sum(((v[1:] - v[:-1])[gap] ** 2).sum() for v in q.values()) / self.N / 0.02 ** 2
        # floor
        if wts.get("floor", 0) > 0:
            sv = self.room(self.body.skin(GR, Gp, self.rest, self.sole_all))   # (N, S, 3)
            y = sv[..., 1] - self.floor_at(sv[..., [0, 2]])                # height above the floor under each point
            pen = torch.relu(SOLE_Y - 0.005 - y)
            out["floor_pen"] = wts["floor"] * (pen ** 2).sum(1).mean() / 0.01 ** 2
            lo = -torch.logsumexp(-y / 0.01, dim=1) * 0.01 + 0.01 * np.log(y.shape[1])   # soft min
            out["floor_contact"] = wts["floor"] * (torch.relu(lo - SOLE_Y - 0.01) ** 2).mean() / 0.02 ** 2 * 4
            if wts.get("skate", 0) > 0:
                # planted foot does not slide: weight by (detached) lowness and slowness of each foot
                yl, yr = y[:, :self.n_sole_l].mean(1), y[:, self.n_sole_l:].mean(1)
                cl, cr = sv[:, :self.n_sole_l].mean(1), sv[:, self.n_sole_l:].mean(1)
                for nm, yy, cc in (("l", yl, cl), ("r", yr, cr)):
                    v = cc[1:] - cc[:-1]
                    sp = (v[:, [0, 2]] ** 2).sum(-1)
                    wc = torch.sigmoid((SOLE_Y + 0.04 - yy[1:].detach()) / 0.01) * torch.exp(-sp.detach() / 0.03 ** 2)
                    out[f"skate_{nm}"] = wts["skate"] * (wc * (v ** 2).sum(-1)).sum() / self.N / 0.01 ** 2
        return sum(out.values()), out, kp3

    def limb_twist(self, p):
        """Rotation of the upper arms / thighs about the bone's own (rest) axis, rad: {"arm", "thigh"}: (N, 2).
        The hanging neutral arm is a pure swing away from the rest pose, i.e. it has no twist."""
        h = self.rest["heads"].detach()
        ix = self.body.idx
        out = {}
        for key, a, b in (("arm", "Arm", "ForeArm"), ("thigh", "UpLeg", "Leg")):
            tw = []
            for i, s in enumerate(("Left", "Right")):
                ax = h[ix[s + b]] - h[ix[s + a]]
                tw.append(twist_angle(p[key][:, i], ax / torch.linalg.norm(ax)))
            out[key] = torch.stack(tw, 1)
        return out

    def rate_excess(self, p):
        """Sum of squares of how far (rad) the rotation of each joint between consecutive frames
        exceeds posefit.MAX_RATE."""
        tot = 0
        for k in ("spine", "neck", "clav", "arm", "thigh", "foot"):
            d = torch.sqrt(((p[k][1:] - p[k][:-1]) ** 2).sum(-1) + 1e-12)
            tot = tot + (torch.relu(d - MAX_RATE[k] / self.fps) ** 2).sum()
        for k, ang in self.hinge_angles(p).items():
            tot = tot + (torch.relu((ang[1:] - ang[:-1]).abs() - MAX_RATE[k] / self.fps) ** 2).sum()
        return tot

    def hinge_angles(self, p):
        """Flexion of knees and elbows, rad: {"knee", "elbow"}: (N, 2)."""
        return {k: torch.stack([self.rig.hinge_angle(self.rig.hinge[s + joint], p[k][:, i]) for i, s in enumerate(("Left", "Right"))], 1)
                for k, joint in (("knee", "Leg"), ("elbow", "ForeArm"))}

    # ---- optimisation -------------------------------------------------------------------
    def optimise(self, wts, iters, lr=0.02, keys=None, X3d=None, w3d=None, tag="", shape=False, lbfgs=0, lr_end=None):
        """Adam for `iters` steps, then `lbfgs` L-BFGS steps. With `lr_end` the step size decays
        geometrically from lr to lr_end: Adam moves every parameter by about its step size per
        iteration, so a constant step leaves that much noise in every frame (4 mm in the root at 0.004)."""
        keys = keys or list(self.p.keys())
        params = [self.p[k].requires_grad_(True) for k in keys]
        groups = [{"params": params, "lr": lr}]
        if shape:
            self.shape_raw.requires_grad_(True)
            groups.append({"params": [self.shape_raw], "lr": 0.01})
        opt = torch.optim.Adam(groups)
        t0 = time.time()
        for it in range(iters):
            if lr_end is not None and iters > 1:
                opt.param_groups[0]["lr"] = lr * (lr_end / lr) ** (it / (iters - 1))
            opt.zero_grad()
            if shape:
                self.apply_shape(grad=True)
            L, parts, _ = self.loss(wts, X3d, w3d)
            L.backward()
            opt.step()
            if it % max(1, iters // 5) == 0 or it == iters - 1:
                log(f"  [{tag}] it {it:4d} loss {float(L):9.3f}  " + " ".join(f"{k}={float(v):.2f}" for k, v in parts.items() if float(v) > 0.005)
                    + f"  ({time.time() - t0:.0f}s)")
        if lbfgs:
            opt2 = torch.optim.LBFGS(params, lr=1.0, max_iter=lbfgs, history_size=30, line_search_fn="strong_wolfe")

            def closure():
                opt2.zero_grad()
                L, _, _ = self.loss(wts, X3d, w3d)
                L.backward()
                return L
            opt2.step(closure)
            L, parts, _ = self.loss(wts, X3d, w3d)
            log(f"  [{tag}] lbfgs loss {float(L):9.3f}  " + " ".join(f"{k}={float(v):.2f}" for k, v in parts.items() if float(v) > 0.005)
                + f"  ({time.time() - t0:.0f}s)")
        for q in params:
            q.requires_grad_(False)
        if shape:
            self.shape_raw.requires_grad_(False)
            self.apply_shape()
        self.rebase()

    def rebase(self):
        """Fold the root rotation increment into the per-frame base rotation (keeps axis-angles small)."""
        from body import rodrigues
        with torch.no_grad():
            self.R0 = self.R0 @ rodrigues(self.p["root_d"])
            self.p["root_d"].zero_()

    # ---- shape ---------------------------------------------------------------------------
    SHAPE_KEYS = ["height", "proportions", "muscle", "weight"]

    def init_shape_params(self, free=("height", "proportions")):
        self.shape_free = list(free)
        raw = [torch.logit(self.phen[PHENOTYPES.index(k)].clamp(0.02, 0.98)) for k in self.shape_free]
        self.shape_raw = torch.tensor([float(r) for r in raw] + [float(torch.log(self.scale))])

    def apply_shape(self, grad=False):
        ph = [self.phen[i] for i in range(6)]
        for i, k in enumerate(self.shape_free):
            ph[PHENOTYPES.index(k)] = torch.sigmoid(self.shape_raw[i])
        phen = torch.stack(ph)
        scale = torch.exp(self.shape_raw[-1])
        if grad:
            self.rest = self.body.rest(phen, scale)
            self.kp_b = self.body.kp_terms(self.rest)
        else:
            self.phen, self.scale = phen.detach(), scale.detach()
            self.set_rest()

    # ---- initialisation -----------------------------------------------------------------
    def neutral_keypoints(self):
        """Keypoints of the neutral standing pose with the Hips joint at the origin, unrotated."""
        with torch.no_grad():
            p = self.rig.new_params(1)
            rot = self.rig.assemble(p, torch.eye(3)[None])
            GR, Gp = self.body.fk(rot, torch.zeros(1, 3), self.rest["heads"])
            return self.body.keypoints(GR, Gp, self.kp_b)[0].numpy()

    def init_from_triangulation(self):
        X, inl, err = triangulate_all(self.cams, self.kp_np, s_min=2.5, tau=14.0)
        self.X3 = X
        N = self.N
        ok = np.isfinite(X[:, [5, 6, 11, 12], 0]).all(1)
        R = np.zeros((N, 3, 3)); pos = np.zeros((N, 3))
        kr = self.neutral_keypoints()
        off = (kr[11] + kr[12]) / 2                    # mid-hip keypoint relative to the Hips joint
        for n in np.nonzero(ok)[0]:
            ls, rs, lh, rh = X[n, 5], X[n, 6], X[n, 11], X[n, 12]
            x = (lh - rh) + (ls - rs)
            up = (ls + rs) / 2 - (lh + rh) / 2
            x = x / np.linalg.norm(x)
            z = np.cross(x, up); z /= np.linalg.norm(z)
            y = np.cross(z, x)
            R[n] = np.stack([x, y, z], 1)
            pos[n] = (lh + rh) / 2 - R[n] @ off
        idx = np.nonzero(ok)[0]
        for n in range(N):
            if not ok[n]:
                j = idx[np.argmin(np.abs(idx - n))]
                R[n], pos[n] = R[j], pos[j]
        # the rest pose stands upright; a forward-leaning torso is spine + hip flexion, but starting the
        # root from the measured torso frame is a good basin for both
        self.R0 = torch.tensor(R, dtype=torch.float32)
        self.p["root_pos"] = torch.tensor(pos, dtype=torch.float32)
        w3 = np.isfinite(X[..., 0]) * np.clip(inl.sum(0) - 1, 0, 2) / 2.0
        X = np.where(np.isfinite(X), X, 0.0)
        return torch.tensor(X, dtype=torch.float32), torch.tensor(w3, dtype=torch.float32), int(ok.sum())

    # ---- left/right label repair ----------------------------------------------------------
    def repair_flips(self):
        with torch.no_grad():
            _, _, _, kp3 = self.forward()
            px, _ = project_t(self.ct, kp3)
            perm = torch.tensor(FLIP_PERM)
            def cost(uv, w, sig):
                r2 = ((px - uv) ** 2).sum(-1) / sig ** 2
                return (w * gm(r2, 3.0)).sum(-1)                      # (C, N)
            c0 = cost(self.uv, self.w2d, self.sig)
            c1 = cost(self.uv[:, :, perm], self.w2d[:, :, perm], self.sig)
            n_w = self.w2d.sum(-1)
            flip = (c1 < 0.6 * c0) & ((c0 - c1) > 0.15 * 9.0 * n_w.clamp(min=1)) & (n_w > 4)
            self.uv = torch.where(flip[..., None, None], self.uv[:, :, perm], self.uv)
            self.w2d = torch.where(flip[..., None], self.w2d[:, :, perm], self.w2d)
            self.flipped = flip.numpy()
        return flip.sum(1).tolist()

    # ---- metrics --------------------------------------------------------------------------
    def metrics(self):
        with torch.no_grad():
            _, GR, Gp, kp3 = self.forward()
            px, z = project_t(self.ct, kp3)
            e = torch.linalg.norm(px - self.uv, dim=-1).numpy()
            m = (self.w2d.numpy() > 0.5)
            res = {}
            for c, name in enumerate(CAMS):
                ee = e[c][m[c]]
                res[name] = {"n": int(len(ee)), "medianPx": float(np.median(ee)), "meanPx": float(ee.mean()),
                             "p90Px": float(np.percentile(ee, 90))}
            sv = self.room(self.body.skin(GR, Gp, self.rest, self.sole_all))
            sv = (sv[..., 1] - self.floor_at(sv[..., [0, 2]])).numpy()
            res["soleMinY"] = {"p05": float(np.percentile(sv.min(1), 5)), "median": float(np.median(sv.min(1))),
                               "p95": float(np.percentile(sv.min(1), 95))}
        return res

    def save(self, path, extra=None):
        with torch.no_grad():
            rot, GR, Gp, kp3 = self.forward()
        extra = dict(extra or {})
        if self.floor is not None:                    # the floor the body stands on (room.fit_floor / fit_lift read it back)
            extra.update(floor_grid=self.floor["np"][0], floor_origin=self.floor["np"][1], lift=self.lift.numpy())
        np.savez_compressed(path, rot=rot.numpy(), root_pos=self.p["root_pos"].numpy(), phen=self.phen.numpy(),
                            scale=float(self.scale), kp3=kp3.numpy(), uv=self.uv.numpy(), w2d=self.w2d.numpy(),
                            flipped=getattr(self, "flipped", np.zeros((self.C, self.N), bool)),
                            R0=self.R0.numpy(), **{f"p_{k}": v.numpy() for k, v in self.p.items()}, **extra)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clip", default="clip02")
    ap.add_argument("--gender", type=float, default=0.0, help="Anny gender phenotype of the template: 0 = male, 1 = female")
    a = ap.parse_args()
    wd = work_dir(a.clip)
    f = Fitter(a.clip, gender=a.gender)
    log("frames", f.N, "detections per camera", (f.src > 0).sum(1).tolist(),
        "keypoints dropped because they are not on the visible person:", f.n_hidden)

    # initial scale: bring the template to the triangulated limb lengths
    X3d, w3d, n_ok = f.init_from_triangulation()
    log("triangulated torso frames", n_ok)
    k0 = f.neutral_keypoints()
    seg = [(11, 13), (13, 15), (12, 14), (14, 16), (5, 7), (7, 9), (6, 8), (8, 10), (5, 6), (11, 12)]
    obs = np.array([np.nanmedian(np.linalg.norm(f.X3[:, i] - f.X3[:, j], axis=-1)) for i, j in seg])
    tmpl = np.array([np.linalg.norm(k0[i] - k0[j]) for i, j in seg])
    s0 = float(np.median(obs[:8] / tmpl[:8]))
    log("segment lengths observed", np.round(obs, 3).tolist(), "template", np.round(tmpl, 3).tolist(), "-> scale", round(s0, 3))
    f.scale = torch.tensor(s0)
    f.set_rest()
    f.rig = Rig(f.body, f.rest); f.rig.calibrate_curl(f.rest)
    X3d, w3d, _ = f.init_from_triangulation()

    base = {"acc": 0.02, "root_acc": 0.02, "ang_vel": 0.02, "ang_acc": 0.05, "root_rot": 0.05, "prior": 0.02}
    # A: 3D keypoints (triangulated) -> good basin for every frame
    f.optimise({**base, "kp3d": 1.0}, 300, lr=0.03, X3d=X3d, w3d=w3d, tag="A 3D")
    log("after A:", json.dumps(f.metrics()))
    # B: 2D reprojection in all cameras
    f.optimise({**base, "kp2d": 1.0, "kp3d": 0.1, "gm_c": 4.0}, 300, lr=0.01, X3d=X3d, w3d=w3d, tag="B 2D")
    log("after B:", json.dumps(f.metrics()))
    log("left/right label flips repaired per camera:", f.repair_flips())
    # C: shape (height, proportions, scale) jointly with pose
    f.init_shape_params()
    f.optimise({**base, "kp2d": 1.0, "gm_c": 3.0, "floor": 0.3}, 250, lr=0.006, tag="C shape", shape=True)
    log("phenotypes", {k: round(float(v), 3) for k, v in zip(PHENOTYPES, f.phen)}, "scale", round(float(f.scale), 4),
        "stature", round(float(f.rest["v"][:, 1].max() - f.rest["v"][:, 1].min()), 3))
    log("after C:", json.dumps(f.metrics()))
    f.rig = Rig(f.body, f.rest); f.rig.calibrate_curl(f.rest)
    # D: final pose with floor contact and anti-skating
    f.optimise({**base, "kp2d": 1.0, "gm_c": 3.0, "floor": 1.0, "skate": 0.3}, 400, lr=0.005, tag="D final", lbfgs=60)
    m = f.metrics()
    log("final:", json.dumps(m))
    f.save(os.path.join(wd, "fit.npz"))
    f.save(os.path.join(wd, "fit_keypoints.npz"))     # refine.py always starts from this keypoint-only result
    with open(os.path.join(wd, "fit_metrics.json"), "w") as fh:
        json.dump({"reprojection": m, "phenotypes": {k: float(v) for k, v in zip(PHENOTYPES, f.phen)}, "scale": float(f.scale),
                   "statureM": float(f.rest["v"][:, 1].max() - f.rest["v"][:, 1].min())}, fh, indent=1)
    log("wrote", os.path.join(wd, "fit.npz"))


if __name__ == "__main__":
    main()
