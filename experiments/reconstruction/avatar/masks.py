"""SAM 2 person masks exported by the existing pipeline (alpha channel of the RGBA footage crops),
and the 2D keypoints restricted to the part of the person each camera can actually see."""
import os
import cv2
import numpy as np
from PIL import Image

from common import CAMS, H, W, clip_dir, load_json, public_dir, work_dir


_CACHE = {}


def clip_boxes(clip):
    """Where each mask is authoritative. The exporter (segmentation/export_sprites.py, clean) keeps a
    mask only inside the tracked person box padded by 20 % / 15 %. Where that box is off - the
    tracked path is up to 0.7 m from the person - the mask ends in a straight cut through the head
    or an arm (about one view in ten), and beyond the cut it says nothing about the person.
    -> {(camera name, frame): (x0, y0, x1, y1)} in full-frame pixels; empty without track.json."""
    path = os.path.join(clip_dir(clip), "track.json")
    out = {}
    if os.path.exists(path):
        for row in load_json(path):
            for cam, b in (row.get("boxes") or {}).items():
                if b is not None:
                    px, py = (b[2] - b[0]) * 0.2, (b[3] - b[1]) * 0.15
                    out[(cam, int(row["k"]))] = (max(0, int(b[0] - px)), max(0, int(b[1] - py)), min(W, int(b[2] + px)), min(H, int(b[3] + py)))
    return out


def load_masks(clip, rgb=False):
    """-> {(cam_index, frame): {"m": uint8 (h, w) in {0,1}, "a": float32 alpha, "x0", "y0", "carried": bool,
    "known": (x0, y0, x1, y1) part of the frame in which the mask is authoritative, "rgb": optional}}"""
    if (clip, rgb) in _CACHE:
        return _CACHE[(clip, rgb)]
    man = load_json(os.path.join(public_dir(clip), "manifest.json"))
    boxes = clip_boxes(clip)
    out = {}
    for ci, cam in enumerate(CAMS):
        for fr in man["cameras"][cam]["frames"]:
            if not fr.get("file"):
                continue
            im = np.asarray(Image.open(os.path.join(public_dir(clip), fr["file"])).convert("RGBA"))
            x0, y0, x1, y1 = fr["cropPx"]
            assert im.shape[0] == y1 - y0 and im.shape[1] == x1 - x0, (cam, fr["k"], im.shape, fr["cropPx"])
            a = im[..., 3].astype(np.float32) / 255.0
            e = {"m": (a > 0.5).astype(np.uint8), "a": a, "x0": int(x0), "y0": int(y0),
                 "carried": "+carried" in fr.get("maskMethod", ""), "method": fr.get("maskMethod", "")}
            kb = boxes.get((cam, int(fr["k"])), (0, 0, W, H))
            ys, xs = np.nonzero(e["m"])
            if len(xs):                               # a carried object is added after the clip and may stick out
                kb = (min(kb[0], x0 + int(xs.min())), min(kb[1], y0 + int(ys.min())), max(kb[2], x0 + int(xs.max()) + 1), max(kb[3], y0 + int(ys.max()) + 1))
            e["known"] = kb
            if rgb:
                e["rgb"] = im[..., :3].copy()
            out[(ci, int(fr["k"]))] = e
    _CACHE[(clip, rgb)] = out
    return out


def paste(e, x0, y0, x1, y1):
    """The mask of entry e inside the window [x0, x1) x [y0, y1) of the full frame, and where it can be
    trusted: `known` is 0 outside the image and outside the box the exporter clipped the mask to.
    -> m, known (uint8, same shape)."""
    m = np.zeros((y1 - y0, x1 - x0), np.uint8)
    known = np.zeros_like(m)
    h, w = e["m"].shape
    ax0, ay0, ax1, ay1 = max(e["x0"], x0), max(e["y0"], y0), min(e["x0"] + w, x1), min(e["y0"] + h, y1)
    if ax1 > ax0 and ay1 > ay0:
        m[ay0 - y0:ay1 - y0, ax0 - x0:ax1 - x0] = e["m"][ay0 - e["y0"]:ay1 - e["y0"], ax0 - e["x0"]:ax1 - e["x0"]]
    kx0, ky0, kx1, ky1 = e["known"]
    bx0, by0, bx1, by1 = max(kx0, x0, 0), max(ky0, y0, 0), min(kx1, x1, W), min(ky1, y1, H)
    if bx1 > bx0 and by1 > by0:
        known[by0 - y0:by1 - y0, bx0 - x0:bx1 - x0] = 1
    return m, known


def in_known(e, px, margin=0.0):
    """Which full-frame points (n, 2) lie where the mask of entry e is authoritative."""
    kx0, ky0, kx1, ky1 = e["known"]
    return (px[:, 0] >= max(kx0, 0) + margin) & (px[:, 1] >= max(ky0, 0) + margin) & \
           (px[:, 0] <= min(kx1, W) - 1 - margin) & (px[:, 1] <= min(ky1, H) - 1 - margin)


