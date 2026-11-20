"""Step 7 - measure the DELIVERED asset against every camera and every frame.

The export check evaluates the GLB the way a glTF viewer does (gltf_io.skin_from_glb: inverse bind
matrices, baked TRS keys, skin weights) and shows that it reproduces the fitted surface; the other
checks then compare that surface with the footage.

  export      every third animation key of the GLB vs the fitted surface (must be identical). The GLB
              is in room coordinates: each frame stands `lift` higher than the cameras see it, on the
              scanned floor (Fitter.set_floor); the image checks below use the body where the
              cameras see it, the ground check the body as the viewer shows it
  keypoints   model keypoints projected into each camera vs the RTMPose detections (px and cm). The
              detections saved by fit.py are already moved to the time of the frame (clock offset of
              the camera x image velocity), so they are compared with the body at that frame
  detectionsKept  of the confident detections that the keypoint-only fit explains within 1 sigma,
              how many the delivered body misses by more than 2 sigma: the silhouettes may refine a
              pose, they may not cost a detection
  silhouette  rasterised body vs the SAM 2 masks: IoU, recall (mask covered by the body) and
              precision (body inside the mask; drops where furniture hides the person)
  photometric the textured body re-rendered into each camera vs the footage, per camera
  temporal    one topology / texture for all frames, rigid bone lengths, frame-to-frame motion,
              joint limits and joint rates
  ground      shoes against the scanned floor under them, and how much a planted foot moves
  coverage    how much of the surface was ever observed (the rest is inferred, never measured)

Writes data/<clip>/avatar/metrics.json (embedded into avatar.json by export.py) and, with --sheet,
a contact sheet of footage / re-rendered body pairs.
"""
import argparse, json, os, time
from multiprocessing import Pool

import cv2
import numpy as np
import torch

from body import BODY_JOINTS, Body
from common import CAMS, clip_dir, load_cameras, load_json, project, public_dir, work_dir
from gltf_io import read_glb, skin_from_glb, split_uv
from masks import load_keypoints, load_masks
from posefit import ANKLE_HI, ANKLE_LO, HIP_TWIST, MAX_RATE, OKS, Rig, twist_angle
from preview import face_colors
from refine import creep_stats, foot_markers, planted_runs
from render import Poser, front_facing, raster_ids, raster_mask
from room import fit_floor, fit_lift, sample_floor, to_room
from shape import window

G = {}


def setup(clip):
    wd = work_dir(clip)
    fit = np.load(os.path.join(wd, "fit.npz"))
    body = Body()
    poser = Poser(body, fit)
    sp_ = os.path.join(wd, "shape.npz")
    v = np.load(sp_)["v"].astype(np.float64) if os.path.exists(sp_) else poser.v0
    tex = cv2.imread(os.path.join(wd, "texture.png"))
    tm = load_json(os.path.join(wd, "texture_metrics.json")) if os.path.exists(os.path.join(wd, "texture_metrics.json")) else None
    G.update(clip=clip, wd=wd, fit=fit, body=body, poser=poser, v=v, cams=load_cameras(clip), faces=body.faces.numpy(),
             masks=load_masks(clip, rgb=True), fps=float(load_json(os.path.join(public_dir(clip), "manifest.json"))["fps"]),
             face_rgb=face_colors(body, tex).astype(np.float32) if tex is not None else None, tm=tm)
    return G


