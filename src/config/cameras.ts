import type { CameraId, CameraPoseConfig, SecurityCamera } from "../types/security";
import { poseTarget } from "../lib/cameraMath";
import cameraSync from "./camera-sync.json";
import cameraPoses from "./camera-poses.json";

export { CCTV_ASPECT, FRUSTUM_LENGTH } from "./cctv";

const syncDefaults = cameraSync as Record<CameraId, number>;

/**
 * Calibrated poses (position, yaw/pitch/roll, fov) for each virtual camera.
 * Edited in the app: CCTV view → CALIBRATE → SAVE TO PROJECT, which rewrites
 * src/config/camera-poses.json. Commit that file to share the calibration.
 */
export const savedPoses = cameraPoses as Record<CameraId, CameraPoseConfig>;

interface CameraMeta {
  id: CameraId;
  name: string;
  /** Exact on-disk file name (case matters on Linux hosts). */
  videoUrl: string;
  videoRotation?: SecurityCamera["videoRotation"];
}

/**
 * Coordinates: room space, Y-up, meters, floor at y = 0 (after auto-grounding).
 * Room: x ∈ [-2.4, 2.4] (window wall at x = -2.4), z ∈ [-6.78, 6.78], ceiling ≈ 3.05.
 * Sync offsets: config/camera-sync.json (defaults) → Camera Sync panel.
 */
const CAMERA_META: CameraMeta[] = [
  { id: "cam1", name: "CAM 01 · NW · Window", videoUrl: "/videos/Jason_cam_01.mov" },
  { id: "cam2", name: "CAM 02 · NE", videoUrl: "/videos/Jason_Cam_02.MOV" },
  { id: "cam3", name: "CAM 03 · SE", videoUrl: "/videos/Jason_cam_03.mov" },
  // Partial coverage, aimed farther to its right; pose is independent (camera-poses.json).
  { id: "cam4", name: "CAM 04 · SW · Window", videoUrl: "/videos/Jason_Cam_04.mov" },
];

export function buildCamera(meta: Pick<SecurityCamera, "id" | "name" | "videoUrl" | "videoRotation">, pose: CameraPoseConfig, offset: number): SecurityCamera {
  return {
    ...meta,
    position: [...pose.position] as SecurityCamera["position"],
    target: poseTarget(pose),
    yaw: pose.yaw,
    pitch: pose.pitch,
    roll: pose.roll,
    fov: pose.fov,
    offset,
  };
}

/** Cameras as saved in the project files. For live (calibrating) values use `useCameras()` from the replay store. */
export const securityCameras: SecurityCamera[] = CAMERA_META.map((m) => buildCamera(m, savedPoses[m.id], syncDefaults[m.id] ?? 0));

export function getCamera(id: string | null | undefined) {
  return securityCameras.find((c) => c.id === id);
}
