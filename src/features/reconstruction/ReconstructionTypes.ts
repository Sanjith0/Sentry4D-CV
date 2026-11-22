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
  /** The calibration the body was fitted with; lets the viewer put the footage back onto the body (version >= 2). */
  projection?: AvatarProjection;
  /** Rigid objects the person handles (a carried chair), each with its own GLB and per-frame pose. */
  props?: AvatarProp[];
}

/**
 * One camera as the avatar pipeline refined it (OpenCV convention, pixels of the upright frame):
 *   x_cam = R X + t,  pixel = f * xn * (1 + k1 * |xn|^2) + (cx, cy)  with xn = x_cam.xy / x_cam.z.
 * X is in FIT coordinates: room metres as the cameras see them. The viewer draws the body `lift`
 * higher (it stands on the scanned floor), so X = displayed position - (0, lift, 0).
 */
export interface AvatarProjectionCamera {
  f: number;
  cx: number;
  cy: number;
  k1: number;
  /** Residual clock offset (s): this camera's image k shows the body at clip time k / fps - dt. */
  dt: number;
  /** Rows of the world -> camera rotation. */
  R: [number, number, number][];
  t: [number, number, number];
  /** Camera centre. */
  C: [number, number, number];
}

export interface AvatarProjection {
  /** Size of the camera frames in pixels [width, height]. */
  frame: [number, number];
  cameras: Partial<Record<CameraId, AvatarProjectionCamera>>;
  /** Per frame: height (m) the body is displayed above where the cameras see it. */
  lift: number[];
  /**
   * Per camera and frame: pixel rectangle [x0, y0, x1, y1] inside which that frame's footage matte is
   * authoritative (the exporter clipped the mask to the tracked box), or null without a cut-out.
   */
  known?: Partial<Record<CameraId, ([number, number, number, number] | null)[]>>;
  /**
   * Per camera and frame: where that frame's cut-out belongs on the fitted body, as [a, bx, by] with
   * body pixel = a * footage pixel + (bx, by) in the pixel coordinates of cropPx; null: as filmed.
   * (Close to a wide-angle lens or at the edge of its frame the calibration is tens of pixels off.)
   */
  register?: Partial<Record<CameraId, ([number, number, number] | null)[]>>;
  /** Per camera and frame: false when the cut-out still disagrees with the body and is not projected onto it. */
  use?: Partial<Record<CameraId, (boolean | null)[]>>;
}

/** A rigid object reconstructed next to the body. Vertex v of its GLB is at R(quat) v + pos (+ lift on y when displayed). */
export interface AvatarProp {
  id: string;
  kind: string;
  /** GLB path relative to /reconstruction/<clip>/. */
  glb: string;
  /**
   * The pieces the object is built from (= the names of the GLB's mesh nodes), in the bit order of
   * `frames.cut`: for the chair its two panels and every leg in short lengths.
   */
  pieces?: string[];
  frames: {
    /** Position in fit coordinates per frame. */
    pos: [number, number, number][];
    /** Orientation per frame (x, y, z, w). */
    quat: [number, number, number, number][];
    /** Height (m) the object is displayed above its fit position. */
    lift: number[];
    /** In the person's hands (off the floor). */
    held?: boolean[];
    /** Draw the object in this frame (absent: always). */
    visible?: boolean[];
    /** Per camera and frame: 1 when that camera's footage matte contains this object. */
    inMatte?: Partial<Record<CameraId, number[]>>;
    /**
     * Per camera and frame: bit j set when that camera's matte really shows piece j of `pieces`. A matte
     * that contains the object rarely has all of it (the chair's panels, but only part of its thin legs),
     * so next to that camera only these pieces are cut to the matte's outline; the others are drawn
     * from the proxy. 0: nothing is cut. Absent: `inMatte` decides for the object as a whole.
     */
    cut?: Partial<Record<CameraId, number[]>>;
  };
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
  /**
   * Footage-on-model look only: cameras whose pixels of this frame are projected onto the body, the
   * one closest to the viewing direction and the angle to it (degrees). Null in the plain 3D model look.
   */
  footage?: { cameras: CameraId[]; nearest: CameraId | null; offDeg: number | null } | null;
  reason: string | null;
}
