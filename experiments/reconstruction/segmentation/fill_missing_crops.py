"""Fill the holes in the footage cut-outs of a clip WITHOUT re-running export_sprites.py.

export_sprites.py starts with shutil.rmtree(public/reconstruction/<clip>) and so cannot be used to
add frames (the avatar assets in that folder cannot be regenerated everywhere). This script only
ADDS  public/reconstruction/<clip>/<cam>/NNNN.webp + NNNN_d.png  for frames that have no cut-out
and updates the matching entries of public/reconstruction/<clip>/manifest.json (atomic write).
It never touches an existing crop file, except with `write --replace` (repair of a broken original
cut-out): the original webp, depth png and manifest entry are first copied to
data/matte_work/replaced/<cam>/ ($MATTE_WORK) and `check` refuses any changed original without that backup.

How the masks are made
  SAM 2.1 video predictor, seeded with EXISTING mattes (mask prompts on the frames next to a hole)
  and propagated into the hole. To get tighter edges than a full 1920x1080 frame squeezed into
  SAM's 1024x1024 input, each job runs on a fixed region of interest (ROI) of the frame around
  the person's path. Hard frames get extra point prompts / corrected masks (job spec).
  Work data: data/<clip>/matte_fill/masks/<cam>/NNNN.png  (full-frame mask, 255 = person [+chair]).

Commands (run from experiments/reconstruction):
  body                      projected avatar-body statistics per camera/frame -> matte_fill/body.npz
  run   --job jobs.json:id[,id2,...]  propagate jobs (see JOB SPEC)         -> matte_fill/masks[_variant]/
  adopt --cam cam1 --ks 273-277 --variant x   clean a trial run's masks and make them final (masks/)
  sheet --cam cam1 --ks 271-315 [--out x.jpg]   contact sheet (magenta) incl. existing neighbours
  zoom  --cam cam1 --ks 273-276 --scale 2       raw | outline | cut-out per frame, full resolution
  write --cam cam1 --ks 273-313 [--carried chair:273-313] --seed 272   export files + manifest
  check                     diff public manifest against the backup: only intended entries changed

JOB SPEC (json: {"<id>": {...}}):
  cam, k0, k1 (inclusive frame range loaded), roi [x0,y0,x1,y1], model "l" | "b+",
  seeds   [k, ...]                   existing mattes used as mask prompts
  masks   {"k": "path.png"}          extra full-frame mask prompts (corrected frames)
  points  {"k": [[x, y, label], ..]} full-frame point prompts (1 = person/chair, 0 = background)
  reverse true|false                 propagate backwards from the last prompt as well / instead
  out     [k, ...] or "a-b"          frames whose masks are saved (default: all without a crop)
  variant "x"                        save to matte_fill/masks_x/ (trial; merged into masks/ by `merge`)
  raw     true                       save SAM's mask without cleanup
"""
import argparse, json, os, shutil, sys, time

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.abspath(os.path.join(HERE, ".."))
ROOT = os.path.abspath(os.path.join(BASE, "..", ".."))
MODELS = os.environ.get("SAM2_CHECKPOINTS", os.path.join(BASE, "checkpoints"))      # sam2.1_hiera_{base_plus,large}.pt
WORK = os.environ.get("MATTE_WORK", os.path.join(BASE, "data", "matte_work"))       # backups of replaced originals, review sheets
SAM = {
    "b+": ("configs/sam2.1/sam2.1_hiera_b+.yaml", os.path.join(MODELS, "sam2.1_hiera_base_plus.pt")),
    "l": ("configs/sam2.1/sam2.1_hiera_l.yaml", os.path.join(MODELS, "sam2.1_hiera_large.pt")),
}
CAMS = ["cam1", "cam2", "cam3", "cam4"]
W, H = 1920, 1080
MARGIN = 12  # export_sprites.py --margin default
MAGENTA = (180, 60, 180)  # BGR


# ----------------------------------------------------------------------------- paths / io
def clip_dir(clip):
    return os.path.join(BASE, "data", clip)


def pub_dir(clip):
    return os.path.join(ROOT, "public", "reconstruction", clip)


def work_dir(clip):
    d = os.path.join(clip_dir(clip), "matte_fill")
    os.makedirs(d, exist_ok=True)
    return d


def frame_path(clip, cam, k):
    return os.path.join(clip_dir(clip), "frames", cam, f"{k:04d}.png")


