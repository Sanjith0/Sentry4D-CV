"""Offline previews of the avatar (no browser/GPU): flat-shaded or texture-coloured turntables."""
import argparse, os
import cv2
import numpy as np

from body import Body
from common import work_dir
from render import Poser, face_normals, raster_ids


def look_at(eye, target, fov_deg, size):
    eye, target = np.asarray(eye, float), np.asarray(target, float)
    fwd = target - eye; fwd /= np.linalg.norm(fwd)
    right = np.cross(fwd, [0, 1, 0]); right /= np.linalg.norm(right)
    down = np.cross(fwd, right)
    R = np.stack([right, down, fwd])
    f = (size[1] / 2) / np.tan(np.radians(fov_deg) / 2)
    return {"R": R, "t": -R @ eye, "C": eye, "f": f, "cx": size[0] / 2, "cy": size[1] / 2}


def render(P, faces, cam, size, face_rgb=None, bg=(40, 40, 46), light=None):
    Xc = P @ cam["R"].T + cam["t"]
    z = Xc[:, 2]
    px = Xc[:, :2] / np.maximum(z[:, None], 1e-6) * cam["f"] + [cam["cx"], cam["cy"]]
    fn = face_normals(P, faces)
    fn /= np.maximum(np.linalg.norm(fn, axis=1, keepdims=True), 1e-12)
    front = (fn * (cam["C"][None] - P[faces[:, 0]])).sum(1) > 0
    sel = np.nonzero(front & (z[faces] > 0.05).all(1))[0]
    ids = raster_ids(px, z, faces[sel], (size[1], size[0]), face_ids=sel)
    img = np.empty((size[1], size[0], 3), np.uint8); img[:] = bg
    m = ids >= 0
    if face_rgb is None:
        l = np.array([0.3, 0.7, 0.6]) if light is None else np.asarray(light, float)
        view = cam["C"] - P[faces].mean(1); view /= np.linalg.norm(view, axis=1, keepdims=True)
        sh = 0.25 + 0.55 * np.clip(fn @ (l / np.linalg.norm(l)), 0, 1) + 0.25 * np.clip((fn * view).sum(1), 0, 1)
        col = (np.clip(sh, 0, 1)[:, None] * np.array([200, 205, 215])).astype(np.uint8)
    else:
        col = face_rgb
    img[m] = col[ids[m]]
    return img


def face_colors(body, tex):
    """Texture colour at every face's UV centroid (BGR texture, origin top-left)."""
    uv = body.uv.numpy()[body.face_uv.numpy()].mean(1)
    h, w = tex.shape[:2]
    x = np.clip((uv[:, 0] * w).astype(int), 0, w - 1); y = np.clip(((1 - uv[:, 1]) * h).astype(int), 0, h - 1)
    return tex[y, x]


def turntable(P, faces, out, face_rgb=None, n=8, size=(300, 520), dist=3.2, fov=32, label=None):
    c = 0.5 * (P.min(0) + P.max(0))
    tiles = []
    for i in range(n):
        az = 2 * np.pi * i / n
        eye = c + [dist * np.sin(az), 0.25, dist * np.cos(az)]
        im = render(P, faces, look_at(eye, c, fov, size), size, face_rgb)
        cv2.putText(im, f"{int(np.degrees(az))} deg", (6, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1)
        tiles.append(im)
    rows = [np.hstack(tiles[i:i + 4]) for i in range(0, n, 4)]
    img = np.vstack(rows)
    if label:
        cv2.putText(img, label, (6, img.shape[0] - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1)
    cv2.imwrite(out, img, [cv2.IMWRITE_JPEG_QUALITY, 90])


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--clip", default="clip02")
    ap.add_argument("--frame", type=int, default=-1, help="-1 = rest pose")
    ap.add_argument("--out", default="/tmp/avatar_preview.jpg")
    ap.add_argument("--naked", action="store_true")
    ap.add_argument("--tex", default="")
    a = ap.parse_args()
    wd = work_dir(a.clip)
    fit = np.load(os.path.join(wd, "fit.npz")); body = Body(); poser = Poser(body, fit)
    v = poser.v0 if a.naked or not os.path.exists(os.path.join(wd, "shape.npz")) else np.load(os.path.join(wd, "shape.npz"))["v"].astype(np.float64)
    P = v if a.frame < 0 else poser.pose(a.frame, v)
    rgb = None
    tp = a.tex or os.path.join(wd, "texture.png")
    if os.path.exists(tp) and not a.naked:
        rgb = face_colors(body, cv2.imread(tp))
    turntable(P, body.faces.numpy(), a.out, rgb, label=f"{a.clip} frame {a.frame}")
