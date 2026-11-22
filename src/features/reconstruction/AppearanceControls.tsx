import { securityCameras } from "../../config/cameras";
import { subjects } from "../../config/subjects";
import { useViewStore, type SubjectRenderMode } from "../../store/useViewStore";
import type { CameraId } from "../../types/security";
import { useAppearanceStore } from "./useAppearanceStore";
import { useAvatarStore } from "./useAvatarStore";

const EVIDENCE_STYLE = {
  observed: "border-emerald-400/60 bg-emerald-400/15 text-emerald-200",
  reconstructed: "border-amber-400/60 bg-amber-400/15 text-amber-200",
  generated: "border-red-400/60 bg-red-400/15 text-red-200",
} as const;

const MODES: { id: SubjectRenderMode; label: string; title: string }[] = [
  {
    id: "hybrid",
    label: "3D + FOOTAGE",
    title: "Reconstructed 3D body with this instant's footage from every camera projected onto it: real pixels from the camera angles, the model in between",
  },
  { id: "model", label: "3D MODEL", title: "Reconstructed 3D body with its baked texture only (no per-frame footage)" },
  { id: "footage", label: "CUT-OUT", title: "One camera's real segmented footage as a flat cut-out" },
  { id: "avatar", label: "DEBUG", title: "Generic tracking avatar (debug / fallback)" },
];

const camLabel = (id: string | null | undefined) => (id ? `CAM ${id.slice(3).padStart(2, "0")}` : "");

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
  const avatarLoad = useAvatarStore((s) => s.loadStatus);
  const avatar = useAvatarStore((s) => s.status[subjects[0]?.id ?? ""]);
  const available = new Set(Object.values(clips).flatMap((c) => Object.keys(c.cameras) as CameraId[]));
  /** Within this many degrees of a camera the subject on screen is that camera's own frame (hybrid look). */
  const atCamera = (avatar?.footage?.offDeg ?? 180) <= 6;

  return (
    <div className="mb-2 space-y-1.5 border-b border-ink-600 pb-2">
      {/* The label sits above the row: four modes next to it are wider than the panel, and the last one was cut off. */}
      <div className="space-y-1">
        <div className="label">Subject</div>
        <div className="flex items-center gap-1" role="group" aria-label="Subject look">
          {MODES.map(({ id, label, title }) => (
            <button
              key={id}
              type="button"
              onClick={() => setMode(id)}
              title={title}
              aria-pressed={mode === id}
              className={`h-6 flex-auto rounded border px-1 text-[10px] whitespace-nowrap ${
                mode === id ? "border-cyan-400/70 bg-cyan-400/15 text-cyan-100" : "border-ink-500 text-slate-400 hover:text-slate-100"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {(mode === "model" || mode === "hybrid") && (
        <div className="text-[10px] leading-snug">
          {avatarLoad === "none" ? (
            <span className="text-amber-300">No reconstructed body generated on this machine (see experiments/reconstruction/avatar). Debug avatar shown.</span>
          ) : avatar?.active ? (
            <span className="flex flex-wrap items-center gap-1">
              {mode === "hybrid" && avatar.footage && avatar.footage.cameras.length > 0 ? (
                <>
                  <span className={`rounded border px-1 ${atCamera ? EVIDENCE_STYLE.observed : EVIDENCE_STYLE.reconstructed}`}>
                    {atCamera ? "OBSERVED VIEW" : "3D BODY + FOOTAGE"}
                  </span>
                  <span className="text-slate-400">
                    real pixels from {avatar.footage.cameras.length} camera{avatar.footage.cameras.length === 1 ? "" : "s"} at this instant · nearest{" "}
                    {camLabel(avatar.footage.nearest)}, {avatar.footage.offDeg ?? 0}° from your view
                  </span>
                  <span className="text-slate-400">
                    {atCamera
                      ? "You are looking from a camera's own angle: what you see on the subject is that camera's frame, placed on the reconstructed body."
                      : "This instant's footage is projected onto the reconstructed body from every camera that sees each surface. Surfaces no camera sees right now show the body's baked texture, which is built from the whole clip."}
                  </span>
                </>
              ) : (
                <>
                  <span className={`rounded border px-1 ${EVIDENCE_STYLE.reconstructed}`}>RECONSTRUCTED 3D BODY</span>
                  <span className="text-slate-400">
                    pose fitted from {avatar.cameras ?? 0} camera{avatar.cameras === 1 ? "" : "s"} at this instant
                  </span>
                  {mode === "hybrid" && !avatar.placeholder && (
                    <span className="text-amber-300">No camera cut-out is available for this instant, so only the body's baked texture is shown.</span>
                  )}
                </>
              )}
              {avatar.placeholder ? (
                <span className="text-amber-300">Placeholder asset: an untextured stand-in body following the track, not yet the reconstruction.</span>
              ) : mode === "hybrid" ? null : avatar.textured ? (
                <span className="text-slate-400">
                  Reconstructed 3D body: one articulated mesh fitted to all cameras over the whole clip; texture is real footage back-projected onto it. Surfaces no
                  camera saw are filled from neighbouring observed texture.
                </span>
              ) : (
                <span className="text-slate-400">
                  Reconstructed 3D body: one articulated mesh fitted to all cameras over the whole clip.{" "}
                  <span className="text-amber-300">This asset carries no texture: the body is drawn in neutral grey, no footage colour is shown on it.</span>
                </span>
              )}
              {avatar.cameras === 0 && (
                <span className="text-amber-300">No camera gave a usable detection of the body at this instant: this pose is carried by the fit from neighbouring frames, not measured.</span>
              )}
            </span>
          ) : (
            <span className="text-slate-400">Debug avatar shown: {avatar?.reason ?? "loading"}</span>
          )}
        </div>
      )}
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
                <span className="text-slate-400">
                  Body volume is inferred from the silhouette (rounded thickness ≈ 0.6 × width). The back is shaded in the measured clothing colour, since no
                  camera saw it. Neither is measured geometry.
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
              <span className="text-slate-400">Debug avatar shown: {status?.reason ?? "loading"}</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
