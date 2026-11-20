"""CPU helpers shared by the silhouette, texture and validation steps.

`Poser` evaluates the fitted animation with plain numpy linear blend skinning (the same maths as
body.Body.skin / the exported GLB) at fractional frames, and exposes the per-vertex blended 3x3
so rest-space normals/offsets can be carried into the posed frame. The rasterisers are painter's
algorithm loops over cv2.fillConvexPoly (27k triangles ~ 30 ms), which is all a 4-core CPU needs.
"""
import cv2
import numpy as np
import torch


class Poser:
    def __init__(self, body, fit):
        rest = body.rest(torch.tensor(fit["phen"]), torch.tensor(float(fit["scale"])))
        self.v0 = rest["v"].numpy().astype(np.float64)
        heads = rest["heads"]
        with torch.no_grad():
            GR, Gp = body.fk(torch.tensor(fit["rot"]), torch.tensor(fit["root_pos"]), heads)
        self.A = GR.numpy().astype(np.float64)                                        # (N, J, 3, 3)
        self.b = Gp.numpy().astype(np.float64) - np.einsum("njab,jb->nja", self.A, heads.numpy().astype(np.float64))
        self.w = body.w.numpy().astype(np.float64)
        self.wi = body.wi.numpy()
        self.N = self.A.shape[0]

    def blend(self, k):
        """Blended skinning transform of every vertex at (fractional) frame k -> (V,3,3), (V,3)."""
        k = float(np.clip(k, 0, self.N - 1))
        k0 = min(int(np.floor(k)), self.N - 2)
        a = k - k0
        A = (1 - a) * self.A[k0] + a * self.A[k0 + 1]
        b = (1 - a) * self.b[k0] + a * self.b[k0 + 1]
        M = np.zeros((self.w.shape[0], 3, 3)); t = np.zeros((self.w.shape[0], 3))
        for i in range(4):
            M += self.w[:, i, None, None] * A[self.wi[:, i]]
            t += self.w[:, i, None] * b[self.wi[:, i]]
        return M, t

    def pose(self, k, v=None, n=None):
        M, t = self.blend(k)
        P = np.einsum("vab,vb->va", M, self.v0 if v is None else v) + t
        if n is None:
            return P
        return P, np.einsum("vab,vb->va", M, n)


def face_normals(P, faces):
    return np.cross(P[faces[:, 1]] - P[faces[:, 0]], P[faces[:, 2]] - P[faces[:, 0]])


def front_facing(P, faces, C):
    fn = face_normals(P, faces)
    return (fn * (C[None] - P[faces[:, 0]])).sum(1) > 0, fn


def raster_mask(px, faces, shape, origin=(0, 0)):
    """Union of the projected triangles (uint8 0/1). px in full-image pixels, origin = window (x0, y0)."""
    img = np.zeros(shape, np.uint8)
    p = np.round((px - np.asarray(origin, float)) * 8).astype(np.int32)
    for t in p[faces]:
        cv2.fillConvexPoly(img, t, 1, lineType=cv2.LINE_8, shift=3)
    return img


def raster_ids(px, z, faces, shape, origin=(0, 0), face_ids=None):
    """Painter's algorithm id buffer (int32, -1 = empty): far triangles first, nearest wins."""
    img = np.full(shape, -1, np.int32)
    zf = z[faces].mean(1)
    order = np.argsort(-zf)
    p = np.round((px - np.asarray(origin, float)) * 8).astype(np.int32)
    tri = p[faces]
    ids = np.arange(len(faces)) if face_ids is None else face_ids
    for i in order:
        cv2.fillConvexPoly(img, tri[i], int(ids[i]), lineType=cv2.LINE_8, shift=3)
    return img


def sdf(mask):
    """Signed distance (px) to the mask boundary: > 0 outside, < 0 inside."""
    m = (mask > 0).astype(np.uint8)
    if m.all():
        return -np.full(m.shape, 1e3, np.float32)
    if not m.any():
        return np.full(m.shape, 1e3, np.float32)
    out = cv2.distanceTransform(1 - m, cv2.DIST_L2, 5)
    inn = cv2.distanceTransform(m, cv2.DIST_L2, 5)
    return np.where(m > 0, -(inn - 0.5), out - 0.5).astype(np.float32)


def bilinear(img, xy):
    """Sample img (h, w[, c]) at float pixel coords xy (n, 2) (pixel centres at integers)."""
    h, w = img.shape[:2]
    x = np.clip(xy[:, 0], 0, w - 1.001); y = np.clip(xy[:, 1], 0, h - 1.001)
    x0 = np.floor(x).astype(np.int64); y0 = np.floor(y).astype(np.int64)
    fx = x - x0; fy = y - y0
    if img.ndim == 3:
        fx, fy = fx[:, None], fy[:, None]
    return (img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x0 + 1] * fx * (1 - fy)
            + img[y0 + 1, x0] * (1 - fx) * fy + img[y0 + 1, x0 + 1] * fx * fy)
