import { useEffect } from "react";
import { create } from "zustand";
import { subjects } from "../../config/subjects";
import { useReplayStore } from "../../store/useReplayStore";
import type { CameraId } from "../../types/security";
import { useAnnotationStore } from "../annotation/useAnnotationStore";
import { useVisibilityStore } from "../annotation/useVisibilityStore";
import { buildEvidenceIndex, evaluateEvidence, type CameraEvidenceState, type EvidenceIndex, type SubjectEvidence } from "./evidence";

/** Live evidence per subject at the current master time (updated only when it changes). */
interface EvidenceStoreState {
  bySubject: Record<string, SubjectEvidence>;
  /** Strongest state per camera across subjects (for markers / feeds). */
  byCamera: Partial<Record<CameraId, CameraEvidenceState>>;
}
export const useEvidenceStore = create<EvidenceStoreState>()(() => ({ bySubject: {}, byCamera: {} }));

const RANK: Record<CameraEvidenceState, number> = {
  tracking: 6,
  occluded: 5,
  "out-of-frame": 4,
  unknown: 3,
  lost: 2,
  "no-evidence": 1,
  "not-recording": 0,
};

function recording(c: CameraId, t: number): boolean | null {
  const s = useReplayStore.getState();
  const f = s.feeds[c];
  if (f.status !== "ready" || f.duration == null) return null;
  const vt = t + (s.cameraOffsets[c] ?? 0);
  return vt >= 0 && vt <= f.duration;
}

let indexCache: Record<string, EvidenceIndex> = {};

export function evidenceAt(subjectId: string, t: number): SubjectEvidence | null {
  const idx = indexCache[subjectId];
  return idx ? evaluateEvidence(idx, t, recording) : null;
}

/** Mount once (App). Rebuilds indexes on data change, re-evaluates on time change. */
export function useEvidenceSync() {
  useEffect(() => {
    let lastKey = "";
    const rebuild = () => {
      const persons = useAnnotationStore.getState().persons;
      const marks = useVisibilityStore.getState().marks;
      indexCache = Object.fromEntries(subjects.map((s) => [s.id, buildEvidenceIndex(persons[s.personId] ?? [], marks[s.personId] ?? [])]));
      lastKey = "";
      evaluate();
    };
    const evaluate = () => {
      const t = useReplayStore.getState().currentTime;
      const bySubject: Record<string, SubjectEvidence> = {};
      const byCamera: EvidenceStoreState["byCamera"] = {};
      for (const s of subjects) {
        const ev = evidenceAt(s.id, t);
        if (!ev) continue;
        bySubject[s.id] = ev;
        for (const c of Object.values(ev.cameras)) if (RANK[c.state] > RANK[byCamera[c.cameraId] ?? "not-recording"]) byCamera[c.cameraId] = c.state;
      }
      // Key excludes continuous time so we only publish real state changes.
      const key = JSON.stringify([
        byCamera,
        Object.entries(bySubject).map(([k, e]) => [k, e.status, e.observers, e.lastSeen, Object.values(e.cameras).map((c) => [c.state, c.at])]),
      ]);
      if (key !== lastKey) {
        lastKey = key;
        useEvidenceStore.setState({ bySubject, byCamera });
      }
    };
    rebuild();
    const u1 = useAnnotationStore.subscribe((s, p) => s.persons !== p.persons && rebuild());
    const u2 = useVisibilityStore.subscribe((s, p) => s.marks !== p.marks && rebuild());
    const u3 = useReplayStore.subscribe((s, p) => {
      if (s.currentTime !== p.currentTime || s.feeds !== p.feeds || s.cameraOffsets !== p.cameraOffsets) evaluate();
    });
    return () => {
      u1();
      u2();
      u3();
    };
  }, []);
}

export const CAMERA_STATE_LABEL: Record<CameraEvidenceState, string> = {
  tracking: "TRACKING",
  occluded: "OCCLUDED",
  "out-of-frame": "OUT OF FRAME",
  unknown: "UNKNOWN",
  lost: "NO DETECTION",
  "no-evidence": "NO EVIDENCE",
  "not-recording": "NOT RECORDING",
};

export const CAMERA_STATE_COLOR: Record<CameraEvidenceState, string> = {
  tracking: "#22d3ee",
  occluded: "#f59e0b",
  "out-of-frame": "#fb923c",
  unknown: "#a78bfa",
  lost: "#94a3b8",
  "no-evidence": "#64748b",
  "not-recording": "#475569",
};
