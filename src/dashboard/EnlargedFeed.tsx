import { ChevronLeft, ChevronRight, Eye, X } from "lucide-react";
import { getCamera, securityCameras } from "../config/cameras";
import { useReplayStore } from "../store/useReplayStore";
import { useViewStore } from "../store/useViewStore";
import { formatClock, formatWallClock } from "../lib/format";
import { VideoMirror } from "./VideoMirror";

/** Large view of one feed, floating over the 3D viewport. Mirrors the synced sidebar video. */
export function EnlargedFeed() {
  const id = useViewStore((s) => s.focusedFeedId);
  const syncOpen = useViewStore((s) => s.syncPanelOpen);
  const setFocusedFeed = useViewStore((s) => s.setFocusedFeed);
  const t = useReplayStore((s) => s.currentTime);
  const selectCamera = useReplayStore((s) => s.selectCamera);
  const viewThroughCamera = useReplayStore((s) => s.viewThroughCamera);
  const cam = getCamera(id);
  const offset = useReplayStore((s) => (cam ? (s.cameraOffsets[cam.id] ?? 0) : 0));
  const feed = useReplayStore((s) => (cam ? s.feeds[cam.id] : null));
  if (!cam || syncOpen) return null;

  const idx = securityCameras.indexOf(cam);
  const step = (d: number) => {
    const next = securityCameras[(idx + d + securityCameras.length) % securityCameras.length];
    setFocusedFeed(next.id);
    selectCamera(next.id);
  };
  const vt = t + offset;
  const recording = feed?.status === "ready" && feed.duration != null && vt >= 0 && vt <= feed.duration;

  return (
    <div className="glass pointer-events-auto absolute right-3 bottom-3 z-40 w-[min(62%,760px)] overflow-hidden rounded-lg !border-cyan-400/50 shadow-2xl fade-in">
      <div className="flex items-center gap-2 border-b border-ink-600 px-2.5 py-1.5">
        {recording && <span className="rec-dot h-2 w-2 rounded-full bg-red-500" />}
        <span className="font-mono text-xs text-slate-100">{cam.name}</span>
        <span className="font-mono text-[10px] text-slate-500">
          {formatWallClock(t)} · VID {formatClock(vt)} · offset {offset >= 0 ? "+" : ""}
          {offset.toFixed(2)}s
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button type="button" title="Previous camera" onClick={() => step(-1)} className="rounded p-1 text-slate-400 hover:text-slate-100">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button type="button" title="Next camera" onClick={() => step(1)} className="rounded p-1 text-slate-400 hover:text-slate-100">
            <ChevronRight className="h-4 w-4" />
          </button>
          <button
            type="button"
            title="View through this camera in 3D"
            onClick={() => viewThroughCamera(cam.id)}
            className="rounded p-1 text-slate-400 hover:text-cyan-300"
          >
            <Eye className="h-4 w-4" />
          </button>
          <button type="button" title="Close (Esc)" onClick={() => setFocusedFeed(null)} className="rounded p-1 text-slate-400 hover:text-slate-100">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="relative aspect-video bg-black">
        {feed?.status === "ready" ? (
          <VideoMirror cameraId={cam.id} rotation={cam.videoRotation ?? 0} className={recording ? "" : "opacity-30 grayscale"} />
        ) : (
          <div className="grid h-full place-items-center font-mono text-xs text-slate-400">{feed?.status === "loading" ? "LOADING…" : (feed?.error ?? "UNAVAILABLE")}</div>
        )}
        {feed?.status === "ready" && !recording && (
          <div className="absolute inset-0 grid place-items-center font-mono text-xs text-slate-300">{vt < 0 ? "NOT RECORDING YET" : "RECORDING ENDED"}</div>
        )}
        <div className="scanlines absolute inset-0 opacity-50" />
      </div>
    </div>
  );
}
