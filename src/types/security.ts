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

export interface SecurityCamera {
  id: string;
  name: string;
  position: Vec3;
  target: Vec3;
  /** Vertical field of view in degrees. */
  fov: number;
  videoUrl: string;
  /**
   * Master-timeline time (seconds) at which this recording's frame 0 occurs.
   * videoTime = masterTime - timeOffset.
   */
  timeOffset: number;
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
}
