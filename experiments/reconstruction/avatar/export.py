"""Step 6 - write the web assets: public/reconstruction/<clip>/avatar/{subject-01.glb, avatar.json}.

The GLB is a standard skinned mesh with one baked animation in ROOM coordinates; the JSON sidecar
carries what the viewer needs without parsing the GLB (floor point, heading, evidence per frame)
and the measured accuracy of the reconstruction. Version 2 of the sidecar adds

  projection  the refined cameras and, per cut-out, where its matte is authoritative, where the cut-out
              belongs on the body (register.py) and how much lighter or darker it shows each part of the
              body than the baked texture does (tone.py), so the viewer can put the footage of the shown
              frame back onto the body (3D + FOOTAGE look)
  props       rigid objects the person handles (prop_*.json from chair.py): pose per frame and, per
              camera and frame, whether that camera's matte contains the object and which of its
              pieces the matte really shows (register.py)
"""
import argparse, json, os
import numpy as np
import torch

from body import BODY_JOINTS, Body, rotmat_to_quat
from common import CAMS, H, W, load_cameras, load_json, public_dir, work_dir
from gltf_io import skin_from_glb, split_uv, write_glb
from masks import load_masks
from room import fit_floor, fit_lift, floor_point, sample_floor


def projection(clip, fit, masks):
    """What the viewer needs to put the footage of a frame back onto the body (FOOTAGE ON MODEL look):
    the refined cameras the body was fitted with, the lift between where the cameras see the body and
    where the viewer draws it, and per cut-out the rectangle in which its matte is authoritative."""
    cams = load_cameras(clip)
    N = len(fit["root_pos"])
    known = {}
    for ci, cam in enumerate(CAMS):
        rows = []
        for k in range(N):
            e = masks.get((ci, k))
            if e is None:
                rows.append(None)
            elif e["method"].startswith("sam2.1 ("):               # segmented on the whole frame, never clipped to a box
                rows.append([0, 0, W, H])
            else:
                rows.append([int(v) for v in e["known"]])
        known[cam] = rows
    out = {
        "frame": [W, H],
        # pixel centres at integer coordinates (the convention of every projection in this pipeline)
        "cameras": {c: {"f": round(float(cams[c]["f"]), 4), "cx": round(float(cams[c]["cx"]), 4), "cy": round(float(cams[c]["cy"]), 4),
                        "k1": float(cams[c]["k1"]), "dt": float(cams[c]["dt"]),
                        "R": np.round(cams[c]["R"], 8).tolist(), "t": np.round(cams[c]["t"], 6).tolist(),
                        "C": np.round(cams[c]["C"], 6).tolist()} for c in CAMS},
        "lift": np.round(fit_lift(fit), 4).tolist(),
        "known": known,
    }
    # where each cut-out belongs on the body (register.py): p_footage = c + s (p_body - c) + d in pixel centres
    # -> p_body = a p_footage + b in the pixel-edge coordinates of cropPx, a = 1 / s, b = c - (c + d) / s + (1 - a) / 2
    path = os.path.join(work_dir(clip), "register.json")
    if os.path.exists(path):
        from register import fingerprint
        reg = load_json(path)["cameras"]
        ident = lambda ci, k: fingerprint(masks[(ci, k)]) if (ci, k) in masks else None
        stale = [(cam, k) for ci, cam in enumerate(CAMS) for k in range(N) if ident(ci, k) != (reg[cam]["id"][k] if k < len(reg[cam]["id"]) else None)]
        if stale:
            raise SystemExit(f"register.json was measured on other cut-outs ({len(stale)} differ, e.g. {stale[:4]}): run register.py --clip {clip} first")
        register, use = {}, {}
        for cam in CAMS:
            rows = []
            for r in reg[cam]["register"][:N]:
                if r is None:
                    rows.append(None)
                else:
                    s, dx, dy, cx, cy = r
                    a = 1.0 / s
                    rows.append([round(a, 5), round(cx - (cx + dx) * a + 0.5 * (1 - a), 2), round(cy - (cy + dy) * a + 0.5 * (1 - a), 2)])
            register[cam] = rows
            use[cam] = reg[cam]["use"][:N]
        out["register"], out["use"] = register, use
        print("  footage registered to the body: " + ", ".join(
            f"{cam} {sum(r is not None for r in register[cam])} moved / {sum(u is False for u in use[cam])} not used" for cam in CAMS))
    else:
        print("  no register.json: the cut-outs are projected as filmed (run register.py)")
    # tone of each cut-out against the baked texture, per body part (tone.py): sqrt(linear) footage minus baked, RGB
    path = os.path.join(work_dir(clip), "tone.json")
    if os.path.exists(path):
        tone = load_json(path)
        rows = {cam: (tone["cameras"][cam]["tone"][:N] + [None] * N)[:N] for cam in CAMS}
        missing = [(cam, k) for ci, cam in enumerate(CAMS) for k in range(N) if (ci, k) in masks and rows[cam][k] is None]
        if missing:
            raise SystemExit(f"tone.json lacks {len(missing)} cut-outs (e.g. {missing[:4]}): run tone.py --clip {clip} first")
        scale = 0.001
        out["tone"] = {"parts": tone["parts"], "joints": tone["joints"], "scale": scale,
                       "cameras": {cam: [None if (ci, k) not in masks else [int(round(v / scale)) for part in rows[cam][k] for v in part] for k in range(N)]
                                   for ci, cam in enumerate(CAMS)}}
        print(f"  tone of the footage against the baked texture, {len(tone['parts'])} body parts: " + ", ".join(
            f"{cam} {np.median([np.mean(t) * scale for t in out['tone']['cameras'][cam] if t is not None]):+.3f}" for cam in CAMS))
    else:
        print("  no tone.json: the footage is compared and shown in the texture's own tone (run tone.py)")
    return out


