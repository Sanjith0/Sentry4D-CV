import { useEffect, useState } from "react";
import { ClipboardCopy, Pause, Play, RotateCcw, SlidersHorizontal, X } from "lucide-react";
import { securityCameras } from "../config/cameras";
import { defaultOffsets, recordingWindow, useReplayStore } from "../store/useReplayStore";
import { useViewStore } from "../store/useViewStore";
import { formatClock } from "../lib/format";
import type { SecurityCamera } from "../types/security";
import { VideoMirror } from "./VideoMirror";

const FRAME = 1 / 30;
const NUDGES: { label: string; d: number }[] = [
  { label: "-1s", d: -1 },
  { label: "-.1", d: -0.1 },
  { label: "-1f", d: -FRAME },
  { label: "+1f", d: FRAME },
  { label: "+.1", d: 0.1 },
  { label: "+1s", d: 1 },
];

function OffsetInput({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState(value.toFixed(3));
  useEffect(() => setText(value.toFixed(3)), [value]);
  const commit = () => {
    const v = Number.parseFloat(text);
    if (Number.isFinite(v)) onCommit(v);
    else setText(value.toFixed(3));
  };
  return (
    <input
      type="number"
      step={0.01}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const v = Number.parseFloat(e.target.value);
        if (Number.isFinite(v)) onCommit(v); // apply immediately while typing / using arrows
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        e.stopPropagation(); // keep global shortcuts from firing while typing
      }}
      className="h-7 w-24 rounded border border-ink-500 bg-ink-950 px-2 text-right font-mono text-xs text-slate-100 outline-none focus:border-amber-400"
    />
  );
}

function SyncCard({ cam, index }: { cam: SecurityCamera; index: number }) {
  const t = useReplayStore((s) => s.currentTime);
  const offset = useReplayStore((s) => s.cameraOffsets[cam.id] ?? 0);
  const feed = useReplayStore((s) => s.feeds[cam.id]);
  const setCameraOffset = useReplayStore((s) => s.setCameraOffset);
  const vt = t + offset;
  const win = recordingWindow(offset, feed.duration);
  const recording = feed.status === "ready" && feed.duration != null && vt >= 0 && vt <= feed.duration;

  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-md border border-ink-600 bg-ink-900">
      <div className="relative min-h-0 flex-1 bg-black">
        {feed.status === "ready" ? (
          <VideoMirror cameraId={cam.id} rotation={cam.videoRotation ?? 0} className={recording ? "" : "opacity-30 grayscale"} />
        ) : (
          <div className="grid h-full place-items-center p-3 text-center font-mono text-[11px] text-slate-400">
            {feed.status === "loading" ? "LOADING…" : (feed.error ?? feed.status.toUpperCase())}
          </div>
        )}
        <div className="pointer-events-none absolute top-1.5 left-1.5 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-slate-100">
          CAM {String(index + 1).padStart(2, "0")}
        </div>
        <div className="pointer-events-none absolute top-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-right font-mono text-[11px] leading-tight text-amber-200">
          VID {formatClock(vt)}
        </div>
        {feed.status === "ready" && !recording && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center font-mono text-[11px] text-slate-300">
            {vt < 0 ? "NOT RECORDING YET" : "RECORDING ENDED"}
          </div>
        )}
      </div>
      <div className="space-y-1.5 border-t border-ink-700 p-2">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-slate-400">{cam.name}</span>
          <span className="label">offset</span>
          <OffsetInput value={offset} onCommit={(v) => setCameraOffset(cam.id, v)} />
          <span className="font-mono text-[10px] text-slate-500">s</span>
        </div>
        <div className="flex items-center gap-1">
          {NUDGES.map((n) => (
            <button
              key={n.label}
              type="button"
              onClick={() => setCameraOffset(cam.id, offset + n.d)}
              className="h-6 flex-1 rounded border border-ink-500 bg-ink-800 font-mono text-[10px] text-slate-300 hover:border-amber-400/70 hover:text-amber-200"
            >
              {n.label}
            </button>
          ))}
        </div>
        <div className="font-mono text-[9px] text-slate-500">
          {win
            ? `covers master ${formatClock(Math.max(0, win[0]))} → ${formatClock(win[1])} · clip ${formatClock(feed.duration ?? 0)}`
            : "duration unknown"}
          {offset !== defaultOffsets[cam.id] && <span className="ml-1 text-amber-300/80">· edited</span>}
        </div>
      </div>
    </div>
  );
}

