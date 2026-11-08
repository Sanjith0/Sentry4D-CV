import { useEffect, useRef, useState } from "react";
import { Eye, Maximize2, Minimize2, VideoOff } from "lucide-react";
import { useReplayStore } from "../store/useReplayStore";
import { useViewStore } from "../store/useViewStore";
import { videoRegistry } from "../lib/videoRegistry";
import type { FeedStatus, SecurityCamera } from "../types/security";
import { formatClock, formatWallClock } from "../lib/format";

/** Drift (s) beyond which we hard-seek during playback. Between SOFT and HARD we nudge playbackRate. */
const HARD_DRIFT = 0.35;
const SOFT_DRIFT = 0.06;
const PAUSED_DRIFT = 0.05;
const CHECK_INTERVAL_MS = 250;

export type RangeState = "before" | "in" | "after";

/**
 * Keeps a <video> slaved to the master clock: videoTime = masterTime + offset.
 * The video never drives time. Hard seeks happen only on explicit seeks, offset
 * changes, or large drift; seeks issued while a seek is in flight are coalesced
 * (latest wins) so scrubbing heavy HEVC files doesn't queue up dozens of seeks.
 */
function useVideoSync(video: React.RefObject<HTMLVideoElement | null>, cam: SecurityCamera, status: FeedStatus) {
  const [range, setRange] = useState<RangeState>("in");
  const rangeRef = useRef<RangeState>("in");

  useEffect(() => {
    const v = video.current;
    if (!v || status !== "ready") return;
    let pending: number | null = null;

    const seekTo = (t: number) => {
      if (v.seeking) pending = t;
      else v.currentTime = t;
    };
    const onSeeked = () => {
      if (pending != null) {
        const t = pending;
        pending = null;
        v.currentTime = t;
      }
    };
    v.addEventListener("seeked", onSeeked);

    const sync = (hard: boolean) => {
      const s = useReplayStore.getState();
      const vt = s.currentTime + (s.cameraOffsets[cam.id] ?? 0);
      const dur = v.duration;
      const r: RangeState = vt < 0 ? "before" : Number.isFinite(dur) && vt > dur - 0.03 ? "after" : "in";
      if (r !== rangeRef.current) {
        rangeRef.current = r;
        setRange(r);
      }
      if (r !== "in") {
        // Park on the first / last frame while the camera isn't recording.
        if (!v.paused) v.pause();
        const parked = r === "before" ? 0 : Math.max(0, dur - 0.05);
        if (hard || Math.abs(v.currentTime - parked) > 0.1) seekTo(parked);
        return;
      }

      const drift = v.currentTime - vt;
      if (s.isPlaying) {
        if (hard || Math.abs(drift) > HARD_DRIFT) {
          seekTo(vt);
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
        if (hard || Math.abs(drift) > PAUSED_DRIFT) seekTo(vt);
      }
    };

    sync(true); // also covers seeks that happened while this video was still loading
    const unsub = useReplayStore.subscribe((s, prev) => {
      if (s.seekToken !== prev.seekToken || s.cameraOffsets[cam.id] !== prev.cameraOffsets[cam.id]) sync(true);
      else if (s.isPlaying !== prev.isPlaying || s.playbackSpeed !== prev.playbackSpeed) sync(false);
    });
    const iv = window.setInterval(() => sync(false), CHECK_INTERVAL_MS);
    return () => {
      unsub();
      window.clearInterval(iv);
      v.removeEventListener("seeked", onSeeked);
    };
  }, [video, cam.id, status]);

  return range;
}

function FeedTimestamp({ cam }: { cam: SecurityCamera }) {
  const t = useReplayStore((s) => s.currentTime);
  const offset = useReplayStore((s) => s.cameraOffsets[cam.id] ?? 0);
  return (
    <div className="pointer-events-none absolute top-1.5 right-1.5 rounded bg-black/60 px-1.5 py-0.5 text-right font-mono text-[10px] leading-tight text-slate-200">
      <div>{formatWallClock(t)}</div>
      <div className="text-slate-400">VID {formatClock(t + offset)}</div>
    </div>
  );
}

const STATUS_TEXT: Record<Exclude<FeedStatus, "ready">, string> = {
  loading: "LOADING RECORDING…",
  missing: "FILE NOT FOUND",
  unsupported: "CODEC NOT SUPPORTED",
  error: "PLAYBACK ERROR",
};

/** Classify a media error: 404 vs. undecodable file. */
async function classifyError(url: string, code: number | undefined): Promise<{ status: FeedStatus; message: string }> {
  try {
    const r = await fetch(url, { method: "HEAD" });
    const type = r.headers.get("content-type") ?? "";
    if (!r.ok || type.includes("text/html")) return { status: "missing", message: `${url} not found` };
  } catch {
    return { status: "missing", message: `${url} not reachable` };
  }
  if (code === 4)
    return {
      status: "unsupported",
      message: "Browser can't decode this file (iPhone HEVC needs Chrome/Safari on macOS). Transcode to H.264 MP4 for other browsers.",
    };
  if (code === 3) return { status: "error", message: "Decoding failed (corrupt or unsupported stream)." };
  return { status: "error", message: "Network/playback error." };
}

export function CCTVFeed({ cam, index }: { cam: SecurityCamera; index: number }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<FeedStatus>("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [buffering, setBuffering] = useState(false);
  const selected = useReplayStore((s) => s.selectedCameraId === cam.id);
  const viewing = useReplayStore((s) => s.cameraMode === "cctv" && s.selectedCameraId === cam.id);
  const offset = useReplayStore((s) => s.cameraOffsets[cam.id] ?? 0);
  const selectCamera = useReplayStore((s) => s.selectCamera);
  const viewThroughCamera = useReplayStore((s) => s.viewThroughCamera);
  const setFeedState = useReplayStore((s) => s.setFeedState);
  const hovered = useViewStore((s) => s.hoveredCameraId === cam.id);
  const enlarged = useViewStore((s) => s.focusedFeedId === cam.id);
  const setHovered = useViewStore((s) => s.setHoveredCamera);
  const setFocusedFeed = useViewStore((s) => s.setFocusedFeed);
  const range = useVideoSync(ref, cam, status);

  useEffect(() => {
    videoRegistry.set(cam.id, ref.current);
    return () => videoRegistry.set(cam.id, null);
  }, [cam.id]);

  const fileName = cam.videoUrl.split("/").pop();
  const label = `CAM ${String(index + 1).padStart(2, "0")}`;
  const linked = selected || hovered;
  const rotation = cam.videoRotation ?? 0;

  return (
    <div
      onClick={() => {
        setFocusedFeed(enlarged ? null : cam.id);
        selectCamera(cam.id);
      }}
      onMouseEnter={() => setHovered(cam.id)}
      onMouseLeave={() => setHovered(null)}
      title="Click to enlarge"
      className={`group relative cursor-pointer overflow-hidden rounded-md border bg-black transition-all duration-200 ${
        linked || enlarged ? "border-cyan-400/80 shadow-[0_0_18px_-6px_rgba(34,211,238,0.9)]" : "border-ink-600 hover:border-slate-500"
      }`}
    >
      <div className="relative aspect-video">
        <video
          ref={ref}
          src={cam.videoUrl}
          muted
          playsInline
          preload="auto"
          disablePictureInPicture
          style={rotation ? { transform: `rotate(${rotation}deg)` } : undefined}
          className={`absolute inset-0 h-full w-full object-cover transition-opacity ${
            status !== "ready" ? "opacity-0" : range === "in" ? "" : "opacity-30 grayscale"
          }`}
          onLoadedMetadata={(e) => {
            setFeedState(cam.id, { status: "ready", duration: e.currentTarget.duration, error: undefined });
            setStatus("ready");
          }}
          onError={(e) => {
            const code = e.currentTarget.error?.code;
            classifyError(cam.videoUrl, code).then(({ status: st, message }) => {
              setStatus(st);
              setErrorMsg(message);
              setFeedState(cam.id, { status: st, error: message });
              console.warn(`[Sentry3D] ${cam.id} ${fileName}: ${message}`);
            });
          }}
          onWaiting={() => setBuffering(true)}
          onPlaying={() => setBuffering(false)}
          onSeeked={() => setBuffering(false)}
        />

        {status !== "ready" && (
          <div className="absolute inset-0 grid place-items-center bg-[repeating-linear-gradient(45deg,#0a111b_0_10px,#070c14_10px_20px)] p-2">
            <div className="flex flex-col items-center gap-1 text-center">
              {status === "loading" ? (
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-cyan-400/30 border-t-cyan-300" />
              ) : (
                <VideoOff className="h-5 w-5 text-amber-400/80" />
              )}
              <div className="font-mono text-[10px] tracking-wider text-slate-300">{STATUS_TEXT[status]}</div>
              <div className="font-mono text-[9px] text-slate-500">{fileName}</div>
              {errorMsg && <div className="max-w-[180px] text-[9px] leading-tight text-slate-500">{errorMsg}</div>}
            </div>
          </div>
        )}
        {status === "ready" && range !== "in" && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="rounded bg-black/70 px-2 py-1 text-center font-mono text-[10px] tracking-wider text-slate-300">
              {range === "before" ? "NOT RECORDING YET" : "RECORDING ENDED"}
            </div>
          </div>
        )}
        {buffering && status === "ready" && range === "in" && (
          <div className="absolute bottom-1.5 left-1.5 font-mono text-[9px] text-amber-300">BUFFERING</div>
        )}

        <div className="scanlines absolute inset-0 opacity-60" />

        <div className="pointer-events-none absolute top-1.5 left-1.5 flex items-center gap-1.5 rounded bg-black/60 px-1.5 py-0.5 font-mono text-[10px] text-slate-100">
          {status === "ready" && range === "in" && <span className="rec-dot h-1.5 w-1.5 rounded-full bg-red-500" />}
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
          <span className="rounded bg-black/70 p-1 text-slate-200">
            {enlarged ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </span>
        </div>
      </div>
      <div className="flex items-center justify-between border-t border-ink-700 bg-ink-850 px-2 py-1">
        <span className={`truncate font-mono text-[10px] ${linked ? "text-cyan-200" : "text-slate-400"}`}>{cam.name}</span>
        <span className={`font-mono text-[9px] ${offset ? "text-amber-300/80" : "text-slate-600"}`} title="Sync offset (videoTime = masterTime + offset)">
          {offset >= 0 ? "+" : ""}
          {offset.toFixed(2)}s
        </span>
      </div>
    </div>
  );
}
