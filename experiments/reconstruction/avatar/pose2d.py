"""Step 1 - 2D whole-body keypoints for the subject in every camera, every master-clock frame.

Top-down RTMW (COCO-WholeBody, 133 keypoints; ONNX on CPU through rtmlib, Apache-2.0) with a
flip test. The person box comes from a YOLOX person detector, gated by the app's own tracked
box / the SAM 2 crop so reflections in the glazing cannot be picked up.

Usage: python pose2d.py --clip clip02 --models /path/to/onnx/models
Output: data/<clip>/avatar/kp2d.npz  (kp [cam, frame, 133, 3] = x, y, score in full-frame pixels)
"""
import argparse, glob, os, time
import cv2
import numpy as np
from common import CAMS, clip_dir, load_json, public_dir, work_dir

WB_FLIP = None


def wholebody_flip_index():
    """Left/right swap for the 133 COCO-WholeBody keypoints."""
    idx = list(range(133))
    def sw(a, b):
        idx[a], idx[b] = b, a
    for a, b in [(1, 2), (3, 4), (5, 6), (7, 8), (9, 10), (11, 12), (13, 14), (15, 16), (17, 20), (18, 21), (19, 22)]:
        sw(a, b)
    for i in range(8):            # face contour 23..39 mirrored
        sw(23 + i, 39 - i)
    for i in range(5):            # eyebrows 40..49
        sw(40 + i, 49 - i)
    for a, b in [(54, 58), (55, 57), (59, 68), (60, 67), (61, 66), (62, 65), (63, 70), (64, 69),
                 (71, 77), (72, 76), (73, 75), (78, 82), (79, 81), (83, 87), (84, 86), (88, 90)]:
        sw(a, b)
    for i in range(21):           # hands 91..111 <-> 112..132
        sw(91 + i, 112 + i)
    return np.array(idx)


def iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0])); iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - ix * iy
    return ix * iy / ua if ua > 0 else 0.0


def cover(a, b):
    """Fraction of box a covered by box b."""
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0])); iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    aa = (a[2] - a[0]) * (a[3] - a[1])
    return ix * iy / aa if aa > 0 else 0.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clip", default="clip02")
    ap.add_argument("--models", default=os.environ.get("AVATAR_MODELS", "models"))
    ap.add_argument("--no-flip", action="store_true")
    a = ap.parse_args()
    from rtmlib import YOLOX, RTMPose

    det_path = glob.glob(os.path.join(a.models, "yolox_m", "**", "end2end.onnx"), recursive=True)[0]
    pose_path = glob.glob(os.path.join(a.models, "rtmw_l_384", "**", "end2end.onnx"), recursive=True)[0]
    det = YOLOX(det_path, model_input_size=(640, 640), score_thr=0.25)
    pose = RTMPose(pose_path, model_input_size=(288, 384))
    flip_idx = wholebody_flip_index()

    man = load_json(os.path.join(public_dir(a.clip), "manifest.json"))
    track = load_json(os.path.join(clip_dir(a.clip), "track.json"))
    n = man["frameCount"]
    kp = np.zeros((len(CAMS), n, 133, 3), np.float32)
    boxes = np.full((len(CAMS), n, 4), np.nan, np.float32)
    src = np.zeros((len(CAMS), n), np.int8)   # 0 none, 1 detector+mask, 2 detector+track, 3 mask only
    t_start = time.time()
    for ci, cam in enumerate(CAMS):
        frames = man["cameras"][cam]["frames"]
        for k in range(n):
            img = cv2.imread(os.path.join(clip_dir(a.clip), "frames", cam, f"{k:04d}.png"))
            mbox = frames[k].get("cropPx") if frames[k].get("file") else None
            tbox = track[k]["boxes"].get(cam) if track[k]["boxInFrame"].get(cam, 0) > 0.3 else None
            dets = det(img)
            dets = [list(map(float, d[:4])) for d in dets] if len(dets) else []
            best, how = None, 0
            if mbox is not None:
                cands = [(max(iou(d, mbox), 0.8 * cover(d, mbox)), d) for d in dets]
                cands = [c for c in cands if c[0] > 0.3]
                if cands:
                    best, how = max(cands, key=lambda c: c[0])[1], 1
                else:
                    best, how = [float(v) for v in mbox], 3
            elif tbox is not None:
                # No usable mask here (occluded / at the frame edge): trust a detection only when it
                # sits where the calibrated track says the person is.
                cands = [(iou(d, tbox), d) for d in dets]
                cands = [c for c in cands if c[0] > 0.25]
                if cands:
                    best, how = max(cands, key=lambda c: c[0])[1], 2
            if best is None:
                continue
            k1, s1 = pose(img, bboxes=[best])
            k1, s1 = k1[0], s1[0]
            if not a.no_flip:
                fl = img[:, ::-1].copy()
                fb = [img.shape[1] - best[2], best[1], img.shape[1] - best[0], best[3]]
                k2, s2 = pose(fl, bboxes=[fb])
                k2, s2 = k2[0][flip_idx], s2[0][flip_idx]
                k2[:, 0] = img.shape[1] - 1 - k2[:, 0]
                # Average the two passes; a large disagreement lowers the confidence.
                d = np.linalg.norm(k1 - k2, axis=1)
                size = max(best[2] - best[0], best[3] - best[1])
                agree = np.exp(-0.5 * (d / (0.05 * size)) ** 2)
                k1 = (k1 + k2) / 2
                s1 = np.minimum(s1, s2) * (0.25 + 0.75 * agree)
            kp[ci, k, :, :2] = k1
            kp[ci, k, :, 2] = s1
            boxes[ci, k] = best
            src[ci, k] = how
            if k % 40 == 0:
                print(f"{cam} {k}/{n}  box={np.round(best).astype(int).tolist()} src={how}  meanScore={s1[:23].mean():.2f}  {time.time() - t_start:.0f}s", flush=True)
    out = os.path.join(work_dir(a.clip), "kp2d.npz")
    np.savez_compressed(out, kp=kp, boxes=boxes, src=src, cams=np.array(CAMS))
    print("wrote", out, "boxes per cam:", (src > 0).sum(1).tolist())


if __name__ == "__main__":
    main()
