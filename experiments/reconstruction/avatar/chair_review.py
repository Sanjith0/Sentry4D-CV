"""Checks of the chair reconstruction of chair.py: numbers against the masks, review sheets, room scan.

compare / score   proxy silhouette against the chair mask in one image: IoU, and the distance of the
                  proxy outline from the mask outline. The gaps between the slats are closed in the
                  mask (the proxy panels are solid); only what the camera can see counts (inside the
                  frame, not behind the body or scanned furniture) and only within MARGIN of the
                  proxy (further out the masks also hold floor reflections and moved furniture).
sheets            per frame every camera with the chair in frame: the footage with the outlines of
                  the proxy (red), the fitted body (green) and the mask (yellow); and a second grid
                  with the proxy drawn solid.
scan_picture      the LiDAR scan around the standing chair, with and without the proxy.
"""
import json, os, struct
import cv2
import numpy as np
from scipy.spatial.transform import Rotation as Rot

import chair_masks as CM
import chair_model as M
from common import CAMS, H, ROOT, W, project
from room import room_offset

MARGIN = 0.10                # m around the proxy that is compared
MIN_SEEN = 0.25              # share of the proxy silhouette that must be visible for a view to count


def pose_at(P, R, kf):
    """Pose of the track (P (N, 3), R Rotation of N) at fractional master frame kf -> matrix, position."""
    i = int(np.clip(np.floor(kf), 0, len(P) - 2)); a = kf - i
    return (R[i] * Rot.from_rotvec(a * (R[i].inv() * R[i + 1]).as_rotvec())).as_matrix(), (1 - a) * P[i] + a * P[i + 1]


def compare(sc, C, P, R, c, k):
    """Proxy (corners C (6, 8, 3) local) and chair mask in image k of camera c -> None if the proxy is
    out of frame, else box, polygons of the pieces and the images sil, mask, valid, body of that box."""
    cam = sc.cams[c]
    Rk, pk = pose_at(P, R, k - cam["dt"] * 15)
    X = C @ Rk.T + pk
    px, z = project(cam, X)
    if z.min() < 0.3:
        return None
    pad = MARGIN * cam["f"] / z.mean()
    x0, y0 = np.floor(px.reshape(-1, 2).min(0) - pad).astype(int)
    x1, y1 = np.ceil(px.reshape(-1, 2).max(0) + pad).astype(int)
    box = (max(0, x0), max(0, y0), min(W, x1), min(H, y1))
    shape = (box[3] - box[1], box[2] - box[0])
    if min(shape) < 8:
        return None
    polys = M.hulls(cam, X)
    zc = np.full(shape, np.inf, np.float32)                     # depth of the proxy per pixel
    for q, zq in zip(polys, z.mean(1)):
        part = M.raster([q], shape, box[:2]) > 0
        zc[part] = np.minimum(zc[part], zq)
    sil = np.isfinite(zc)
    zc[~sil] = z.mean()
    body, zb = sc.body_view(c, k, box)
    mask, grown = CM.moving_mask(CM.frame(sc.clip, c, k), sc.bg[c], box, body)
    mask = CM.closed(mask, z.mean() / cam["f"]) > 0
    near = cv2.erode(zb, np.ones((2 * CM.BODY_PAD + 5,) * 2, np.uint8))
    scan = sc.scan[c][box[1]:box[3], box[0]:box[2]]
    hidden = ((grown > 0) & (near < zc + 0.05)) | ((scan < zc - 0.15) & (scan > zc - 1.5))
    return {"box": box, "polys": polys, "sil": sil, "mask": mask, "valid": ~hidden, "body": body}