def mask_path(clip, cam, k, variant=""):
    """Final masks live in masks/; trial runs (job "variant": "x") in masks_x/ until merged by hand."""
    return os.path.join(work_dir(clip), "masks" + ("_" + variant if variant else ""), cam, f"{k:04d}.png")


def load_pub_manifest(clip):
    with open(os.path.join(pub_dir(clip), "manifest.json")) as fh:
        return json.load(fh)


def existing_mask(clip, entry):
    """Full-frame uint8 {0,1} mask of an existing cut-out (alpha > 0.5), or None."""
    if not entry.get("file"):
        return None
    im = cv2.imread(os.path.join(pub_dir(clip), entry["file"]), cv2.IMREAD_UNCHANGED)
    x0, y0, x1, y1 = entry["cropPx"]
    m = np.zeros((H, W), np.uint8)
    m[y0:y1, x0:x1] = (im[..., 3] > 127).astype(np.uint8)
    return m


def new_mask(clip, cam, k, variant=""):
    p = mask_path(clip, cam, k, variant)
    if not os.path.exists(p):
        return None
    return (cv2.imread(p, cv2.IMREAD_GRAYSCALE) > 127).astype(np.uint8)


def parse_ks(s):
    """'273-313,278' -> sorted list (ranges inclusive)."""
    if isinstance(s, (list, tuple)):
        return sorted(int(x) for x in s)
    out = set()
    for part in str(s).split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-")
            out.update(range(int(a), int(b) + 1))
        else:
            out.add(int(part))
    return sorted(out)


# ----------------------------------------------------------------------------- projected body
_BODY = {}


def body_tools(clip):
    if clip not in _BODY:
        sys.path.insert(0, os.path.join(BASE, "avatar"))
        cwd = os.getcwd()
        os.chdir(os.path.join(BASE, "avatar"))
        try:
            from common import load_cameras, project
            from body import Body
            from render import Poser, raster_mask

            fit = np.load(os.path.join(clip_dir(clip), "avatar", "fit.npz"))
            v = np.load(os.path.join(clip_dir(clip), "avatar", "shape.npz"))["v"]
            body = Body()
            _BODY[clip] = dict(poser=Poser(body, fit), v=v, cams=load_cameras(clip), faces=body.faces.numpy(), project=project, raster=raster_mask)
        finally:
            os.chdir(cwd)
    return _BODY[clip]


def body_mask(clip, cam, k, window=(0, 0, W, H)):
    """Silhouette of the fitted 3D body in camera `cam` at frame k inside window (x0, y0, x1, y1)."""
    t = body_tools(clip)
    c = t["cams"][cam]
    P = t["poser"].pose(k - c["dt"] * 15, t["v"])
    px, z = t["project"](c, P)
    faces = t["faces"]
    ok = (z[faces] > 0.15).all(1)  # triangles in front of the camera only
    x0, y0, x1, y1 = window
    px = np.clip(px, -20000, 20000)
    return t["raster"](px, faces[ok], (y1 - y0, x1 - x0), origin=(x0, y0)), float(ok.mean())


def cmd_body(a):
    """Per camera / frame: body silhouette area in the frame, fraction of the whole silhouette that is
    inside the frame, bounding box inside the frame."""
    n = load_pub_manifest(a.clip)["frameCount"]
    big = (-1500, -1000, W + 1500, H + 2500)
    area = np.zeros((4, n), np.int64); frac = np.zeros((4, n)); bbox = np.zeros((4, n, 4), np.int32); front = np.zeros((4, n))
    for ci, cam in enumerate(CAMS):
        for k in range(n):
            m, fr = body_mask(a.clip, cam, k, big)
            inside = m[-big[1]:-big[1] + H, -big[0]:-big[0] + W]
            area[ci, k] = int(inside.sum()); frac[ci, k] = inside.sum() / max(1, m.sum()) * fr; front[ci, k] = fr
            ys, xs = np.nonzero(inside)
            if len(xs):
                bbox[ci, k] = [xs.min(), ys.min(), xs.max() + 1, ys.max() + 1]
        print(cam, "frames with body area >= 1500 px:", int((area[ci] >= 1500).sum()))
    np.savez(os.path.join(work_dir(a.clip), "body.npz"), area=area, frac=frac, bbox=bbox, front=front)


