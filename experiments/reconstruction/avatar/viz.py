"""Diagnostics: project the fitted body back into the footage (contact sheets)."""
import argparse, os
import cv2
import numpy as np
import torch

from body import Body
from common import CAMS, H, SKELETON, W, clip_dir, load_cameras, project, work_dir


def posed_vertices(body, fit, frames, offsets=None):
    rest = body.rest(torch.tensor(fit["phen"]), torch.tensor(float(fit["scale"])))
    if offsets is not None:
        rest = dict(rest); rest["v"] = rest["v"] + torch.tensor(offsets, dtype=torch.float32)
    rot = torch.tensor(fit["rot"][frames]); root = torch.tensor(fit["root_pos"][frames])
    with torch.no_grad():
        GR, Gp = body.fk(rot, root, rest["heads"])
        v = body.skin(GR, Gp, rest)
    return v.numpy()


def sheet(clip, frames, out, fit_name="fit.npz", size=340, mesh=True, offsets=None):
    wd = work_dir(clip)
    fit = np.load(os.path.join(wd, fit_name))
    cams = load_cameras(clip)
    body = Body()
    V = posed_vertices(body, fit, frames, offsets)
    faces = body.faces.numpy()
    edges = np.unique(np.sort(np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]]), 1), axis=0)[::3]
    rows = []
    for i, k in enumerate(frames):
        row = []
        for ci, c in enumerate(CAMS):
            img = cv2.imread(os.path.join(clip_dir(clip), "frames", c, f"{k:04d}.png"))
            px, z = project(cams[c], V[i])
            kp, _ = project(cams[c], fit["kp3"][k])
            inside = (z > 0.3) & (px[:, 0] > -200) & (px[:, 0] < W + 200) & (px[:, 1] > -200) & (px[:, 1] < H + 200)
            if inside.sum() < 100:
                row.append(np.zeros((size, size, 3), np.uint8)); continue
            x0, y0, x1, y1 = px[inside, 0].min(), px[inside, 1].min(), px[inside, 0].max(), px[inside, 1].max()
            cx, cy, hh = (x0 + x1) / 2, (y0 + y1) / 2, max(x1 - x0, y1 - y0) * 0.62 + 16
            X0, Y0 = int(round(cx - hh)), int(round(cy - hh)); S = int(round(2 * hh))
            M = np.array([[size / S, 0, -X0 * size / S], [0, size / S, -Y0 * size / S]])
            crop = cv2.warpAffine(img, M, (size, size), flags=cv2.INTER_LINEAR)
            sc = size / S
            ov = crop.copy()
            if mesh:
                p = ((px - [X0, Y0]) * sc)
                for a, b in edges:
                    if z[a] > 0.3 and z[b] > 0.3:
                        cv2.line(ov, (int(p[a, 0]), int(p[a, 1])), (int(p[b, 0]), int(p[b, 1])), (255, 200, 0), 1, cv2.LINE_AA)
                crop = cv2.addWeighted(ov, 0.35, crop, 0.65, 0)
            q = (kp - [X0, Y0]) * sc
            for a, b in SKELETON:
                cv2.line(crop, (int(q[a, 0]), int(q[a, 1])), (int(q[b, 0]), int(q[b, 1])), (0, 255, 0) if a % 2 else (0, 128, 255), 1, cv2.LINE_AA)
            uv, w = fit["uv"][ci, k], fit["w2d"][ci, k]
            for j in range(23):
                if w[j] > 0:
                    u = (uv[j] - [X0, Y0]) * sc
                    cv2.circle(crop, (int(u[0]), int(u[1])), 2, (0, 0, 255) if w[j] < 0.5 else (255, 255, 255), -1)
                    cv2.line(crop, (int(u[0]), int(u[1])), (int(q[j, 0]), int(q[j, 1])), (0, 0, 255), 1)
            cv2.putText(crop, f"{c} k{k}", (5, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 255), 1)
            row.append(crop)
        rows.append(np.hstack(row))
    cv2.imwrite(out, np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 85])


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--clip", default="clip02")
    ap.add_argument("--frames", default="20,60,100,140")
    ap.add_argument("--out", default="/tmp/avatar_fit_sheet.jpg")
    ap.add_argument("--fit", default="fit.npz")
    ap.add_argument("--no-mesh", action="store_true")
    a = ap.parse_args()
    sheet(a.clip, [int(x) for x in a.frames.split(",")], a.out, a.fit, mesh=not a.no_mesh)
