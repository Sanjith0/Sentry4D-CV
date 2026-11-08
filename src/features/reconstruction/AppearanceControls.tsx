import { Film, PersonStanding } from "lucide-react";
import { securityCameras } from "../../config/cameras";
import { subjects } from "../../config/subjects";
import { useViewStore } from "../../store/useViewStore";
import type { CameraId } from "../../types/security";
import { useAppearanceStore } from "./useAppearanceStore";

const EVIDENCE_STYLE = {
  observed: "border-emerald-400/60 bg-emerald-400/15 text-emerald-200",
  reconstructed: "border-amber-400/60 bg-amber-400/15 text-amber-200",
  generated: "border-red-400/60 bg-red-400/15 text-red-200",
} as const;

/**
 * Subject rendering selector + provenance of what is on screen. Rendered inside the
 * Camera evidence panel so all "what are we looking at" information sits together.
 */
export function AppearanceControls() {
  const mode = useViewStore((s) => s.subjectRenderMode);
  const setMode = useViewStore((s) => s.setSubjectRenderMode);
  const source = useViewStore((s) => s.appearanceSource);
  const setSource = useViewStore((s) => s.setAppearanceSource);
  const loadStatus = useAppearanceStore((s) => s.loadStatus);
  const clips = useAppearanceStore((s) => s.clips);
  const status = useAppearanceStore((s) => s.status[subjects[0]?.id ?? ""]);
  const available = new Set(Object.values(clips).flatMap((c) => Object.keys(c.cameras) as CameraId[]));

  return (
    <div className="mb-2 space-y-1.5 border-b border-ink-600 pb-2">
      <div className="flex items-center gap-1">
        <span className="label mr-1">Subject</span>
        <button
          type="button"
          onClick={() => setMode("footage")}
          title="Draw the person with their real segmented footage"
          className={`flex h-6 flex-1 items-center justify-center gap-1 rounded border text-[10px] ${
            mode === "footage" ? "border-cyan-400/70 bg-cyan-400/15 text-cyan-100" : "border-ink-500 text-slate-400 hover:text-slate-100"
          }`}
        >
          <Film className="h-3 w-3" /> REAL APPEARANCE
        </button>
        <button
          type="button"
          onClick={() => setMode("avatar")}
          title="Generic tracking avatar (debug / fallback)"
          className={`flex h-6 flex-1 items-center justify-center gap-1 rounded border text-[10px] ${
            mode === "avatar" ? "border-cyan-400/70 bg-cyan-400/15 text-cyan-100" : "border-ink-500 text-slate-400 hover:text-slate-100"
          }`}
        >
          <PersonStanding className="h-3 w-3" /> TRACKING DEBUG
        </button>
      </div>
      {mode === "footage" && (
        <>
          <div className="flex items-center gap-1">
            <span className="label mr-1">Source</span>
            {(["auto", ...securityCameras.map((c) => c.id)] as ("auto" | CameraId)[]).map((s) => {
              const ok = s === "auto" || available.has(s);
              return (
                <button
                  key={s}
                  type="button"
                  disabled={!ok}
                  onClick={() => setSource(s)}
                  title={s === "auto" ? "Camera closest to your viewing direction" : ok ? `Show ${s.toUpperCase()}'s footage` : "No segmented footage for this camera yet"}
                  className={`h-6 flex-1 rounded border text-[10px] disabled:opacity-30 ${
                    source === s ? "border-cyan-400/70 bg-cyan-400/15 text-cyan-100" : "border-ink-500 text-slate-400 hover:text-slate-100"
                  }`}
                >
                  {s === "auto" ? "AUTO" : `C${s.slice(3)}`}
                </button>
              );
            })}
          </div>
          <div className="text-[10px] leading-snug">
            {loadStatus === "none" ? (
              <span className="text-amber-300">No segmented footage generated on this machine (see experiments/reconstruction).</span>
            ) : status?.active ? (
              <span className="flex flex-wrap items-center gap-1">
                <span className={`rounded border px-1 ${EVIDENCE_STYLE[status.evidence ?? "reconstructed"]}`}>
                  {status.evidence === "observed" ? "OBSERVED VIEW" : "RECONSTRUCTED PERSPECTIVE"}
                </span>
                <span className="text-slate-400">
                  real pixels · CAM {status.cameraId?.slice(3).padStart(2, "0")} · {status.offSourceDeg}° from source
                  {status.feetHeightM != null && status.feetHeightM > 0.3 ? " · lower body not visible in this camera" : ""}
                </span>
                {status.positionEstimated && (
                  <span className="text-amber-300">
                    Position ESTIMATED: no floor observation here, so the cut-out stands at the interpolated track position. Its pixels are real; its depth is not
                    measured.
                  </span>
                )}
                {(status.offSourceDeg ?? 0) > 45 && (
                  <span className="text-amber-300">
                    Low support: a flat cut-out seen {status.offSourceDeg}° off its camera. No camera recorded this side of the person.
                  </span>
                )}
              </span>
            ) : (
              <span className="text-slate-500">Avatar shown: {status?.reason ?? "loading"}</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
