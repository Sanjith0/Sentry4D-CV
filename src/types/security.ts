/**
 * Shared Sentry3D contracts. Imported by both the viewer shell and the
 * sentry feature (SceneActors). Coordinate system: Y-up, meters, room floor at y = 0.
 */
export type Vec3 = [number, number, number];

export interface PersonKeyframe {
  time: number;
  position: Vec3;
  rotationY?: number;
  visibleCameras: string[];
}

export interface ObjectKeyframe {
  time: number;
  position: Vec3;
  rotationY: number;
}

export interface IncidentEvent {
  id: string;
  time: number;
  /** Free-form type string. Colors are resolved via config/incident.ts `eventTypeStyles`. */
  type: string;
  entityId?: string;
  description: string;
}

/** Stable camera IDs. Use these everywhere (tracking data, visibleCameras, events). */
export const CAMERA_IDS = ["cam1", "cam2", "cam3", "cam4"] as const;
export type CameraId = (typeof CAMERA_IDS)[number];

/**
 * Calibrated pose of a virtual camera (stored in src/config/camera-poses.json,
 * edited live in the Calibrate panel). Angles in degrees, Euler order YXZ:
 * yaw 0 looks toward -Z, positive yaw turns left; positive pitch looks up;
 * positive roll rotates the image counter-clockwise.
 */
export interface CameraPoseConfig {
  position: Vec3;
  yaw: number;
  pitch: number;
  roll: number;
  /** Vertical field of view of the 16:9 sensor, degrees. */
  fov: number;
}

export interface SecurityCamera {
  id: CameraId;
  name: string;
  position: Vec3;
  /** Point 3 m along the view direction (derived from yaw/pitch). */
  target: Vec3;
  yaw: number;
  pitch: number;
  roll: number;
  /** Vertical field of view in degrees (16:9 sensor). */
  fov: number;
  videoUrl: string;
  /**
   * Default sync offset in seconds: videoTime = masterTime + offset.
   * Runtime value lives in the replay store (`cameraOffsets`), editable in the
   * Camera Sync panel and persisted to localStorage. Defaults: config/camera-sync.json.
   */
  offset: number;
  /** Clockwise display rotation for the recording (e.g. an upside-down mount). Default 0. */
  videoRotation?: 0 | 90 | 180 | 270;
}

/** Load/playback state of one CCTV recording. */
export type FeedStatus = "loading" | "ready" | "missing" | "unsupported" | "error";

export interface CameraFeedState {
  cameraId: CameraId;
  status: FeedStatus;
  /** Recording length in seconds, once metadata has loaded. */
  duration: number | null;
  error?: string;
}

/**
 * Per-camera coverage at a master time, from `useReplayStore.getState().getCameraCoverage(t)`.
 * `recording` is true when the camera has footage at that instant.
 */
export interface CameraCoverage {
  cameraId: CameraId;
  offset: number;
  videoTime: number;
  recording: boolean;
  status: FeedStatus;
}

/**
 * Optional contract for tracking output: an entity seen in a camera's footage.
 * Times are MASTER times; bbox is normalized [x, y, w, h] in the video frame (0..1).
 */
export interface EntityCameraVisibility {
  entityId: string;
  cameraId: CameraId;
  time: number;
  bbox?: [number, number, number, number];
  confidence?: number;
}

export type CameraMode = "free" | "orbit" | "topdown" | "cctv";

export interface RoomBounds {
  min: Vec3;
  max: Vec3;
  size: Vec3;
  center: Vec3;
}

/** Info shown in the incident panel for whatever entity is selected in the scene. */
export interface SelectedEntityInfo {
  id: string;
  label: string;
  kind: "person" | "object" | string;
  details?: Record<string, string>;
}

/**
 * Contract for the sentry feature's root scene component.
 * Rendered inside the R3F <Canvas>. Everything must be derived from `currentTime`
 * so seeking reproduces scene state deterministically.
 *
 * For per-frame reads without React re-renders, use
 * `useReplayStore.getState().currentTime` inside useFrame.
 */
export interface SceneActorsProps {
  currentTime: number;
  xrayEnabled: boolean;
  sentryEnabled: boolean;
  /** Room bounds in world space (after RoomModel transform), null while loading. */
  roomBounds: RoomBounds | null;
  cameras: SecurityCamera[];
  /** Live sync offsets by camera ID (videoTime = masterTime + offset). */
  cameraOffsets: Record<CameraId, number>;
}

/** How an annotation was produced. "manual" = clicked feet in a real video frame. */
export type ObservationSource = "manual" | "manual-topdown";

/**
 * One annotated position of a real person, in MASTER time.
 * (videoTime = masterTime + offset, so masterTime = videoTime - offset.)
 */
export interface PersonObservation {
  id: string;
  masterTime: number;
  cameraId: CameraId;
  /** Normalized [u, v] in the upright displayed video frame: (0,0) top-left, (1,1) bottom-right. */
  pixel: [number, number];
  /** Room-space floor position [x, 0, z] in meters. */
  worldPosition: Vec3;
  source: ObservationSource;
  /** Video timestamp at annotation time (informational; masterTime is authoritative). */
  videoTime?: number;
}

/**
 * Per-camera visibility evidence, in MASTER time. A feet click (PersonObservation)
 * is implicit "observed" evidence; marks add explicit states, including negative
 * ones. A camera recording at time t does NOT imply it sees the person.
 */
export type VisibilityState = "observed" | "occluded" | "out-of-frame" | "unknown";

export interface VisibilityMark {
  id: string;
  masterTime: number;
  cameraId: CameraId;
  state: VisibilityState;
  source: "manual";
}

/** Export/import format for one person's annotations. */
export interface PersonAnnotationDataset {
  personId: string;
  observations: PersonObservation[];
  /** Explicit per-camera visibility marks (optional for older files). */
  visibility?: VisibilityMark[];
}
