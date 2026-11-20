"""Step 4b - silhouette pose refinement (run after shape.py, then run shape.py once more).

Keypoints pin the joints, but say little about the head when the face turns away, about wrists
inside sleeves, or about a torso seen end-on. The SAM 2 silhouettes do. With the clothed surface
from shape.py, two extra terms are added to the stage-D objective of fit.py:

  inside    surface points must project inside the mask (signed distance field, bilinear lookup)
  coverage  mask-outline samples must have surface nearby (ICP with re-assigned neighbours)

Both are Geman-McClure robust and gated per body part: a part that is mostly outside the mask at the
start (legs behind the sofa or a table) is treated as occluded in that view and left to the other
cameras; coverage is skipped for masks that include a carried object.

Nose / eye detections are also re-weighted by whether the camera can see the face at all (see
SilFitter.face_visibility): seen from behind they are guesses, and they were what kept the head
too high while the subject bends over the table.

A silhouette does not say which part of the body fills it, and it is not always only the body: SAM 2
follows the chair and the laptop the subject picks up, and the exporter flags that in some views
only. Left alone, the outline of the chair in one camera pulled a leg 30 cm away from the shoe that
another camera sees plainly. So the silhouettes only decide what the keypoints leave open:

  anchor    a detection that the keypoint fit explains (within 1.5 sigma) may not end up more than
            half a sigma farther from the model than it was (SilFitter.anchor_keypoints); a planted
            foot gets 1.5 sigma, because there the pin below knows better than a noisy detection
  near      outline samples farther than about 10 cm from the keypoint fit never attract the surface
  steady    a silhouette is cut out anew in every frame and its noise shakes the body: no joint may
            accelerate more than it did in the keypoint fit (2 mm of slack)

Stages E and F end with a decaying step size and an L-BFGS polish; with a constant step, Adam itself
left a few millimetres of frame-to-frame noise in every joint.

Ground (stage F). From here on "the floor" is the scanned floor of the room model under each foot
(room.floor_map), because that is the floor the viewer draws; the keypoint fit used the plane y = 0.
The scan is a few centimetres off the cameras there (Fitter.set_floor): each frame is fitted where
the cameras see it and shown lifted by the scanned floor height under the body (`lift` in fit.npz,
added by export.py), and the ground terms work on the lifted body. Three terms make the shoes
behave on the floor:

  shoe_pen  no vertex of the clothed shoes below the floor
  pin       the heel / ball of a planted foot does not move: zero variance of its position over each
            planted interval (planted_runs: within 2 cm of the floor and slower than 1.5 cm per
            frame for at least 3 frames, cut where the foot was repositioned by 4 cm)
  rest      a planted heel / ball touches the floor; and a heel that stays planted carries weight,
            so the ball of that foot is down as well (flat_runs). This is what decides the pose of
            a foot whose toes no camera sees, e.g. under the sofa while the subject leans on a table

Keypoints alone leave a planted foot creeping by about half a centimetre per frame, which reads as
skating when the body is looked at from close by.
"""
import argparse, json, os, time

import cv2
import numpy as np
import torch
import torch.nn.functional as F

from common import CAMS, work_dir
from fit import Fitter, log
from masks import in_known, load_masks, paste
from posefit import gm, project_t, second_diff
from render import sdf

PARTS = ["head", "torso", "larm", "rarm", "lleg", "rleg"]
FOOT_KPS = ([15, 17, 18, 19], [16, 20, 21, 22])       # ankle, big toe, small toe, heel of the left / right foot


def part_of(label):
    side = "l" if label.startswith("Left") else "r" if label.startswith("Right") else ""
    if label in ("Head", "Neck"):
        return 0
    if side and any(s in label for s in ("Shoulder", "Arm", "Hand")):
        return 2 if side == "l" else 3
    if side and any(s in label for s in ("Leg", "Foot", "Toe")):
        return 4 if side == "l" else 5
    return 1


