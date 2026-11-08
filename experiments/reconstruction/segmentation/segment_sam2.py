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
import argparse, json, os, sys, time

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
    for cam in a.cams.split(","):
        frames = manifest["cameras"][cam]["frames"]
        # SAM2's video loader wants a folder of JPEGs named <int>.jpg
        jdir = os.path.join(clip, "_jpg", cam)
        os.makedirs(jdir, exist_ok=True)
        for f in frames:
            cv2.imwrite(os.path.join(jdir, f"{f['k']:05d}.jpg"), cv2.imread(os.path.join(clip, f["file"])), [cv2.IMWRITE_JPEG_QUALITY, 95])
        h, w = cv2.imread(os.path.join(clip, frames[0]["file"])).shape[:2]
        t0 = time.time()
        with torch.inference_mode():
            state = pred.init_state(video_path=jdir)
            n = len(frames)
            # Box prompts on a few keyframes (from the tracked position) keep the object locked on.
            for k in sorted({0, n // 3, (2 * n) // 3, n - 1}):
                pred.add_new_points_or_box(state, frame_idx=k, obj_id=1, box=np.array(pad_box(track[k]["boxes"][cam], w, h), dtype=np.float32))
            masks = {}
            for fi, _, logits in pred.propagate_in_video(state):
                masks[fi] = (logits[0, 0] > 0).cpu().numpy().astype(np.uint8) * 255
        mdir = os.path.join(clip, "masks", cam)
        os.makedirs(mdir, exist_ok=True)
        for k, m in masks.items():
            cv2.imwrite(os.path.join(mdir, f"{k:04d}.png"), m)
        areas = [int((masks[k] > 0).sum()) for k in sorted(masks)]
        print(f"{cam}: {len(masks)} masks in {time.time() - t0:.1f}s, area min/median/max = {min(areas)}/{int(np.median(areas))}/{max(areas)} px")
        pred.reset_state(state)


if __name__ == "__main__":
    main()
