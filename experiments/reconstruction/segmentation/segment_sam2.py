"""Segment the tracked person in a clip with SAM 2.1 (Apple Silicon MPS, CPU fallback).

Prompts come from REAL data only: data/<clip>/track.json holds the person's tracked floor position
projected into each camera as a feet-to-head box (exported from the app's own trajectory code).

Modes:
  --test   : image predictor on 3 frames per camera -> data/<clip>/test/ overlays (fast sanity check)
  default  : video predictor, box prompts on several keyframes, propagated through all frames ->
             data/<clip>/masks/<cam>/<k>.png  (8-bit mask, 255 = person)

Usage:
  .venv/bin/python segmentation/segment_sam2.py --clip clip01 --cams cam1,cam2 --test
  .venv/bin/python segmentation/segment_sam2.py --clip clip01 --cams cam1,cam2
"""
import argparse, json, os, shutil, sys, time

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
import cv2
import numpy as np
import torch

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.abspath(os.path.join(HERE, ".."))
CKPT = os.path.join(BASE, "checkpoints", "sam2.1_hiera_small.pt")
CFG = "configs/sam2.1/sam2.1_hiera_s.yaml"


def device():
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def pad_box(b, w, h, frac=0.12):
    x0, y0, x1, y1 = b
    px, py = (x1 - x0) * frac, (y1 - y0) * frac
    return [max(0, x0 - px), max(0, y0 - py), min(w - 1, x1 + px), min(h - 1, y1 + py)]


