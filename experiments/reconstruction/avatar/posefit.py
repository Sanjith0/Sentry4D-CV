"""Pose parametrisation, camera projection and the losses used to fit the body to the footage."""
import math
import numpy as np
import torch

from body import rodrigues
from common import CAMS, FLIP_PAIRS

# COCO / COCO-WholeBody per-keypoint localisation sigmas (17 body + 6 feet), relative to object scale.
OKS = np.array([.026, .025, .025, .035, .035, .079, .079, .072, .072, .062, .062, .107, .107, .087, .087, .089, .089,
                .068, .066, .066, .092, .094, .094])
SOLE_Y = 0.02     # shoe sole thickness: the bare-foot model's sole rests this far above the floor
# Range of the ankle as an axis-angle in the rest frame (rad): x = dorsiflexion (-) / plantarflexion (+),
# y = toes in / out, z = roll. Generous compared with anatomy (about 20 / 50, 20 and 25 degrees) because
# the shoe, the midfoot and the rotation of the shin about its own axis are not modelled separately.
ANKLE_LO = (-0.50, -0.55, -0.45)
ANKLE_HI = (0.90, 0.55, 0.45)
# Rotation of the thigh about its own axis, from the rest pose (rad). A hip turns about 45 degrees
# outward and 40 inward; 60 either way are allowed here because the heading of the pelvis is only
# known as well as the hip and shoulder keypoints define it.
HIP_TWIST = 1.05
# Fastest rotation of a joint (rad / s) that still counts as motion. Above it, a change from one frame
# to the next is a tracking pop: a limb that flips because a detection came or went. The values are
# about twice what the joints reach in brisk walking and reaching (knee and elbow some 400 deg / s).
MAX_RATE = {"spine": 6.0, "neck": 8.0, "clav": 5.0, "arm": 12.0, "thigh": 8.0, "foot": 9.0, "knee": 13.0, "elbow": 14.0}
FLIP_PERM = np.arange(23)
for _a, _b in FLIP_PAIRS:
    FLIP_PERM[_a], FLIP_PERM[_b] = _b, _a


def cams_to_torch(cams, dtype=torch.float32):
    return {"R": torch.tensor(np.stack([cams[c]["R"] for c in CAMS]), dtype=dtype),
            "t": torch.tensor(np.stack([cams[c]["t"] for c in CAMS]), dtype=dtype),
            "f": torch.tensor([cams[c]["f"] for c in CAMS], dtype=dtype),
            "c": torch.tensor([[cams[c]["cx"], cams[c]["cy"]] for c in CAMS], dtype=dtype),
            "k1": torch.tensor([cams[c].get("k1", 0.0) for c in CAMS], dtype=dtype)}


def project_t(ct, X):
    """X (..., P, 3) world -> pixels (C, ..., P, 2), depth (C, ..., P)."""
    Xc = torch.einsum("cij,...j->c...i", ct["R"], X) + ct["t"].reshape((-1,) + (1,) * (X.dim() - 1) + (3,))
    z = Xc[..., 2]
    xn = Xc[..., :2] / z.clamp(min=0.05)[..., None]
    sh = (-1,) + (1,) * (X.dim() - 1)
    xn = xn * (1 + ct["k1"].reshape(sh)[..., None] * (xn ** 2).sum(-1, keepdim=True))
    return xn * ct["f"].reshape(sh)[..., None] + ct["c"].reshape((-1,) + (1,) * (X.dim() - 1) + (2,)), z


def hinge_rot(axis, theta):
    """axis (3,), theta (...,) -> (..., 3, 3)."""
    K = torch.zeros(3, 3, dtype=theta.dtype)
    K[0, 1], K[0, 2], K[1, 0], K[1, 2], K[2, 0], K[2, 1] = -axis[2], axis[1], axis[2], -axis[0], -axis[1], axis[0]
    s, c = torch.sin(theta)[..., None, None], torch.cos(theta)[..., None, None]
    return torch.eye(3, dtype=theta.dtype) + s * K + (1 - c) * (K @ K)


def rot_between(a, b):
    """Minimal rotation (axis-angle, numpy) taking unit vector a to unit vector b."""
    a, b = a / np.linalg.norm(a), b / np.linalg.norm(b)
    ax = np.cross(a, b)
    s, c = np.linalg.norm(ax), float(a @ b)
    if s < 1e-9:
        return np.zeros(3)
    return ax / s * math.atan2(s, c)


