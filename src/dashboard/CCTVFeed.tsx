import { useEffect, useRef, useState } from "react";
import { Eye, Maximize2, Minimize2, VideoOff } from "lucide-react";
import { useReplayStore } from "../store/useReplayStore";
import { useViewStore } from "../store/useViewStore";
import type { SecurityCamera } from "../types/security";
import { formatClock, formatWallClock } from "../lib/format";

type FeedStatus = "loading" | "ready" | "missing" | "error";

/** Drift (s) beyond which we hard-seek during playback. Below it we nudge playbackRate. */
const HARD_DRIFT = 0.35;
const SOFT_DRIFT = 0.06;
const PAUSED_DRIFT = 0.08;

/**
 * Keeps a <video> slaved to the master clock. The video never drives time.
 * Hard seeks only on explicit timeline seeks or large drift, to avoid stutter.
 */
function useVideoSync(video: React.RefObject<HTMLVideoElement | null>, cam: SecurityCamera, status: FeedStatus) {
  const [inRange, setInRange] = useState(true);
  const inRangeRef = useRef(true);

  useEffect(() => {
    const v = video.current;
    if (!v || status !== "ready") return;

    const sync = (hard: boolean) => {
      const s = useReplayStore.getState();
      const vt = s.currentTime - cam.timeOffset;
      const dur = v.duration;
      const ok = vt >= 0 && (!Number.isFinite(dur) || vt <= dur - 0.02);
      if (ok !== inRangeRef.current) {
        inRangeRef.current = ok;
        setInRange(ok);
      }
      if (!ok) {
        if (!v.paused) v.pause();
        if (hard && Number.isFinite(dur)) v.currentTime = Math.min(Math.max(vt, 0), dur);
        return;
      }

      const drift = v.currentTime - vt;
      if (s.isPlaying) {
        if (hard || Math.abs(drift) > HARD_DRIFT) {
          if (!v.seeking || hard) v.currentTime = vt;
          v.playbackRate = s.playbackSpeed;
        } else if (Math.abs(drift) > SOFT_DRIFT) {
          // Gentle catch-up instead of seeking: ±8% rate.
          v.playbackRate = s.playbackSpeed * (drift > 0 ? 0.92 : 1.08);
        } else if (v.playbackRate !== s.playbackSpeed) {
          v.playbackRate = s.playbackSpeed;
        }
        if (v.paused) v.play().catch(() => {});
      } else {
        if (!v.paused) v.pause();
        if ((hard || Math.abs(drift) > PAUSED_DRIFT) && !v.seeking) v.currentTime = vt;
        else if (hard) v.currentTime = vt;
      }
    };

    sync(true);
    const unsub = useReplayStore.subscribe((s, prev) => {
      if (s.seekToken !== prev.seekToken) sync(true);
      else if (s.isPlaying !== prev.isPlaying || s.playbackSpeed !== prev.playbackSpeed) sync(false);
    });
    const iv = window.setInterval(() => sync(false), 250);
    return () => {
      unsub();
      window.clearInterval(iv);
    };
  }, [video, cam.timeOffset, status]);

  return inRange;
}

function FeedTimestamp({ cam }: { cam: SecurityCamera }) {
  const t = useReplayStore((s) => s.currentTime);
  return (
    <div className="pointer-events-none absolute top-1.5 right-1.5 rounded bg-black/60 px-1.5 py-0.5 text-right font-mono text-[10px] leading-tight text-slate-200">
      <div>{formatWallClock(t)}</div>
      <div className="text-slate-400">T+{formatClock(Math.max(0, t - cam.timeOffset))}</div>
    </div>
  );
}

