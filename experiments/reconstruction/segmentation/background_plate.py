"""Median background plate per static camera (the person keeps moving, so the median removes them).

Samples 1 frame/s across the whole recording (tone-mapped exactly like extract_clip.py) and writes
data/background/<cam>.png. Used by export_sprites.py to drop static pixels (booths, floor) that
SAM occasionally attaches to the person.

Usage: .venv/bin/python segmentation/background_plate.py --cams cam1,cam2
"""
import argparse, os, subprocess, sys, tempfile
import cv2
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "preprocess"))
from extract_clip import DEFAULT_FFMPEG, HLG_TO_SDR, ROOT, VIDEOS, probe_transfer  # noqa: E402

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cams", default="cam1,cam2")
    ap.add_argument("--step", type=float, default=1.0)
    a = ap.parse_args()
    out = os.path.join(BASE, "data", "background")
    os.makedirs(out, exist_ok=True)
    for cam in a.cams.split(","):
        src = os.path.join(ROOT, "public", "videos", VIDEOS[cam])
        vf = (HLG_TO_SDR + ",") if probe_transfer(DEFAULT_FFMPEG, src) else ""
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run([DEFAULT_FFMPEG, "-loglevel", "error", "-i", src, "-vf", f"{vf}fps=1/{a.step},format=rgb24", os.path.join(tmp, "%04d.png")], check=True)
            stack = np.stack([cv2.imread(os.path.join(tmp, f)) for f in sorted(os.listdir(tmp))])
        plate = np.median(stack, axis=0).astype(np.uint8)
        cv2.imwrite(os.path.join(out, f"{cam}.png"), plate)
        print(f"{cam}: median of {len(stack)} frames -> data/background/{cam}.png")


if __name__ == "__main__":
    main()