/**
 * Manual alignment tool. Scrub (or frame-step) to a sharp event that every camera
 * sees, then adjust each camera's offset until all four previews show the same moment.
 * Offsets apply instantly, auto-save to localStorage, and can be copied as JSON for
 * src/config/camera-sync.json so the whole team shares them.
 */
export function CameraSyncPanel() {
  const open = useViewStore((s) => s.syncPanelOpen);
  const setOpen = useViewStore((s) => s.setSyncPanelOpen);
  const t = useReplayStore((s) => s.currentTime);
  const duration = useReplayStore((s) => s.duration);
  const isPlaying = useReplayStore((s) => s.isPlaying);
  const offsets = useReplayStore((s) => s.cameraOffsets);
  const resetCameraOffsets = useReplayStore((s) => s.resetCameraOffsets);
  const [copied, setCopied] = useState(false);
  const r = useReplayStore.getState;
  if (!open) return null;

  const json = JSON.stringify(offsets, null, 2);
  const step = (d: number) => {
    r().pause();
    r().seek(r().currentTime + d);
  };

  return (
    <div className="pointer-events-auto absolute inset-3 z-40 flex flex-col overflow-hidden rounded-lg border border-amber-400/40 bg-ink-950/95 shadow-2xl backdrop-blur fade-in">
      <div className="flex items-center gap-3 border-b border-ink-600 px-3 py-2">
        <SlidersHorizontal className="h-4 w-4 text-amber-300" />
        <span className="font-mono text-xs tracking-[0.18em] text-slate-100">CAMERA SYNC</span>
        <span className="text-[11px] text-slate-500">
          Scrub to a sharp moment every camera sees (clap, door, object set down), then adjust offsets until all four match.
        </span>
        <button type="button" title="Close" onClick={() => setOpen(false)} className="ml-auto rounded p-1 text-slate-400 hover:text-slate-100">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-2 grid-rows-2 gap-2 p-2">
        {securityCameras.map((cam, i) => (
          <SyncCard key={cam.id} cam={cam} index={i} />
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-ink-600 px-3 py-2">
        <div className="mr-2 leading-tight">
          <div className="label">master time</div>
          <div className="font-mono text-base text-slate-100 tabular-nums">
            {formatClock(t)} <span className="text-[11px] text-slate-500">/ {formatClock(duration)}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => r().togglePlay()}
          className="grid h-8 w-8 place-items-center rounded border border-cyan-400/60 bg-cyan-400/10 text-cyan-200"
          title="Play / pause"
        >
          {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </button>
        {[
          ["-1s", -1],
          ["-.1s", -0.1],
          ["-1f", -FRAME],
          ["+1f", FRAME],
          ["+.1s", 0.1],
          ["+1s", 1],
        ].map(([label, d]) => (
          <button
            key={label}
            type="button"
            onClick={() => step(d as number)}
            className="h-8 rounded border border-ink-500 bg-ink-800 px-2 font-mono text-[11px] text-slate-300 hover:text-slate-100"
            title="Step master time (pauses playback)"
          >
            {label}
          </button>
        ))}
        <span className="text-[11px] text-slate-500">videoTime = masterTime + offset · saved in this browser automatically</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              navigator.clipboard?.writeText(json).catch(() => {});
              console.info("[Sentry3D] camera-sync.json:\n" + json);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            title="Copy offsets as JSON for src/config/camera-sync.json (shares them with the team)"
            className="flex h-8 items-center gap-1.5 rounded border border-ink-500 bg-ink-800 px-2.5 font-mono text-[11px] text-slate-300 hover:text-slate-100"
          >
            <ClipboardCopy className="h-3.5 w-3.5" /> {copied ? "COPIED" : "COPY JSON"}
          </button>
          <button
            type="button"
            onClick={resetCameraOffsets}
            title="Restore offsets from src/config/camera-sync.json"
            className="flex h-8 items-center gap-1.5 rounded border border-ink-500 bg-ink-800 px-2.5 font-mono text-[11px] text-slate-300 hover:text-red-200"
          >
            <RotateCcw className="h-3.5 w-3.5" /> RESET
          </button>
        </div>
      </div>
    </div>
  );
}