class Rig:
    """Maps the low-dimensional pose parameters to the 52 joint rotations of the body rig."""

    SIDES = ("Left", "Right")

    def __init__(self, body, rest):
        self.body = body
        self.J = body.J
        ix = body.idx
        self.ix = ix
        h = rest["heads"].detach().cpu().numpy()
        self.hinge = {}
        self.neutral = {}
        for s in self.SIDES:
            for name, (a, b, c), lim in ((f"{s}Leg", (f"{s}UpLeg", f"{s}Leg", f"{s}Foot"), (-4.0, 150.0)),
                                         (f"{s}ForeArm", (f"{s}Arm", f"{s}ForeArm", f"{s}Hand"), (-3.0, 150.0))):
                u, v = h[ix[b]] - h[ix[a]], h[ix[c]] - h[ix[b]]
                axis = np.cross(u, v)
                bend = math.atan2(np.linalg.norm(axis), float(u @ v))
                axis = axis / np.linalg.norm(axis)
                # theta = 0 is the rest bend; limits are expressed as anatomical flexion (0 = straight)
                self.hinge[name] = {"axis": torch.tensor(axis, dtype=torch.float32), "rest_bend": bend,
                                    "lo": math.radians(lim[0]) - bend, "hi": math.radians(lim[1]) - bend}
            # neutral upper arm: hanging, 8 degrees of abduction
            d = h[ix[f"{s}ForeArm"]] - h[ix[f"{s}Arm"]]
            sign = 1.0 if s == "Left" else -1.0
            tgt = np.array([sign * math.sin(math.radians(8)), -math.cos(math.radians(8)), 0.0])
            self.neutral[f"{s}Arm"] = torch.tensor(rot_between(d, tgt), dtype=torch.float32)
        # relaxed finger curl about each finger's flexion axis (perpendicular to finger and across the palm)
        self.static = {}
        for s in self.SIDES:
            hand, mid = h[ix[f"{s}Hand"]], h[ix[f"{s}HandMiddle1"]]
            idx1, pinky1 = h[ix[f"{s}HandIndex1"]], h[ix[f"{s}HandPinky1"]]
            across = (pinky1 - idx1) / np.linalg.norm(pinky1 - idx1)        # index -> pinky
            fwd = (mid - hand) / np.linalg.norm(mid - hand)
            palm_n = np.cross(fwd, across)                                    # palm normal (sign fixed below)
            for finger, curl in (("Index", 22), ("Middle", 26), ("Ring", 30), ("Pinky", 34)):
                for seg in (1, 2, 3):
                    j = ix[f"{s}Hand{finger}{seg}"]
                    self.static[j] = (across, math.radians(curl if seg < 3 else curl * 0.6))
            self.static[ix[f"{s}HandThumb2"]] = (palm_n, math.radians(12))
            self.static[ix[f"{s}HandThumb3"]] = (palm_n, math.radians(12))
        self._curl_sign = None

    def calibrate_curl(self, rest):
        """Pick the sign of the finger flexion axes so that curling moves fingertips toward the palm side
        (the side the thumb is on / the body's front in the A-pose)."""
        body, ix = self.body, self.ix
        h = rest["heads"].detach()
        signs = {}
        for s in self.SIDES:
            hand = h[ix[f"{s}Hand"]]
            tip0 = rest["tails"].detach()[ix[f"{s}HandMiddle3"]]
            thumb = h[ix[f"{s}HandThumb2"]]
            best = None
            for sg in (1.0, -1.0):
                rot = torch.eye(3).repeat(1, self.J, 1, 1)
                for j, (ax, ang) in self.static.items():
                    if body.labels[j].startswith(s) and "Thumb" not in body.labels[j]:
                        rot[0, j] = hinge_rot(torch.tensor(ax, dtype=torch.float32), torch.tensor(sg * ang))
                GR, Gp = body.fk(rot, h[0][None], h)
                j3 = ix[f"{s}HandMiddle3"]
                tip = Gp[0, j3] + GR[0, j3] @ (tip0 - h[j3])
                # curled tip should end up closer to the thumb than the straight tip
                d = float(torch.linalg.norm(tip - thumb))
                if best is None or d < best[0]:
                    best = (d, sg)
            signs[s] = best[1]
        self._curl_sign = signs
        return signs

    def new_params(self, N):
        z = lambda *s: torch.zeros(*s, dtype=torch.float32)
        p = {"root_pos": z(N, 3), "root_d": z(N, 3), "spine": z(N, 3), "neck": z(N, 3), "clav": z(N, 2, 3),
             "arm": z(N, 2, 3), "elbow": z(N, 2), "thigh": z(N, 2, 3), "knee": z(N, 2), "foot": z(N, 2, 3)}
        for i, s in enumerate(self.SIDES):
            p["arm"][:, i] = self.neutral[f"{s}Arm"]
            he = self.hinge[f"{s}ForeArm"]
            p["elbow"][:, i] = self._inv_hinge(he, math.radians(15) - he["rest_bend"])
            hk = self.hinge[f"{s}Leg"]
            p["knee"][:, i] = self._inv_hinge(hk, math.radians(5) - hk["rest_bend"])
        return p

    @staticmethod
    def _inv_hinge(h, theta):
        u = min(max((theta - h["lo"]) / (h["hi"] - h["lo"]), 1e-4), 1 - 1e-4)
        return math.log(u / (1 - u))

    @staticmethod
    def hinge_angle(h, raw):
        return h["lo"] + (h["hi"] - h["lo"]) * torch.sigmoid(raw)

    def assemble(self, p, R0):
        """-> local rotations (N, J, 3, 3). R0 (N, 3, 3): per-frame base root orientation."""
        N = p["root_pos"].shape[0]
        ix = self.ix
        rot = [None] * self.J
        eye = torch.eye(3, dtype=torch.float32).expand(N, 3, 3)
        rot[0] = R0 @ rodrigues(p["root_d"])
        sp = rodrigues(p["spine"] / 3.0)
        for n in ("Spine", "Spine1", "Spine2"):
            rot[ix[n]] = sp
        nk = rodrigues(p["neck"] / 2.0)
        rot[ix["Neck"]] = nk
        rot[ix["Head"]] = nk
        for i, s in enumerate(self.SIDES):
            rot[ix[f"{s}Shoulder"]] = rodrigues(p["clav"][:, i])
            rot[ix[f"{s}Arm"]] = rodrigues(p["arm"][:, i])
            he = self.hinge[f"{s}ForeArm"]
            rot[ix[f"{s}ForeArm"]] = hinge_rot(he["axis"], self.hinge_angle(he, p["elbow"][:, i]))
            rot[ix[f"{s}UpLeg"]] = rodrigues(p["thigh"][:, i])
            hk = self.hinge[f"{s}Leg"]
            rot[ix[f"{s}Leg"]] = hinge_rot(hk["axis"], self.hinge_angle(hk, p["knee"][:, i]))
            rot[ix[f"{s}Foot"]] = rodrigues(p["foot"][:, i])
        for j, (ax, ang) in self.static.items():
            sg = 1.0 if self._curl_sign is None else self._curl_sign["Left" if self.body.labels[j].startswith("Left") else "Right"]
            if "Thumb" in self.body.labels[j]:
                sg = 1.0
            rot[j] = hinge_rot(torch.tensor(ax, dtype=torch.float32), torch.tensor(sg * ang)).expand(N, 3, 3)
        for j in range(self.J):
            if rot[j] is None:
                rot[j] = eye
        return torch.stack(rot, 1)


def twist_angle(aa, axis):
    """Swing-twist decomposition of the rotation aa (..., 3; axis-angle): the angle (rad, in
    (-pi, pi]) by which it turns about the unit vector `axis`. What remains is the swing that
    takes `axis` to its new direction along the shortest way."""
    th = torch.sqrt((aa ** 2).sum(-1) + 1e-12)
    qv = aa / th[..., None] * torch.sin(th / 2)[..., None]
    tw = 2 * torch.atan2((qv * axis).sum(-1), torch.cos(th / 2))
    return tw - 2 * math.pi * torch.round(tw / (2 * math.pi))


def gm(r2, c=3.0):
    """Geman-McClure on squared normalised residuals: ~r2 for small residuals, saturates at c^2."""
    return r2 * (c * c) / (r2 + c * c)


def second_diff(x):
    return x[2:] - 2 * x[1:-1] + x[:-2]