HEAD_KP = [0, 1, 2, 3, 4]
TORSO_KP = [5, 6, 11, 12]                         # shoulders, hips
LEG_KP = [13, 14, 15, 16, 17, 18, 19, 20, 21, 22]  # knees, ankles, toes, heels


def fill_gaps(flag, n):
    """Close gaps of up to n frames between flagged frames (flag: (frames,) bool)."""
    out = flag.copy()
    idx = np.nonzero(flag)[0]
    for a, b in zip(idx[:-1], idx[1:]):
        if 1 < b - a <= n + 1:
            out[a:b] = True
    return out


def hidden_keypoints(masks, kp, boxes, rel=0.02, min_px=4.0, pad=64, s_min=2.5, edge_px=16.0, edge_rel=0.04, gap=3):
    """(C, N, K) bool: detections that do not show the keypoint they are reported for.

    A top-down pose network returns every keypoint, seen or not, and reports guesses with full
    confidence. Two kinds of guess are recognised:

    edge    The limb leaves the frame: the keypoint is pinned to the image border (in the camera that
            looks down at the table, every ankle and half of the knees). Anything within `edge_px`
            (or `edge_rel` x the person box) of the border is such a detection.
    hidden  The limb is behind furniture: the guess lies along the edge of whatever hides it, and two
            cameras guessing differently triangulate to a point in mid-air. A detection farther
            outside the SAM 2 mask of its view than `rel` x the person box (at least `min_px`) is such
            a guess. The allowance is doubled for the face, whose keypoints lie on the outline of a
            head in profile, and halved for knees, ankles and feet: a joint centre lies inside the
            leg, and a foot is too short for a guess next to it to be harmless - one ankle guessed
            4 px beside the visible shoe turned the whole leg. Keypoints hidden by the body itself
            project onto the person and are kept.

    A keypoint that is hidden before and after a gap of up to `gap` frames is hidden in between as
    well, so that evidence does not flicker at the threshold.

    The mask test is skipped where the mask is no evidence: in views without a mask, beyond the box
    the exporter clipped the mask to (see clip_boxes), and in the handful of views whose mask does not
    show this person at all - where most confident shoulder / hip keypoints (or, without those,
    head keypoints) fall off it, SAM 2 has drifted onto a plant or a sofa."""
    C, N, K = kp.shape[:3]
    hidden = np.zeros((C, N, K), bool)
    tol = np.full(K, 1.0)
    tol[HEAD_KP] = 2.0
    tol[[j for j in LEG_KP if j < K]] = 0.5
    size = np.where(np.isfinite(boxes).all(-1), np.maximum(boxes[..., 2] - boxes[..., 0], boxes[..., 3] - boxes[..., 1]), 0.0)
    for (ci, k), e in masks.items():
        h, w = e["m"].shape
        x0, y0 = e["x0"] - pad, e["y0"] - pad
        m, known = paste(e, x0, y0, x0 + w + 2 * pad, y0 + h + 2 * pad)
        dist = cv2.distanceTransform(1 - np.maximum(m, 1 - known), cv2.DIST_L2, 5)    # px to the person, or to where nothing is known
        uv = kp[ci, k, :, :2]
        x, y = np.round(uv[:, 0] - x0).astype(int), np.round(uv[:, 1] - y0).astype(int)
        ok = (x >= 0) & (y >= 0) & (x < m.shape[1]) & (y < m.shape[0])
        d = np.where(in_known(e, uv), 1e3, 0.0)
        d[ok] = dist[y[ok], x[ok]]
        off = d > tol * max(min_px, rel * (size[ci, k] if size[ci, k] > 0 else max(h, w)))
        conf = kp[ci, k, :, 2] >= s_min
        ref = TORSO_KP if conf[TORSO_KP].sum() >= 2 else HEAD_KP + TORSO_KP
        if conf[ref].any() and off[ref][conf[ref]].mean() > 0.5:
            continue
        hidden[ci, k] = off
    uv = kp[..., :2]
    to_edge = np.minimum(np.minimum(uv[..., 0], W - 1 - uv[..., 0]), np.minimum(uv[..., 1], H - 1 - uv[..., 1]))
    hidden |= to_edge < np.maximum(edge_px, edge_rel * size)[..., None]
    if gap > 0:
        for ci in range(C):
            for j in range(K):
                hidden[ci, :, j] = fill_gaps(hidden[ci, :, j], gap)
    return hidden


def load_keypoints(clip, masks=None):
    """kp2d.npz of pose2d.py with the score of hidden keypoints set to 0.
    -> kp (C, N, 133, 3), boxes (C, N, 4), src (C, N), hidden (C, N, 133) bool."""
    d = np.load(os.path.join(work_dir(clip), "kp2d.npz"))
    kp = d["kp"].copy()
    hidden = hidden_keypoints(load_masks(clip) if masks is None else masks, kp, d["boxes"])
    kp[..., 2][hidden] = 0.0
    return kp, d["boxes"], d["src"], hidden
