import type { CameraId } from "../../types/security";

/**
 * Evidence class of what is on screen (REPORT.md §E).
 * - observed:      original camera pixels seen from (or very near) their own camera viewpoint
 * - reconstructed: original pixels re-projected to a viewpoint no camera occupied
 * - generated:     content synthesized by a prior (never produced by this module)
 */
export type EvidenceClass = "observed" | "reconstructed" | "generated";

/** One RGBA crop of real footage (from experiments/reconstruction/segmentation/export_sprites.py). */
export interface AppearanceFrame {
  k: number;
  masterTime: number;
  videoTime: number;
  sourcePts?: number;
  /** Relative to the clip folder, or null when no usable mask exists for this frame. */
  file: string | null;
  /** Normalized [u0, v0, u1, v1] of the crop in the upright displayed frame. */
  crop?: [number, number, number, number];
  cropPx?: [number, number, number, number];
  maskArea?: number;
  /** Lowest mask pixel [x, y] in source pixels (≈ feet when the legs are visible). */
  maskBottomPx?: [number, number];
  maskMethod?: string;
  /** Inflated-silhouette height map (PNG, 0..255 of inflateMaxPx) used to give the cut-out volume. */
  depthFile?: string;
  inflateMaxPx?: number;
  /** Mean sRGB colour of the person's pixels (shades surfaces no camera saw). */
  meanColor?: [number, number, number];
  samVsBackgroundIoU?: number | null;
  backgroundDriftPx?: [number, number];
  reason?: string;
}

export interface AppearanceClipManifest {
  clip: string;
  personId: string;
  subjectId: string;
  fps: number;
  t0: number;
  t1: number;
  frameCount: number;
  syncOffsets: Record<CameraId, number>;
  cameras: Partial<Record<CameraId, { width: number; height: number; frames: AppearanceFrame[] }>>;
}

/** What the renderer is showing right now (published for HUD/labels; updated only on change). */
export interface AppearanceStatus {
  subjectId: string;
  active: boolean;
  cameraId: CameraId | null;
  /** Angle between the viewer's and the source camera's view of the subject (degrees). */
  offSourceDeg: number | null;
  evidence: EvidenceClass | null;
  clip: string | null;
  frameK: number | null;
  /** Height (m) at which the source camera's lowest mask pixel meets the sprite plane. */
  feetHeightM: number | null;
  /** The 3D position is interpolated across a gap in floor observations (not measured). */
  positionEstimated: boolean;
  reason: string | null;
}

/**
 * Per-frame motion of the reconstructed 3D body (avatar.json, written by
 * experiments/reconstruction/avatar). Frame k <-> masterTime = t0 + k / fps. Unknown keys are ignored.
 */
export interface AvatarMotion {
  version: number;
  clip: string;
  subjectId: string;
  personId: string;
  /** GLB path relative to /reconstruction/<clip>/. */
  glb: string;
  fps: number;
  t0: number;
  t1: number;
  frameCount: number;
  heightM: number;
  /** Set by the pipeline's stand-in asset: an untextured test body, not a reconstruction. */
  placeholder?: boolean;
  frames: {
    /** Pelvis position in room metres (Y-up, floor y = 0). */
    root: [number, number, number][];
    /** Point on the floor under the body [x, z]. */
    floor: [number, number][];
    /** Body yaw (rad); 0 = facing +Z, same convention as SubjectState.rotationY. */
    heading: number[];
    /** How many cameras gave a usable detection of the body in this frame (0..4). */
    cameras: number[];
    /** The fitted pose is usable. */
    valid: boolean[];
    /** At least one camera observed the person in this frame (false: pose carried by neighbouring frames). */
    observed?: boolean[];
    /** Height (m) of the scanned room floor under the body; the fit stands the feet on it. Absent = 0. */
    floorY?: number[];
  };
  /** Accuracy of the delivered asset measured against the footage (experiments/reconstruction/avatar/validate.py). */
  metrics?: Record<string, unknown>;
}

/** Reconstructed body state on the floor at one master time (interpolated between frames). */
export interface AvatarFloorSample {
  x: number;
  /** Height of the scanned floor under the body (0 when the asset does not carry it). */
  y: number;
  z: number;
  heading: number;
  /** Cameras whose detections of the body support the pose at the nearest frame (can be fewer than the cameras marked as tracking). */
  cameras: number;
  /** The nearest frame's pose is usable. */
  valid: boolean;
  /** Nearest frame index. */
  k: number;
  /** Time (s) on the GLB's baked "motion" clip that shows this same instant. */
  clipTime: number;
  clip: string;
}

/** What the 3D MODEL renderer is showing right now (published for HUD/labels; updated only on change). */
export interface AvatarStatus {
  subjectId: string;
  active: boolean;
  clip: string | null;
  frameK: number | null;
  /** Cameras the pose is fitted from at this instant (usable detections of the body), or null when inactive. */
  cameras: number | null;
  /** The asset on disk is the pipeline's untextured stand-in, not a reconstruction. */
  placeholder: boolean;
  /** The loaded GLB carries a colour texture (false: neutral grey body, no footage applied). */
  textured: boolean;
  reason: string | null;
}
