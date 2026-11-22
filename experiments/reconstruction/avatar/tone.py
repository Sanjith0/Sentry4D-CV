"""Step 5e - tone of every footage cut-out against the baked texture (work dir: tone.json).

The baked texture holds ONE colour per point of the body for the whole clip. A camera films that point
lighter or darker at a given moment: the back of a person bending over a table is lit by the ceiling
lights, a person far away in front of the window is hazy, the camera adjusts its exposure. The 3D + FOOTAGE
look of the viewer needs that difference twice:

  * to judge whether a footage pixel "looks like the body at this point" before it is projected onto it
    (a wall seen through a gap in the matte does not, a hoodie filmed two stops lighter does), and
  * to give the baked fill next to the footage the tone of that footage, so that the parts no camera
    shows do not stand out as dark patches, and the pixels of two cameras meet in one tone.

The difference is not one number per view: in clip02 camera 1 films the back of the hoodie 0.2 lighter
than the texture holds it while he bends over the table, and his trousers 0.03 lighter. It is therefore
measured per BODY PART (PARTS: the bones of the rig, with fingers and toes counted to hand and foot).

Per cut-out the body with its baked texture is rendered into the camera (moved by the registration of
register.py, like the viewer moves the cut-out), and over the pixels that both the matte and the body
cover - not those of a carried object - the median, per part and channel, of

    sqrt(linear footage) - sqrt(linear baked)

is taken: an offset in the gamma 2 space the viewer's shader compares colours in. The fewer pixels a view
has of a part, the more it takes the value of its garment (GROUPS), and that of the whole body. Per camera
and part the series is then smoothed over time (median of 7 frames, mean of 7): the tone changes slowly,
and a single view may have something else in front of a part.

export.py copies the result into avatar.json (`projection.tone`); the viewer gives every vertex the tone
of its bones (skin weights), per camera.

    python tone.py --clip clip02          # ~20 s on 3 cores
"""
import argparse, json, os, time
from multiprocessing import Pool

import cv2
import numpy as np
from scipy.spatial.transform import Rotation as Rot

import chair_model as CM
import validate as V
from common import CAMS, load_json, project, work_dir
from register import carried
from render import front_facing, raster_ids

MIN_PX = 400                                   # a view with fewer common pixels is not measured (its neighbours carry it)
PART_PX = 60                                   # a part with this many pixels in a view is half its own median, half its garment's
MIN_PART_PX = 20                               # with fewer it is its garment's alone
ERODE_PX = 2                                   # matte and body are both known to a few pixels only
LIMIT = (-0.15, 0.32)                          # offsets outside this are not a tone, they are something in front
MEDIAN_N, MEAN_N = 7, 7                        # frames (15 per second)

# body parts: the bones of the rig; fingers and toes belong to hand and foot, the shoulder to the upper arm
PARTS = ["Hips", "LeftUpLeg", "LeftLeg", "LeftFoot", "RightUpLeg", "RightLeg", "RightFoot", "Spine", "Spine1", "Spine2",
         "LeftArm", "LeftForeArm", "LeftHand", "Neck", "Head", "RightArm", "RightForeArm", "RightHand"]
# what a part with too few pixels in a view falls back on: the parts of the same garment (then the whole body)
GROUPS = {"top": ["Spine", "Spine1", "Spine2", "LeftArm", "LeftForeArm", "RightArm", "RightForeArm", "Neck"],
          "bottom": ["LeftUpLeg", "LeftLeg", "RightUpLeg", "RightLeg"],
          "skin": ["Head", "LeftHand", "RightHand"],
          "shoes": ["LeftFoot", "RightFoot"]}


def part_of(label):
    """Bone label of the rig -> index into PARTS."""
    for side in ("Left", "Right"):
        if label.startswith(side + "Hand"):
            return PARTS.index(side + "Hand")
        if label in (side + "ToeBase", side + "Foot"):
            return PARTS.index(side + "Foot")
        if label == side + "Shoulder":
            return PARTS.index(side + "Arm")
    return PARTS.index(label)


P = {}


