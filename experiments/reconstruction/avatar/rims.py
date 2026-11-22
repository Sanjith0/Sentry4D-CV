"""Step 5d - the rim of a cut-out along furniture carries the person's colour (rewrites cut-outs; work dir: rims.json, rims_orig/).

The last pixels of a matte are part person and part whatever is next to the person in the picture. Along the
free outline that is what an outline looks like. Where furniture stands in front of the body (the sofa across a
knee, the table across the shins) the matte ends in the middle of the body, and its rim is part furniture. Projected
onto the body and seen from anywhere but that camera's own position, that rim is a line of the furniture's colour
across the leg.

For every cut-out this finds the stretches of its outline beyond which the fitted body goes on inside the frame
(the body as that camera sees it, registered by step 5c, at least BEYOND px outside the matte and no sliver), and paints the rim
within NEAR px of such a part with the person's own colour next to it: the nearest pixel that lies 7 px inside
the matte (5 px where the part is too narrow for that). The weight is 1 for the outer 4 (3) px of the matte, for its
feathered edge and for OUTSIDE px beyond it, and falls to 0 at 7 (5) px.
Left as filmed:
  * thin parts (fingers, a chair leg): they have no pixel that deep straight inwards;
  * the hands, the head and the feet as the fit places them (KEEP px around): their rim is skin or a sole, not
    the colour a few pixels further in;
  * views that step 5c does not use.

Only the colours of those rim pixels change: alpha, crop rectangle and every other pixel are what the exporter
wrote (same source frame, same encoder settings), so mattes, registration and everything measured on them stay
valid, and the run is repeatable. The cut-out as exported is kept in the work dir (rims_orig/) the first time it
is rewritten and put back when a later run finds nothing to paint; `--restore` puts all of them back.
The clip's manifest says that its pixels are unmodified footage: its note is extended by what this step changed
(and shortened again by `--restore`).

    python rims.py --clip clip02                            # ~1 minute on 3 cores
    python rims.py --clip clip02 --only cam3:244 --out DIR  # review sheets for some views, writes no cut-out
    python rims.py --clip clip02 --restore                  # the cut-outs as exported
"""
import argparse, json, os, shutil, time
from multiprocessing import Pool

import cv2
import numpy as np
from scipy.ndimage import distance_transform_edt

import register as R
import shape as S
from common import CAMS, clip_dir, load_json, project, public_dir, work_dir
from render import front_facing, raster_mask

DEPTHS = ((7.0, 4.0), (5.0, 3.0))   # (px inside the matte from which a pixel is the person alone, px inside the matte that
                      # are painted in full), tried in turn: the footage is soft, and the furniture's colour reaches
                      # 6 px into a wide part; a narrow part has no pixel that deep and uses the second pair
STRAIGHT = 2.5        # px: the deep pixel must lie this close to straight inwards (else the part is thin: left alone)
OUTSIDE = 8.0         # px outside the matte that are painted as well (invisible, but texture filtering and the encoder read them)
BEYOND = 6.0          # px the body must go on beyond the matte (less is the fit being a few px off, not a hidden part)
MIN_PART = 80         # px of body beyond the matte that count as a hidden part
NEAR = 14.0           # px from such a part of the body within which the rim is painted (the fit is a few px off sideways too)
KEEP = 5              # px around the fitted hands, head and feet that are left as filmed
PAD = 24              # px around the crop that are looked at
MIN_PIXELS = 12       # fewer changed pixels than this: the cut-out stays as exported
QUALITY = 92          # as written by segmentation/export_sprites.py
NOTE = " Except (avatar/rims.py): "   # what follows this in the manifest's note is written by this step


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def body_masks(key, window):
    """The fitted body as camera `key` sees it, registered to its cut-out, inside window (x0, y0, x1, y1)
    -> (the whole body, its hands, head and feet), or None when the body is behind the camera."""
    ci, k = key
    G = S.G
    cam = G["cams"][CAMS[ci]]
    X = G["poser"].pose(k - cam["dt"] * G["fps"], G["v"])
    px, z = project(cam, X)
    ok = z > 0.3
    if ok.mean() < 0.5:
        return None
    ff, _ = front_facing(X, G["faces"], cam["C"])
    fsel = G["faces"][ff & ok[G["faces"]].all(1)]
    r = REG[CAMS[ci]]["register"][k]
    if r is not None:
        s, dx, dy, cx, cy = r
        px = np.array([cx, cy]) + s * (px - np.array([cx, cy])) + np.array([dx, dy])
    x0, y0, x1, y1 = window
    px = np.where(ok[:, None], px, -1e4)
    size, origin = (y1 - y0, x1 - x0), (x0, y0)
    return (raster_mask(px, fsel, size, origin).astype(bool),
            raster_mask(px, fsel[DETAIL[fsel].any(1)], size, origin).astype(bool))


