import { Footprints, Ghost, Radar, ScanEye, Users, BrainCircuit, Clapperboard } from "lucide-react";
import { useInvestigatorStore } from "../features/investigator/useInvestigatorStore";
import { useDemoStore } from "../features/demo/useDemoStore";
import { incidentConfig } from "../config/incident";
import { useReplayStore } from "../store/useReplayStore";
import { useViewStore } from "../store/useViewStore";
import { formatDate, formatWallClock } from "../lib/format";
import { ToolButton } from "./ui";

function RoomStatusChip() {
  const status = useViewStore((s) => s.roomStatus);
  const b = useViewStore((s) => s.roomBounds);
  const err = useViewStore((s) => s.roomError);
  const map = {
    checking: ["text-slate-400", "Probing scan…"],
    loading: ["text-cyan-300", "Loading LiDAR scan…"],
    loaded: ["text-emerald-300", "LiDAR scan"],
    missing: ["text-amber-300", "Placeholder room"],
    error: ["text-red-300", "Scan failed · placeholder"],
  } as const;
  const [cls, text] = map[status];
  const dims = b ? `${b.size[0].toFixed(2)}×${b.size[1].toFixed(2)}×${b.size[2].toFixed(2)} m` : null;
  return (
    <div className="flex shrink-0 items-center gap-2 font-mono text-[11px]" title={err ?? dims ?? undefined}>
      <span className={`h-1.5 w-1.5 rounded-full bg-current ${cls}`} />
      <span className={cls}>{text}</span>
      {/* The room's size gives way first when the window is too narrow for the whole header (it stays in the
          tooltip): the header needs 1,764 px to show it next to the complete incident name, so it appears from
          1800 px up. */}
      {dims && <span className="hidden text-slate-500 min-[1800px]:inline">{dims}</span>}
    </div>
  );
}

function Clock() {
  const t = useReplayStore((s) => Math.floor(s.currentTime));
  return (
    <div className="font-mono text-[11px] text-slate-400">
      {formatDate(t)} <span className="text-slate-200">{formatWallClock(t)}</span>
    </div>
  );
}

export function Header() {
  const isPlaying = useReplayStore((s) => s.isPlaying);
  const subjects = useReplayStore((s) => s.activeSubjectCount);
  const xray = useReplayStore((s) => s.xrayEnabled);
  const sentry = useReplayStore((s) => s.sentryEnabled);
  const toggleXray = useReplayStore((s) => s.toggleXray);
  const toggleSentry = useReplayStore((s) => s.toggleSentry);
  const annotating = useViewStore((s) => s.annotating);
  const setAnnotating = useViewStore((s) => s.setAnnotating);
  const aiOpen = useInvestigatorStore((s) => s.open);
  const aiRunning = useInvestigatorStore((s) => s.status === "running");
  const toggleAi = useInvestigatorStore((s) => s.toggle);

  return (
    <header className="relative z-10 flex h-14 shrink-0 items-center gap-5 whitespace-nowrap border-b border-ink-600/70 bg-ink-900/95 px-4">
      <div className="flex shrink-0 items-center gap-2.5">
        <div className="grid h-8 w-8 place-items-center rounded-md border border-cyan-400/40 bg-cyan-400/10">
          <ScanEye className="h-4.5 w-4.5 text-cyan-300" />
        </div>
        <div className="leading-tight">
          <div className="font-mono text-sm font-semibold tracking-[0.2em] text-slate-100">
            SENTRY<span className="text-cyan-300">3D</span>
          </div>
          <div className="label !text-[9px]">Spatial investigation</div>
        </div>
      </div>

      <div className="h-8 w-px bg-ink-600" />

      <div className="min-w-0 shrink leading-tight">
        <div className="label">Incident</div>
        <div className="truncate text-[13px] font-medium text-slate-200">{incidentConfig.name}</div>
      </div>

      <div className="flex shrink-0 items-center gap-2 rounded-md border border-ink-600 bg-ink-850 px-2.5 py-1">
        {isPlaying ? (
          <>
            <span className="rec-dot h-2 w-2 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.9)]" />
            <span className="font-mono text-[11px] tracking-wider text-red-300">REPLAY</span>
          </>
        ) : (
          <>
            <span className="h-2 w-2 rounded-full bg-slate-500" />
            <span className="font-mono text-[11px] tracking-wider text-slate-400">PAUSED</span>
          </>
        )}
        <span className="mx-1 h-3 w-px bg-ink-500" />
        <Clock />
      </div>

      <RoomStatusChip />

      <div className="ml-auto flex shrink-0 items-center gap-2">
        <div className="mr-2 flex items-center gap-2 rounded-md border border-ink-600 bg-ink-850 px-2.5 py-1" title="Active subjects (from tracking module)">
          <Users className="h-3.5 w-3.5 text-cyan-300" />
          <span className="font-mono text-sm text-slate-100">{subjects}</span>
          <span className="label">subjects</span>
        </div>
        <ToolButton
          onClick={(e) => {
            if (e.detail) e.currentTarget.blur(); // clicked with the pointer: leave the keyboard with the viewer
            useDemoStore.getState().start();
          }}
          title="Demo mode: a 25-second automatic walkthrough, from the four recordings to the 3D reconstruction (Esc to exit)"
          className="!border-cyan-400/60 !bg-cyan-400/10 !text-cyan-100 shadow-[0_0_14px_-4px_rgba(34,211,238,0.8)] hover:!border-cyan-300 hover:!bg-cyan-400/20"
        >
          <Clapperboard className="h-3.5 w-3.5" /> DEMO MODE
        </ToolButton>
        <ToolButton
          active={annotating}
          onClick={() => {
            if (!annotating) {
              const r = useReplayStore.getState();
              r.pause();
              useViewStore.getState().setAnnotationCamera(r.selectedCameraId ?? "cam1");
              r.setCameraMode("topdown");
            }
            setAnnotating(!annotating);
          }}
          title="Click a real person's feet in the CCTV video to place them in the 3D room"
        >
          <Footprints className="h-3.5 w-3.5" /> ANNOTATE SUBJECT
        </ToolButton>
        <ToolButton
          active={aiOpen}
          onClick={toggleAi}
          title="NVIDIA Nemotron autonomous investigation agent"
          className={aiOpen ? "" : "!border-[#76b900]/60 !text-[#b5e05c]"}
        >
          <BrainCircuit className={`h-3.5 w-3.5 ${aiRunning ? "animate-pulse" : ""}`} /> AI INVESTIGATOR
        </ToolButton>
        <ToolButton active={xray} onClick={toggleXray} title="Toggle X-ray tracking (X)">
          <Ghost className="h-3.5 w-3.5" /> X-RAY
        </ToolButton>
        <ToolButton active={sentry} tone="red" onClick={toggleSentry} title="Toggle Sentry Mode (M)">
          <Radar className="h-3.5 w-3.5" /> SENTRY MODE
        </ToolButton>
      </div>
    </header>
  );
}
