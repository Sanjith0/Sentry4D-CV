import { Radar } from "lucide-react";
import { securityCameras } from "../../config/cameras";
import { subjects } from "../../config/subjects";
import { useReplayStore } from "../../store/useReplayStore";
import { formatClock } from "../../lib/format";
import { useViewStore } from "../../store/useViewStore";
import { subjectPosition } from "./SceneActors";
import { CAMERA_STATE_COLOR, CAMERA_STATE_LABEL, useEvidenceStore } from "./useEvidence";

const STATUS_STYLE = {
  observed: "text-cyan-200",
  estimated: "text-amber-300",
  departed: "text-slate-400",
  "not-yet": "text-slate-500",
  none: "text-slate-500",
} as const;

/** Free camera ~5 m from the person, on the far side of the room centre, looking at their chest. */
function locate(subjectId: string) {
  const sub = subjects.find((s) => s.id === subjectId);
  const r = useReplayStore.getState();
  const v = useViewStore.getState();
  const tr = sub && v.roomBounds ? subjectPosition(subjectId, r.currentTime) : null;
  if (!sub || !tr || !v.roomBounds) return;
  const [cx, , cz] = v.roomBounds.center;
  let dx = cx - tr[0];
  let dz = cz - tr[2];
  const len = Math.hypot(dx, dz) || 1;
  dx /= len;
  dz /= len;
  const pos: [number, number, number] = [tr[0] + dx * 5, 1.7, tr[2] + dz * 5];
  if (r.cameraMode !== "free") r.setCameraMode("free");
  // Let the free controller mount first.
  setTimeout(() => v.focusFreeCamera(pos, [tr[0], sub.heightM * 0.55, tr[2]]), r.cameraMode === "free" ? 0 : 1000);
}

/** Live provenance: which camera currently sees each tracked person. Click a camera to view through it. */
export function EvidencePanel() {
  const bySubject = useEvidenceStore((s) => s.bySubject);
  const t = useReplayStore((s) => Math.floor(s.currentTime * 10) / 10);
  const viewThroughCamera = useReplayStore((s) => s.viewThroughCamera);
  const selectedCam = useReplayStore((s) => (s.cameraMode === "cctv" ? s.selectedCameraId : null));
  const xray = useReplayStore((s) => s.xrayEnabled);
  const tracked = subjects.filter((s) => bySubject[s.id] && bySubject[s.id].status !== "none");
  if (!tracked.length) return null;

  return (
    <div className="glass pointer-events-auto absolute right-3 bottom-3 z-10 w-[268px] rounded-lg p-2.5 font-mono text-[11px] fade-in">
      <div className="mb-1.5 flex items-center gap-1.5">
        <Radar className="h-3.5 w-3.5 text-cyan-300" />
        <span className="label !text-slate-300">Camera evidence</span>
        {xray && <span className="ml-auto rounded bg-cyan-400/20 px-1 text-[9px] text-cyan-200">X-RAY</span>}
      </div>
      {tracked.map((sub) => {
        const ev = bySubject[sub.id];
        const word =
          ev.status === "observed" ? "OBSERVED" : ev.status === "estimated" ? "ESTIMATED" : ev.status === "departed" ? "LAST SEEN" : "NOT YET SEEN";
        return (
          <div key={sub.id} className="space-y-0.5">
            <div className="flex items-center gap-2">
              <span className={`font-semibold tracking-wide ${STATUS_STYLE[ev.status]}`}>
                {sub.label}: {word}
              </span>
              <button
                type="button"
                onClick={() => locate(sub.id)}
                title="Free camera: look at this person from across the room (pair with X-ray)"
                className="ml-auto rounded border border-ink-500 px-1.5 text-[9px] text-slate-300 hover:border-cyan-400 hover:text-cyan-200"
              >
                LOCATE
              </button>
            </div>
            {ev.status !== "observed" && ev.lastSeen && (
              <div className="text-[10px] text-slate-400">
                last seen CAM {ev.lastSeen.cameraId.slice(3).padStart(2, "0")} @ {formatClock(ev.lastSeen.t)} · {(t - ev.lastSeen.t).toFixed(1)} s ago
              </div>
            )}
            <div className="mt-1 space-y-px">
              {securityCameras.map((c, i) => {
                const ce = ev.cameras[c.id];
                const color = CAMERA_STATE_COLOR[ce.state];
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => viewThroughCamera(c.id)}
                    title={`View through ${c.name}`}
                    className={`flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-ink-700 ${selectedCam === c.id ? "bg-ink-700/80" : ""}`}
                  >
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: color, boxShadow: ce.state === "tracking" ? `0 0 6px ${color}` : undefined }} />
                    <span className="text-slate-300">CAM {String(i + 1).padStart(2, "0")}:</span>
                    <span style={{ color }}>{CAMERA_STATE_LABEL[ce.state]}</span>
                    {ce.at != null && ce.state !== "tracking" && ce.state !== "not-recording" && (
                      <span className="ml-auto text-[9px] text-slate-500">{ce.state === "lost" ? "seen" : "marked"} {formatClock(ce.at, false)}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      <div className="mt-1.5 border-t border-ink-600 pt-1 text-[9px] leading-snug text-slate-500">
        From real annotations + visibility marks only. Recording ≠ seeing.
      </div>
    </div>
  );
}
