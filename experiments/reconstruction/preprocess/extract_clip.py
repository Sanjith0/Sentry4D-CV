"""Extract master-time-aligned SDR frames for a clip window (derived copies; originals untouched).

For each camera and each master time t = t0 + k/fps (k = 0..N-1):
    videoTime = t + offset[cam]          (app convention, src/config/camera-sync.json)
The frame shown is the one the browser shows at that videoTime: the last decoded frame with
pts <= videoTime (VFR-safe; uses ffmpeg's select on pts, not fps resampling).

- HLG/BT.2020 HEVC (cam1, cam3, cam4) is tone-mapped to SDR BT.709 (hable). H.264 SDR (cam2) is passed through.
- Rotation metadata (cam1: -180° displaymatrix) is applied by ffmpeg's autorotate exactly once, which is
  also what the browser does, so pixel coords match the app's normalized video pixels 1:1.
- Output: data/<clip>/frames/<cam>/<k:04d>.png  +  data/<clip>/manifest.json

Usage:
  .venv/bin/python preprocess/extract_clip.py --clip clip01 --t0 8.6 --t1 10.4 --fps 15 --cams cam1,cam2
"""
import argparse, json, os, shutil, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
VIDEOS = {
    "cam1": "Jason_cam_01.mov",
    "cam2": "Jason_Cam_02.MOV",
    "cam3": "Jason_cam_03.mov",
    "cam4": "Jason_Cam_04.mov",
}
HLG_TO_SDR = "zscale=t=linear:npl=203,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p"
def _default_ffmpeg():
    try:
        import imageio_ffmpeg  # static ffmpeg in the project venv (has zscale + tonemap)
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        return shutil.which("ffmpeg") or "ffmpeg"


DEFAULT_FFMPEG = _default_ffmpeg()


def probe_transfer(ffmpeg, path):
    out = subprocess.run([ffmpeg, "-hide_banner", "-i", path], capture_output=True, text=True).stderr
    return "arib-std-b67" in out or "smpte2084" in out  # HLG or PQ


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clip", default="clip01")
    ap.add_argument("--t0", type=float, default=8.6)
    ap.add_argument("--t1", type=float, default=10.4)
    ap.add_argument("--fps", type=float, default=15)
    ap.add_argument("--cams", default="cam1,cam2")
    ap.add_argument("--ffmpeg", default=os.environ.get("FFMPEG", DEFAULT_FFMPEG))
    a = ap.parse_args()

    offsets = json.load(open(os.path.join(ROOT, "src", "config", "camera-sync.json")))
    out_dir = os.path.join(ROOT, "experiments", "reconstruction", "data", a.clip)
    n = int(round((a.t1 - a.t0) * a.fps))
    masters = [round(a.t0 + k / a.fps, 4) for k in range(n)]
    manifest = {
        "clip": a.clip,
        "fps": a.fps,
        "t0": a.t0,
        "t1": a.t1,
        "frameCount": n,
        "syncOffsets": offsets,
        "convention": "videoTime = masterTime + offset; frame = last decoded frame with pts <= videoTime; pixels in the upright displayed frame (rotation metadata applied)",
        "cameras": {},
    }
    for cam in a.cams.split(","):
        src = os.path.join(ROOT, "public", "videos", VIDEOS[cam])
        hdr = probe_transfer(a.ffmpeg, src)
        off = offsets[cam]
        # Decode a little before the window so the 'last frame <= t' rule works at the first sample.
        start = max(0.0, a.t0 + off - 0.2)
        dur = (a.t1 - a.t0) + 0.4
        cam_dir = os.path.join(out_dir, "frames", cam)
        os.makedirs(cam_dir, exist_ok=True)
        tmp = os.path.join(cam_dir, "_all")
        shutil.rmtree(tmp, ignore_errors=True)
        os.makedirs(tmp)
        # ONE decode pass writes every source frame AND reports its pts (showinfo is last in the
        # chain, so output file i <-> pts i exactly; no second probe that could disagree).
        vf = (HLG_TO_SDR + ",") if hdr else ""
        vf += "format=rgb24,showinfo"
        err = subprocess.run(
            [a.ffmpeg, "-hide_banner", "-y", "-ss", f"{start:.4f}", "-i", src, "-t", f"{dur:.4f}", "-vf", vf, "-fps_mode", "passthrough", os.path.join(tmp, "%05d.png")],
            capture_output=True, text=True, check=True,
        ).stderr
        # With -ss before -i, output pts restart near 0: map back to source time.
        rel = [float(l.split("pts_time:")[1].split()[0]) for l in err.splitlines() if "pts_time:" in l]
        decoded = sorted(os.listdir(tmp))
        # showinfo also reports a trailing frame past -t that the muxer drops: files = first N pts.
        extra = rel[len(decoded):]
        if len(rel) < len(decoded) or any(r < dur - 0.05 for r in extra):
            sys.exit(f"{cam}: {len(decoded)} files vs {len(rel)} pts lines (unexpected)")
        rel = rel[: len(decoded)]
        pts = [start + r for r in rel]
        picks = []
        for t in masters:
            vt = t + off
            cands = [i for i, p in enumerate(pts) if p <= vt + 1e-4]
            if not cands:
                sys.exit(f"{cam}: no frame at videoTime {vt:.3f}")
            picks.append(cands[-1])
        frames = []
        for k, (t, i) in enumerate(zip(masters, picks)):
            name = f"{k:04d}.png"
            shutil.copyfile(os.path.join(tmp, decoded[i]), os.path.join(cam_dir, name))
            frames.append({"k": k, "masterTime": t, "videoTime": round(t + off, 4), "sourcePts": round(pts[i], 4), "file": f"frames/{cam}/{name}"})
        shutil.rmtree(tmp)
        manifest["cameras"][cam] = {"source": f"public/videos/{VIDEOS[cam]}", "hdrToneMapped": hdr, "offset": off, "frames": frames}
        lag = max(abs(f["videoTime"] - f["sourcePts"]) for f in frames)
        print(f"{cam}: {len(frames)} frames, hdr={hdr}, max |videoTime - pts| = {lag * 1000:.1f} ms")
    with open(os.path.join(out_dir, "manifest.json"), "w") as fh:
        json.dump(manifest, fh, indent=1)
    print("wrote", os.path.join(out_dir, "manifest.json"))


if __name__ == "__main__":
    main()
