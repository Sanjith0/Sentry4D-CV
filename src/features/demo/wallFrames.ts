import { securityCameras } from "../../config/cameras";
import { videoRegistry } from "../../lib/videoRegistry";
import { useReplayStore } from "../../store/useReplayStore";
import type { CameraId } from "../../types/security";

/**
 * The frame a recording showed when it was cut (see DemoScript.cuts): the wall keeps drawing it while the
 * recording finds the frame it jumped to, and until the script has that one uncovered (WallState.keep).
 */
export interface KeptFrame {
  canvas: HTMLCanvasElement;
  /** Time in the recording (s) it jumped to. */
  target: number;
  /** performance.now() when it was kept. */
  at: number;
  /** Draws in a row on which the recording had its new frame. */
  fresh: number;
  /** The script has begun to uncover the new frame (WallState.keep was given). */
  swept: boolean;
  /** The new frame was not there when the script began to uncover it: it is dissolved in instead. */
  late: boolean;
  /** Demo time the dissolve began at. */
  fadeFrom: number | null;
}

const kept = new Map<CameraId, KeptFrame>();
/** One canvas per camera, made once (behind the loading card) and used again. */
const canvases = new Map<CameraId, HTMLCanvasElement>();

/** The recordings are about to jump to incident time T: keep the frame each of them shows now. */
export function keepWallFrames(T: number) {
  const offsets = useReplayStore.getState().cameraOffsets;
  for (const cam of securityCameras.slice(0, 4)) {
    const video = videoRegistry.get(cam.id);
    if (!video || video.error || video.readyState < 2 || !video.videoWidth) continue;
    let canvas = canvases.get(cam.id);
    if (!canvas) canvases.set(cam.id, (canvas = document.createElement("canvas")));
    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    const g = canvas.getContext("2d");
    if (!g) continue;
    g.drawImage(video, 0, 0);
    kept.set(cam.id, { canvas, target: T + (offsets[cam.id] ?? 0), at: performance.now(), fresh: 0, swept: false, late: false, fadeFrom: null });
  }
}

export const keptFrame = (id: CameraId) => kept.get(id);
export const dropKeptFrame = (id: CameraId) => kept.delete(id);
export const dropWallFrames = () => kept.clear();