def foot_markers(body, v_rest):
    """Vertex sets on the (clothed) rest surface: a heel and a ball marker under each foot (the rear and
    the front part of the lowest 1.5 cm of the shoe) and all vertices of both shoes.
    Returns ([Left heel, Left ball, Right heel, Right ball], names, shoe)."""
    v0 = torch.as_tensor(v_rest, dtype=torch.float32)
    ix = body.idx
    marks, names, shoe = [], [], []
    for s in ("Left", "Right"):
        wf = body.w_dense[:, [ix[f"{s}Foot"], ix[f"{s}ToeBase"]]].sum(1)
        shoe.append(torch.nonzero(wf > 0.5)[:, 0])
        cand = torch.nonzero(wf > 0.9)[:, 0]
        low = cand[v0[cand, 1] < v0[cand, 1].min() + 0.015]
        z = v0[low, 2]                                                              # +Z is forward at rest
        zr = (z - z.min()) / (z.max() - z.min())
        marks += [low[zr < 0.3], low[zr > 0.65]]
        names += [f"{s} heel", f"{s} ball"]
    return marks, names, torch.cat(shoe)


def planted_runs(c, h, v_max=0.015, h_max=0.02, r_split=0.04, min_len=3):
    """Intervals in which a foot marker is planted. c: (N, M, 3) marker centres, h: (N, M) lowest
    height above the floor. Planted = within h_max of the floor and moving less than v_max per frame
    for at least min_len frames; an interval is cut where the marker has drifted r_split away from
    where it stood, i.e. where the foot was repositioned without a recognisable step.
    Returns [(marker, first frame, last frame)]."""
    runs = []
    for m in range(c.shape[1]):
        xz = c[:, m][:, [0, 2]]
        sp = np.linalg.norm(np.diff(xz, axis=0), axis=1)
        still = (sp < v_max) & (h[1:, m] < h_max) & (h[:-1, m] < h_max)              # pair k -> k + 1
        k = 0
        while k < len(still):
            if not still[k]:
                k += 1
                continue
            a = k
            while k < len(still) and still[k]:
                k += 1
            s0 = a                                                                # frames a .. k
            for j in range(a + 1, k + 1):
                if np.linalg.norm(xz[j] - xz[s0:j].mean(0)) > r_split:
                    if j - s0 >= min_len:
                        runs.append((m, s0, j - 1))
                    s0 = j
            if k + 1 - s0 >= min_len:
                runs.append((m, s0, k))
    return runs


def flat_runs(runs, min_len=6, lead=2):
    """Intervals (ball marker, first frame, last frame) in which a foot stands flat. A heel that stays
    planted for `min_len` frames (0.4 s) carries weight, so from `lead` frames after it lands the ball is
    on the floor too: heel strike is over within a frame or two at 15 fps, and nobody stands on a heel
    with the toes in the air for longer. The reverse does not hold (the heel of a planted ball may be up)."""
    return [(m + 1, a + lead, b) for m, a, b in runs if m % 2 == 0 and b - a + 1 >= min_len]


def creep_stats(c, runs, n_frames):
    """How much planted markers move: per frame, and over a whole planted interval."""
    step, spread, planted = [], [], np.zeros((n_frames, c.shape[1]), bool)
    for m, a, b in runs:
        seg = c[a:b + 1, m][:, [0, 2]]
        step.append(np.linalg.norm(np.diff(seg, axis=0), axis=1))
        spread.append(np.linalg.norm(seg - seg.mean(0), axis=1).max())
        planted[a:b + 1, m] = True
    step = np.concatenate(step) if step else np.zeros(1)
    spread = np.array(spread) if spread else np.zeros(1)
    return {"plantedIntervals": len(runs), "framesWithAPlantedFoot": round(float(planted.any(1).mean()), 3),
            "creepPerFrameMm": {"median": round(float(np.median(step)) * 1000, 2), "p90": round(float(np.percentile(step, 90)) * 1000, 2),
                                "max": round(float(step.max()) * 1000, 2)},
            "driftOverIntervalMm": {"median": round(float(np.median(spread)) * 1000, 1), "p90": round(float(np.percentile(spread, 90)) * 1000, 1),
                                    "max": round(float(spread.max()) * 1000, 1)}}


