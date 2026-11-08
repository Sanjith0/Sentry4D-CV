import { useCallback, useRef, useState } from "react";
import { ChevronsLeft, ChevronsRight, Pause, Play, RotateCcw, SkipBack, SkipForward } from "lucide-react";
import { securityCameras } from "../config/cameras";
import { eventStyle } from "../config/incident";
import { PLAYBACK_SPEEDS, useReplayStore } from "../store/useReplayStore";
import { formatClock, formatWallClock } from "../lib/format";

function Scrubber() {
  const currentTime = useReplayStore((s) => s.currentTime);
  const duration = useReplayStore((s) => s.duration);
  const events = useReplayStore((s) => s.events);
  const seek = useReplayStore((s) => s.seek);
  const videoDurations = useReplayStore((s) => s.videoDurations);
  const track = useRef<HTMLDivElement>(null);
  const [hoverT, setHoverT] = useState<number | null>(null);
  const dragging = useRef(false);
  const wasPlaying = useRef(false);

  const timeAt = useCallback(
    (clientX: number) => {
      const r = track.current!.getBoundingClientRect();
      return Math.min(Math.max((clientX - r.left) / r.width, 0), 1) * duration;
    },
    [duration],
  );

  const pct = (t: number) => `${(Math.min(Math.max(t / duration, 0), 1) * 100).toFixed(3)}%`;
  const tickStep = duration > 300 ? 60 : duration > 120 ? 15 : 5;

  return (
    <div className="relative flex-1 select-none">
      {/* Recording-coverage lanes: one per camera, from timeOffset to end of loaded video. */}
      <div className="mb-1 space-y-[3px]">
        {securityCameras.map((c) => {
          const d = videoDurations[c.id];
          return (
            <div key={c.id} className="relative h-[3px] rounded-full bg-ink-700/70" title={`${c.name}${d ? "" : " · no recording"}`}>
              {d ? (
                <div className="absolute inset-y-0 rounded-full bg-cyan-400/40" style={{ left: pct(c.timeOffset), width: `calc(${pct(c.timeOffset + d)} - ${pct(c.timeOffset)})` }} />
              ) : null}
            </div>
          );
        })}
      </div>

      <div
        ref={track}
        className="group relative h-7 cursor-pointer"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          dragging.current = true;
          const s = useReplayStore.getState();
          wasPlaying.current = s.isPlaying;
          if (s.isPlaying) s.pause();
          seek(timeAt(e.clientX));
        }}
        onPointerMove={(e) => {
          const t = timeAt(e.clientX);
          setHoverT(t);
          if (dragging.current) seek(t);
        }}
        onPointerUp={() => {
          dragging.current = false;
          if (wasPlaying.current) useReplayStore.getState().play();
        }}
        onPointerLeave={() => setHoverT(null)}
      >
        {/* Tick marks */}
        <div className="absolute inset-x-0 top-0 h-2">
          {Array.from({ length: Math.floor(duration / tickStep) + 1 }, (_, i) => (
            <div key={i} className="absolute top-0 h-1.5 w-px bg-slate-600/60" style={{ left: pct(i * tickStep) }} />
          ))}
        </div>
        <div className="absolute inset-x-0 top-3 h-1.5 rounded-full bg-ink-600">
          <div className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-cyan-600 to-cyan-300" style={{ width: pct(currentTime) }} />
        </div>

        {events.map((ev) => {
          const st = eventStyle(ev.type);
          return (
            <button
              key={ev.id}
              type="button"
              title={`${formatClock(ev.time, false)} · ${ev.description}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => seek(ev.time)}
              className="absolute top-1 z-10 h-5 w-1.5 -translate-x-1/2 rounded-sm transition-transform hover:scale-y-125"
              style={{ left: pct(ev.time), background: st.color, boxShadow: `0 0 8px ${st.color}` }}
            />
          );
        })}

        {/* Playhead */}
        <div className="pointer-events-none absolute top-0 bottom-0 z-20 w-px -translate-x-1/2 bg-white" style={{ left: pct(currentTime) }}>
          <div className="absolute top-2 left-1/2 h-3.5 w-3.5 -translate-x-1/2 rounded-full border-2 border-white bg-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.9)]" />
        </div>

        {hoverT !== null && (
          <div className="pointer-events-none absolute -top-6 z-30 -translate-x-1/2 rounded bg-ink-700 px-1.5 py-0.5 font-mono text-[10px] text-slate-200" style={{ left: pct(hoverT) }}>
            {formatClock(hoverT)}
          </div>
        )}
      </div>
    </div>
  );
}

function IconBtn({ onClick, title, children, primary }: { onClick: () => void; title: string; children: React.ReactNode; primary?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`grid place-items-center rounded-md border transition-colors ${
        primary
          ? "h-10 w-10 border-cyan-400/70 bg-cyan-400/15 text-cyan-200 hover:bg-cyan-400/25"
          : "h-8 w-8 border-ink-500/70 bg-ink-800 text-slate-400 hover:text-slate-100"
      }`}
    >
      {children}
    </button>
  );
}

export function ReplayTimeline() {
  const isPlaying = useReplayStore((s) => s.isPlaying);
  const currentTime = useReplayStore((s) => s.currentTime);
  const duration = useReplayStore((s) => s.duration);
  const speed = useReplayStore((s) => s.playbackSpeed);
  const s = useReplayStore.getState;

  const jumpEvent = (dir: 1 | -1) => {
    const { events, currentTime: t, seek } = s();
    const ev = dir > 0 ? events.find((e) => e.time > t + 0.05) : [...events].reverse().find((e) => e.time < t - 0.25);
    if (ev) seek(ev.time);
  };

  return (
    <footer className="relative z-10 flex h-[88px] shrink-0 items-center gap-4 border-t border-ink-600/70 bg-ink-900/95 px-4">
      <div className="flex items-center gap-1.5">
        <IconBtn onClick={() => s().restart()} title="Restart">
          <RotateCcw className="h-3.5 w-3.5" />
        </IconBtn>
        <IconBtn onClick={() => jumpEvent(-1)} title="Previous event">
          <SkipBack className="h-3.5 w-3.5" />
        </IconBtn>
        <IconBtn onClick={() => s().seek(s().currentTime - 5)} title="Back 5s (←)">
          <ChevronsLeft className="h-4 w-4" />
        </IconBtn>
        <IconBtn primary onClick={() => s().togglePlay()} title="Play / pause (K)">
          {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 translate-x-px" />}
        </IconBtn>
        <IconBtn onClick={() => s().seek(s().currentTime + 5)} title="Forward 5s (→)">
          <ChevronsRight className="h-4 w-4" />
        </IconBtn>
        <IconBtn onClick={() => jumpEvent(1)} title="Next event">
          <SkipForward className="h-3.5 w-3.5" />
        </IconBtn>
      </div>

      <div className="w-[118px] shrink-0 leading-tight">
        <div className="font-mono text-lg text-slate-100 tabular-nums">{formatClock(currentTime)}</div>
        <div className="font-mono text-[10px] text-slate-500 tabular-nums">
          / {formatClock(duration, false)} · {formatWallClock(currentTime)}
        </div>
      </div>

      <div className="flex min-w-0 flex-1">
        <Scrubber />
      </div>

      <div className="flex shrink-0 items-center gap-1 rounded-md border border-ink-600 bg-ink-850 p-0.5">
        {PLAYBACK_SPEEDS.map((sp) => (
          <button
            key={sp}
            type="button"
            onClick={() => s().setPlaybackSpeed(sp)}
            className={`h-7 rounded px-2 font-mono text-[11px] transition-colors ${
              speed === sp ? "bg-cyan-400/20 text-cyan-200" : "text-slate-500 hover:text-slate-200"
            }`}
          >
            {sp}×
          </button>
        ))}
      </div>
    </footer>
  );
}