# ----------------------------------------------------------------------------- mask cleanup
def clean(m, keep_near=9, min_part=25, close=3, max_hole=40):
    """Conservative cleanup (never adds image content beyond a 3x3 closing): keep the largest
    component + components of >= min_part px within keep_near px of it (a chair leg cut off by a
    hand), drop specks, fill interior holes of <= max_hole px (noise). Larger holes are real
    see-through (floor between an arm and the body, between the chair's legs) and stay open.
    export_sprites.clean filled every hole and closed 5x5, which glues floor into such gaps."""
    m = (m > 0).astype(np.uint8)
    if close:
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((close, close), np.uint8))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m, 8)
    if n <= 1:
        return np.zeros_like(m)
    big = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    keep = (lab == big).astype(np.uint8)
    near = cv2.dilate(keep, np.ones((2 * keep_near + 1, 2 * keep_near + 1), np.uint8))
    for i in range(1, n):
        if i != big and stats[i, cv2.CC_STAT_AREA] >= min_part and (near[lab == i] > 0).any():
            keep[lab == i] = 1
    pad = cv2.copyMakeBorder((1 - keep).astype(np.uint8), 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=1)
    cv2.floodFill(pad, None, (0, 0), 2)
    holes = (pad[1:-1, 1:-1] == 1).astype(np.uint8)
    nh, hl, hs, _ = cv2.connectedComponentsWithStats(holes, 4)
    for i in range(1, nh):
        if hs[i, cv2.CC_STAT_AREA] <= max_hole:
            keep[hl == i] = 1
    return keep


def cmd_adopt(a):
    """Take the (raw) masks of a trial variant for the given frames, clean them, save to masks/."""
    os.makedirs(os.path.dirname(mask_path(a.clip, a.cam, 0)), exist_ok=True)
    for k in parse_ks(a.ks):
        m = new_mask(a.clip, a.cam, k, a.variant)
        assert m is not None, (a.cam, k, a.variant)
        c = clean(m, keep_near=a.keep_near, min_part=a.min_part)
        cv2.imwrite(mask_path(a.clip, a.cam, k), c * 255)
        print(f"  {a.cam} k{k}: {a.variant} area {int(m.sum())} -> {int(c.sum())}")


# ----------------------------------------------------------------------------- SAM 2 propagation
def cmd_run(a):
    import torch

    torch.set_num_threads(a.threads)
    from sam2.build_sam import build_sam2_video_predictor

    path, ids = a.job.rsplit(":", 1)
    jobs = json.load(open(path))
    preds = {}
    for jid in ids.split(","):  # several jobs share one loaded model
        job = jobs[jid]
        model = job.get("model", "l")
        if model not in preds:
            preds.clear()
            preds[model] = build_sam2_video_predictor(*SAM[model], device="cpu")
        run_job(a, jid, job, preds[model], torch)