def view_metrics(pair):
    """Silhouette + photometric agreement of one (camera, frame)."""
    ci, k = pair
    e = G["masks"][(ci, k)]
    cam = G["cams"][CAMS[ci]]
    faces = G["faces"]
    P = G["poser"].pose(k - cam["dt"] * G["fps"], G["v"])
    px, z = project(cam, P)
    if (z < 0.3).mean() > 0.5:
        return None
    pxs = np.nan_to_num(np.where((z > 0.3)[:, None], px, np.nan), nan=-1e4)
    ff, _ = front_facing(P, faces, cam["C"])
    sel = np.nonzero(ff & (z[faces] > 0.3).all(1))[0]
    (x0, y0, x1, y1), m, known = window(e, np.where((z > 0.3)[:, None], px, np.nan))
    S = raster_mask(pxs, faces[sel], m.shape, (x0, y0)) & known        # compared only where the mask is authoritative
    inter = float((S & m).sum()); union = float((S | m).sum())
    out = {"cam": ci, "k": k, "carried": bool(e["carried"]), "iou": inter / max(union, 1.0),
           "recall": inter / max(float(m.sum()), 1.0), "precision": inter / max(float(S.sum()), 1.0)}
    if G["face_rgb"] is not None:
        ids = raster_ids(pxs, z, faces[sel], m.shape, (x0, y0), face_ids=sel)
        # footage crop placed in the same window
        h, w = e["m"].shape
        foot = np.zeros(m.shape + (3,), np.float32)
        ax0, ay0 = max(e["x0"], x0), max(e["y0"], y0); ax1, ay1 = min(e["x0"] + w, x1), min(e["y0"] + h, y1)
        foot[ay0 - y0:ay1 - y0, ax0 - x0:ax1 - x0] = e["rgb"][ay0 - e["y0"]:ay1 - e["y0"], ax0 - e["x0"]:ax1 - e["x0"], ::-1]
        both = (ids >= 0) & (cv2.erode(m, np.ones((3, 3), np.uint8)) > 0)
        if both.sum() > 200:
            ren = G["face_rgb"][np.maximum(ids, 0)]
            g, o = G["gains"][ci], G["offs"][ci]
            # the texture lives in the cross-camera consensus colour space; bring the footage there
            fc = np.clip(foot * g[None, None] + o[None, None], 0, 255)
            d = np.abs(ren - fc)[both]
            out["mae"] = float(d.mean()); out["mse"] = float((d ** 2).mean()); out["npx"] = int(both.sum())
            if pair in G.get("sheet_pairs", ()):
                rr = np.zeros_like(foot); rr[ids >= 0] = ren[ids >= 0]
                out["tile"] = (np.clip(fc * (m[..., None] > 0), 0, 255).astype(np.uint8), rr.astype(np.uint8))
    return out


