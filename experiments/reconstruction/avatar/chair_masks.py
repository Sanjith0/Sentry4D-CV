"""Image evidence for the chair: which pixels of each camera show it, frame by frame.

The chair is a thin slatted object about 100 px tall in the far cameras. A promptable segmenter
(SAM 2.1 with a box around the rough chair position) returns the floor seen through the legs
rather than the chair, and where it does lock on it fills the object as a blob and drops the legs.
The cameras are static (up to a slow sag of their mounts, `drift`), so the footage itself gives a
sharper cut-out:

- standing chair: the chair is at its place for the first two thirds of the clip and gone at the
  end, so |median(early frames) - median(late frames)| is the chair (and whatever else was moved);
- moving chair: |frame - background| is the man plus what he carries, the fitted body (render.Poser)
  says which of those pixels are the man, and inside the body outline the chair is what is light
  and colourless against the black clothes. The background is the median of the whole clip, except
  where the chair stood (there it is the late median, which shows the floor behind it).

What stands in front of the chair is known as well: the fitted body, and the furniture of the
LiDAR room scan (`scan_depth`, a z-buffer of the scan per camera), so that a hidden part of the
proxy is not counted as a miss. Everything is cached under data/<clip>/avatar/chair_*.npz.
"""
import os
import cv2
import numpy as np
from scipy.ndimage import median_filter

from common import CAMS, H, W, clip_dir, project, undistort_px, work_dir

DIFF, DIFF_STAND = 25, 22           # grey levels a pixel must differ from the background
BRIGHT, GREY = 90, 80               # chair in front of the dark clothes: HSV value above, saturation below
SLAT = 0.015                        # m: the proxy panels are solid, so gaps up to this half-width are closed in a mask
BODY_PAD = 7                        # px the body outline is grown by (silhouette agreement is IoU 0.8-0.9)