def gamma2(u8):
    """sRGB bytes -> sqrt(linear), the encoding the shader compares in."""
    c = np.asarray(u8, np.float32) / 255.0
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    return np.sqrt(lin)


def measure(key):
    """(camera index, frame) -> offsets RGB per part, how much of each is the part's own median (the rest: its garment's,
    the whole body's), common pixels, spread within a part (None when the view cannot be measured)."""
    ci, k = key
    G = V.G
    e = G["masks"][key]
    cam = G["cams"][CAMS[ci]]
    faces = G["faces"]
    kf = k - cam["dt"] * G["fps"]
    X = G["poser"].pose(kf, G["v"])
    px, z = project(cam, X)
    ok = z > 0.3
    if ok.mean() < 0.5:
        return key, None
    reg = P["register"].get(CAMS[ci], {}).get(k)
    if reg is not None:                                 # p_footage = c + s (p_model - c) + d
        s, dx, dy, cx, cy = reg
        px = np.array([cx, cy]) + s * (px - np.array([cx, cy])) + np.array([dx, dy])
    q = np.where(ok[:, None], px, -1e4)
    ff, _ = front_facing(X, faces, cam["C"])
    sel = np.nonzero(ff & ok[faces].all(1))[0]
    h, w = e["m"].shape
    x0, y0 = int(e["x0"]), int(e["y0"])
    ids = raster_ids(q, z, faces[sel], (h, w), (x0, y0), face_ids=sel)
    both = (ids >= 0) & (cv2.erode(e["m"].astype(np.uint8), np.ones((2 * ERODE_PX + 1,) * 2, np.uint8)) > 0)
    for kind, p in P["props"].items():                  # the carried object is in the matte, not in the body
        if f"carried:{kind}" in e["method"]:
            k0 = int(np.clip(np.floor(kf), 0, len(p["pos"]) - 2)); a = float(np.clip(kf - k0, 0, 1))
            R = Rot.from_rotvec((1 - a) * p["rot"][k0].as_rotvec() + a * p["rot"][k0 + 1].as_rotvec()) if a > 1e-6 else p["rot"][k0]
            T = (1 - a) * p["pos"][k0] + a * p["pos"][k0 + 1]
            Xp = R.apply(p["corners"].reshape(-1, 3)).reshape(-1, 8, 3) + T
            if (project(cam, Xp)[1] > 0.3).all():
                hulls = CM.hulls(cam, Xp)
                if reg is not None:
                    hulls = [np.array([cx, cy]) + s * (hh - np.array([cx, cy])) + np.array([dx, dy]) for hh in hulls]
                obj = CM.raster(hulls, (h, w), (x0, y0))
                both &= cv2.dilate(obj, np.ones((9, 9), np.uint8)) == 0
    n = int(both.sum())
    if n < MIN_PX:
        return key, {"n": n}
    d = gamma2(e["rgb"][both]) - gamma2(G["face_rgb"][ids[both]][:, ::-1])   # the texture is read as BGR
    part = P["face_part"][ids[both]]
    whole = np.median(d, 0)

    def shrunk(m, towards):
        """Median over the pixels m, drawn towards a wider estimate the fewer they are; share of its own median."""
        c = int(m.sum())
        if c < MIN_PART_PX:
            return towards, 0.0
        w = c / (c + PART_PX)
        return w * np.median(d[m], 0) + (1 - w) * towards, w

    group = {g: shrunk(np.isin(part, [PARTS.index(p) for p in names]), whole)[0] for g, names in GROUPS.items()}
    group_of = {p: g for g, names in GROUPS.items() for p in names}
    off, own = [], []
    for j, name in enumerate(PARTS):
        v, w = shrunk(part == j, group.get(group_of.get(name), whole))
        off.append(np.asarray(v, float).tolist())
        own.append(round(w, 2))
    return key, {"n": n, "whole": whole.tolist(), "off": off, "own": own, "spread": float(np.median(np.abs(d - np.asarray(off)[part])))}


