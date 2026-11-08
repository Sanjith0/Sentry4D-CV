import * as THREE from "three";
import { CCTV_ASPECT } from "../config/cctv";
import type { CameraPoseConfig, RoomBounds, Vec3 } from "../types/security";
import { poseQuaternion } from "./cameraMath";

/**
 * Video-pixel ↔ room-floor projection for calibrated CCTV cameras.
 *
 * Conventions (must match how the cameras were calibrated in the app):
 * - The calibrated pose's `fov` is the VERTICAL FOV of a 16:9 sensor box (CCTV_ASPECT).
 * - The recording is fitted ("contain") into that box, exactly like VideoMirror draws it
 *   in the calibration overlay. For 16:9 recordings the frame fills the box.
 * - Pixels are NORMALIZED [u, v] in the upright *displayed* frame: the browser has
 *   already applied the file's rotation metadata, then `videoRotation` (config) is
 *   applied. (0,0) = top-left, (1,1) = bottom-right. They are not CSS coordinates.
 * - World: meters, Y-up, floor plane y = 0.
 */

export interface VideoFrameInfo {
  /** Decoded frame size as reported by HTMLVideoElement.videoWidth/videoHeight. */
  width: number;
  height: number;
  /** Extra display rotation from camera config (degrees clockwise). */
  rotation?: number;
}

export type ProjectionStatus = "ok" | "warning" | "invalid";
export type ProjectionConfidence = "high" | "medium" | "low" | "none";

export interface PixelToWorldResult {
  valid: boolean;
  status: ProjectionStatus;
  /** Human-readable reason for warning/invalid. */
  reason: string | null;
  worldPosition: Vec3 | null;
  /** Camera → floor point distance (m). */
  distance: number | null;
  /** Angle between the view ray and the floor plane (deg). Small = grazing = unreliable. */
  incidenceDeg: number | null;
  /** Floor meters covered by one source-video pixel at this point. */
  metersPerPixel: number | null;
  /** Expected position error for a ±FOOT_CLICK_PX click error (m). */
  expectedErrorM: number | null;
  confidence: ProjectionConfidence;
  ndc: [number, number] | null;
}

/** Assumed click uncertainty when picking feet, in source pixels. */
export const FOOT_CLICK_PX = 6;
const MAX_RANGE_M = 40;
/** Scan hits below this height (m) count as floor, not an occluder. */
const OCCLUDER_MIN_HEIGHT = 0.25;
const ROOM_MARGIN_M = 0.5;

/** Aspect ratio of the upright displayed frame. */
export function displayedAspect(frame: VideoFrameInfo) {
  const quarter = ((frame.rotation ?? 0) / 90) % 2 !== 0;
  return quarter ? frame.height / frame.width : frame.width / frame.height;
}

/** Displayed frame size in source pixels (for pixel-error reporting). */
export function displayedSize(frame: VideoFrameInfo): [number, number] {
  const quarter = ((frame.rotation ?? 0) / 90) % 2 !== 0;
  return quarter ? [frame.height, frame.width] : [frame.width, frame.height];
}

/** A Three.js camera reproducing a calibrated CCTV camera (16:9 sensor). */
export function buildCctvCamera(pose: CameraPoseConfig) {
  const cam = new THREE.PerspectiveCamera(pose.fov, CCTV_ASPECT, 0.01, 500);
  cam.position.set(...pose.position);
  poseQuaternion(pose, cam.quaternion);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  return cam;
}

/** Normalized frame pixel → sensor NDC, accounting for letterboxing into the 16:9 box. */
export function frameToNdc(u: number, v: number, frameAspect: number): [number, number] {
  let x = 2 * u - 1;
  let y = 1 - 2 * v;
  if (frameAspect < CCTV_ASPECT) x *= frameAspect / CCTV_ASPECT; // pillarboxed
  else if (frameAspect > CCTV_ASPECT) y *= CCTV_ASPECT / frameAspect; // letterboxed
  return [x, y];
}

export function ndcToFrame(x: number, y: number, frameAspect: number): [number, number] {
  if (frameAspect < CCTV_ASPECT) x /= frameAspect / CCTV_ASPECT;
  else if (frameAspect > CCTV_ASPECT) y /= CCTV_ASPECT / frameAspect;
  return [(x + 1) / 2, (1 - y) / 2];
}

const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();

function intersectFloor(cam: THREE.PerspectiveCamera, ndc: [number, number]) {
  _ndc.set(ndc[0], ndc[1]);
  _ray.setFromCamera(_ndc, cam);
  const { origin, direction } = _ray.ray;
  if (direction.y >= -1e-6) return { hit: null, origin: origin.clone(), direction: direction.clone() };
  const t = -origin.y / direction.y;
  return { hit: origin.clone().addScaledVector(direction, t), origin: origin.clone(), direction: direction.clone(), t };
}

const invalid = (reason: string, ndc: [number, number] | null = null): PixelToWorldResult => ({
  valid: false,
  status: "invalid",
  reason,
  worldPosition: null,
  distance: null,
  incidenceDeg: null,
  metersPerPixel: null,
  expectedErrorM: null,
  confidence: "none",
  ndc,
});

/**
 * Project a normalized video pixel (e.g. a person's feet) onto the room floor (y = 0).
 * @param bounds measured room bounds; points beyond them (+0.5 m) are rejected.
 */
