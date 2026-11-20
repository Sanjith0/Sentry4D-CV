"""Diagnostics: mask outline (green) vs rasterised avatar outline (red) for chosen frames; blue = the
part of the frame in which the mask is authoritative (masks.clip_boxes)."""
import argparse, os
import cv2
import numpy as np

import shape as S
from common import CAMS, clip_dir, work_dir


def sheet(clip, frames, out, size=320, naked=False, fit="fit.npz"):
    G = S.setup(clip, fit)
    sp_ = os.path.join(work_dir(clip), "shape.npz")
    v = G["poser"].v0 if naked or not os.path.exists(sp_) else np.load(sp_)["v"].astype(np.float64)
    rows = []
    for k in frames:
        row = []
        for ci, c in enumerate(CAMS):
            tile = np.zeros((size, size, 3), np.uint8)
            if (ci, k) in G["masks"]:
                r = S.silhouette(ci, k, v)
                if r is not None:
                    x0, y0, x1, y1 = r["box"]
                    img = cv2.imread(os.path.join(clip_dir(clip), "frames", c, f"{k:04d}.png"))[y0:y1, x0:x1]
                    sc = size / max(img.shape[:2])
                    big = cv2.resize(img, None, fx=sc, fy=sc, interpolation=cv2.INTER_LINEAR)
                    for m, col in ((r["m"], (0, 255, 0)), (r["S"], (0, 0, 255)), (r["known"], (255, 200, 0))):
                        cs, _ = cv2.findContours(m, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
                        cv2.drawContours(big, [np.round(cc * sc).astype(np.int32) for cc in cs], -1, col, 1)
                    iou = (r["Sk"] & r["m"]).sum() / max((r["Sk"] | r["m"]).sum(), 1)
                    tile[:big.shape[0], :big.shape[1]] = big[:size, :size]
                    e = G["masks"][(ci, k)]
                    cv2.putText(tile, f"{c} k{k} IoU {iou:.2f}{' +carried' if e['carried'] else ''}", (4, size - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (0, 255, 255), 1)
            row.append(tile)
        rows.append(np.hstack(row))
    cv2.imwrite(out, np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 88])


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--clip", default="clip02")
    ap.add_argument("--frames", default="40,100,150,200,260")
    ap.add_argument("--out", default="/tmp/avatar_sil.jpg")
    ap.add_argument("--naked", action="store_true")
    ap.add_argument("--fit", default="fit.npz")
    a = ap.parse_args()
    sheet(a.clip, [int(x) for x in a.frames.split(",")], a.out, naked=a.naked, fit=a.fit)