def drift(clip, _cache={}):
    """Per camera (frames, 2) px: shift of the picture of frame k against the clip's median picture.
    The mounts sag (cam2 by 5 px over clip02), which is the width of a chair leg; the refined
    cameras describe the average."""
    if clip not in _cache:
        path = os.path.join(work_dir(clip), "chair_drift.npz")
        if not os.path.exists(path):
            out = {}
            for c in CAMS:
                n = len(os.listdir(os.path.join(clip_dir(clip), "frames", c)))
                small = lambda k: cv2.resize(cv2.imread(os.path.join(clip_dir(clip), "frames", c, f"{k:04d}.png"), cv2.IMREAD_GRAYSCALE),
                                             (W // 2, H // 2), interpolation=cv2.INTER_AREA).astype(np.float32)
                ref, win = small(0), cv2.createHanningWindow((W // 2, H // 2), cv2.CV_32F)
                ks = np.arange(0, n, 3)
                d = 2 * np.array([cv2.phaseCorrelate(ref, small(k), win)[0] for k in ks])
                d = np.stack([np.interp(np.arange(n), ks, median_filter(d[:, j], 5, mode="nearest")) for j in (0, 1)], 1)
                out[c] = (d - np.median(d, 0)).astype(np.float32)
            np.savez(path, **out)
        _cache[clip] = dict(np.load(path))
    return _cache[clip]


def frame(clip, cam, k):
    """Image k of a camera (BGR), registered to the clip's median picture."""
    dx, dy = drift(clip)[cam][k]
    img = cv2.imread(os.path.join(clip_dir(clip), "frames", cam, f"{k:04d}.png"))
    return cv2.warpAffine(img, np.array([[1, 0, -dx], [0, 1, -dy]], np.float64), (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


def backgrounds(clip, n, late_from):
    """Per camera (3, H, W, 3) uint8: median of the whole clip, of the frames before the man arrives
    (`early`) and of the frames after the chair has left its place (`late`)."""
    path = os.path.join(work_dir(clip), "chair_bg.npz")
    if os.path.exists(path):
        return dict(np.load(path))
    out = {}
    for c in CAMS:
        med = lambda ks: np.median(np.stack([frame(clip, c, k) for k in ks]), 0).astype(np.uint8)
        out[c] = np.stack([med(range(0, n, 7)), med(range(0, 100, 8)), med(range(late_from, n, 5))])
    np.savez_compressed(path, **out)
    return out


def scan_depth(clip, cams):
    """Depth (m along the optical axis) of the nearest room-scan surface at every pixel of every
    camera, (H, W) float32 per camera; inf where the scan has no surface."""
    path = os.path.join(work_dir(clip), "chair_scan_depth.npz")
    if os.path.exists(path):
        return dict(np.load(path))
    from room import load_room
    V, F = load_room()
    out = {}
    yy, xx = np.mgrid[0:H, 0:W]
    for c in CAMS:
        cam = cams[c]
        Vc = V @ cam["R"].T + cam["t"]
        px, z = project(cam, V)
        ok = (z[F] > 0.3).all(1) & (np.abs(px[F] - [W / 2, H / 2]).max((1, 2)) < 4000)
        f = F[ok]
        ids = np.full((H, W), -1, np.int32)
        p = np.round(px * 8).astype(np.int32)[f]
        for i in np.argsort(-z[f].mean(1)):           # painter's algorithm, nearest triangle last
            cv2.fillConvexPoly(ids, p[i], int(i), lineType=cv2.LINE_8, shift=3)
        # depth of the triangle's plane along the ray of each pixel
        n = np.cross(Vc[f[:, 1]] - Vc[f[:, 0]], Vc[f[:, 2]] - Vc[f[:, 0]])
        d = (n * Vc[f[:, 0]]).sum(1)
        ray = (undistort_px(cam, np.stack([xx, yy], -1).reshape(-1, 2).astype(np.float64)) - [cam["cx"], cam["cy"]]) / cam["f"]
        i = np.maximum(ids.reshape(-1), 0)
        den = n[i, 0] * ray[:, 0] + n[i, 1] * ray[:, 1] + n[i, 2]
        depth = d[i] / np.where(np.abs(den) < 1e-9, 1e-9, den)
        lo, hi = z[f].min(1)[i], z[f].max(1)[i]
        out[c] = np.where(ids.reshape(-1) >= 0, np.clip(depth, lo, hi), np.inf).reshape(H, W).astype(np.float32)
    np.savez_compressed(path, **out)
    return out


def window(cam, centres, radius=0.85):
    """Pixel box (x0, y0, x1, y1) around spheres of `radius` m at the 3D points `centres`, cut to the frame."""
    px, z = project(cam, np.atleast_2d(centres))
    r = radius * cam["f"] / np.maximum(z, 0.5)
    x0, y0 = np.floor((px - r[:, None]).min(0)).astype(int)
    x1, y1 = np.ceil((px + r[:, None]).max(0)).astype(int)
    return max(0, x0), max(0, y0), min(W, x1), min(H, y1)


def _tidy(m, min_area=12):
    """Drop specks smaller than `min_area` px."""
    n, lab, st, _ = cv2.connectedComponentsWithStats(m.astype(np.uint8), connectivity=8)
    keep = np.zeros(n, bool); keep[1:] = st[1:, cv2.CC_STAT_AREA] >= min_area
    return keep[lab].astype(np.uint8)


def closed(mask, scale):
    """Mask with the gaps between the slats filled (`scale` = m per px at the chair)."""
    r = int(np.ceil(SLAT / scale))
    return cv2.morphologyEx(mask, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1)))


def standing_mask(bg, box):
    """Chair pixels inside `box` while it stands: where the early and the late background differ."""
    x0, y0, x1, y1 = box
    d = np.abs(bg[1, y0:y1, x0:x1].astype(np.int16) - bg[2, y0:y1, x0:x1]).max(2)
    return _tidy(d > DIFF_STAND)


def moving_mask(img, bg, box, body):
    """Chair pixels inside `box` of one frame. `body` = fitted body silhouette of that window (0/1).
    -> mask, grown body (both uint8 0/1)."""
    x0, y0, x1, y1 = box
    crop = img[y0:y1, x0:x1]
    ghost = cv2.dilate((np.abs(bg[1, y0:y1, x0:x1].astype(np.int16) - bg[2, y0:y1, x0:x1]).max(2) > DIFF_STAND).astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    ref = np.where(ghost[..., None], bg[2, y0:y1, x0:x1], bg[0, y0:y1, x0:x1]).astype(np.int16)
    fg = np.abs(crop.astype(np.int16) - ref).max(2) > DIFF
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    light = (hsv[..., 2] > BRIGHT) & (hsv[..., 1] < GREY)
    grown = cv2.dilate(body, np.ones((2 * BODY_PAD + 1,) * 2, np.uint8))
    near = cv2.dilate(body, np.ones((6 * BODY_PAD + 1,) * 2, np.uint8)) > 0     # slivers of the man beside his outline
    m = fg & np.where(near, light, True)
    return _tidy(m), grown