export function videoPixelToWorld(
  pose: CameraPoseConfig,
  pixel: [number, number],
  frame: VideoFrameInfo,
  bounds?: RoomBounds | null,
  /** Optional scan meshes: warns when the ray hits a wall/furniture before the floor. */
  occluders?: THREE.Object3D[],
): PixelToWorldResult {
  const [u, v] = pixel;
  if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) return invalid("Pixel is outside the video frame.");
  if (!(frame.width > 0 && frame.height > 0)) return invalid("Video frame size unknown (not loaded).");
  if (!(pose.fov > 1 && pose.fov < 179)) return invalid("Camera FOV is invalid.");

  const aspect = displayedAspect(frame);
  const ndc = frameToNdc(u, v, aspect);
  const cam = buildCctvCamera(pose);
  const r = intersectFloor(cam, ndc);
  if (!r.hit) return invalid("Ray points at or above the horizon; it never reaches the floor.", ndc);
  if (pose.position[1] <= 0) return invalid("Camera is not above the floor.", ndc);
  if (r.t! > MAX_RANGE_M) return invalid(`Floor hit is ${r.t!.toFixed(1)} m away (> ${MAX_RANGE_M} m).`, ndc);

  const p = r.hit;
  const world: Vec3 = [p.x, 0, p.z];
  const incidenceDeg = (Math.asin(Math.min(1, -r.direction.y)) * 180) / Math.PI;

  // Sensitivity: how far the floor point moves for a 1 source-pixel change.
  const [dw, dh] = displayedSize(frame);
  let mpp = 0;
  for (const [du, dv] of [
    [1 / dw, 0],
    [0, 1 / dh],
  ]) {
    const q = intersectFloor(cam, frameToNdc(Math.min(1, u + du), Math.min(1, v + dv), aspect)).hit;
    mpp = q ? Math.max(mpp, q.distanceTo(p)) : Infinity;
  }
  const expectedErrorM = mpp * FOOT_CLICK_PX;

  let status: ProjectionStatus = "ok";
  let reason: string | null = null;
  if (bounds) {
    const out =
      p.x < bounds.min[0] - ROOM_MARGIN_M ||
      p.x > bounds.max[0] + ROOM_MARGIN_M ||
      p.z < bounds.min[2] - ROOM_MARGIN_M ||
      p.z > bounds.max[2] + ROOM_MARGIN_M;
    if (out) return { ...invalid("Point lands outside the measured room bounds.", ndc), worldPosition: world, distance: r.t!, incidenceDeg };
    const edge = p.x < bounds.min[0] || p.x > bounds.max[0] || p.z < bounds.min[2] || p.z > bounds.max[2];
    if (edge) {
      status = "warning";
      reason = "Just outside the room walls (within 0.5 m tolerance).";
    }
  }

  let confidence: ProjectionConfidence = !Number.isFinite(expectedErrorM) ? "low" : expectedErrorM < 0.1 ? "high" : expectedErrorM < 0.3 ? "medium" : "low";
  if (incidenceDeg < 5) confidence = "low";
  if (occluders?.length && status === "ok") {
    intersectFloor(cam, ndc); // re-aim the shared raycaster at the clicked pixel
    _ray.far = r.t! - 0.05;
    const hit = _ray.intersectObjects(occluders, false).find((h) => h.point.y > OCCLUDER_MIN_HEIGHT);
    _ray.far = Infinity;
    if (hit) {
      status = "warning";
      reason = `Ray hits scanned geometry ${hit.distance.toFixed(1)} m out (${hit.point.y.toFixed(2)} m high) before the floor: feet may be hidden there, or the camera calibration is off.`;
      if (confidence === "high") confidence = "medium";
    }
  }
  if (confidence === "low" && status === "ok") {
    status = "warning";
    reason = `Grazing view: a ${FOOT_CLICK_PX}px click error moves the point ~${Number.isFinite(expectedErrorM) ? expectedErrorM.toFixed(2) : "∞"} m.`;
  }

  return {
    valid: true,
    status,
    reason,
    worldPosition: world,
    distance: r.t!,
    incidenceDeg,
    metersPerPixel: mpp,
    expectedErrorM,
    confidence,
    ndc,
  };
}

export interface WorldToPixelResult {
  pixel: [number, number] | null;
  /** In front of the camera and inside the displayed frame. */
  inFrame: boolean;
  behind: boolean;
}

/** Project a world point into a camera's displayed video frame (normalized pixel). */
export function worldToVideoPixel(pose: CameraPoseConfig, world: Vec3, frame: VideoFrameInfo): WorldToPixelResult {
  const cam = buildCctvCamera(pose);
  const p = new THREE.Vector3(...world);
  const local = p.clone().applyMatrix4(cam.matrixWorldInverse);
  if (local.z >= -1e-6) return { pixel: null, inFrame: false, behind: true };
  p.project(cam);
  const px = ndcToFrame(p.x, p.y, displayedAspect(frame));
  const inFrame = px[0] >= 0 && px[0] <= 1 && px[1] >= 0 && px[1] <= 1;
  return { pixel: px, inFrame, behind: false };
}

/** Reprojection error in source pixels between a clicked pixel and a reprojected one. */
export function pixelError(a: [number, number], b: [number, number], frame: VideoFrameInfo) {
  const [w, h] = displayedSize(frame);
  return Math.hypot((a[0] - b[0]) * w, (a[1] - b[1]) * h);
}
