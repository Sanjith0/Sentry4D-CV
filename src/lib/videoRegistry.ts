import type { CameraId } from "../types/security";
import { getCamera } from "../config/cameras";
import type { VideoFrameInfo } from "./videoProjection";

/**
 * Registry of the live <video> element for each camera. The CCTV feeds own the
 * elements (and their decoders); other views (enlarged feed, sync preview)
 * mirror them onto canvases instead of creating extra decoders or moving the
 * element in the DOM (which would pause it).
 */
const videos = new Map<CameraId, HTMLVideoElement>();
const listeners = new Set<() => void>();

export const videoRegistry = {
  set(id: CameraId, el: HTMLVideoElement | null) {
    if (el) videos.set(id, el);
    else videos.delete(id);
    listeners.forEach((l) => l());
  },
  get(id: CameraId) {
    return videos.get(id) ?? null;
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};

/** Recorded frame size (all four recordings are 1920×1080), used before a video has loaded. */
export const DEFAULT_FRAME = { width: 1920, height: 1080 };

/** Frame info for a camera from its registered video element (null until loaded). */
export function frameInfoFor(id: CameraId): VideoFrameInfo | null {
  const v = videoRegistry.get(id);
  const cam = getCamera(id);
  return v && v.videoWidth ? { width: v.videoWidth, height: v.videoHeight, rotation: cam?.videoRotation ?? 0 } : null;
}

/** Like frameInfoFor, but falls back to the known recording size so math works before load. */
export function frameInfoOrDefault(id: CameraId): VideoFrameInfo {
  return frameInfoFor(id) ?? { ...DEFAULT_FRAME, rotation: getCamera(id)?.videoRotation ?? 0 };
}