def overlay(img, mask, box=None):
    o = img.copy()
    o[mask > 0] = (0.45 * o[mask > 0] + 0.55 * np.array([255, 255, 0])).astype(np.uint8)
    cnts, _ = cv2.findContours((mask > 0).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(o, cnts, -1, (0, 255, 255), 2)
    if box is not None:
        cv2.rectangle(o, (int(box[0]), int(box[1])), (int(box[2]), int(box[3])), (0, 0, 255), 2)
    return o


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clip", default="clip01")
    ap.add_argument("--cams", default="cam1,cam2")
    ap.add_argument("--test", action="store_true")
    ap.add_argument("--chunk", type=int, default=45, help="frames per propagation chunk (memory bound)")
    ap.add_argument("--min-in-frame", type=float, default=0.5, help="min fraction of the prompt box inside the frame")
    a = ap.parse_args()
    clip = os.path.join(BASE, "data", a.clip)
    manifest = json.load(open(os.path.join(clip, "manifest.json")))
    track = json.load(open(os.path.join(clip, "track.json")))
    dev = device()
    print("device:", dev)

    if a.test:
        from sam2.build_sam import build_sam2
        from sam2.sam2_image_predictor import SAM2ImagePredictor

        pred = SAM2ImagePredictor(build_sam2(CFG, CKPT, device=dev))
        out = os.path.join(clip, "test")
        os.makedirs(out, exist_ok=True)
        for cam in a.cams.split(","):
            n = len(manifest["cameras"][cam]["frames"])
            for k in [0, n // 2, n - 1]:
                img = cv2.cvtColor(cv2.imread(os.path.join(clip, manifest["cameras"][cam]["frames"][k]["file"])), cv2.COLOR_BGR2RGB)
                box = pad_box(track[k]["boxes"][cam], img.shape[1], img.shape[0])
                t0 = time.time()
                with torch.inference_mode():
                    pred.set_image(img)
                    masks, scores, _ = pred.predict(box=np.array(box), multimask_output=False)
                m = (masks[0] > 0).astype(np.uint8) * 255
                print(f"{cam} k={k}: score {scores[0]:.3f}, area {int((m > 0).sum())} px, {time.time() - t0:.2f}s")
                cv2.imwrite(os.path.join(out, f"{cam}_{k:04d}.jpg"), cv2.cvtColor(overlay(img, m, box), cv2.COLOR_RGB2BGR))
        return

    from sam2.build_sam import build_sam2_video_predictor

    pred = build_sam2_video_predictor(CFG, CKPT, device=dev)
    from sam2.build_sam import build_sam2
    from sam2.sam2_image_predictor import SAM2ImagePredictor

    img_pred = SAM2ImagePredictor(build_sam2(CFG, CKPT, device=dev))

    def repair_collapsed(cam, frames, mdir, ks, w, h):
        """Video propagation sometimes collapses to a speck on one frame. Re-segment frames whose
        mask is < 40% of the chunk median with the image predictor + the same box prompt."""
        areas = {}
        for k in ks:
            f = os.path.join(mdir, f"{k:04d}.png")
            if os.path.exists(f):
                areas[k] = int((cv2.imread(f, cv2.IMREAD_GRAYSCALE) > 0).sum())
        if len(areas) < 3:
            return 0
        med = float(np.median(list(areas.values())))
        fixed = 0
        for k, ar in areas.items():
            if ar >= 0.4 * med:
                continue
            img = cv2.cvtColor(cv2.imread(os.path.join(clip, frames[k]["file"])), cv2.COLOR_BGR2RGB)
            with torch.inference_mode():
                img_pred.set_image(img)
                masks, scores, _ = img_pred.predict(box=np.array(pad_box(track[k]["boxes"][cam], w, h)), multimask_output=False)
            m = (masks[0] > 0).astype(np.uint8) * 255
            if (m > 0).sum() > ar:
                cv2.imwrite(os.path.join(mdir, f"{k:04d}.png"), m)
                fixed += 1
        return fixed

    for cam in a.cams.split(","):
        frames = manifest["cameras"][cam]["frames"]
        h, w = cv2.imread(os.path.join(clip, frames[0]["file"])).shape[:2]
        mdir = os.path.join(clip, "masks", cam)
        os.makedirs(mdir, exist_ok=True)

        def promptable(k):
            row = track[k]
            b = row["boxes"].get(cam)
            inside = row.get("boxInFrame", {}).get(cam, 1.0)
            return row.get("visible", True) and b is not None and inside >= a.min_in_frame

        t0 = time.time()
        written = 0
        repaired = 0
        n = len(frames)
        for c0 in range(0, n, a.chunk):
            ks = list(range(c0, min(n, c0 + a.chunk)))
            prompts = [k for k in ks if promptable(k)]
            if not prompts:
                continue  # person not (projected) in this camera for the whole chunk
            jdir = os.path.join(clip, "_jpg", cam)
            shutil.rmtree(jdir, ignore_errors=True)
            os.makedirs(jdir)
            for i, k in enumerate(ks):
                cv2.imwrite(os.path.join(jdir, f"{i:05d}.jpg"), cv2.imread(os.path.join(clip, frames[k]["file"])), [cv2.IMWRITE_JPEG_QUALITY, 95])
            # Box prompts every ~0.5 s on frames where the person projects inside the image.
            keys = sorted({prompts[0], prompts[-1], *prompts[:: max(1, int(manifest["fps"] // 2))]})
            with torch.inference_mode():
                state = pred.init_state(video_path=jdir, offload_video_to_cpu=True)
                for k in keys:
                    pred.add_new_points_or_box(state, frame_idx=k - c0, obj_id=1, box=np.array(pad_box(track[k]["boxes"][cam], w, h), dtype=np.float32))
                for fi, _, logits in pred.propagate_in_video(state):
                    k = c0 + fi
                    if not promptable(k):
                        continue  # never emit masks for frames where the person can't be in view
                    cv2.imwrite(os.path.join(mdir, f"{k:04d}.png"), (logits[0, 0] > 0).cpu().numpy().astype(np.uint8) * 255)
                    written += 1
                # also propagate backwards from the first prompt so early frames are covered
                if keys[0] > c0:
                    for fi, _, logits in pred.propagate_in_video(state, reverse=True):
                        k = c0 + fi
                        if promptable(k):
                            cv2.imwrite(os.path.join(mdir, f"{k:04d}.png"), (logits[0, 0] > 0).cpu().numpy().astype(np.uint8) * 255)
                pred.reset_state(state)
            repaired += repair_collapsed(cam, frames, mdir, ks, w, h)
        shutil.rmtree(os.path.join(clip, "_jpg"), ignore_errors=True)
        print(f"{cam}: {written} masks / {n} frames in {time.time() - t0:.0f}s (repaired {repaired} collapsed frames)")


if __name__ == "__main__":
    main()
