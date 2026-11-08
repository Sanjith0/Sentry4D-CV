import type { CameraId } from "../types/security";

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