def smooth(series):
    """One camera: {frame: offsets (PARTS, 3)} -> {frame: smoothed offsets}, over the frames that have a measurement."""
    ks = sorted(series)
    if not ks:
        return {}
    val = np.array([series[k] for k in ks])
    kk = np.array(ks)
    med = np.empty_like(val)
    for i, k in enumerate(ks):
        med[i] = np.median(val[np.abs(kk - k) <= MEDIAN_N // 2], 0)
    return {k: np.clip(med[np.abs(kk - k) <= MEAN_N // 2].mean(0), *LIMIT) for k in ks}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clip", default="clip02")
    ap.add_argument("--procs", type=int, default=3)
    a = ap.parse_args()
    t0 = time.time()
    cv2.setNumThreads(1)
    G = V.setup(a.clip)
    if G["face_rgb"] is None:
        raise SystemExit("no baked texture (run texture.py first)")
    wd = work_dir(a.clip)
    reg_path = os.path.join(wd, "register.json")
    reg = load_json(reg_path)["cameras"] if os.path.exists(reg_path) else {}
    P["register"] = {cam: {k: r for k, r in enumerate(reg[cam]["register"]) if r is not None} for cam in reg}
    P["props"] = carried(a.clip)
    body = G["body"]
    joints = [part_of(label) for label in body.labels]           # in the order of the GLB's skin joints
    dom = body.w_dense.numpy().argmax(1)                         # the bone that moves a vertex most
    P["face_part"] = np.asarray(joints)[dom][G["faces"][:, 0]]
    keys = sorted(G["masks"].keys())
    with Pool(a.procs) as pool:
        rows = dict(pool.imap_unordered(measure, keys, chunksize=8))
    N = G["poser"].N
    out = {"space": "sqrt(linear sRGB), footage minus baked, RGB", "parts": PARTS, "joints": joints, "cameras": {}}
    zero = np.zeros((len(PARTS), 3))
    for ci, cam in enumerate(CAMS):
        views = [k for (c, k) in keys if c == ci]
        got = {k: rows[(ci, k)]["off"] for k in views if rows[(ci, k)] and "off" in rows[(ci, k)]}
        sm = smooth(got)
        ks = sorted(sm)
        tone = [None] * N
        for k in views:                                 # a view that could not be measured takes the nearest one that could
            j = min(ks, key=lambda kk: abs(kk - k)) if ks else None
            tone[k] = np.round(sm[j] if j is not None and abs(j - k) <= 15 else zero, 3).tolist()
        raw = [None] * N
        for k in views:
            r = rows[(ci, k)]
            raw[k] = None if not r else {"n": r["n"], **({"whole": np.round(r["whole"], 4).tolist(), "off": np.round(r["off"], 4).tolist(),
                                                           "own": r["own"], "spread": round(r["spread"], 4)} if "off" in r else {})}
        out["cameras"][cam] = {"tone": tone, "raw": raw}
        if ks:
            v = np.array([sm[k] for k in ks]).mean(2)   # (frames, parts): mean of RGB
            own = np.array([rows[(ci, k)]["own"] for k in ks])
            top = [PARTS.index(p) for p in ("Spine", "Spine1", "Spine2")]
            legs = [PARTS.index(p) for p in GROUPS["bottom"]]
            print(f"  {cam}: {len(views)} views, {len(got)} measured; a part's value is its own median to {100 * own.mean():.0f} % "
                  f"(none of it in {100 * (own == 0).mean():.0f} % of parts x views); offset (mean of RGB) torso median "
                  f"{np.median(v[:, top]):+.3f} (p5 {np.percentile(v[:, top], 5):+.3f}, p95 {np.percentile(v[:, top], 95):+.3f}), legs median "
                  f"{np.median(v[:, legs]):+.3f} (p5 {np.percentile(v[:, legs], 5):+.3f}, p95 {np.percentile(v[:, legs], 95):+.3f}); "
                  f"spread within a part median {np.median([rows[(ci, k)]['spread'] for k in ks]):.3f}")
    with open(os.path.join(wd, "tone.json"), "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    print(f"wrote {os.path.join(wd, 'tone.json')} in {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
