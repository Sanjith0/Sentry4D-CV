import type { SecurityCamera } from "../types/security";

/**
 * Virtual counterparts of the four physical CCTV cameras.
 * Coordinates: room space, Y-up, meters, floor at y = 0 (after auto-grounding).
 *
 * Room (after grounding): x ∈ [-2.4, 2.4] (window wall at x = -2.4), z ∈ [-6.78, 6.78],
 * floor y = 0, ceiling ≈ 3.05. Cameras sit in the four interior corners, 0.3 m in from
 * the walls, 2.7 m high, aimed at the room center.
 * These are corner estimates — fine-tune to the physical mounts if needed.
 * Tip: fly to the camera spot in free mode, aim, then click "Copy pose" in the
 * viewer toolbar to get a JSON snippet for this file.
 */
export const securityCameras: SecurityCamera[] = [
  {
    id: "cam1",
    name: "CAM 01 · NW · Window",
    position: [-2.1, 2.7, -6.45],
    target: [0, 0.8, 0],
    fov: 60,
    videoUrl: "/videos/cam1.mp4",
    timeOffset: 0,
  },
  {
    id: "cam2",
    name: "CAM 02 · NE",
    position: [2.1, 2.7, -6.45],
    target: [0, 0.8, 0],
    fov: 60,
    videoUrl: "/videos/cam2.mp4",
    timeOffset: 0,
  },
  {
    id: "cam3",
    name: "CAM 03 · SE",
    position: [2.1, 2.7, 6.45],
    target: [0, 0.8, 0],
    fov: 60,
    videoUrl: "/videos/cam3.mp4",
    timeOffset: 0,
  },
  {
    id: "cam4",
    name: "CAM 04 · SW · Window",
    position: [-2.1, 2.7, 6.45],
    target: [0, 0.8, 0],
    fov: 60,
    videoUrl: "/videos/cam4.mp4",
    timeOffset: 0,
  },
];

/** Aspect ratio used to draw coverage frustums (physical camera sensor aspect). */
export const CCTV_ASPECT = 16 / 9;
/** Length (m) of drawn coverage frustums. */
export const FRUSTUM_LENGTH = 4;
