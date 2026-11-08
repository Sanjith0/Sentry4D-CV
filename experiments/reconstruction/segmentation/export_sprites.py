"""Clean SAM 2 masks and export RGBA crops of the REAL footage + a manifest for the web app.

Input : data/<clip>/{manifest.json, track.json, frames/<cam>/<k>.png, masks/<cam>/<k>.png}
Output: public/reconstruction/<clip>/<cam>/<k>.webp   (RGBA, source resolution, no resampling)
        public/reconstruction/<clip>/manifest.json
        data/<clip>/review_<cam>.jpg                    (contact sheet for human review)

Mask cleanup is conservative (it never adds image content):
  open 3x3 -> keep the largest component + components touching it (dilated 9 px) -> fill interior
  holes -> close 5x5 -> keep only inside the padded tracked box. Alpha = mask blurred ~1.5 px.
Manual override: if data/<clip>/masks_manual/<cam>/<k>.png exists it replaces the SAM mask.

Crop rectangles are stored in NORMALIZED coordinates of the upright displayed frame (same convention
as the app's videoPixelToWorld / worldToVideoPixel), so the renderer can projectively texture them.
"""
import argparse, json, os, shutil
import cv2
import numpy as np

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
ROOT = os.path.abspath(os.path.join(BASE, "..", ".."))


