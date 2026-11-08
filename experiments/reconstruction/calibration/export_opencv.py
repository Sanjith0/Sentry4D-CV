"""Convert Sentry4D camera poses (Three.js, Y-up, metres) to OpenCV/COLMAP conventions.

Three.js camera: looks down local -Z, +Y up, +X right; orientation = Euler(pitch, yaw, roll, order "YXZ")
  (same as src/lib/cameraMath.ts poseQuaternion). fov = VERTICAL FOV of the 16:9 frame; pinhole, no distortion,
  principal point at the image centre (the app makes exactly these assumptions).
OpenCV camera: looks down +Z, +Y down, +X right.  R_cv_c2w = R_three_c2w @ diag(1,-1,-1).
World frame is kept as the app's room frame (Y-up, metres, floor y=0). COLMAP stores world->camera
(qvec = R_w2c as w,x,y,z; tvec = -R_w2c @ C).

Usage: python export_opencv.py ../../../src/config/camera-poses.json [width height] > cameras_opencv.json
Self-test: reprojects a floor point and compares with the app's convention (three.js PerspectiveCamera math).
"""
import json, math, sys
import numpy as np

def rot_three(pitch, yaw, roll):  # Euler YXZ: R = Ry(yaw) @ Rx(pitch) @ Rz(roll)
    p, y, r = map(math.radians, (pitch, yaw, roll))
    Rx = np.array([[1, 0, 0], [0, math.cos(p), -math.sin(p)], [0, math.sin(p), math.cos(p)]])
    Ry = np.array([[math.cos(y), 0, math.sin(y)], [0, 1, 0], [-math.sin(y), 0, math.cos(y)]])
    Rz = np.array([[math.cos(r), -math.sin(r), 0], [math.sin(r), math.cos(r), 0], [0, 0, 1]])
    return Ry @ Rx @ Rz

def quat_wxyz(R):
    w = math.sqrt(max(0, 1 + R[0, 0] + R[1, 1] + R[2, 2])) / 2
    x = math.copysign(math.sqrt(max(0, 1 + R[0, 0] - R[1, 1] - R[2, 2])) / 2, R[2, 1] - R[1, 2])
    y = math.copysign(math.sqrt(max(0, 1 - R[0, 0] + R[1, 1] - R[2, 2])) / 2, R[0, 2] - R[2, 0])
    z = math.copysign(math.sqrt(max(0, 1 - R[0, 0] - R[1, 1] + R[2, 2])) / 2, R[1, 0] - R[0, 1])
    return [w, x, y, z]

def convert(pose, W, H):
    C = np.array(pose["position"], float)
    R3 = rot_three(pose["pitch"], pose["yaw"], pose["roll"])        # three camera->world
    Rcv_c2w = R3 @ np.diag([1, -1, -1])                              # opencv camera->world
    Rw2c = Rcv_c2w.T
    t = -Rw2c @ C
    fy = (H / 2) / math.tan(math.radians(pose["fov"]) / 2)
    K = np.array([[fy, 0, W / 2], [0, fy, H / 2], [0, 0, 1]])
    hfov = 2 * math.degrees(math.atan((W / 2) / fy))
    return {"K": K, "R_w2c": Rw2c, "t_w2c": t, "C": C, "R_three_c2w": R3, "hfov": hfov}

def project_cv(cam, X):
    x = cam["K"] @ (cam["R_w2c"] @ X + cam["t_w2c"]); return x[:2] / x[2]

def project_three(pose, X, W, H):  # independent path: three.js view + projection math
    R3 = rot_three(pose["pitch"], pose["yaw"], pose["roll"]); C = np.array(pose["position"], float)
    v = R3.T @ (X - C)                                                # camera space (-Z forward)
    f = 1 / math.tan(math.radians(pose["fov"]) / 2); a = W / H
    ndc = np.array([f / a * v[0] / -v[2], f * v[1] / -v[2]])
    return np.array([(ndc[0] + 1) / 2 * W, (1 - ndc[1]) / 2 * H])

if __name__ == "__main__":
    poses = json.load(open(sys.argv[1])); W = int(sys.argv[2]) if len(sys.argv) > 2 else 1920; H = int(sys.argv[3]) if len(sys.argv) > 3 else 1080
    out = {"convention": "OpenCV pinhole; world = Sentry4D room frame (Y-up, metres, floor y=0); x_img = K (R_w2c X + t_w2c); no distortion (UNVERIFIED: real lenses have some)", "width": W, "height": H, "cameras": {}}
    worst = 0
    for cid, p in poses.items():
        c = convert(p, W, H)
        for X in ([0, 0, 0], [1.0, 0, -3.0], [-1.5, 1.2, 2.0]):
            X = np.array(X, float)
            if (c["R_w2c"] @ X + c["t_w2c"])[2] > 0: worst = max(worst, np.abs(project_cv(c, X) - project_three(p, X, W, H)).max())
        out["cameras"][cid] = {
            "K": c["K"].round(4).tolist(), "fx": round(c["K"][0, 0], 3), "fy": round(c["K"][1, 1], 3), "cx": W / 2, "cy": H / 2,
            "hfov_deg": round(c["hfov"], 2), "vfov_deg": p["fov"], "distortion": [0, 0, 0, 0, 0],
            "R_w2c": c["R_w2c"].round(6).tolist(), "t_w2c": c["t_w2c"].round(6).tolist(), "C_world": c["C"].tolist(),
            "c2w_opencv_4x4": np.vstack([np.hstack([c["R_w2c"].T, c["C"][:, None]]), [0, 0, 0, 1]]).round(6).tolist(),
            "colmap": {"qvec_wxyz": [round(v, 8) for v in quat_wxyz(c["R_w2c"])], "tvec": c["t_w2c"].round(6).tolist(), "model": "PINHOLE", "params": [round(c["K"][0, 0], 4), round(c["K"][1, 1], 4), W / 2, H / 2]},
        }
    out["selftest_max_px_diff_vs_threejs_math"] = float(worst)
    print(json.dumps(out, indent=1))
    print(f"self-test: max |opencv - three.js| reprojection = {worst:.2e} px", file=sys.stderr)