def clean(key, alpha, detail=None):
    """One cut-out (its alpha as exported) -> (BGRA with the rim along furniture painted, or None when nothing
    changes; pixels changed)."""
    ci, k = key
    cam = CAMS[ci]
    x0, y0, x1, y1 = MAN["cameras"][cam]["frames"][k]["cropPx"]
    frame = cv2.imread(os.path.join(CLIP, "frames", cam, f"{k:04d}.png"))
    Hh, Ww = frame.shape[:2]
    wx0, wy0, wx1, wy1 = x0 - PAD, y0 - PAD, x1 + PAD, y1 + PAD
    h, w = wy1 - wy0, wx1 - wx0
    img = np.zeros((h, w, 3), np.float32); a = np.zeros((h, w), np.uint8); inside = np.zeros((h, w), bool)
    ax0, ay0, ax1, ay1 = max(wx0, 0), max(wy0, 0), min(wx1, Ww), min(wy1, Hh)
    img[ay0 - wy0:ay1 - wy0, ax0 - wx0:ax1 - wx0] = frame[ay0:ay1, ax0:ax1]
    inside[ay0 - wy0:ay1 - wy0, ax0 - wx0:ax1 - wx0] = True
    a[PAD:PAD + y1 - y0, PAD:PAD + x1 - x0] = alpha
    m = a >= 128
    both = body_masks(key, (wx0, wy0, wx1, wy1))
    if both is None or not m.any():
        return None, 0
    body, part = both
    keep = cv2.dilate(part.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * KEEP + 1, 2 * KEEP + 1))).astype(bool)
    d_in = cv2.distanceTransform(m.astype(np.uint8), cv2.DIST_L2, 5)
    d_out = cv2.distanceTransform((~m).astype(np.uint8), cv2.DIST_L2, 5)
    # the body beyond the matte, inside the frame (what the frame's edge cuts off is not behind furniture)
    beyond = cv2.morphologyEx((body & inside & (d_out >= BEYOND)).astype(np.uint8), cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(beyond, 8)
    beyond = np.isin(lab, [i for i in range(1, n) if st[i, cv2.CC_STAT_AREA] >= MIN_PART])     # a sliver is the fit being off
    if not beyond.any():
        return None, 0
    band = ((a > 0) | (d_out <= OUTSIDE)) & ~keep & (cv2.distanceTransform(1 - beyond.astype(np.uint8), cv2.DIST_L2, 5) <= NEAR)
    out, wgt = img.copy(), np.zeros((h, w), np.float32)
    for deep_px, soft_px in DEPTHS:
        deep = m & (d_in >= deep_px)
        todo = band & ~deep & (wgt == 0)
        if not deep.any() or not todo.any():
            continue
        # the person's colour next to a rim pixel: the nearest deep pixel, lightly averaged among the deep pixels
        num = cv2.GaussianBlur(img * deep[..., None].astype(np.float32), (0, 0), 1.0)
        den = cv2.GaussianBlur(deep.astype(np.float32), (0, 0), 1.0)
        dF, (iy, ix) = distance_transform_edt(~deep, return_indices=True)
        F = (num / np.maximum(den[..., None], 1e-6))[iy, ix]
        straight = dF <= np.where(m, deep_px - d_in, deep_px + d_out - 1.0) + STRAIGHT     # else: a thin part
        wg = (todo & straight) * np.where(m, 1.0 - smoothstep(soft_px, deep_px, d_in), 1.0).astype(np.float32)
        out += wg[..., None] * (F - out)
        wgt = np.maximum(wgt, wg)
    changed = int(((np.abs(out - img).max(-1) > 8) & (a > 0)).sum())
    if detail is not None:
        detail.update(img=img, out=out, beyond=beyond, wgt=wgt, a=a, keep=keep)
    if changed < MIN_PIXELS:
        return None, changed
    rgb = frame[y0:y1, x0:x1].copy()                                             # exactly the exporter's colours ...
    sel = wgt[PAD:PAD + y1 - y0, PAD:PAD + x1 - x0] > 0                          # ... except on the painted rim
    rgb[sel] = np.clip(np.rint(out[PAD:PAD + y1 - y0, PAD:PAD + x1 - x0][sel]), 0, 255).astype(np.uint8)
    return np.dstack([rgb, alpha]), changed


def setup(clip):
    global MAN, PUB, CLIP, REG, DETAIL, ORIG
    cv2.setNumThreads(1)
    R.init(clip, "fit.npz")
    PUB, CLIP, ORIG = public_dir(clip), clip_dir(clip), os.path.join(work_dir(clip), "rims_orig")
    MAN = load_json(os.path.join(PUB, "manifest.json"))
    REG = load_json(os.path.join(work_dir(clip), "register.json"))["cameras"]
    body = S.G["body"]
    label = np.array(body.labels)[body.wi[:, 0].numpy()]                         # the joint that moves each vertex most
    DETAIL = np.array([("Hand" in s or "Foot" in s or "Toe" in s or s in ("Head", "Neck")) for s in label])


def exported(key):
    """-> (path of the cut-out, path of its copy as exported, alpha as exported). A copy whose matte is not the
    cut-out's matte belongs to an earlier export of that frame and is dropped."""
    ci, k = key
    cam = CAMS[ci]
    path = os.path.join(PUB, MAN["cameras"][cam]["frames"][k]["file"])
    keep = os.path.join(ORIG, cam, f"{k:04d}.webp")
    alpha = cv2.imread(path, cv2.IMREAD_UNCHANGED)[..., 3]
    if os.path.exists(keep):
        old = cv2.imread(keep, cv2.IMREAD_UNCHANGED)
        if old.shape[:2] != alpha.shape or not (old[..., 3] == alpha).all():
            os.remove(keep)
    return path, keep, alpha


def put_back(path, keep):
    if os.path.exists(keep):
        shutil.copy2(keep, path)
        os.remove(keep)
        return True
    return False


def one(key):
    """Rewrite one cut-out (or put it back as exported) -> (key, pixels changed or None)."""
    ci, k = key
    path, keep, alpha = exported(key)
    rgba, changed = clean(key, alpha) if REG[CAMS[ci]]["use"][k] else (None, 0)
    if rgba is None:
        put_back(path, keep)
        return key, None
    if not os.path.exists(keep):                                                  # never overwrite the first (= exported) copy
        os.makedirs(os.path.dirname(keep), exist_ok=True)
        shutil.copy2(path, keep)
    cv2.imwrite(path, rgba, [cv2.IMWRITE_WEBP_QUALITY, QUALITY])
    back = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    assert back.shape == rgba.shape and (back[..., 3] == alpha).all(), f"{path}: the matte changed in encoding"
    return key, changed


def note(painted):
    """The manifest's note says what the pixels of the cut-outs are: add (or take back) what this step changed."""
    path = os.path.join(PUB, "manifest.json")
    man = load_json(path)
    text = man.get("note", "").split(NOTE)[0].rstrip()
    if painted:
        text += f"{NOTE}in {painted} cut-outs the colours of the matte's rim along furniture that hides the rest " \
                "of the person are replaced by the person's own colour a few pixels further in (alpha unchanged)."
    if text != man.get("note"):
        man["note"] = text
        with open(path + ".tmp", "w") as fh:
            json.dump(man, fh, indent=1)                                           # same call as segmentation/export_sprites.py
        os.replace(path + ".tmp", path)


def review(key, out):
    """Sheet of one view, 4x: the frame with the body beyond the matte (red), the rim painted (green) and what is
    left as filmed (blue) | the cut-out as exported | the cut-out as painted, both over grey."""
    alpha = exported(key)[2] if not os.path.exists(os.path.join(ORIG, CAMS[key[0]], f"{key[1]:04d}.webp")) else \
        cv2.imread(os.path.join(ORIG, CAMS[key[0]], f"{key[1]:04d}.webp"), cv2.IMREAD_UNCHANGED)[..., 3]
    d = {}
    _, changed = clean(key, alpha, d)
    print(f"{CAMS[key[0]]}:{key[1]}  {changed} px", flush=True)
    if not d:
        return
    up = lambda x: cv2.resize(x, None, fx=4, fy=4, interpolation=cv2.INTER_NEAREST)
    before, after = np.clip(d["img"], 0, 255).astype(np.uint8), np.clip(d["out"], 0, 255).astype(np.uint8)
    lay = before.copy(); lay[d["keep"]] = lay[d["keep"]] // 2 + np.array([127, 0, 0], np.uint8)
    lay[d["beyond"]] = (0, 0, 255); lay[d["wgt"] > 0] = (0, 255, 0)
    al = d["a"].astype(np.float32)[..., None] / 255
    comp = lambda c: (c * al + 128 * (1 - al)).astype(np.uint8)                   # over mid grey, as seen away from the camera
    cv2.imwrite(os.path.join(out, f"{CAMS[key[0]]}_{key[1]:04d}.png"), np.hstack([up(lay), up(comp(before)), up(comp(after))]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clip", default="clip02")
    ap.add_argument("--procs", type=int, default=3)
    ap.add_argument("--only", default="", help="cam3:244,cam3:110: review sheets in --out; writes no cut-out")
    ap.add_argument("--out", default="/tmp/rims")
    ap.add_argument("--restore", action="store_true", help="put every cut-out back as exported")
    a = ap.parse_args()
    t0 = time.time()
    setup(a.clip)
    keys = sorted(S.G["masks"].keys())
    if a.only:
        os.makedirs(a.out, exist_ok=True)
        for spec in a.only.split(","):
            cam, k = spec.split(":")
            review((CAMS.index(cam), int(k)), a.out)
        return
    report = os.path.join(work_dir(a.clip), "rims.json")
    if a.restore:
        n = sum(put_back(*exported(key)[:2]) for key in keys)
        if os.path.exists(report):
            os.remove(report)
        note(0)
        print(f"{n} cut-outs put back as exported")
        return
    with Pool(a.procs) as pool:
        rows = dict(pool.imap_unordered(one, keys, chunksize=8))
    out = {"clip": a.clip, "note": "pixels of each cut-out whose colour step 5d changed (null: as exported)", "cameras": {}}
    for ci, cam in enumerate(CAMS):
        out["cameras"][cam] = [rows.get((ci, k)) for k in range(len(MAN["cameras"][cam]["frames"]))]
        got = [r for r in out["cameras"][cam] if r]
        print(f"{cam}: {len(got)} of {sum(1 for key in keys if key[0] == ci)} cut-outs have a rim along furniture"
              + (f"; {int(np.median(got))} px changed in the median, {max(got)} at most" if got else ""))
    with open(report, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    note(sum(1 for r in rows.values() if r))
    print(f"wrote {report}  [{time.time() - t0:.0f}s]")


if __name__ == "__main__":
    main()