def run_job(a, jid, job, pred, torch):
    cam, k0, k1 = job["cam"], int(job["k0"]), int(job["k1"])
    rx0, ry0, rx1, ry1 = job.get("roi", [0, 0, W, H])
    man = load_pub_manifest(a.clip)
    entries = man["cameras"][cam]["frames"]
    ks = list(range(k0, k1 + 1))
    out_ks = parse_ks(job["out"]) if job.get("out") else [k for k in ks if not entries[k].get("file")]
    jdir = os.path.join(work_dir(a.clip), "_jpg", jid)
    shutil.rmtree(jdir, ignore_errors=True)
    os.makedirs(jdir)
    for i, k in enumerate(ks):
        img = cv2.imread(frame_path(a.clip, cam, k))[ry0:ry1, rx0:rx1]
        cv2.imwrite(os.path.join(jdir, f"{i:05d}.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, 95])
    t0 = time.time()
    variant = job.get("variant", "")
    os.makedirs(os.path.dirname(mask_path(a.clip, cam, 0, variant)), exist_ok=True)
    prompts = []
    with torch.inference_mode():
        state = pred.init_state(video_path=jdir, offload_video_to_cpu=True, offload_state_to_cpu=True)
        for k in job.get("seeds", []):
            m = existing_mask(a.clip, entries[k])
            assert m is not None, f"seed {cam} k{k} has no cut-out"
            pred.add_new_mask(state, frame_idx=k - k0, obj_id=1, mask=m[ry0:ry1, rx0:rx1].astype(bool))
            prompts.append(k)
        for k, p in (job.get("masks") or {}).items():
            m = (cv2.imread(p if os.path.isabs(p) else os.path.join(work_dir(a.clip), p), cv2.IMREAD_GRAYSCALE) > 127)
            pred.add_new_mask(state, frame_idx=int(k) - k0, obj_id=1, mask=m[ry0:ry1, rx0:rx1])
            prompts.append(int(k))
        for k, pts in (job.get("points") or {}).items():
            pts = np.array(pts, np.float32)
            xy = pts[:, :2] - np.array([rx0, ry0], np.float32)
            pred.add_new_points_or_box(state, frame_idx=int(k) - k0, obj_id=1, points=xy, labels=pts[:, 2].astype(np.int32))
            prompts.append(int(k))
        print(f"{jid}: {cam} k{k0}-{k1} roi {rx0},{ry0},{rx1},{ry1} model {job.get('model', 'l')} prompts {sorted(prompts)}; loaded in {time.time() - t0:.0f}s", flush=True)
        got = {}
        passes = [False, True] if job.get("reverse") == "both" else [bool(job.get("reverse"))]
        for rev in passes:
            for fi, _, logits in pred.propagate_in_video(state, reverse=rev):
                k = k0 + fi
                lg = logits[0, 0].cpu().numpy()
                if k in got and k not in prompts:
                    # both directions reached this frame: keep the one propagated from the nearer prompt
                    d_old = min(abs(k - p) for p in prompts if (p <= k) != got[k][1]) if any((p <= k) != got[k][1] for p in prompts) else 1e9
                    d_new = min(abs(k - p) for p in prompts if (p <= k) != rev) if any((p <= k) != rev for p in prompts) else 1e9
                    if d_new >= d_old:
                        continue
                got[k] = (lg, rev)
                print(f"  k{k} {'rev' if rev else 'fwd'} area {(lg > 0).sum()} t={time.time() - t0:.0f}s", flush=True)
        pred.reset_state(state)
    for k, (lg, _) in sorted(got.items()):
        if k not in out_ks:
            continue
        full = np.zeros((H, W), np.uint8)
        full[ry0:ry1, rx0:rx1] = (lg > 0).astype(np.uint8)
        cv2.imwrite(mask_path(a.clip, cam, k, variant), (full if job.get("raw") else clean(full)) * 255)
    shutil.rmtree(jdir, ignore_errors=True)
    print(f"{jid}: wrote {len([k for k in got if k in out_ks])} masks in {time.time() - t0:.0f}s")


# ----------------------------------------------------------------------------- contact sheets
def cutout_tile(img, m, label, pad=MARGIN, scale=1.0, body=None, color=(0, 255, 255), size=None):
    """Crop of the frame on magenta with the export's alpha (mask blurred sigma 1.2)."""
    ys, xs = np.nonzero(m)
    if not len(xs):
        t = np.full((120, 120, 3), MAGENTA, np.uint8)
        cv2.putText(t, label, (4, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1, cv2.LINE_AA)
        return t
    x0, x1 = max(0, xs.min() - pad), min(W, xs.max() + pad + 1)
    y0, y1 = max(0, ys.min() - pad), min(H, ys.max() + pad + 1)
    if size is not None:  # fixed window
        x0, y0, x1, y1 = size
    al = cv2.GaussianBlur(m.astype(np.float32), (0, 0), 1.2)[y0:y1, x0:x1, None]
    t = (img[y0:y1, x0:x1] * al + np.array(MAGENTA, np.float32) * (1 - al)).astype(np.uint8)
    if body is not None:
        cnts, _ = cv2.findContours(body[y0:y1, x0:x1], cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        cv2.drawContours(t, cnts, -1, (0, 255, 0), 1)
    if scale != 1.0:
        t = cv2.resize(t, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC if scale > 1 else cv2.INTER_AREA)
    cv2.putText(t, label, (4, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 3, cv2.LINE_AA)
    cv2.putText(t, label, (4, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1, cv2.LINE_AA)
    return t


def pack(tiles, width=1900, gap=4):
    rows, row, rw = [], [], 0
    for t in tiles:
        if row and rw + t.shape[1] + gap > width:
            rows.append(row); row, rw = [], 0
        row.append(t); rw += t.shape[1] + gap
    if row:
        rows.append(row)
    out = []
    for row in rows:
        hh = max(t.shape[0] for t in row)
        canvas = np.full((hh + gap, width, 3), 30, np.uint8)
        x = 0
        for t in row:
            canvas[: t.shape[0], x : x + t.shape[1]] = t[:, : max(0, width - x)]
            x += t.shape[1] + gap
        out.append(canvas)
    return np.vstack(out)


def cmd_sheet(a):
    man = load_pub_manifest(a.clip)
    entries = man["cameras"][a.cam]["frames"]
    orig = json.load(open(a.backup))["cameras"][a.cam]["frames"] if os.path.exists(a.backup) else None
    tiles = []
    for k in parse_ks(a.ks):
        if not (0 <= k < len(entries)):
            continue
        img = cv2.imread(frame_path(a.clip, a.cam, k))
        ex = existing_mask(a.clip, entries[k])
        nm = new_mask(a.clip, a.cam, k, a.variant)
        added = orig is not None and orig[k].get("file") is None  # no cut-out before this script ran
        if ex is not None and not (a.prefer_new and nm is not None):  # what is in public/ now
            m, lab, col = ex, (f"k{k} NEW" if added else f"k{k} existing"), ((0, 255, 255) if added else (255, 255, 255))
            if orig is not None and orig[k].get("file") and orig[k] != entries[k]:  # original cut-out replaced by this script
                lab, col = f"k{k} REPAIRED", (120, 255, 120)
        elif nm is not None:
            m, lab, col = nm, f"k{k} new(unwritten) {int(nm.sum())}", (0, 255, 255)
        else:
            continue
        body = body_mask(a.clip, a.cam, k)[0] if a.body else None
        t = cutout_tile(img, m, lab, scale=a.scale, body=body, color=col)
        if t.shape[1] < 130:  # room for the label on slivers at the frame edge
            t = cv2.copyMakeBorder(t, 0, 0, 0, 130 - t.shape[1], cv2.BORDER_CONSTANT, value=(60, 60, 60))
            cv2.putText(t, lab, (4, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 3, cv2.LINE_AA)
            cv2.putText(t, lab, (4, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.5, col, 1, cv2.LINE_AA)
        tiles.append(t)
    out = a.out or os.path.join(WORK, "review", f"{a.cam}_{a.ks.replace(',', '_')}.jpg")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    cv2.imwrite(out, pack(tiles, a.width), [cv2.IMWRITE_JPEG_QUALITY, a.quality])
    print("wrote", out, len(tiles), "tiles")


def cmd_zoom(a):
    """Full-resolution check of single frames: raw footage with the mask outline (yellow; projected body
    green) next to the cut-out on magenta, in one fixed window per frame."""
    man = load_pub_manifest(a.clip)
    entries = man["cameras"][a.cam]["frames"]
    tiles = []
    for k in parse_ks(a.ks):
        img = cv2.imread(frame_path(a.clip, a.cam, k))
        ex = existing_mask(a.clip, entries[k])
        nm = new_mask(a.clip, a.cam, k, a.variant)
        m = nm if (nm is not None and (ex is None or a.prefer_new)) else ex
        if m is None:
            m = np.zeros((H, W), np.uint8)
        tag = "EXISTING" if m is ex else "new"
        if a.win:
            x0, y0, x1, y1 = [int(v) for v in a.win.split(",")]
        else:
            ys, xs = np.nonzero(m)
            x0, x1 = max(0, xs.min() - 30), min(W, xs.max() + 31)
            y0, y1 = max(0, ys.min() - 30), min(H, ys.max() + 31)
        raw = img[y0:y1, x0:x1].copy()
        raw = cv2.resize(raw, None, fx=a.scale, fy=a.scale, interpolation=cv2.INTER_CUBIC)
        ov = raw.copy()
        for mm, col in ((body_mask(a.clip, a.cam, k)[0] if a.body else None, (0, 255, 0)), (m, (0, 255, 255))):
            if mm is None:
                continue
            big = cv2.resize(mm[y0:y1, x0:x1], None, fx=a.scale, fy=a.scale, interpolation=cv2.INTER_NEAREST)
            cnts, _ = cv2.findContours(big, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
            cv2.drawContours(ov, cnts, -1, col, 1)
        cut = cutout_tile(img, m, f"{a.cam} k{k} {tag}", scale=a.scale, size=(x0, y0, x1, y1), color=(255, 255, 255) if tag == "EXISTING" else (0, 255, 255))
        cv2.putText(raw, f"k{k} raw  win {x0},{y0}", (4, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1, cv2.LINE_AA)
        tiles += [raw, ov, cut] if not a.compact else [ov, cut]
    out = a.out or os.path.join(WORK, f"zoom_{a.cam}_{a.ks.replace(',', '_')}.jpg")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    cv2.imwrite(out, pack(tiles, a.width), [cv2.IMWRITE_JPEG_QUALITY, a.quality])
    print("wrote", out)


# ----------------------------------------------------------------------------- export (== export_sprites.py 261-307)
def export_frame(clip, cam, k, m, f, method, dry=False, own=False):
    """Write <cam>/NNNN.webp + NNNN_d.png exactly like export_sprites.py and return the manifest entry.
    f = the frame's row in data/<clip>/manifest.json. Refuses to overwrite an existing file (own=True:
    the caller has verified against the backup manifest that this script created the file)."""
    out = pub_dir(clip)
    img = cv2.imread(frame_path(clip, cam, k))
    h, w = img.shape[:2]
    m = (m > 0).astype(np.uint8)
    area = int(m.sum())
    ys, xs = np.nonzero(m)
    x0, x1 = max(0, xs.min() - MARGIN), min(w, xs.max() + MARGIN + 1)
    y0, y1 = max(0, ys.min() - MARGIN), min(h, ys.max() + MARGIN + 1)
    alpha = cv2.GaussianBlur(m.astype(np.float32) * 255, (0, 0), 1.2)
    rgba = np.dstack([img, alpha.clip(0, 255).astype(np.uint8)])[y0:y1, x0:x1]
    name = f"{k:04d}.webp"
    mc = m[y0:y1, x0:x1].astype(np.uint8)
    dist = np.clip(cv2.distanceTransform(mc, cv2.DIST_L2, 5) - 2.0, 0, None)
    r0 = float(dist.max()) or 1.0
    hgt = np.sqrt(np.clip(2 * r0 * dist - dist * dist, 0, None))
    hgt = cv2.GaussianBlur(hgt, (0, 0), max(1.0, r0 * 0.06)) * (dist > 0)
    hmax = float(hgt.max()) or 1.0
    dname = f"{k:04d}_d.png"
    if not dry:
        for n_ in (name, dname):
            assert own or not os.path.exists(os.path.join(out, cam, n_)), f"refusing to overwrite {cam}/{n_}"
        cv2.imwrite(os.path.join(out, cam, name), rgba, [cv2.IMWRITE_WEBP_QUALITY, 92])
        cv2.imwrite(os.path.join(out, cam, dname), (hgt / hmax * 255).clip(0, 255).astype(np.uint8))
    mean_bgr = img[m > 0].mean(axis=0)
    bottom = int(ys.max())
    feet_x = float(xs[ys >= bottom - 3].mean())
    return {
        "k": k,
        "masterTime": f["masterTime"],
        "videoTime": f["videoTime"],
        "sourcePts": f["sourcePts"],
        "file": f"{cam}/{name}",
        "depthFile": f"{cam}/{dname}",
        "inflateMaxPx": round(hmax, 2),
        "meanColor": [int(mean_bgr[2]), int(mean_bgr[1]), int(mean_bgr[0])],
        "crop": [round(x0 / w, 6), round(y0 / h, 6), round(x1 / w, 6), round(y1 / h, 6)],
        "cropPx": [int(x0), int(y0), int(x1), int(y1)],
        "maskArea": area,
        "maskBottomPx": [round(feet_x, 1), bottom],
        "manualMask": False,
        "maskMethod": method,
        "samVsBackgroundIoU": None,
        "backgroundDriftPx": [0, 0],
    }


REPLACED = os.path.join(WORK, "replaced")


def backup_replaced(clip, cam, k, orig_entry):
    """Copy the original <cam>/NNNN.webp, NNNN_d.png and manifest entry to REPLACED/<cam>/ (once)."""
    d = os.path.join(REPLACED, cam)
    os.makedirs(d, exist_ok=True)
    for n_ in (f"{k:04d}.webp", f"{k:04d}_d.png"):
        src, dst = os.path.join(pub_dir(clip), cam, n_), os.path.join(d, n_)
        if not os.path.exists(dst):  # never overwrite the first (= original) backup
            shutil.copy2(src, dst)
    ej = os.path.join(d, f"{k:04d}.entry.json")
    if not os.path.exists(ej):
        json.dump(orig_entry, open(ej, "w"))


def save_manifest(clip, man):
    p = os.path.join(pub_dir(clip), "manifest.json")
    tmp = p + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(man, fh, indent=1)  # same call as export_sprites.py
    os.replace(tmp, p)


def cmd_write(a):
    man = load_pub_manifest(a.clip)
    data = json.load(open(os.path.join(clip_dir(a.clip), "manifest.json")))
    entries = man["cameras"][a.cam]["frames"]
    if not os.path.exists(a.backup):  # first write for this clip: keep the manifest as export_sprites.py left it
        os.makedirs(os.path.dirname(a.backup), exist_ok=True)
        shutil.copy2(os.path.join(pub_dir(a.clip), "manifest.json"), a.backup)
    orig = json.load(open(a.backup))
    carried = {}
    for spec in a.carried or []:
        label, rng = spec.split(":")
        for k in parse_ks(rng):
            carried[k] = label
    seeds = {}
    for spec in a.seed.split(","):  # "272" or "273-290:272,291-313:278"
        if ":" in spec:
            rng, s = spec.split(":")
            for k in parse_ks(rng):
                seeds[k] = s if s == "points" else int(s)
        else:
            seeds[None] = spec if spec == "points" else int(spec)
    done = 0
    for k in parse_ks(a.ks):
        e = entries[k]
        assert e["k"] == k
        own = False
        if e.get("file"):
            # only a cut-out this script added (no file in the backup = original manifest) may be redone
            own = a.redo and not orig["cameras"][a.cam]["frames"][k].get("file")
            if not own and a.replace:
                # repair of a broken ORIGINAL cut-out: keep the old files + manifest entry for restore
                backup_replaced(a.clip, a.cam, k, orig["cameras"][a.cam]["frames"][k])
                own = True
            if not own:
                print(f"  skip {a.cam} k{k}: already has a cut-out")
                continue
        m = new_mask(a.clip, a.cam, k)
        if m is None or m.sum() < a.min_area:
            print(f"  skip {a.cam} k{k}: {'no mask' if m is None else 'mask area %d < %d' % (m.sum(), a.min_area)}")
            continue
        f = data["cameras"][a.cam]["frames"][k]
        assert f["k"] == k and abs(f["masterTime"] - e["masterTime"]) < 1e-6
        sd = seeds.get(k, seeds.get(None))
        # seed "points": the frame itself was prompted with clicks (no usable matte nearby)
        method = (a.method or (f"sam2.1 (point prompts on k{k})" if sd == "points" else f"sam2.1 (propagated from k{sd})")) + (f"+carried:{carried[k]}" if k in carried else "")
        entries[k] = export_frame(a.clip, a.cam, k, m, f, method, own=own)
        done += 1
    save_manifest(a.clip, man)
    print(f"{a.cam}: wrote {done} cut-outs")


def cmd_reason(a):
    """Update the `reason` of frames that stay without a cut-out."""
    man = load_pub_manifest(a.clip)
    entries = man["cameras"][a.cam]["frames"]
    n = 0
    for k in parse_ks(a.ks):
        if not entries[k].get("file"):
            entries[k]["reason"] = a.reason
            n += 1
    save_manifest(a.clip, man)
    print(f"{a.cam}: reason updated on {n} frames")


def cmd_check(a):
    """Compare the public manifest with the backup: list changed entries; verify that every changed
    entry had no file before, that nothing else changed, and that files on disk match the manifest."""
    old = json.load(open(a.backup))
    new = load_pub_manifest(a.clip)
    head = lambda m: {k: v for k, v in m.items() if k not in ("cameras", "note")}   # avatar/rims.py extends the note
    assert head(old) == head(new), "header changed"
    total = 0
    for cam in old["cameras"]:
        oc, nc = old["cameras"][cam], new["cameras"][cam]
        assert {k: v for k, v in oc.items() if k != "frames"} == {k: v for k, v in nc.items() if k != "frames"}
        assert len(oc["frames"]) == len(nc["frames"])
        added, reason, replaced, dropped = [], [], [], []
        for o, n in zip(oc["frames"], nc["frames"]):
            if o == n:
                continue
            assert o["k"] == n["k"]
            assert abs(o["masterTime"] - n["masterTime"]) < 1e-9 and abs(o["videoTime"] - n["videoTime"]) < 1e-9
            if o.get("file"):  # an original cut-out was repaired / dropped: its backup must exist
                for n_ in (f"{o['k']:04d}.webp", f"{o['k']:04d}_d.png", f"{o['k']:04d}.entry.json"):
                    assert os.path.exists(os.path.join(REPLACED, cam, n_)), f"{cam} k{o['k']}: changed without backup"
                assert json.load(open(os.path.join(REPLACED, cam, f"{o['k']:04d}.entry.json"))) == o
                (replaced if n.get("file") else dropped).append(n["k"])
            else:
                (added if n.get("file") else reason).append(n["k"])
        for n in nc["frames"]:
            if n.get("file"):
                for key in ("file", "depthFile"):
                    assert os.path.exists(os.path.join(pub_dir(a.clip), n[key])), n[key]
        on_disk = {f for f in os.listdir(os.path.join(pub_dir(a.clip), cam))}
        listed = {os.path.basename(n[key]) for n in nc["frames"] if n.get("file") for key in ("file", "depthFile")}
        assert on_disk == listed, (cam, sorted(on_disk ^ listed)[:10])
        total += len(added) + len(reason) + len(replaced) + len(dropped)
        print(f"{cam}: {len(replaced)} original cut-outs replaced {ranges(replaced)}; {len(dropped)} original cut-outs dropped {ranges(dropped)}")
        print(f"{cam}: {len(added)} entries gained a cut-out {ranges(added)}; {len(reason)} entries only changed reason {ranges(reason)}; still missing {ranges([n['k'] for n in nc['frames'] if not n.get('file')])}")
    print("entries changed:", total)


def ranges(ks):
    out, ks = [], sorted(ks)
    i = 0
    while i < len(ks):
        j = i
        while j + 1 < len(ks) and ks[j + 1] == ks[j] + 1:
            j += 1
        out.append(str(ks[i]) if i == j else f"{ks[i]}-{ks[j]}")
        i = j + 1
    return "[" + ", ".join(out) + "]"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["body", "run", "adopt", "sheet", "zoom", "write", "reason", "check"])
    ap.add_argument("--clip", default="clip02")
    ap.add_argument("--cam")
    ap.add_argument("--ks")
    ap.add_argument("--job")
    ap.add_argument("--threads", type=int, default=2)
    ap.add_argument("--variant", default="", help="sheet: show masks_<variant>/ instead of masks/")
    ap.add_argument("--out")
    ap.add_argument("--scale", type=float, default=1.0)
    ap.add_argument("--width", type=int, default=1900)
    ap.add_argument("--quality", type=int, default=88)
    ap.add_argument("--body", action="store_true", help="draw the projected body outline (green)")
    ap.add_argument("--prefer-new", action="store_true")
    ap.add_argument("--carried", action="append", help="label:ks, e.g. chair:273-313")
    ap.add_argument("--seed", default="")
    ap.add_argument("--min-area", type=int, default=1500)
    ap.add_argument("--redo", action="store_true", help="write: replace cut-outs this script added earlier")
    ap.add_argument("--replace", action="store_true", help="write: replace an ORIGINAL cut-out (backup under $MATTE_WORK/replaced/<cam>/)")
    ap.add_argument("--method", help="write: maskMethod text instead of 'sam2.1 (propagated from k<seed>)'")
    ap.add_argument("--reason")
    ap.add_argument("--keep-near", type=int, default=9, help="adopt: keep detached parts within this many px of the main part (raise it when an occluder splits him)")
    ap.add_argument("--min-part", type=int, default=25, help="adopt: smallest detached part kept")
    ap.add_argument("--win", help="zoom: fixed window x0,y0,x1,y1")
    ap.add_argument("--compact", action="store_true", help="zoom: outline + cut-out only")
    ap.add_argument("--backup", default=os.path.join(WORK, "manifest.orig.json"), help="check: the manifest as it was before this script first ran")
    a = ap.parse_args()
    globals()["cmd_" + a.cmd](a)


if __name__ == "__main__":
    main()
