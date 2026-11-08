import { useEffect, useState } from "react";
import { videoRegistry } from "../../lib/videoRegistry";
import { useReplayStore } from "../../store/useReplayStore";
import type { CameraId } from "../../types/security";
import type { VideoFrameInfo } from "../../lib/videoProjection";

export interface FrameState {
  /** Decoded frame size (+ configured display rotation), null until loaded. */
  frame: VideoFrameInfo | null;
  /** The displayed frame matches the master time (not seeking/drifting) and the camera is recording. */
  settled: boolean;
  inRange: boolean;
  videoTime: number;
}

/**
 * Watches a camera's registered <video> so annotation clicks are only accepted
 * once the frame on screen really is the frame at the current master time.
 */
export function useFrameState(cameraId: CameraId, rotation = 0): FrameState {
  const [state, setState] = useState<FrameState>({ frame: null, settled: false, inRange: false, videoTime: 0 });

  useEffect(() => {
    let raf = 0;
    let prev = "";
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const v = videoRegistry.get(cameraId);
      const s = useReplayStore.getState();
      const vt = s.currentTime + (s.cameraOffsets[cameraId] ?? 0);
      const ready = !!v && v.readyState >= 2 && v.videoWidth > 0;
      const dur = v?.duration ?? NaN;
      const inRange = ready && vt >= 0 && Number.isFinite(dur) && vt <= dur;
      const settled = inRange && !v!.seeking && Math.abs(v!.currentTime - vt) < 0.04;
      const frame = ready ? { width: v!.videoWidth, height: v!.videoHeight, rotation } : null;
      const key = `${frame?.width}x${frame?.height}|${settled}|${inRange}|${vt.toFixed(3)}`;
      if (key !== prev) {
        prev = key;
        setState({ frame, settled, inRange, videoTime: vt });
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [cameraId, rotation]);

  return state;
}
