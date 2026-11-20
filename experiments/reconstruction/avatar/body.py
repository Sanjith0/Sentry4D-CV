"""Parametric body used by the avatar pipeline.

Geometry, skeleton, skin weights, UV layout and COCO keypoint regressors come from Anny
(NAVER, Apache-2.0 code, CC0 MakeHuman-derived data) with its Mixamo-compatible rig. Anny is only
used for the *rest* state (identity -> rest vertices + joint positions). Posing is done here with
plain linear blend skinning over world-aligned joint frames and at most 4 influences per vertex,
i.e. exactly what a glTF / three.js SkinnedMesh evaluates, so the exported animation reproduces
the fitted surface bit-for-bit (up to float32).

Frames: Anny is Z-up, facing -Y, character-left = +X. Everything returned here is converted to
the app's convention: Y-up, facing +Z, character-left = +X, metres.
"""
import warnings
import numpy as np
import torch

from common import KP_NAMES

BONES = None  # filled by load_anny()
BODY_JOINTS = ["Hips", "LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase", "RightUpLeg", "RightLeg", "RightFoot",
               "RightToeBase", "Spine", "Spine1", "Spine2", "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
               "Neck", "Head", "RightShoulder", "RightArm", "RightForeArm", "RightHand"]
PHENOTYPES = ["gender", "age", "muscle", "weight", "height", "proportions"]


def load_anny():
    warnings.filterwarnings("ignore")
    import anny
    model = anny.Anny(rig="mixamo", topology="anny", skinning_method="lbs")
    return model


def _to_app(x):
    """Anny (x left, y back, z up) -> app (x left, y up, z front)."""
    return torch.stack([x[..., 0], x[..., 2], -x[..., 1]], dim=-1)


class Body:
    """Static rig data + differentiable rest state and posing."""

    def __init__(self, model=None, dtype=torch.float32):
        import anny
        self.anny = model or load_anny()
        m = self.anny
        self.dtype = dtype
        self.labels = [l.split(":")[-1] for l in m.bone_labels]
        self.parents = [int(p) for p in m.bone_parents]
        self.J = len(self.labels)
        self.idx = {l: i for i, l in enumerate(self.labels)}
        self.faces = m.faces.to(torch.int64)
        self.uv = m.texture_coordinates.to(dtype)                    # (T, 2), origin bottom-left
        self.face_uv = m.face_texture_coordinate_indices.to(torch.int64)
        # Top-4 influences, renormalised (three.js / glTF evaluate 4 per vertex).
        w, wi = m.vertex_bone_weights.to(torch.float64), m.vertex_bone_indices.to(torch.int64)
        order = torch.argsort(w, dim=1, descending=True)[:, :4]
        w4 = torch.gather(w, 1, order)
        self.wi = torch.gather(wi, 1, order)
        self.w = (w4 / w4.sum(1, keepdim=True)).to(dtype)
        self.V = self.w.shape[0]
        dense = torch.zeros(self.V, self.J, dtype=torch.float64)
        dense.scatter_add_(1, self.wi, self.w.to(torch.float64))
        self.w_dense = dense.to(dtype)
        # COCO-WholeBody body+feet regressors (vertex -> keypoint), reduced to per-bone terms.
        reg = anny.KeypointsRegressor.coco(m, labels=KP_NAMES).regression_weights.to(torch.float64)   # (K, V)
        self.kp_reg = reg.to(dtype)
        self.kp_M = torch.einsum("kv,vj->kjv", reg, dense).to(dtype)   # (K, J, V)
        self.kp_A = self.kp_M.sum(-1)                                   # (K, J)
        # Kinematic order (parents first).
        self.order = list(range(self.J))
        assert all(self.parents[j] < j for j in range(1, self.J))

    # ---- identity -----------------------------------------------------------------------
    def rest(self, phen, scale=None):
        """phen: (6,) in [0,1] (gender, age, muscle, weight, height, proportions). Returns dict of
        rest vertices (V,3), joint heads (J,3) and tails (J,3) in app coordinates, differentiable."""
        m = self.anny
        p = phen.to(m.dtype).reshape(1, -1)
        co = m._get_phenotype_blendshape_coefficients(p, torch.zeros(1, len(m.local_change_labels), dtype=m.dtype),
                                                      torch.zeros(1, len(m.facial_action_labels), dtype=m.dtype))
        r = m.get_rest_model(co)
        v, h, t = (_to_app(r[k][0]).to(self.dtype) for k in ("rest_vertices", "rest_bone_heads", "rest_bone_tails"))
        if scale is not None:
            v, h, t = v * scale, h * scale, t * scale
        return {"v": v, "heads": h, "tails": t}

    def kp_terms(self, rest):
        """Per-bone offsets so that keypoint_k = sum_j (R_j b_kj + a_kj p_j)."""
        b = torch.einsum("kjv,vd->kjd", self.kp_M, rest["v"]) - self.kp_A[..., None] * rest["heads"][None]
        return b

    # ---- posing -------------------------------------------------------------------------
    def fk(self, rot, root_pos, heads):
        """rot: (B, J, 3, 3) local rotations in world-aligned joint frames; root_pos: (B, 3) world
        position of the Hips joint. Returns global rotations (B, J, 3, 3) and joint positions (B, J, 3)."""
        B = rot.shape[0]
        GR, Gp = [None] * self.J, [None] * self.J
        GR[0], Gp[0] = rot[:, 0], root_pos
        off = heads - heads[[max(p, 0) for p in self.parents]]
        for j in range(1, self.J):
            p = self.parents[j]
            GR[j] = GR[p] @ rot[:, j]
            Gp[j] = Gp[p] + (GR[p] @ off[j][None, :, None].expand(B, 3, 1))[..., 0]
        return torch.stack(GR, 1), torch.stack(Gp, 1)

    def keypoints(self, GR, Gp, kp_b):
        return torch.einsum("bjmn,kjn->bkm", GR, kp_b) + torch.einsum("kj,bjm->bkm", self.kp_A, Gp)

    def skin(self, GR, Gp, rest, vidx=None):
        """Linear blend skinning. vidx: optional vertex subset. Returns (B, V', 3)."""
        v, heads = rest["v"], rest["heads"]
        w, wi = self.w, self.wi
        if vidx is not None:
            v, w, wi = v[vidx], w[vidx], wi[vidx]
        out = 0
        for k in range(4):
            j = wi[:, k]
            local = v - heads[j]                                         # (V, 3)
            R = GR[:, j]                                                 # (B, V, 3, 3)
            out = out + w[None, :, k, None] * ((R @ local[None, :, :, None])[..., 0] + Gp[:, j])
        return out