class SilFitter(Fitter):
    def load_state(self, path):
        from posefit import Rig
        d = np.load(path)
        self.phen, self.scale = torch.tensor(d["phen"]), torch.tensor(float(d["scale"]))
        self.set_rest()
        self.rig = Rig(self.body, self.rest); self.rig.calibrate_curl(self.rest)
        self.R0 = torch.tensor(d["R0"])
        self.p = {k[2:]: torch.tensor(d[k]) for k in d.files if k.startswith("p_")}
        self.uv, self.w2d = torch.tensor(d["uv"]), torch.tensor(d["w2d"])
        with torch.no_grad():
            rot, _, _, _ = self.forward()
        err = float((rot - torch.tensor(d["rot"])).abs().max())
        assert err < 1e-4, f"restored state does not reproduce the saved fit ({err})"

    def prepare_sil(self, v_clothed, G=96, S=900, M=72):
        masks = load_masks(self.clip)
        pairs = sorted(masks.keys())
        P = len(pairs)
        body = self.body
        # farthest-point subset of the surface
        v0 = np.asarray(v_clothed, np.float64)
        lab = np.array([part_of(body.labels[j]) for j in body.wi[:, 0].numpy()])
        sel = [int(np.argmax(v0[:, 1]))]
        dmin = np.linalg.norm(v0 - v0[sel[0]], axis=1)
        for _ in range(S - 1):
            i = int(np.argmax(dmin)); sel.append(i)
            dmin = np.minimum(dmin, np.linalg.norm(v0 - v0[i], axis=1))
        self.s_idx = torch.tensor(sel)
        self.s_part = torch.tensor(lab[sel])
        self.rest_c = {"v": torch.tensor(v0, dtype=torch.float32), "heads": self.rest["heads"]}
        ci = np.array([p[0] for p in pairs]); kk = np.array([p[1] for p in pairs])
        dts = np.array([self.cams[c].get("dt", 0.0) for c in CAMS])
        kf = np.clip(kk - dts[ci] * self.fps, 0, self.N - 1.001)
        self.s_k0 = torch.tensor(np.floor(kf).astype(np.int64)); self.s_a = torch.tensor((kf - np.floor(kf)).astype(np.float32))
        self.s_ci = torch.tensor(ci)
        grids = np.zeros((P, 1, G, G), np.float32); win = np.zeros((P, 4), np.float32)
        cont = np.zeros((P, M, 2), np.float32); cvalid = np.zeros((P, M), bool)
        for i, key in enumerate(pairs):
            e = masks[key]
            h, w = e["m"].shape
            mrg = int(0.35 * max(w, h) + 24)
            x0, y0 = e["x0"] - mrg, e["y0"] - mrg
            ww, wh = w + 2 * mrg, h + 2 * mrg
            # outside the image, and beyond the box the exporter clipped the mask to, nothing can be
            # said: count it as "inside"
            m, known = paste(e, x0, y0, x0 + ww, y0 + wh)
            phi = sdf(np.maximum(m, 1 - known))
            grids[i, 0] = cv2.resize(phi, (G, G), interpolation=cv2.INTER_AREA)
            win[i] = (x0, y0, ww, wh)
            if not e["carried"] and e["m"].sum() > 1200:
                cs, _ = cv2.findContours(e["m"], cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
                pts = np.concatenate([c[:, 0, :] for c in cs if len(c) > 30] or [np.zeros((0, 2), np.int32)]).astype(np.float32)
                pts += [e["x0"], e["y0"]]
                pts = pts[in_known(e, pts, 3)]                 # the image border and the clip are not outlines
                if len(pts) >= M:
                    cont[i] = pts[np.linspace(0, len(pts) - 1, M).round().astype(int)]     # evenly along the outline
                    cvalid[i] = True
        self.s_grid = torch.tensor(grids); self.s_win = torch.tensor(win)
        self.s_cont = torch.tensor(cont); self.s_cvalid = torch.tensor(cvalid)
        self.s_pairs = pairs
        self.s_carried = torch.tensor([masks[k]["carried"] for k in pairs])
        self.s_area = torch.tensor([float(masks[k]["m"].sum()) for k in pairs])
        with torch.no_grad():
            px, z, phi = self.sil_project()
            self.s_scale = (0.035 * self.ct["f"][self.s_ci] / z.mean(1)).clamp(min=3.0)          # px, ~3.5 cm on the subject
            far = phi > 2.5 * self.s_scale[:, None]
            gate = torch.ones(P, len(PARTS))
            for g in range(len(PARTS)):
                m = self.s_part == g
                gate[:, g] = (far[:, m].float().mean(1) < 0.3).float()
            bad = (far.float().mean(1) > 0.5) | (self.s_area < 1200) | (z.min(1).values < 0.5)
            gate[bad] = 0
            self.s_gate = gate
            self.s_nn = self.s_near = None
        log("silhouette terms:", P, "views;", int(S), "surface points; parts gated off per part:",
            {PARTS[g]: int((gate[:, g] == 0).sum()) for g in range(len(PARTS))}, "coverage views:", int(self.s_cvalid[:, 0].sum()))

    def sil_project(self):
        rot, GR, Gp, _ = self.forward()
        V = self.body.skin(GR, Gp, self.rest_c, self.s_idx)                         # (N, S, 3)
        X = (1 - self.s_a)[:, None, None] * V[self.s_k0] + self.s_a[:, None, None] * V[self.s_k0 + 1]
        ct = self.ct
        Xc = torch.einsum("pij,psj->psi", ct["R"][self.s_ci], X) + ct["t"][self.s_ci][:, None]
        z = Xc[..., 2]
        xn = Xc[..., :2] / z.clamp(min=0.05)[..., None]
        xn = xn * (1 + ct["k1"][self.s_ci][:, None, None] * (xn ** 2).sum(-1, keepdim=True))
        px = xn * ct["f"][self.s_ci][:, None, None] + ct["c"][self.s_ci][:, None]
        g = torch.stack([(px[..., 0] - self.s_win[:, None, 0]) / self.s_win[:, None, 2] * 2 - 1,
                         (px[..., 1] - self.s_win[:, None, 1]) / self.s_win[:, None, 3] * 2 - 1], -1)
        phi = F.grid_sample(self.s_grid, g[:, :, None, :], mode="bilinear", padding_mode="border", align_corners=False)[:, 0, :, 0]
        return px, z, phi

    def assign(self, px):
        """Nearest surface point for every mask-outline sample (no gradient)."""
        with torch.no_grad():
            nn = torch.zeros(self.s_cont.shape[:2], dtype=torch.int64); dist = torch.zeros(self.s_cont.shape[:2])
            for i in range(0, px.shape[0], 128):
                d = torch.cdist(self.s_cont[i:i + 128], px[i:i + 128])
                dist[i:i + 128], nn[i:i + 128] = d.min(-1)
            if self.s_near is None:
                # first call = the keypoint fit. An outline farther from it than about 10 cm is not a
                # body part that the keypoints misplaced: it is the chair or the laptop in the mask
                self.s_near = dist < 3.0 * self.s_scale[:, None]
            ok = self.s_cvalid & self.s_near & (dist < 5.0 * self.s_scale[:, None])
            ok &= torch.gather(self.s_gate, 1, self.s_part[nn]) > 0
            self.s_nn, self.s_nn_ok = nn, ok

    def anchor_keypoints(self, r_max=1.5):
        """Remember how well the current (keypoint-only) solution explains each detection. In the
        stages that follow, a detection it explains within r_max sigma keeps the model: see `anchor`
        in loss()."""
        with torch.no_grad():
            _, _, _, kp3 = self.forward()
            px, _ = project_t(self.ct, kp3)
            self.a_r0 = torch.sqrt(((px - self.uv) ** 2).sum(-1)) / self.sig
            self.a_on = (self.a_r0 <= r_max).float()
            self.a_slack = torch.full_like(self.a_r0, 0.5)
            self.a_acc = torch.sqrt((second_diff(kp3) ** 2).sum(-1))                  # (N - 2, K), see `steady`
            self.a_steady = torch.ones_like(self.a_acc)
        return int((self.a_on * (self.w2d > 0)).sum())

    def face_visibility(self):
        """Nose and eye detections only mean something where the camera can see the face. From behind,
        the detector still reports confident face keypoints (it guesses them through the head); in the
        bent-over frames those guesses sit on top of the hood and hold the head up. They are weighted
        by the angle between the head's forward axis and the direction to each camera."""
        with torch.no_grad():
            rot, GR, Gp, kp3 = self.forward()
            fwd = GR[:, self.body.idx["Head"], :, 2]                                  # (N, 3); +Z is "forward" at rest
            C = -torch.einsum("cji,cj->ci", self.ct["R"], self.ct["t"])               # camera centres
            to_cam = C[:, None] - kp3[None, :, 0]                                     # from the nose
            cos = (to_cam / to_cam.norm(dim=-1, keepdim=True) * fwd[None]).sum(-1)    # (C, N)
            vis = ((cos + 0.15) / 0.4).clamp(0, 1)
            self.w2d = self.w2d_base.clone()
            self.w2d[:, :, 0:3] = self.w2d_base[:, :, 0:3] * vis[..., None]
        return vis

    def loss(self, wts, X3d=None, w3d=None):
        self.it_count = getattr(self, "it_count", 0) + 1
        refresh = self.it_count % 12 == 0 and not getattr(self, "frozen", False)   # frozen: a fixed objective for L-BFGS
        if refresh:
            self.face_visibility()
        total, out, kp3 = super().loss(wts, X3d, w3d)
        if wts.get("anchor", 0) > 0:
            # one-sided: free within half a sigma of where the keypoint fit left the detection
            px2, _ = project_t(self.ct, kp3)
            r = torch.sqrt(((px2 - self.uv) ** 2).sum(-1) + 1e-6) / self.sig
            over = torch.relu(r - self.a_r0 - self.a_slack)
            out["anchor"] = wts["anchor"] * (self.w2d * self.a_on * over ** 2).sum() / self.N / 0.1 ** 2
            total = total + out["anchor"]
        if wts.get("steady", 0) > 0:
            # a silhouette is cut out anew in every frame, and its noise shakes the body. Joints may
            # not accelerate more (2 mm of slack) than they did in the keypoint fit
            acc = torch.sqrt((second_diff(kp3) ** 2).sum(-1) + 1e-10)
            out["steady"] = wts["steady"] * (self.a_steady * torch.relu(acc - self.a_acc - 0.002) ** 2).sum() / self.N / 0.005 ** 2
            total = total + out["steady"]
        if wts.get("sil", 0) > 0:
            px, z, phi = self.sil_project()
            if self.s_nn is None or refresh:
                self.assign(px.detach())
            sc = self.s_scale[:, None]
            gate = self.s_gate[:, self.s_part]                                     # (P, S)
            r_in = torch.relu(phi) / sc
            out["sil_in"] = wts["sil"] * (gate * gm(r_in ** 2, 3.0)).sum() / phi.shape[1] / self.N
            q = torch.gather(px, 1, self.s_nn[..., None].expand(-1, -1, 2))
            r2 = ((q - self.s_cont) ** 2).sum(-1) / sc ** 2
            out["sil_cov"] = wts["sil"] * wts.get("cov", 1.0) * (self.s_nn_ok * gm(r2, 3.0)).sum() / self.s_cont.shape[1] / self.N
            total = total + out["sil_in"] + out["sil_cov"]
        if wts.get("ground", 0) > 0:
            _, GR, Gp, _ = self.forward()
            Ps = self.room(self.body.skin(GR, Gp, self.rest_c, self.g_shoe))        # (N, S, 3) clothed shoes
            below = torch.relu(self.floor_at(Ps[..., [0, 2]]) + 0.001 - Ps[..., 1])
            out["shoe_pen"] = wts["ground"] * (below ** 2).sum(1).mean() / 0.002 ** 2
            c, h = self.markers(GR, Gp)
            pin, rest = c.new_zeros(()), c.new_zeros(())
            for m, a, b in self.g_runs:
                seg = c[a:b + 1, m]
                pin = pin + ((seg - seg.mean(0, keepdim=True)) ** 2).sum()
            for m, a, b in self.g_runs + flat_runs(self.g_runs):
                rest = rest + (torch.relu(h[a:b + 1, m] - 0.003) ** 2).sum()
            out["pin"] = wts["ground"] * pin / self.N / 0.004 ** 2
            out["rest"] = wts["ground"] * rest / self.N / 0.008 ** 2
            total = total + out["shoe_pen"] + out["pin"] + out["rest"]
        return total, out, kp3

    # ---- ground contact ---------------------------------------------------------------------
    def prepare_ground(self):
        """Clothed shoe surface for the ground terms, and a heel and a ball marker under each foot."""
        self.g_mark, self.g_names, self.g_shoe = foot_markers(self.body, self.rest_c["v"])
        self.g_runs = []

    def markers(self, GR, Gp):
        """Centre (N, M, 3) of the heel / ball markers and their lowest height above the floor (N, M)."""
        cs, hs = [], []
        for idx in self.g_mark:
            P = self.room(self.body.skin(GR, Gp, self.rest_c, idx))
            cs.append(P.mean(1))
            hs.append((P[..., 1] - self.floor_at(P[..., [0, 2]])).min(1).values)
        return torch.stack(cs, 1), torch.stack(hs, 1)

    def label_contacts(self):
        """Planted intervals (marker, first frame, last frame) read from the current solution."""
        with torch.no_grad():
            _, GR, Gp, _ = self.forward()
            c, h = self.markers(GR, Gp)
        self.g_runs = planted_runs(c.numpy(), h.numpy())
        # A planted foot does not move, but its detections do (a few px of noise that the keypoint fit
        # followed by 1 - 3 cm). The pin knows better: the anchors of a planted foot get room for that,
        # and a foot that stops dead and leaves again accelerates harder than the smoothed keypoint
        # fit did, so `steady` lets the foot be from two frames before to two frames after
        if hasattr(self, "a_slack"):
            self.a_slack[:] = 0.5
            self.a_steady[:] = 1.0
            for m, a, b in self.g_runs:
                self.a_slack[:, a:b + 1, FOOT_KPS[m // 2]] = 1.5
                self.a_steady[max(a - 3, 0):b + 2, FOOT_KPS[m // 2]] = 0.0      # row i is the acceleration at frame i + 1
        return self.g_runs

    def ground_report(self):
        """Creep of planted heels / balls (labels from the current solution) and shoe-floor penetration."""
        runs = self.label_contacts()
        with torch.no_grad():
            _, GR, Gp, _ = self.forward()
            c, _ = self.markers(GR, Gp)
            Ps = self.room(self.body.skin(GR, Gp, self.rest_c, self.g_shoe))
            low = (Ps[..., 1] - self.floor_at(Ps[..., [0, 2]])).min(1).values.numpy()
        return {**creep_stats(c.numpy(), runs, self.N),
                "lowestShoePointMm": {"min": round(float(low.min()) * 1000, 1), "p05": round(float(np.percentile(low, 5)) * 1000, 1),
                                      "median": round(float(np.median(low)) * 1000, 1), "max": round(float(low.max()) * 1000, 1)}}

    def sil_report(self):
        with torch.no_grad():
            px, z, phi = self.sil_project()
            gate = self.s_gate[:, self.s_part] > 0
            outside = ((phi > self.s_scale[:, None]) & gate).float().sum() / gate.float().sum()
            self.assign(px)
            q = torch.gather(px, 1, self.s_nn[..., None].expand(-1, -1, 2))
            d = torch.linalg.norm(q - self.s_cont, dim=-1)[self.s_cvalid]
        return {"surfaceOutsideMask": round(float(outside), 4), "outlineToSurfaceMedianPx": round(float(d.median()), 2),
                "outlineToSurfaceP90Px": round(float(torch.quantile(d, 0.9)), 2)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clip", default="clip02")
    ap.add_argument("--w-sil", type=float, default=60.0)
    ap.add_argument("--iters", type=int, default=200)
    ap.add_argument("--lr", type=float, default=0.004)
    ap.add_argument("--flat-floor", action="store_true", help="keep the floor at y = 0 instead of the scanned room floor")
    ap.add_argument("--w-ground", type=float, default=1.0)
    ap.add_argument("--ground-iters", type=int, default=120)
    ap.add_argument("--ground-rounds", type=int, default=3)
    ap.add_argument("--w-anchor", type=float, default=1.0, help="0: let the silhouettes override the detections")
    ap.add_argument("--w-steady", type=float, default=1.0, help="0: let the silhouettes add frame-to-frame shake")
    ap.add_argument("--polish", type=int, default=150, help="L-BFGS iterations at the end")
    ap.add_argument("--out", default="fit.npz")
    a = ap.parse_args()
    wd = work_dir(a.clip)
    src = os.path.join(wd, "fit_keypoints.npz")       # the keypoint-only result of fit.py (fit.npz is overwritten below)
    d = np.load(src)
    f = SilFitter(a.clip, gender=float(d["phen"][0]))
    f.load_state(src)
    if not a.flat_floor:
        # the body has to stand on the floor the viewer draws: the scanned floor under the subject
        try:
            from room import floor_map, floor_point, sample_floor
            fm = floor_map(d["root_pos"][:, [0, 2]])
            fh = sample_floor(fm["grid"], fm["origin"], floor_point(d["kp3"], d["root_pos"]))
            f.set_floor(fm, fh)
            log("scanned floor under the subject (m): min %.3f median %.3f max %.3f" % (fh.min(), np.median(fh), fh.max()))
        except (FileNotFoundError, NotImplementedError) as e:
            log("room scan not usable, the floor stays at y = 0:", e)
    f.prepare_sil(np.load(os.path.join(wd, "shape.npz"))["v"])
    f.prepare_ground()
    f.w2d_base = f.w2d.clone()
    vis = f.face_visibility()
    log("face keypoints kept per camera (share of frames with the face toward the camera):",
        {c: round(float((vis[i] > 0.5).float().mean()), 2) for i, c in enumerate(CAMS)})
    m0, s0 = f.metrics(), f.sil_report()
    log("before:", json.dumps({c: round(m0[c]["medianPx"], 2) for c in CAMS}), json.dumps(s0))
    log("detections the keypoint fit explains, kept as anchors:", f.anchor_keypoints(), "of", int((f.w2d > 0).sum()))
    base = {"acc": 0.02, "root_acc": 0.02, "ang_vel": 0.02, "ang_acc": 0.05, "root_rot": 0.05, "prior": 0.02}
    wts = {**base, "kp2d": 1.0, "gm_c": 3.0, "floor": 1.0, "skate": 0.3, "sil": a.w_sil, "anchor": a.w_anchor, "steady": a.w_steady}
    f.optimise(wts, a.iters, lr=a.lr, lr_end=a.lr * 0.1, tag="E silhouettes")
    f.face_visibility()
    mE, sE, g0 = f.metrics(), f.sil_report(), f.ground_report()
    log("after E:", json.dumps({c: round(mE[c]["medianPx"], 2) for c in CAMS}), json.dumps(sE))
    log("ground before:", json.dumps(g0))
    # F: planted feet stay put; the labels are read again once the first round has settled the feet
    for rnd in range(a.ground_rounds):
        runs = f.label_contacts()
        log("planted intervals per marker:", {n: sum(1 for r in runs if r[0] == i) for i, n in enumerate(f.g_names)},
            "marker-frames:", sum(b - a_ + 1 for _, a_, b in runs))
        lr = a.lr * 0.75                               # the pins need full steps to settle; the last round winds down
        f.optimise({**wts, "ground": a.w_ground}, a.ground_iters, lr=lr, lr_end=lr * 0.1 if rnd == a.ground_rounds - 1 else None,
                   tag=f"F ground {rnd + 1}")
    # polish: the same objective with the outline assignment and the face weights held fixed
    f.face_visibility()
    f.frozen = True
    f.optimise({**wts, "ground": a.w_ground}, 0, lbfgs=a.polish, tag="G polish")
    f.frozen = False
    f.face_visibility()
    m1, s1, g1 = f.metrics(), f.sil_report(), f.ground_report()
    log("after: ", json.dumps({c: round(m1[c]["medianPx"], 2) for c in CAMS}), json.dumps(s1))
    log("ground after: ", json.dumps(g1))
    log("sole height", json.dumps(m1["soleMinY"]))
    f.save(os.path.join(wd, a.out))
    if a.out != "fit.npz":                             # an experiment: leave the metrics of the pipeline alone
        log("wrote", os.path.join(wd, a.out))
        return
    fm = json.load(open(os.path.join(wd, "fit_metrics.json")))
    fm["reprojection"] = m1
    fm["silhouetteRefinement"] = {"before": s0, "after": s1, "keypointMedianPxBefore": {c: m0[c]["medianPx"] for c in CAMS}}
    fm["ground"] = {"scannedFloor": f.floor is not None, "beforeContactStage": g0, "after": g1}
    with open(os.path.join(wd, "fit_metrics.json"), "w") as fh:
        json.dump(fm, fh, indent=1)
    log("wrote", os.path.join(wd, "fit.npz"))


if __name__ == "__main__":
    main()
