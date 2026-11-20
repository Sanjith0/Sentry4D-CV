"""Shared paths, camera model and small helpers for the avatar pipeline.

World frame = the app's room frame (metres, Y-up, floor y = 0). Cameras follow the app's
calibration convention exactly (src/lib/cameraMath.ts, src/lib/videoProjection.ts):
three.js camera (looks down -Z), orientation = Euler(pitch, yaw, roll, "YXZ"), `fov` = vertical
FOV of the 16:9 frame, pinhole, principal point at the image centre.
"""
import json, math, os
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
CAMS = ["cam1", "cam2", "cam3", "cam4"]
W, H = 1920, 1080

# COCO-WholeBody: 17 body + 6 feet (the 23 keypoints Anny ships vertex regressors for).
KP_NAMES = [
    "nose", "left_eye", "right_eye", "left_ear", "right_ear", "left_shoulder", "right_shoulder",
    "left_elbow", "right_elbow", "left_wrist", "right_wrist", "left_hip", "right_hip", "left_knee",
    "right_knee", "left_ankle", "right_ankle", "left_big_toe", "left_small_toe", "left_heel",
    "right_big_toe", "right_small_toe", "right_heel",
]
KP = {n: i for i, n in enumerate(KP_NAMES)}
FLIP_PAIRS = [(1, 2), (3, 4), (5, 6), (7, 8), (9, 10), (11, 12), (13, 14), (15, 16), (17, 20), (18, 21), (19, 22)]
SKELETON = [(5, 6), (5, 7), (7, 9), (6, 8), (8, 10), (5, 11), (6, 12), (11, 12), (11, 13), (13, 15), (12, 14), (14, 16),
            (15, 17), (15, 18), (15, 19), (16, 20), (16, 21), (16, 22), (0, 1), (0, 2), (1, 3), (2, 4)]


def clip_dir(clip):
    return os.path.join(ROOT, "experiments", "reconstruction", "data", clip)


def work_dir(clip):
    d = os.path.join(clip_dir(clip), "avatar")
    os.makedirs(d, exist_ok=True)
    return d


def public_dir(clip):
    return os.path.join(ROOT, "public", "reconstruction", clip)


def load_json(p):
    with open(p) as fh:
        return json.load(fh)


def rot_three(pitch, yaw, roll):
    """three.js Euler 'YXZ' (degrees): R = Ry(yaw) @ Rx(pitch) @ Rz(roll); camera -> world."""
    p, y, r = map(math.radians, (pitch, yaw, roll))
    Rx = np.array([[1, 0, 0], [0, math.cos(p), -math.sin(p)], [0, math.sin(p), math.cos(p)]])
    Ry = np.array([[math.cos(y), 0, math.sin(y)], [0, 1, 0], [-math.sin(y), 0, math.cos(y)]])
    Rz = np.array([[math.cos(r), -math.sin(r), 0], [math.sin(r), math.cos(r), 0], [0, 0, 1]])
    return Ry @ Rx @ Rz


def pose_to_cv(pose, w=W, h=H):
    """App pose -> OpenCV pinhole (x_img = K (R X + t)), world = room frame."""
    C = np.array(pose["position"], float)
    R_c2w = rot_three(pose["pitch"], pose["yaw"], pose["roll"]) @ np.diag([1.0, -1.0, -1.0])
    R = R_c2w.T
    f = (h / 2) / math.tan(math.radians(pose["fov"]) / 2)
    return {"f": f, "cx": w / 2, "cy": h / 2, "R": R, "t": -R @ C, "C": C}


def load_app_cameras():
    poses = load_json(os.path.join(ROOT, "src", "config", "camera-poses.json"))
    return {c: pose_to_cv(poses[c]) for c in CAMS}


def load_cameras(clip, refined=True):
    """Cameras used by the avatar pipeline: keypoint-refined if available, else the app calibration."""
    p = os.path.join(work_dir(clip), "cameras_refined.json")
    if refined and os.path.exists(p):
        d = load_json(p)["cameras"]
        return {c: {"f": d[c]["f"], "cx": d[c]["cx"], "cy": d[c]["cy"], "k1": d[c].get("k1", 0.0), "dt": d[c].get("dt", 0.0),
                    "R": np.array(d[c]["R"]), "t": np.array(d[c]["t"]), "C": np.array(d[c]["C"])} for c in CAMS}
    cams = load_app_cameras()
    for c in cams.values():
        c["k1"], c["dt"] = 0.0, 0.0
    return cams


def project(cam, X):
    """X (...,3) world -> pixels (...,2), depth (...). One radial term k1 (0 for the app calibration)."""
    Xc = X @ cam["R"].T + cam["t"]
    z = Xc[..., 2]
    xn = Xc[..., :2] / np.maximum(z[..., None], 1e-6)
    k1 = cam.get("k1", 0.0)
    if k1:
        xn = xn * (1 + k1 * (xn ** 2).sum(-1, keepdims=True))
    return xn * cam["f"] + np.array([cam["cx"], cam["cy"]]), z


def P_matrix(cam):
    K = np.array([[cam["f"], 0, cam["cx"]], [0, cam["f"], cam["cy"]], [0, 0, 1]])
    return K @ np.hstack([cam["R"], cam["t"][:, None]])


def undistort_px(cam, uv):
    """Pixels -> ideal pinhole pixels (inverse of the k1 term; fixed-point iteration)."""
    k1 = cam.get("k1", 0.0)
    if not k1:
        return uv
    xd = (uv - np.array([cam["cx"], cam["cy"]])) / cam["f"]
    xu = xd.copy()
    for _ in range(8):
        xu = xd / (1 + k1 * (xu ** 2).sum(-1, keepdims=True))
    return xu * cam["f"] + np.array([cam["cx"], cam["cy"]])
