/**
 * Cross-camera visibility evidence (pure, master-time).
 *
 * Evidence per camera = real feet annotations (implicit "observed") + manual marks
 * (observed / occluded / out-of-frame / unknown). A camera that is merely recording,
 * or merely has the person inside its field of view, is NOT treated as seeing them.
 */
import { trajectoryConfig as CFG } from "../../config/subjects";
import { CAMERA_IDS, type CameraId, type PersonObservation, type VisibilityMark, type VisibilityState } from "../../types/security";

export type CameraEvidenceState =
  | "tracking" // observed (annotation/mark within hold, or bridged between observations)
  | "occluded" // marked: in view but blocked
  | "out-of-frame" // marked: outside this camera's frame
  | "unknown" // marked: can't tell
  | "lost" // previously observed in this camera, no current evidence
  | "no-evidence" // never observed / no marks
  | "not-recording"; // camera has no footage at this master time

export interface CameraEvidence {
  cameraId: CameraId;
  state: CameraEvidenceState;
  /** Time of the evidence event the state is based on. */
  at: number | null;
  /** Last time this camera observed the person (≤ t), if any. */
  lastSeen: number | null;
}

export type SubjectEvidenceStatus = "observed" | "estimated" | "not-yet" | "departed" | "none";

export interface SubjectEvidence {
  status: SubjectEvidenceStatus;
  observers: CameraId[];
  lastSeen: { t: number; cameraId: CameraId } | null;
  cameras: Record<CameraId, CameraEvidence>;
}

interface Ev {
  t: number;
  state: VisibilityState;
}

export interface EvidenceIndex {
  perCamera: Record<CameraId, Ev[]>;
  first: number | null;
  last: number | null;
}

export function buildEvidenceIndex(observations: PersonObservation[], marks: VisibilityMark[]): EvidenceIndex {
  const perCamera = Object.fromEntries(CAMERA_IDS.map((c) => [c, [] as Ev[]])) as Record<CameraId, Ev[]>;
  for (const o of observations) perCamera[o.cameraId].push({ t: o.masterTime, state: "observed" });
  for (const m of marks) {
    const list = perCamera[m.cameraId];
    // An explicit mark at the same frame as a feet click overrides it.
    const i = list.findIndex((e) => Math.abs(e.t - m.masterTime) <= 0.02);
    if (i >= 0) list.splice(i, 1);
    list.push({ t: m.masterTime, state: m.state });
  }
  for (const c of CAMERA_IDS) perCamera[c].sort((a, b) => a.t - b.t);
  const times = observations.map((o) => o.masterTime);
  return { perCamera, first: times.length ? Math.min(...times) : null, last: times.length ? Math.max(...times) : null };
}

function cameraState(events: Ev[], t: number): Omit<CameraEvidence, "cameraId"> {
  let pi = -1;
  for (let i = 0; i < events.length; i++) {
    if (events[i].t <= t + 1e-6) pi = i;
    else break;
  }
  const prev = pi >= 0 ? events[pi] : null;
  const next = pi + 1 < events.length ? events[pi + 1] : null;
  let lastSeen: number | null = null;
  for (let i = pi; i >= 0; i--)
    if (events[i].state === "observed") {
      lastSeen = events[i].t;
      break;
    }

  if (prev?.state === "observed" && next?.state === "observed" && next.t - prev.t <= CFG.evidenceBridge)
    return { state: "tracking", at: prev.t, lastSeen };
  if (prev?.state === "observed" && t - prev.t <= CFG.evidenceHold) return { state: "tracking", at: prev.t, lastSeen };
  if (next?.state === "observed" && next.t - t <= CFG.evidenceHold && (!prev || prev.state === "observed" || next.t - t < t - prev.t))
    return { state: "tracking", at: next.t, lastSeen };
  if (prev && prev.state !== "observed") return { state: prev.state, at: prev.t, lastSeen };
  if (lastSeen != null) return { state: "lost", at: lastSeen, lastSeen };
  return { state: "no-evidence", at: null, lastSeen: null };
}

/**
 * Evidence at master time t.
 * @param recording returns false when a camera has no footage at t (null = unknown).
 */
export function evaluateEvidence(index: EvidenceIndex, t: number, recording: (c: CameraId, t: number) => boolean | null): SubjectEvidence {
  const cameras = {} as Record<CameraId, CameraEvidence>;
  let lastSeen: SubjectEvidence["lastSeen"] = null;
  const observers: CameraId[] = [];
  for (const c of CAMERA_IDS) {
    const r = cameraState(index.perCamera[c], t);
    let state = r.state;
    // Footage is required for any claim about what this camera sees right now.
    if (recording(c, t) === false && state !== "out-of-frame") state = "not-recording";
    cameras[c] = { cameraId: c, state, at: r.at, lastSeen: r.lastSeen };
    if (state === "tracking") observers.push(c);
    if (r.lastSeen != null && (!lastSeen || r.lastSeen > lastSeen.t)) lastSeen = { t: r.lastSeen, cameraId: c };
  }
  let status: SubjectEvidenceStatus;
  if (index.first == null) status = "none";
  else if (observers.length) status = "observed";
  else if (t < index.first - CFG.evidenceHold) status = "not-yet";
  else if (index.last != null && t > index.last + CFG.evidenceHold) status = "departed";
  else status = "estimated";
  return { status, observers, lastSeen, cameras };
}