def _rim(m):
    return m & ~(cv2.erode(m.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0)


def score(cmp):
    """-> None if too little of the proxy can be seen, else IoU, visible share of the proxy, median
    distance (px) of the proxy outline from the mask outline and the share of it within 4 px."""
    sil, mask, valid = cmp["sil"], cmp["mask"], cmp["valid"]
    seen = (sil & valid).sum()
    if seen < 150 or seen < MIN_SEEN * sil.sum():
        return None
    d = cv2.distanceTransform((~_rim(mask)).astype(np.uint8), cv2.DIST_L2, 5)[_rim(sil) & valid]
    return {"iou": float((sil & mask & valid).sum() / ((sil | mask) & valid).sum()), "seen": float(seen / sil.sum()),
            "outline": float(np.median(d)), "within4": float((d <= 4).mean())}


def evaluate(sc, C, P, R, frames):
    """Scores of every camera in the given frames -> list of dicts with k, cam and the fields of `score`."""
    out = []
    for k in frames:
        for c in CAMS:
            cmp = compare(sc, C, P, R, c, k)
            s = score(cmp) if cmp else None
            if s:
                out.append({"k": int(k), "cam": c, **s})
    return out


def summary(rows, phases):
    """Per phase (name -> (first frame, end)) and camera: median IoU and outline distance, worst frames."""
    out = {}
    for name, (k0, k1) in phases.items():
        out[name] = {"frames": [int(k0), int(k1) - 1]}
        for c in CAMS:
            sel = sorted((r for r in rows if r["cam"] == c and k0 <= r["k"] < k1), key=lambda r: r["iou"])
            if sel:
                out[name][c] = {"views": len(sel), "iouMedian": round(float(np.median([r["iou"] for r in sel])), 3),
                                "outlinePxMedian": round(float(np.median([r["outline"] for r in sel])), 2),
                                "outlineWithin4px": round(float(np.mean([r["within4"] for r in sel])), 3),
                                "worst": [[r["k"], round(r["iou"], 3)] for r in sel[:3]]}
    return out


def sheets(sc, C, P, R, frames, out_dir, size=330):
    """Review grids, seven frames per sheet: outline_<n>.jpg and solid_<n>.jpg."""
    os.makedirs(out_dir, exist_ok=True)
    rows = {"outline": [], "solid": []}
    for k in frames:
        row = {"outline": [], "solid": []}
        for c in CAMS:
            cmp = compare(sc, C, P, R, c, k)
            tiles = {n: np.zeros((size, size, 3), np.uint8) for n in rows}
            if cmp is not None and (cmp["sil"].sum() > 100):
                x0, y0, x1, y1 = cmp["box"]
                s = size / max(x1 - x0, y1 - y0)
                crop = cv2.resize(CM.frame(sc.clip, c, k)[y0:y1, x0:x1], None, fx=s, fy=s, interpolation=cv2.INTER_CUBIC)
                h, w = crop.shape[:2]
                up = lambda m: cv2.resize(m.astype(np.uint8), (w, h), interpolation=cv2.INTER_NEAREST)
                line = crop.copy()
                for m, col in ((cmp["mask"], (0, 220, 255)), (cmp["body"], (0, 255, 0))):
                    cv2.drawContours(line, cv2.findContours(up(m), cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)[0], -1, col, 1)
                pp = [np.round((q - [x0, y0]) * s * 8).astype(np.int32) for q in cmp["polys"]]
                sil = np.zeros((h, w), np.uint8)
                lay = crop.copy()
                for q, col in zip(pp, [(60, 200, 255), (60, 120, 255)] + [(255, 160, 60)] * 4):
                    cv2.fillConvexPoly(sil, q, 1, shift=3)
                    cv2.fillConvexPoly(lay, q, col, lineType=cv2.LINE_AA, shift=3)
                cv2.drawContours(line, cv2.findContours(sil, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)[0], -1, (0, 0, 255), 1)
                sc_ = score(cmp)
                for n, im in (("outline", line), ("solid", cv2.addWeighted(lay, 0.55, crop, 0.45, 0))):
                    tiles[n][:h, :w] = im
                    cv2.putText(tiles[n], f"IoU {sc_['iou']:.2f}" if sc_ else "hidden", (5, size - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 255), 1)
            for n in rows:
                cv2.putText(tiles[n], f"{c} k{k}", (5, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1)
                row[n].append(tiles[n])
        for n in rows:
            rows[n].append(np.hstack(row[n]))
    for n in rows:
        for j in range(0, len(rows[n]), 7):
            cv2.imwrite(os.path.join(out_dir, f"{n}_{j // 7}.jpg"), np.vstack(rows[n][j:j + 7]), [cv2.IMWRITE_JPEG_QUALITY, 85])


def _scan_colours():
    """Room scan as vertices, triangles and one BGR colour per triangle (its texture at the centroid)."""
    with open(os.path.join(ROOT, "public", "assets", "room.glb"), "rb") as fh:
        fh.read(12)
        n, _ = struct.unpack("<I4s", fh.read(8))
        js = json.loads(fh.read(n))
        n, _ = struct.unpack("<I4s", fh.read(8))
        buf = fh.read(n)

    def acc(i, dtype, k):
        a = js["accessors"][i]; bv = js["bufferViews"][a["bufferView"]]
        return np.frombuffer(buf, dtype, a["count"] * k, bv.get("byteOffset", 0) + a.get("byteOffset", 0)).reshape(-1, k)
    V, F, col, base = [], [], [], 0
    for mesh in js["meshes"]:
        for p in mesh["primitives"]:
            v, uv = acc(p["attributes"]["POSITION"], np.float32, 3), acc(p["attributes"]["TEXCOORD_0"], np.float32, 2)
            ia = js["accessors"][p["indices"]]
            f = acc(p["indices"], {5123: np.uint16, 5125: np.uint32}[ia["componentType"]], 1).reshape(-1, 3).astype(np.int64)
            tex = js["textures"][js["materials"][p["material"]]["pbrMetallicRoughness"]["baseColorTexture"]["index"]]
            bv = js["bufferViews"][js["images"][tex["source"]]["bufferView"]]
            img = cv2.imdecode(np.frombuffer(buf, np.uint8, bv["byteLength"], bv.get("byteOffset", 0)), cv2.IMREAD_COLOR)
            c = uv[f].mean(1) % 1.0
            col.append(img[np.minimum((c[:, 1] * img.shape[0]).astype(int), img.shape[0] - 1), np.minimum((c[:, 0] * img.shape[1]).astype(int), img.shape[1] - 1)])
            V.append(v.astype(np.float64)); F.append(f + base); base += len(v)
    return np.concatenate(V) + room_offset(), np.concatenate(F), np.concatenate(col)


def scan_picture(C, Rs, ps, path, size=620, reach=1.3):
    """The textured room scan within `reach` m of the standing chair (pose Rs, ps), seen obliquely
    and from above, without (left) and with (right) the proxy (red)."""
    V, F, col = _scan_colours()
    tri = V[F]
    keep = (np.linalg.norm(tri.mean(1)[:, [0, 2]] - ps[[0, 2]], axis=1) < reach) & (tri[:, :, 1].max(1) < 1.7)
    tri, col = tri[keep], col[keep]
    nrm = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    nrm /= np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-12)
    shade = 0.55 + 0.45 * np.abs(nrm @ np.array([0.35, 0.85, 0.4]))
    X = C @ Rs.T + ps
    target = ps + [0, 0.45, 0]
    rows = []
    for eye in (target + [-1.5, 1.6, -1.9], target + [0.001, 4.0, 0.0]):
        z = target - eye; z /= np.linalg.norm(z)
        x = np.cross(z, [0, 1.0, 0]); x /= np.linalg.norm(x)
        cam = {"R": np.stack([x, np.cross(z, x), z]), "f": 0.8 * size * np.linalg.norm(target - eye) / reach, "cx": size / 2, "cy": size / 2, "k1": 0.0}
        cam["t"] = -cam["R"] @ eye
        px, depth = project(cam, tri)
        img = np.full((size, size, 3), 30, np.uint8)
        for i in np.argsort(-depth.mean(1)):                    # painter's algorithm
            if depth[i].min() > 0.2:
                cv2.fillConvexPoly(img, np.round(px[i] * 8).astype(np.int32), [int(v) for v in col[i] * shade[i]], lineType=cv2.LINE_AA, shift=3)
        both = img.copy()
        for q in M.hulls(cam, X):
            cv2.polylines(both, [np.round(q * 8).astype(np.int32)], True, (0, 0, 255), 2, lineType=cv2.LINE_AA, shift=3)
        rows.append(np.hstack([img, both]))
    cv2.imwrite(path, np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 90])
