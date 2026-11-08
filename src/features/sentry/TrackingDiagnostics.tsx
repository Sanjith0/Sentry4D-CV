import { useReplayStore } from "../../store/useReplayStore";
import { useViewStore } from "../../store/useViewStore";
import { frameInfoOrDefault } from "../../lib/videoRegistry";
import { pixelError, worldToVideoPixel } from "../../lib/videoProjection";
import { formatClock } from "../../lib/format";
import { useAnnotationStore } from "../annotation/useAnnotationStore";
import { useSubjectTracks } from "./useSubjectTracks";

const FRAME = 1 / 30;
const NEAR = 0.5;

function Pt({ u, v, children, className }: { u: number; v: number; children?: React.ReactNode; className?: string }) {
  return (
    <div className={`absolute -translate-x-1/2 -translate-y-1/2 ${className ?? ""}`} style={{ left: `${u * 100}%`, top: `${v * 100}%` }}>
      {children}
    </div>
  );
}

/**
 * Rendered inside the CCTV sensor frame (which also ghosts the real recording):
 * orange = annotated feet pixel from the real video, cyan = 3D subject position
 * projected through the calibrated camera. They should coincide.
 */
export function TrackingDiagnostics() {
  const id = useReplayStore((s) => s.selectedCameraId);
  const t = useReplayStore((s) => s.currentTime);
  const pose = useReplayStore((s) => (id ? s.cameraPoses[id] : null));
  const persons = useAnnotationStore((s) => s.persons);
  const opacity = useViewStore((s) => s.ghostOpacity);
  const setOpacity = useViewStore((s) => s.setGhostOpacity);
  const tracks = useSubjectTracks();
  if (!id || !pose) return null;
  const frame = frameInfoOrDefault(id);

  const rows: string[] = [];
  const marks = tracks.flatMap(({ subject, trajectory }) => {
    const out: React.ReactNode[] = [];
    const st = trajectory.sample(t);
    const proj = st.visible ? worldToVideoPixel(pose, st.position, frame) : null;
    if (proj?.pixel && proj.inFrame) {
      out.push(
        <Pt key={`${subject.id}-3d`} u={proj.pixel[0]} v={proj.pixel[1]}>
          <div className="relative h-6 w-6">
            <div className="absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 bg-cyan-300 shadow-[0_0_6px_rgba(34,211,238,1)]" />
            <div className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-cyan-300 shadow-[0_0_6px_rgba(34,211,238,1)]" />
          </div>
          <div className="absolute top-6 left-1/2 -translate-x-1/2 rounded bg-black/75 px-1 font-mono text-[9px] whitespace-nowrap text-cyan-200">
            3D {subject.label} {st.status === "estimated" ? "(est.)" : ""}
          </div>
        </Pt>,
      );
    }
    // Real-video annotations for this camera near the current master time.
    const obs = (persons[subject.personId] ?? []).filter((o) => o.cameraId === id && Math.abs(o.masterTime - t) <= NEAR);
    for (const o of obs) {
      const dt = o.masterTime - t;
      const exact = Math.abs(dt) <= FRAME * 1.5;
      out.push(
        <Pt key={o.id} u={o.pixel[0]} v={o.pixel[1]} className={exact ? "" : "opacity-50"}>
          <div className="h-3.5 w-3.5 rounded-full border-2 border-orange-300 bg-orange-400/60 shadow-[0_0_6px_rgba(251,146,60,1)]" />
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded bg-black/75 px-1 font-mono text-[9px] whitespace-nowrap text-orange-200">
            VIDEO{exact ? "" : ` ${dt > 0 ? "+" : ""}${dt.toFixed(2)}s`}
          </div>
        </Pt>,
      );
      if (exact && proj?.pixel) rows.push(`${subject.label}: 3D vs video ${pixelError(o.pixel, proj.pixel, frame).toFixed(1)} px`);
    }
    if (st.visible && !proj?.inFrame) rows.push(`${subject.label}: outside this camera's view`);
    if (!st.visible) rows.push(`${subject.label}: not present at ${formatClock(t)}`);
    return out;
  });

  return (
    <>
      {marks}
      <div className="pointer-events-auto absolute bottom-2 left-2 rounded border border-ink-500 bg-black/75 px-2 py-1 font-mono text-[10px] leading-snug text-slate-300">
        <div>
          <span className="text-orange-300">●</span> VIDEO = annotated feet in the real recording · <span className="text-cyan-300">+</span> 3D = subject projected
          through this calibrated camera
        </div>
        {rows.map((r) => (
          <div key={r} className="text-slate-400">
            {r}
          </div>
        ))}
        <label className="mt-0.5 flex items-center gap-2 text-slate-400">
          real footage
          <input type="range" min={0} max={100} value={Math.round(opacity * 100)} onChange={(e) => setOpacity(Number(e.target.value) / 100)} className="h-1 w-24 accent-cyan-400" />
          {Math.round(opacity * 100)}%
        </label>
      </div>
    </>
  );
}
