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
  maskMethod?: "sam2" | "sam2+background" | "background-subtraction" | "manual";
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