export function CCTVFeed({ cam, index, focused }: { cam: SecurityCamera; index: number; focused: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<FeedStatus>("loading");
  const [buffering, setBuffering] = useState(false);
  const selected = useReplayStore((s) => s.selectedCameraId === cam.id);
  const viewing = useReplayStore((s) => s.cameraMode === "cctv" && s.selectedCameraId === cam.id);
  const selectCamera = useReplayStore((s) => s.selectCamera);
  const viewThroughCamera = useReplayStore((s) => s.viewThroughCamera);
  const registerVideoDuration = useReplayStore((s) => s.registerVideoDuration);
  const hovered = useViewStore((s) => s.hoveredCameraId === cam.id);
  const setHovered = useViewStore((s) => s.setHoveredCamera);
  const setFocusedFeed = useViewStore((s) => s.setFocusedFeed);
  const inRange = useVideoSync(ref, cam, status);

  const fileName = cam.videoUrl.split("/").pop();
  const label = `CAM ${String(index + 1).padStart(2, "0")}`;
  const linked = selected || hovered;

  return (
    <div
      onClick={() => selectCamera(selected ? null : cam.id)}
      onDoubleClick={() => setFocusedFeed(focused ? null : cam.id)}
      onMouseEnter={() => setHovered(cam.id)}
      onMouseLeave={() => setHovered(null)}
      style={{ order: focused ? -1 : index }}
      className={`group relative cursor-pointer overflow-hidden rounded-md border bg-black transition-all duration-200 ${
        focused ? "col-span-2" : ""
      } ${linked ? "border-cyan-400/80 shadow-[0_0_18px_-6px_rgba(34,211,238,0.9)]" : "border-ink-600 hover:border-slate-500"}`}
    >
      <div className="relative aspect-video">
        <video
          ref={ref}
          src={cam.videoUrl}
          muted
          playsInline
          preload="auto"
          className={`absolute inset-0 h-full w-full object-cover ${status === "ready" && inRange ? "" : "opacity-0"}`}
          onLoadedMetadata={(e) => {
            registerVideoDuration(cam.id, e.currentTarget.duration);
            setStatus("ready");
          }}
          onError={(e) => {
            const code = e.currentTarget.error?.code;
            // 4 = SRC_NOT_SUPPORTED (typically 404 / missing file)
            setStatus(code === 4 ? "missing" : "error");
          }}
          onWaiting={() => setBuffering(true)}
          onPlaying={() => setBuffering(false)}
          onSeeked={() => setBuffering(false)}
        />

        {status !== "ready" && (
          <div className="absolute inset-0 grid place-items-center bg-[repeating-linear-gradient(45deg,#0a111b_0_10px,#070c14_10px_20px)]">
            <div className="flex flex-col items-center gap-1 text-center">
              <VideoOff className={`h-5 w-5 ${status === "loading" ? "text-slate-500" : "text-amber-400/80"}`} />
              <div className="font-mono text-[10px] tracking-wider text-slate-300">
                {status === "loading" ? "CONNECTING…" : status === "missing" ? "NO RECORDING" : "PLAYBACK ERROR"}
              </div>
              {status !== "loading" && <div className="font-mono text-[9px] text-slate-500">{fileName} unavailable</div>}
            </div>
          </div>
        )}
        {status === "ready" && !inRange && (
          <div className="absolute inset-0 grid place-items-center bg-ink-950">
            <div className="text-center font-mono text-[10px] tracking-wider text-slate-500">
              NO SIGNAL
              <div className="text-[9px]">outside recording window</div>
            </div>
          </div>
        )}
        {buffering && status === "ready" && inRange && (
          <div className="absolute bottom-1.5 right-1.5 font-mono text-[9px] text-amber-300">BUFFERING</div>
        )}

        <div className="scanlines absolute inset-0 opacity-60" />

        <div className="pointer-events-none absolute top-1.5 left-1.5 flex items-center gap-1.5 rounded bg-black/60 px-1.5 py-0.5 font-mono text-[10px] text-slate-100">
          {status === "ready" && <span className="rec-dot h-1.5 w-1.5 rounded-full bg-red-500" />}
          {label}
          {viewing && <span className="text-cyan-300">· 3D VIEW</span>}
          {selected && !viewing && <span className="text-cyan-300">· LINKED</span>}
        </div>
        {status === "ready" && <FeedTimestamp cam={cam} />}

        <div className="absolute right-1.5 bottom-1.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            title="View through this camera in 3D"
            className="rounded bg-black/70 p-1 text-slate-200 hover:text-cyan-300"
            onClick={(e) => {
              e.stopPropagation();
              viewThroughCamera(cam.id);
            }}
          >
            <Eye className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title={focused ? "Restore grid" : "Enlarge feed"}
            className="rounded bg-black/70 p-1 text-slate-200 hover:text-cyan-300"
            onClick={(e) => {
              e.stopPropagation();
              setFocusedFeed(focused ? null : cam.id);
            }}
          >
            {focused ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
      <div className="flex items-center justify-between border-t border-ink-700 bg-ink-850 px-2 py-1">
        <span className={`truncate font-mono text-[10px] ${linked ? "text-cyan-200" : "text-slate-400"}`}>{cam.name}</span>
        {cam.timeOffset !== 0 && <span className="font-mono text-[9px] text-slate-500">+{cam.timeOffset}s</span>}
      </div>
    </div>
  );
}