def stats(a):
    a = np.asarray(a, float)
    return {"n": int(len(a)), "median": round(float(np.median(a)), 4), "p10": round(float(np.percentile(a, 10)), 4),
            "p90": round(float(np.percentile(a, 90)), 4), "min": round(float(a.min()), 4)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clip", default="clip02")
    ap.add_argument("--procs", type=int, default=3)
    ap.add_argument("--sheet", default="")
    a = ap.parse_args()
    t0 = time.time()
    g = setup(a.clip)
    body, poser, fit, v, cams = g["body"], g["poser"], g["fit"], g["v"], g["cams"]
    N = poser.N
    fps = g["fps"]
    res = {"clip": a.clip, "frames": N, "fps": fps}

    # ---- export: every key of the GLB equals the fitted surface --------------------------------
    glb = os.path.join(public_dir(a.clip), "avatar", "subject-01.glb")
    vmap, _, _ = split_uv(body.faces.numpy(), body.face_uv.numpy())
    gltf, acc = read_glb(glb)
    worst = 0.0
    lift = fit_lift(fit)                              # the GLB is in room coordinates (export.py), the fit is not
    for k in range(0, N, 3):
        ref = poser.pose(k, v)[vmap].astype(np.float64)
        ref[:, 1] += lift[k]
        worst = max(worst, float(np.abs(skin_from_glb(glb, k) - ref).max()))
    prim = gltf["meshes"][0]["primitives"][0]
    res["export"] = {"glbBytes": os.path.getsize(glb), "renderVertices": int(acc(prim["attributes"]["POSITION"]).shape[0]),
                     "triangles": int(acc(prim["indices"]).shape[0] // 3), "animationKeys": N,
                     "maxDifferenceToFitMm": round(worst * 1000, 4), "keysChecked": len(range(0, N, 3))}

    # ---- keypoints ------------------------------------------------------------------------------
    reg = body.kp_reg.numpy().astype(np.float64)
    uv, w2d = fit["uv"], fit["w2d"]
    kp_res = {}
    raw = np.load(os.path.join(g["wd"], "kp2d.npz"))["kp"][:, :, :23, 2]
    _, boxes, _, hid = load_keypoints(a.clip, g["masks"])
    hidden = hid[:, :, :23] & (raw >= 2.5)                                     # confident detections that were not used
    bh = boxes[..., 3] - boxes[..., 1]
    sig = np.maximum(3.0, 0.02 * np.where(np.isfinite(bh), bh, 200.0)[..., None] * (OKS[None, None] / 0.07))   # px, as in fit.py
    r_fit = np.full(uv.shape[:3], np.nan)                                      # (C, N, K) residual in sigma
    for ci, c in enumerate(CAMS):
        cam = cams[c]
        epx, ecm = [], []
        for k in range(N):
            # `uv` are the detections moved to the time of frame k (fit.py shifts them by the clock offset
            # of the camera times their image velocity), so they are compared with the body AT frame k
            p, z = project(cam, reg @ poser.pose(k))
            d = np.linalg.norm(p - uv[ci, k], axis=1)
            r_fit[ci, k] = d / sig[ci, k]
            m = w2d[ci, k] > 0.5
            epx.append(d[m]); ecm.append((d * z / cam["f"] * 100)[m])
        epx, ecm = np.concatenate(epx), np.concatenate(ecm)
        kp_res[c] = {"n": int(len(epx)), "medianPx": round(float(np.median(epx)), 2), "p90Px": round(float(np.percentile(epx, 90)), 2),
                     "medianCm": round(float(np.median(ecm)), 2), "p90Cm": round(float(np.percentile(ecm, 90)), 2),
                     "detectionsNotOnTheVisiblePerson": int(hidden[ci].sum())}
    res["keypoints"] = kp_res
    # A silhouette must not cost a detection: of the confident detections that the keypoint-only fit
    # explains within 1 sigma, how many does the delivered body miss by more than 2 sigma? Confidence is
    # taken from the keypoint-only fit, i.e. before refine.py discounts face keypoints seen from behind.
    kf_path = os.path.join(g["wd"], "fit_keypoints.npz")
    if os.path.exists(kf_path):
        kf = np.load(kf_path)
        wk = kf["w2d"]
        r_kp = np.stack([np.linalg.norm(project(cams[c], kf["kp3"].astype(np.float64))[0] - uv[ci], axis=-1) for ci, c in enumerate(CAMS)]) / sig
        good = (wk >= 0.75) & (r_kp < 1.0)
        lost = good & (r_fit > 2.0)
        names = ["nose", "leftEye", "rightEye", "leftEar", "rightEar", "leftShoulder", "rightShoulder", "leftElbow", "rightElbow", "leftWrist",
                 "rightWrist", "leftHip", "rightHip", "leftKnee", "rightKnee", "leftAnkle", "rightAnkle", "leftBigToe", "leftSmallToe", "leftHeel",
                 "rightBigToe", "rightSmallToe", "rightHeel"]
        res["detectionsKept"] = {"confidentAndExplainedByKeypointFit": int(good.sum()), "missedByDeliveredBody": int(lost.sum()),
                                 "missedPerCamera": {c: int(lost[ci].sum()) for ci, c in enumerate(CAMS)},
                                 "missedByKeypoint": {names[j]: int(lost[:, :, j].sum()) for j in range(23) if lost[:, :, j].any()},
                                 "medianResidualSigma": {"keypointFit": round(float(np.median(r_kp[wk >= 0.75])), 2),
                                                         "delivered": round(float(np.median(r_fit[wk >= 0.75])), 2)}}

    # ---- silhouettes + photometric --------------------------------------------------------------
    tm = g["tm"]
    G["gains"] = np.array([tm["cameraGainsBGR"][c] for c in CAMS]) if tm else np.ones((4, 3))
    G["offs"] = np.array([tm["cameraOffsetsBGR"][c] for c in CAMS]) if tm else np.zeros((4, 3))
    pairs = sorted(g["masks"].keys())
    if a.sheet:
        per = {ci: [p for p in pairs if p[0] == ci] for ci in range(4)}
        G["sheet_pairs"] = set(per[ci][int(f * (len(per[ci]) - 1))] for ci in range(4) for f in (0.12, 0.3, 0.5, 0.7, 0.88))
    with Pool(a.procs) as pool:
        rows = [r for r in pool.imap_unordered(view_metrics, pairs, chunksize=8) if r is not None]
    sil, pho = {}, {}
    for ci, c in enumerate(CAMS):
        rc = [r for r in rows if r["cam"] == ci and not r["carried"]]
        sil[c] = {"views": len(rc), "iou": stats([r["iou"] for r in rc]), "recall": stats([r["recall"] for r in rc]),
                  "precision": stats([r["precision"] for r in rc])}
        rp = [r for r in rows if r["cam"] == ci and "mae" in r]
        if rp:
            npx = np.array([r["npx"] for r in rp], float)
            mse = float((np.array([r["mse"] for r in rp]) * npx).sum() / npx.sum())
            pho[c] = {"views": len(rp), "meanAbsError255": round(float((np.array([r["mae"] for r in rp]) * npx).sum() / npx.sum()), 2),
                      "psnrDb": round(float(10 * np.log10(255.0 ** 2 / mse)), 2)}
    res["silhouette"] = sil
    res["photometric"] = pho

    # ---- temporal consistency --------------------------------------------------------------------
    A, b = poser.A, poser.b
    rest = body.rest(torch.tensor(fit["phen"]), torch.tensor(float(fit["scale"])))
    heads = rest["heads"].numpy().astype(np.float64)
    J = np.einsum("njab,jb->nja", A, heads) + b                                  # joint positions per frame
    par = np.array([max(p, 0) for p in body.parents])
    bl = np.linalg.norm(J - J[:, par], axis=-1)
    Pall = np.stack([poser.pose(k, v) for k in range(N)])                        # (N, V, 3)
    step = np.linalg.norm(np.diff(Pall, axis=0), axis=-1)                        # (N-1, V)
    rot = fit["rot"][:, [body.idx[n] for n in BODY_JOINTS]].astype(np.float64)   # local rotations of the animated joints
    Rrel = np.einsum("njab,njcb->njac", rot[1:], rot[:-1])
    ang = np.degrees(np.arccos(np.clip((np.trace(Rrel, axis1=-2, axis2=-1) - 1) / 2, -1, 1)))
    root = fit["root_pos"].astype(np.float64)
    speed = np.linalg.norm(np.diff(root, axis=0), axis=1) * fps
    acc = np.linalg.norm(root[2:] - 2 * root[1:-1] + root[:-2], axis=1) * fps ** 2      # pelvis acceleration
    foot = fit["p_foot"].astype(np.float64)                                             # (N, 2, 3) ankle axis-angles
    over = np.maximum(foot - np.array(ANKLE_HI), 0) + np.maximum(np.array(ANKLE_LO) - foot, 0)
    hip_tw = np.stack([twist_angle(torch.tensor(fit["p_thigh"][:, i]), torch.tensor(heads[body.idx[s + "Leg"]] - heads[body.idx[s + "UpLeg"]], dtype=torch.float32)
                                   / float(np.linalg.norm(heads[body.idx[s + "Leg"]] - heads[body.idx[s + "UpLeg"]]))).numpy() for i, s in enumerate(("Left", "Right"))], 1)
    # rotation of each joint between consecutive frames relative to the fastest a person moves it (posefit.MAX_RATE)
    rig = Rig(body, rest)
    rate = [np.linalg.norm(np.diff(fit["p_" + k].astype(np.float64), axis=0), axis=-1).reshape(N - 1, -1) * fps / MAX_RATE[k] for k in ("spine", "neck", "clav", "arm", "thigh", "foot")]
    for k, joint in (("knee", "Leg"), ("elbow", "ForeArm")):
        hin = np.stack([rig.hinge_angle(rig.hinge[s + joint], torch.tensor(fit["p_" + k][:, i])).numpy() for i, s in enumerate(("Left", "Right"))], 1)
        rate.append(np.abs(np.diff(hin, axis=0)) * fps / MAX_RATE[k])
    rate = np.concatenate(rate, 1)                                                      # (N - 1, joints)
    cams_n = (w2d.sum(-1) > 6.0).sum(0)
    res["temporal"] = {
        "framesWithPose": int(N), "framesByNumberOfObservingCameras": {str(i): int((cams_n == i).sum()) for i in range(5)},
        "meshTopologyPerFrame": "identical (one skinned mesh, one texture)",
        "boneLengthMaxChangeMm": round(float((bl.max(0) - bl.min(0)).max() * 1000), 4),
        "rootSpeedMPerS": {"median": round(float(np.median(speed)), 2), "max": round(float(speed.max()), 2)},
        "rootAccelerationMPerS2": {"median": round(float(np.median(acc)), 2), "p95": round(float(np.percentile(acc, 95)), 2),
                                   "max": round(float(acc.max()), 2)},
        # ankle range of posefit (dorsi / plantar flexion, toes in / out, roll); 3 degrees of slack
        "ankleBeyondRange": {"frames": int((over.max(-1) > 0.05).any(1).sum()), "maxDeg": round(float(np.degrees(over.max())), 1)},
        # rotation of the thigh about its own axis (posefit.HIP_TWIST); 3 degrees of slack
        "hipTwistBeyondRange": {"frames": int((np.abs(hip_tw) > HIP_TWIST + 0.05).any(1).sum()), "maxDeg": round(float(np.degrees(np.abs(hip_tw).max())), 1),
                                "limitDeg": round(float(np.degrees(HIP_TWIST)), 1)},
        # frame-to-frame changes faster than the joint can move (10 % slack): pops, not motion
        "jointsFasterThanAPersonMoves": {"events": int((rate > 1.1).sum()), "fastestRelativeToLimit": round(float(rate.max()), 2)},
        "jointRotationPerFrameDeg": {"median": round(float(np.median(ang)), 2), "p99": round(float(np.percentile(ang, 99)), 2),
                                     "max": round(float(ang.max()), 2)},
        "fastestVertexPerFrameM": {"median": round(float(np.median(step.max(1))), 3), "max": round(float(step.max()), 3)},
    }

    # ---- ground ----------------------------------------------------------------------------------
    # heights are measured from the floor the fit used: the scanned room floor under each vertex
    # and in room coordinates, i.e. on the body as the viewer shows it (room.to_room)
    grid, origin = fit_floor(fit)
    Proom = to_room(fit, Pall)
    above = Proom[..., 1] - sample_floor(grid, origin, Proom[..., [0, 2]])       # (N, V)
    ymin = above.min(1)
    marks, _, _ = foot_markers(body, v)
    mc = np.stack([Proom[:, m.numpy()].mean(1) for m in marks], 1)               # (N, 4, 3) heel / ball of both feet
    mh = np.stack([above[:, m.numpy()].min(1) for m in marks], 1)
    fl = sample_floor(grid, origin, root[:, [0, 2]])
    res["ground"] = {
        "floor": "scanned room floor (height map)" if grid is not None else "plane y = 0",
        "floorUnderSubjectM": {"min": round(float(fl.min()), 4), "median": round(float(np.median(fl)), 4), "max": round(float(fl.max()), 4)},
        "lowestPointAboveFloorMm": {"min": round(float(ymin.min()) * 1000, 1), "p05": round(float(np.percentile(ymin, 5)) * 1000, 1),
                                    "median": round(float(np.median(ymin)) * 1000, 1), "max": round(float(ymin.max()) * 1000, 1)},
        "framesWithAPointMoreThan5MmBelowFloor": int((ymin < -0.005).sum()),
        # planted = heel or ball within 2 cm of the floor and slower than 1.5 cm per frame for >= 3 frames (refine.planted_runs)
        "plantedFoot": creep_stats(mc, planted_runs(mc, mh), N),
    }

    # ---- coverage --------------------------------------------------------------------------------
    if tm:
        res["coverage"] = {"surfaceObserved": tm["surfaceObserved"], "atlasTexelsObservedIn2PlusViews": tm["texelsObserved"],
                           "medianViewsPerTexel": tm["medianViewsPerTexel"], "views": tm["views"],
                           "note": "unobserved surface is filled from neighbouring / mirrored observed texture (inferred)"}
    res["subject"] = {"statureM": round(float(poser.v0[:, 1].max() - poser.v0[:, 1].min()), 3),
                      "heightWithShoesAndHairM": round(float(v[:, 1].max() - v[:, 1].min()), 3)}
    with open(os.path.join(g["wd"], "metrics.json"), "w") as fh:
        json.dump(res, fh, indent=1)
    print(json.dumps(res, indent=1))

    if a.sheet:
        tiles = []
        for r in sorted([r for r in rows if "tile" in r], key=lambda r: (r["cam"], r["k"])):
            f, m = r["tile"]
            s = 300.0 / max(f.shape[:2])
            pair = np.hstack([cv2.resize(x, None, fx=s, fy=s, interpolation=cv2.INTER_AREA) for x in (f, m)])
            canvas = np.full((310, 420, 3), 30, np.uint8)
            canvas[:pair.shape[0], :min(pair.shape[1], 420)] = pair[:, :420]
            cv2.putText(canvas, f"{CAMS[r['cam']]} k{r['k']} IoU {r['iou']:.2f}", (4, 304), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (0, 255, 255), 1)
            tiles.append(canvas)
        rows_ = [np.hstack(tiles[i:i + 5]) for i in range(0, len(tiles) - len(tiles) % 5, 5)]
        cv2.imwrite(a.sheet, np.vstack(rows_), [cv2.IMWRITE_JPEG_QUALITY, 88])
    print(f"validated in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