def props(clip, wd, out_dir, masks, N):
    """Rigid objects the person handles (prop_*.json next to the fit, written by chair.py), with one flag per
    camera and frame: does that camera's matte contain the object? Only then may the viewer cut the
    object's outline to the matte; otherwise the matte is the person alone and says nothing about it.
    The segmentation records it in the cut-out's maskMethod ("...+carried:<kind>").

    Such a matte rarely has the whole object (the panels of the chair, but only part of its thin legs), so
    register.py also measured which pieces it shows: `pieces` names them (= the nodes of the GLB) and
    `cut[camera][frame]` has bit j set when the matte shows piece j. Next to that camera the viewer cuts
    those pieces to the matte and draws the others from the proxy; 0 = nothing is cut."""
    out = []
    reg_path = os.path.join(wd, "register.json")
    reg = load_json(reg_path) if os.path.exists(reg_path) else {}
    for name in sorted(os.listdir(wd)):
        if not (name.startswith("prop_") and name.endswith(".json")):
            continue
        p = load_json(os.path.join(wd, name))
        glb = os.path.join(public_dir(clip), p["glb"])
        if not os.path.exists(glb) or len(p["frames"]["pos"]) < N:
            print(f"  prop {p.get('id')}: no GLB at {glb} or too few frames, skipped")
            continue
        fr = p["frames"]
        kind = p.get("kind", "object")
        in_matte = {}
        for ci, cam in enumerate(CAMS):
            row = np.zeros(N, int)
            for k in range(N):
                e = masks.get((ci, k))
                row[k] = int(e is not None and f"carried:{kind}" in e["method"])
            # one flag per stretch of frames, not per frame: an outline that is cut in one frame and whole in
            # the next would flicker (stretches of up to 2 frames are closed / removed)
            r = row.copy()
            for k in range(1, N - 1):
                lo, hi = row[max(0, k - 2):k], row[k + 1:k + 3]
                if lo.all() and hi.all():
                    r[k] = 1
                elif not lo.any() and not hi.any():
                    r[k] = 0
            in_matte[cam] = r.tolist()
        entry = {"id": p["id"], "kind": kind, "glb": p["glb"],
                 "frames": {"pos": np.round(np.asarray(fr["pos"], float)[:N], 4).tolist(),
                            "quat": np.round(np.asarray(fr["quat"], float)[:N], 5).tolist(),
                            "lift": np.round(np.asarray(fr["lift"], float)[:N], 4).tolist(),
                            "held": [bool(b) for b in fr.get("held", [False] * N)[:N]],
                            "inMatte": in_matte}}
        for key in ("visible", "fitted"):
            if key in fr:
                entry["frames"][key] = [bool(b) for b in fr[key][:N]]
        names = reg.get("pieces", {}).get(kind)
        if names:
            shown = {cam: (reg["cameras"][cam].get("shown", {}).get(kind) or [])[:N] for cam in CAMS}
            entry["pieces"] = names
            entry["frames"]["cut"] = {cam: [int(b) if b is not None else 0 for b in shown[cam]] + [0] * (N - len(shown[cam])) for cam in CAMS}
        for key in ("dims", "metrics", "rest", "plain"):
            if key in p:
                entry[key] = p[key]
        out.append(entry)
        print(f"  prop {p['id']}: " + ", ".join(f"{c} matte has it in {int(np.sum(in_matte[c]))} frames" for c in CAMS))
        if names:
            full = (1 << len(names)) - 1
            print(f"    {len(names)} pieces; mattes that lack some of them: " + ", ".join(
                f"{c} {sum(0 < b < full for b in entry['frames']['cut'][c])} of {sum(b > 0 for b in entry['frames']['cut'][c])}" for c in CAMS))
        else:
            print("    no piece flags (run register.py): next to a camera the whole object is cut to its matte")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clip", default="clip02")
    ap.add_argument("--fit", default="fit.npz")
    a = ap.parse_args()
    wd = work_dir(a.clip)
    man = load_json(os.path.join(public_dir(a.clip), "manifest.json"))
    fit = np.load(os.path.join(wd, a.fit))
    body = Body()
    rest = body.rest(torch.tensor(fit["phen"]), torch.tensor(float(fit["scale"])))
    v, heads = rest["v"].numpy().copy(), rest["heads"].numpy()
    shape_path = os.path.join(wd, "shape.npz")
    has_shape = os.path.exists(shape_path)
    if has_shape:
        v = np.load(shape_path)["v"]
    tex_path = os.path.join(wd, "texture.jpg")
    texture = open(tex_path, "rb").read() if os.path.exists(tex_path) else None
    rot = fit["rot"]
    # the fit is where the cameras see the body; the viewer shows it standing on the scanned floor of
    # the room model, which is up to a few centimetres off that (Fitter.set_floor)
    root = fit["root_pos"].astype(np.float64)
    root[:, 1] += fit_lift(fit)
    root = root.astype(np.float32)
    N = rot.shape[0]
    aj = [body.idx[n] for n in BODY_JOINTS]
    quats = rotmat_to_quat(rot[:, aj])
    static = {j: rotmat_to_quat(rot[0, j]) for j in range(body.J) if j not in aj and not np.allclose(rot[0, j], np.eye(3), atol=1e-6)}
    out_dir = os.path.join(public_dir(a.clip), "avatar")
    os.makedirs(out_dir, exist_ok=True)
    glb = os.path.join(out_dir, "subject-01.glb")
    fps = float(man["fps"])
    nv = write_glb(glb, v=v, faces=body.faces.numpy(), uv=body.uv.numpy(), face_uv=body.face_uv.numpy(), w=body.w.numpy(),
                   wi=body.wi.numpy(), heads=heads, parents=body.parents, labels=body.labels, times=np.arange(N) / fps,
                   root_pos=root, quats=quats, anim_joints=aj, texture=texture, static_quats=static,
                   extras={"clip": a.clip, "subjectId": man["subjectId"], "source": "multi-view fit of an Anny body (Apache-2.0 / CC0)"})
    # prove the file reproduces the fitted surface
    with torch.no_grad():
        GR, Gp = body.fk(torch.tensor(rot[[N // 2]]), torch.tensor(root[[N // 2]]), rest["heads"])
        r2 = dict(rest); r2["v"] = torch.tensor(v, dtype=torch.float32)
        ref = body.skin(GR, Gp, r2)[0].numpy()
    vmap, _, _ = split_uv(body.faces.numpy(), body.face_uv.numpy())
    err = float(np.abs(skin_from_glb(glb, N // 2) - ref[vmap]).max())
    # sidecar
    w2d = fit["w2d"]                                   # (C, N, K)
    cams_n = (w2d.sum(-1) > 6.0).sum(0)
    floor = floor_point(fit["kp3"], root)
    fwd = rot[:, 0, :, 2]
    heading = np.arctan2(fwd[:, 0], fwd[:, 2])
    observed = cams_n >= 1
    # frames without a usable detection are carried by the temporal model as long as an observed frame
    # is at most 8 frames (0.53 s at 15 fps) away; anything further is not shown by the viewer
    obs = np.nonzero(observed)[0]
    gap_ok = np.array([np.abs(obs - k).min() <= 8 for k in range(N)])
    metrics = load_json(os.path.join(wd, "metrics.json")) if os.path.exists(os.path.join(wd, "metrics.json")) else None
    # height of the scanned room floor under the body, the floor the fit stood it on (refine.py / room.py);
    # 0 when the fit used the nominal plane
    floor_y = sample_floor(*fit_floor(fit), floor)
    masks = load_masks(a.clip)
    side = {
        "version": 2, "clip": a.clip, "subjectId": man["subjectId"], "personId": man["personId"],
        "glb": "avatar/subject-01.glb", "fps": fps, "t0": man["t0"], "t1": man["t1"], "frameCount": N,
        "heightM": round(float(v[:, 1].max() - v[:, 1].min()), 3),
        "textured": texture is not None, "clothed": has_shape,
        "frames": {"root": np.round(root, 4).tolist(), "floor": np.round(floor, 4).tolist(),
                   "heading": np.round(heading, 4).tolist(), "cameras": cams_n.astype(int).tolist(),
                   "valid": gap_ok.tolist(), "observed": observed.tolist(),
                   "floorY": np.round(floor_y, 4).tolist()},
    }
    if metrics:
        side["metrics"] = metrics
    side["projection"] = projection(a.clip, fit, masks)
    side["props"] = props(a.clip, wd, out_dir, masks, N)
    with open(os.path.join(out_dir, "avatar.json"), "w") as fh:
        json.dump(side, fh, separators=(",", ":"))
    print(f"wrote {glb} ({os.path.getsize(glb) / 1e6:.2f} MB, {nv} render vertices, textured={texture is not None}, clothed={has_shape})")
    print(f"GLB vs fitted surface: max abs difference {err * 1000:.4f} mm; valid frames {int(gap_ok.sum())}/{N}; stature {side['heightM']} m")


if __name__ == "__main__":
    main()
