"""Step 6 - write the web assets: public/reconstruction/<clip>/avatar/{subject-01.glb, avatar.json}.

The GLB is a standard skinned mesh with one baked animation in ROOM coordinates; the JSON sidecar
carries what the viewer needs without parsing the GLB (floor point, heading, evidence per frame)
and the measured accuracy of the reconstruction.
"""
import argparse, json, os
import numpy as np
import torch

from body import BODY_JOINTS, Body, rotmat_to_quat
from common import CAMS, load_json, public_dir, work_dir
from gltf_io import skin_from_glb, split_uv, vertex_normals, write_glb
from room import fit_floor, fit_lift, floor_point, sample_floor


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
    side = {
        "version": 1, "clip": a.clip, "subjectId": man["subjectId"], "personId": man["personId"],
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
    with open(os.path.join(out_dir, "avatar.json"), "w") as fh:
        json.dump(side, fh, separators=(",", ":"))
    print(f"wrote {glb} ({os.path.getsize(glb) / 1e6:.2f} MB, {nv} render vertices, textured={texture is not None}, clothed={has_shape})")
    print(f"GLB vs fitted surface: max abs difference {err * 1000:.4f} mm; valid frames {int(gap_ok.sum())}/{N}; stature {side['heightM']} m")


if __name__ == "__main__":
    main()
