import type { CameraId, SecurityCamera } from "../types/security";
import cameraSync from "./camera-sync.json";

const syncDefaults = cameraSync as Record<CameraId, number>;

/**
 * Virtual counterparts of the four physical CCTV cameras.
 * Coordinates: room space, Y-up, meters, floor at y = 0 (after auto-grounding).
 *
 * Room: x ∈ [-2.4, 2.4] (window wall at x = -2.4), z ∈ [-6.78, 6.78], ceiling ≈ 3.05.
 * Each camera has its OWN position + target; they are not auto-aimed. Fine-tune by
 * flying to the mount in free mode, aiming, and clicking "POSE" in the toolbar.
 *
 * Video file names match the files on disk exactly (case matters on Linux hosts).
 * Sync offsets: config/camera-sync.json (defaults) → Camera Sync panel (live, saved locally).
 */
export const securityCameras: SecurityCamera[] = [
  {
    id: "cam1",
    name: "CAM 01 · NW · Window",
    position: [-2.1, 2.7, -6.45],
    target: [0, 0.8, 0],
    fov: 60,
    videoUrl: "/videos/Jason_cam_01.mov",
    offset: syncDefaults.cam1 ?? 0,
  },
  {
    id: "cam2",
    name: "CAM 02 · NE",
    position: [2.1, 2.7, -6.45],
    target: [0, 0.8, 0],
    fov: 60,
    videoUrl: "/videos/Jason_Cam_02.MOV",
    offset: syncDefaults.cam2 ?? 0,
  },
  {
    id: "cam3",
    name: "CAM 03 · SE",
    position: [2.1, 2.7, 6.45],
    target: [0, 0.8, 0],
    fov: 60,
    videoUrl: "/videos/Jason_cam_03.mov",
    offset: syncDefaults.cam3 ?? 0,
  },
  {
    id: "cam4",
    name: "CAM 04 · SW · Window",
    position: [-2.1, 2.7, 6.45],
    // Partial coverage: aimed farther to its right (toward the orange-wall side,
    // +x) rather than at the room center. Adjust independently of the others.
    target: [2.0, 0.6, 2.2],
    fov: 60,
    videoUrl: "/videos/Jason_Cam_04.mov",
    offset: syncDefaults.cam4 ?? 0,
  },
];

export function getCamera(id: string | null | undefined) {
  return securityCameras.find((c) => c.id === id);
}

/** Aspect ratio used to draw coverage frustums (physical camera sensor aspect). */
export const CCTV_ASPECT = 16 / 9;
/** Length (m) of drawn coverage frustums. */
export const FRUSTUM_LENGTH = 4;