def rodrigues(aa):
    """Axis-angle (..., 3) -> rotation matrices (..., 3, 3)."""
    th = torch.sqrt((aa ** 2).sum(-1) + 1e-12)
    k = aa / th[..., None]
    K = torch.zeros(aa.shape[:-1] + (3, 3), dtype=aa.dtype)
    K[..., 0, 1], K[..., 0, 2] = -k[..., 2], k[..., 1]
    K[..., 1, 0], K[..., 1, 2] = k[..., 2], -k[..., 0]
    K[..., 2, 0], K[..., 2, 1] = -k[..., 1], k[..., 0]
    s, c = torch.sin(th)[..., None, None], torch.cos(th)[..., None, None]
    return torch.eye(3, dtype=aa.dtype) + s * K + (1 - c) * (K @ K)


def rotmat_to_quat(R):
    """(..., 3, 3) numpy -> (..., 4) xyzw, w >= 0 not enforced (continuity is handled by the caller)."""
    R = np.asarray(R, np.float64)
    q = np.empty(R.shape[:-2] + (4,))
    t = np.trace(R, axis1=-2, axis2=-1)
    it = np.nditer(t, flags=["multi_index"])
    for tr in it:
        i = it.multi_index
        m = R[i]
        if tr > 0:
            s = np.sqrt(tr + 1.0) * 2
            q[i] = [(m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s, 0.25 * s]
        elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
            s = np.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
            q[i] = [0.25 * s, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s, (m[2, 1] - m[1, 2]) / s]
        elif m[1, 1] > m[2, 2]:
            s = np.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
            q[i] = [(m[0, 1] + m[1, 0]) / s, 0.25 * s, (m[1, 2] + m[2, 1]) / s, (m[0, 2] - m[2, 0]) / s]
        else:
            s = np.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
            q[i] = [(m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, 0.25 * s, (m[1, 0] - m[0, 1]) / s]
    return q