def clean(mask, box, w, h):
    m = (mask > 127).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m, 8)
    if n <= 1:
        return np.zeros_like(m)
    big = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    keep = (lab == big).astype(np.uint8)
    near = cv2.dilate(keep, np.ones((19, 19), np.uint8))
    for i in range(1, n):
        if i != big and stats[i, cv2.CC_STAT_AREA] >= 80 and (near[lab == i] > 0).any():
            keep[lab == i] = 1
    # fill holes: flood the background from the border, anything not reached is interior
    inv = (1 - keep).astype(np.uint8)
    ff = inv.copy()
    cv2.floodFill(ff, np.zeros((h + 2, w + 2), np.uint8), (0, 0), 2)
    keep[(ff == 1)] = 1
    keep = cv2.morphologyEx(keep, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    x0, y0, x1, y1 = box
    px, py = (x1 - x0) * 0.2, (y1 - y0) * 0.15
    clip = np.zeros_like(keep)
    clip[max(0, int(y0 - py)) : min(h, int(y1 + py)), max(0, int(x0 - px)) : min(w, int(x1 + px))] = 1
    return keep * clip


def foreground(img, plate, box, w, h, thr=22.0):
    """Pixels that differ from the static background plate (CIE Lab distance), restricted to the box."""
    if plate is None:
        return None
    a = cv2.cvtColor(cv2.GaussianBlur(img, (5, 5), 0), cv2.COLOR_BGR2LAB).astype(np.float32)
    b = cv2.cvtColor(cv2.GaussianBlur(plate, (5, 5), 0), cv2.COLOR_BGR2LAB).astype(np.float32)
    fg = (np.linalg.norm(a - b, axis=2) > thr).astype(np.uint8)
    fg = cv2.morphologyEx(fg, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    fg = cv2.morphologyEx(fg, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    return clean(fg * 255, box, w, h)


def iou(a, b):
    u = np.logical_or(a, b).sum()
    return float(np.logical_and(a, b).sum() / u) if u else 0.0


def plausible(m, box):
    """Person-sized blob centred in the tracked box."""
    x0, y0, x1, y1 = box
    ba = max(1, (x1 - x0) * (y1 - y0))
    area = int(m.sum())
    if not (0.06 * ba <= area <= 0.85 * ba):
        return False, f"mask area {area / ba:.2f} of box"
    ys, xs = np.nonzero(m)
    cx, cy = xs.mean(), ys.mean()
    # tolerance = known calibration error (tens of px): box may be offset from the real person
    tx, ty = 0.25 * (x1 - x0), 0.25 * (y1 - y0)
    if not (x0 - tx <= cx <= x1 + tx and y0 - ty <= cy <= y1 + ty):
        return False, "mask centroid outside tracked box"
    return True, None


def drift(ref, img):
    """Vertical/horizontal shift of the ceiling band (static background) in px."""
    a = cv2.cvtColor(ref[: ref.shape[0] // 4], cv2.COLOR_BGR2GRAY).astype(np.float32)
    b = cv2.cvtColor(img[: img.shape[0] // 4], cv2.COLOR_BGR2GRAY).astype(np.float32)
    (dx, dy), _ = cv2.phaseCorrelate(a, b, cv2.createHanningWindow(a.shape[::-1], cv2.CV_32F))
    return round(float(dx), 2), round(float(dy), 2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clip", default="clip01")
    ap.add_argument("--cams", default="cam1,cam2")
    ap.add_argument("--margin", type=int, default=12)
    ap.add_argument("--person", default="person_01", help="annotation dataset this clip shows")
    ap.add_argument("--subject", default="subject-01", help="config/subjects.ts id")
    ap.add_argument("--min-in-frame", type=float, default=0.5)
    # Only cameras verified static (stabilization_check.py) get background refinement: CAM 02's mount
    # sags ~12 px over the recording, so its median plate is blurred and would damage good SAM masks.
    ap.add_argument("--bg-cams", default="cam1,cam3,cam4")
    a = ap.parse_args()
    clip = os.path.join(BASE, "data", a.clip)
    man = json.load(open(os.path.join(clip, "manifest.json")))
    track = json.load(open(os.path.join(clip, "track.json")))
    # Explicit manual visibility marks (occluded / out-of-frame) override automatic segmentation.
    ann = json.load(open(os.path.join(ROOT, "src", "data", "person-annotations.json")))
    marks = [m for d in ann["datasets"] if d["personId"] == a.person for m in d.get("visibility", [])]
    # Human review decisions: {"cam4": [102, 107, 108], ...} -> frames dropped from the export.
    rj = os.path.join(clip, "reject.json")
    reviewed_out = json.load(open(rj)) if os.path.exists(rj) else {}
    out = os.path.join(ROOT, "public", "reconstruction", a.clip)
    shutil.rmtree(out, ignore_errors=True)
    web = {
        "clip": a.clip,
        "personId": a.person,
        "subjectId": a.subject,
        "fps": man["fps"],
        "t0": man["t0"],
        "t1": man["t1"],
        "frameCount": man["frameCount"],
        "syncOffsets": man["syncOffsets"],
        "evidence": "observed-pixels",
        "note": "RGBA crops of the original recordings (SAM 2.1 mask). Pixels are unmodified footage; only alpha is computed.",
        "cameras": {},
    }
    for cam in a.cams.split(","):
        os.makedirs(os.path.join(out, cam), exist_ok=True)
        frames = man["cameras"][cam]["frames"]
        ref = cv2.imread(os.path.join(clip, frames[0]["file"]))
        plate_path = os.path.join(BASE, "data", "background", f"{cam}.png")
        plate = cv2.imread(plate_path) if os.path.exists(plate_path) and cam in a.bg_cams.split(",") else None
        h, w = ref.shape[:2]
        entries, sheet = [], []
        for f in frames:
            k = f["k"]
            img = cv2.imread(os.path.join(clip, f["file"]))
            manual = os.path.join(clip, "masks_manual", cam, f"{k:04d}.png")
            sam_path = os.path.join(clip, "masks", cam, f"{k:04d}.png")
            row = track[k]
            box = row["boxes"].get(cam)
            reject = None
            if not os.path.exists(manual):
                neg = [m for m in marks if m["cameraId"] == cam and m["state"] in ("occluded", "out-of-frame") and abs(m["masterTime"] - f["masterTime"]) <= 1.5 / man["fps"]]
                if k in reviewed_out.get(cam, []):
                    reject = "rejected in manual review"
                elif not row.get("visible", True) or box is None:
                    reject = "subject not tracked here"
                elif row.get("boxInFrame", {}).get(cam, 1) < a.min_in_frame:
                    reject = "tracked box mostly outside this camera's frame"
                elif neg:
                    reject = f"manual mark: {neg[0]['state']}"
                elif not os.path.exists(sam_path):
                    reject = "no SAM mask"
            if reject:
                entries.append({"k": k, "masterTime": f["masterTime"], "videoTime": f["videoTime"], "file": None, "reason": reject})
                continue
            img = cv2.imread(os.path.join(clip, f["file"]))
            src = manual if os.path.exists(manual) else sam_path
            raw = cv2.imread(src, cv2.IMREAD_GRAYSCALE)
            method = "manual"
            agreement = None
            if src == manual:
                m = (raw > 127).astype(np.uint8)
            else:
                m = clean(raw, box, w, h)
                method = "sam2"
                fg = foreground(img, plate, box, w, h)
                if fg is not None and fg.sum() > 500:
                    agreement = round(iou(m > 0, fg > 0), 3)
                    if agreement < 0.5:
                        ok_fg, _ = plausible(fg, box)
                        ok_sam, _ = plausible(m, box) if m.sum() else (False, None)
                        a_sam, a_fg = int(m.sum()), int(fg.sum())
                        if ok_sam and a_fg > 1.6 * a_sam:
                            # Background difference grabbed extra static-scene change (reflections,
                            # lighting near windows): SAM's tighter person mask is the reliable one.
                            method = "sam2 (background unreliable)"
                        elif ok_fg and (not ok_sam or a_sam > 1.6 * a_fg or a_sam < 0.4 * a_fg):
                            # SAM collapsed / latched elsewhere; the moving blob is person-like.
                            m, method = fg, "background-subtraction"
                        else:
                            entries.append({"k": k, "masterTime": f["masterTime"], "videoTime": f["videoTime"], "file": None, "reason": f"SAM/background disagree (IoU {agreement})"})
                            continue
                    else:
                        m2 = m * cv2.dilate(fg, np.ones((7, 7), np.uint8))
                        m = clean(m2 * 255, box, w, h)
                        method = "sam2+background"
                ok, why = plausible(m, box) if m.sum() else (False, "empty mask")
                if not ok:
                    entries.append({"k": k, "masterTime": f["masterTime"], "videoTime": f["videoTime"], "file": None, "reason": why})
                    continue
            area = int(m.sum())
            if area < 500:
                entries.append({"k": k, "masterTime": f["masterTime"], "videoTime": f["videoTime"], "file": None, "reason": "no mask"})
                continue
            ys, xs = np.nonzero(m)
            x0, x1 = max(0, xs.min() - a.margin), min(w, xs.max() + a.margin + 1)
            y0, y1 = max(0, ys.min() - a.margin), min(h, ys.max() + a.margin + 1)
            alpha = cv2.GaussianBlur(m.astype(np.float32) * 255, (0, 0), 1.2)
            rgba = np.dstack([img, alpha.clip(0, 255).astype(np.uint8)])[y0:y1, x0:x1]
            name = f"{k:04d}.webp"
            cv2.imwrite(os.path.join(out, cam, name), rgba, [cv2.IMWRITE_WEBP_QUALITY, 92])
            # feet = lowest mask row (only meaningful when the legs are unoccluded)
            bottom = int(ys.max())
            feet_x = float(xs[ys >= bottom - 3].mean())
            entries.append(
                {
                    "k": k,
                    "masterTime": f["masterTime"],
                    "videoTime": f["videoTime"],
                    "sourcePts": f["sourcePts"],
                    "file": f"{cam}/{name}",
                    # normalized [u0, v0, u1, v1] of the crop in the full upright frame
                    "crop": [round(x0 / w, 6), round(y0 / h, 6), round(x1 / w, 6), round(y1 / h, 6)],
                    "cropPx": [int(x0), int(y0), int(x1), int(y1)],
                    "maskArea": area,
                    "maskBottomPx": [round(feet_x, 1), bottom],
                    "manualMask": src == manual,
                    "maskMethod": method,
                    "samVsBackgroundIoU": agreement,
                    "backgroundDriftPx": drift(ref, img),
                }
            )
            o = img.copy()
            o[m > 0] = (0.5 * o[m > 0] + 0.5 * np.array([0, 255, 255])).astype(np.uint8)
            c = o[y0:y1, x0:x1]
            sheet.append(cv2.resize(c, (int(220 * c.shape[1] / c.shape[0]), 220)))
            cv2.putText(sheet[-1], str(k), (4, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 255), 2)
        web["cameras"][cam] = {"width": w, "height": h, "frames": entries}
        rows, row, rw = [], [], 0
        for s in sheet:
            if rw + s.shape[1] > 1800 and row:
                rows.append(np.hstack(row + [np.zeros((220, 1800 - rw, 3), np.uint8)]))
                row, rw = [], 0
            row.append(s)
            rw += s.shape[1]
        if row:
            rows.append(np.hstack(row + [np.zeros((220, 1800 - rw, 3), np.uint8)]))
        cv2.imwrite(os.path.join(clip, f"review_{cam}.jpg"), np.vstack(rows))
        d = [e["backgroundDriftPx"] for e in entries if e.get("file")]
        size = sum(os.path.getsize(os.path.join(out, e["file"])) for e in entries if e.get("file"))
        rejected = {}
        for e in entries:
            if not e.get("file"):
                rejected[e["reason"]] = rejected.get(e["reason"], 0) + 1
        print(f"{cam}: rejected {rejected}")
        methods = {}
        for e in entries:
            methods[e.get("maskMethod", "none")] = methods.get(e.get("maskMethod", "none"), 0) + 1
        low = [(e["k"], e["samVsBackgroundIoU"]) for e in entries if e.get("samVsBackgroundIoU") is not None and e["samVsBackgroundIoU"] < 0.7]
        print(f"{cam}: methods {methods}; SAM-vs-background IoU < 0.7 at {low}")
        print(f"{cam}: {sum(1 for e in entries if e.get('file'))}/{len(entries)} crops, {size / 1024:.0f} KB, background drift within clip max |dx|,|dy| = {max(abs(x) for x, _ in d)}, {max(abs(y) for _, y in d)} px")
    with open(os.path.join(out, "manifest.json"), "w") as fh:
        json.dump(web, fh, indent=1)
    print("wrote", os.path.relpath(os.path.join(out, "manifest.json"), ROOT))


if __name__ == "__main__":
    main()
