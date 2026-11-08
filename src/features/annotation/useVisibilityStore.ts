import { create } from "zustand";
import { CAMERA_IDS, type CameraId, type VisibilityMark, type VisibilityState } from "../../types/security";
import projectFile from "../../data/person-annotations.json";

const STORAGE_KEY = "sentry3d.visibility.v1";
export const VISIBILITY_STATES: VisibilityState[] = ["observed", "occluded", "out-of-frame", "unknown"];
/** Marks closer than this (s) on the same camera replace each other. */
const SAME_FRAME = 0.02;

type Marks = Record<string, VisibilityMark[]>;

export interface VisibilityStoreState {
  marks: Marks;
  undoStack: Marks[];
  /** Set (or replace) the state of `cameraId` at `masterTime` for `personId`. */
  setMark: (personId: string, cameraId: CameraId, masterTime: number, state: VisibilityState) => void;
  remove: (personId: string, id: string) => void;
  undo: () => void;
  clearPerson: (personId: string) => void;
  importMarks: (personId: string, marks: VisibilityMark[]) => void;
}

const sortMarks = (m: VisibilityMark[]) => [...m].sort((a, b) => a.masterTime - b.masterTime);
const newId = () => `vis_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

export function parseVisibility(list: unknown): VisibilityMark[] {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new Error("visibility must be an array");
  return sortMarks(
    list.map((m, i) => {
      const x = m as Record<string, unknown>;
      if (typeof x?.masterTime !== "number" || !Number.isFinite(x.masterTime)) throw new Error(`visibility #${i + 1}: masterTime must be a number`);
      if (!CAMERA_IDS.includes(x.cameraId as CameraId)) throw new Error(`visibility #${i + 1}: unknown cameraId`);
      if (!VISIBILITY_STATES.includes(x.state as VisibilityState)) throw new Error(`visibility #${i + 1}: state must be one of ${VISIBILITY_STATES.join(", ")}`);
      return {
        id: typeof x.id === "string" && x.id ? x.id : newId(),
        masterTime: Math.round(x.masterTime * 1000) / 1000,
        cameraId: x.cameraId as CameraId,
        state: x.state as VisibilityState,
        source: "manual" as const,
      };
    }),
  );
}

function load(): Marks {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Marks;
      return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, parseVisibility(v)]));
    }
  } catch (e) {
    console.warn("[Sentry3D] could not restore visibility marks", e);
  }
  // First run: seed from the committed project file.
  try {
    const ds = (projectFile as { datasets?: { personId: string; visibility?: unknown }[] }).datasets ?? [];
    return Object.fromEntries(ds.map((d) => [d.personId, parseVisibility(d.visibility)]));
  } catch (e) {
    console.warn("[Sentry3D] invalid visibility in src/data/person-annotations.json", e);
    return {};
  }
}

const persist = (marks: Marks) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(marks));
  } catch {
    /* storage unavailable */
  }
};

export const useVisibilityStore = create<VisibilityStoreState>()((set) => {
  const mutate = (fn: (m: Marks) => Marks) =>
    set((s) => {
      const marks = fn(s.marks);
      persist(marks);
      return { marks, undoStack: [...s.undoStack, s.marks].slice(-50) };
    });
  return {
    marks: load(),
    undoStack: [],
    setMark: (personId, cameraId, masterTime, state) =>
      mutate((m) => {
        const t = Math.round(masterTime * 1000) / 1000;
        const kept = (m[personId] ?? []).filter((x) => !(x.cameraId === cameraId && Math.abs(x.masterTime - t) <= SAME_FRAME));
        return { ...m, [personId]: sortMarks([...kept, { id: newId(), masterTime: t, cameraId, state, source: "manual" }]) };
      }),
    remove: (personId, id) => mutate((m) => ({ ...m, [personId]: (m[personId] ?? []).filter((x) => x.id !== id) })),
    undo: () =>
      set((s) => {
        const prev = s.undoStack[s.undoStack.length - 1];
        if (!prev) return {};
        persist(prev);
        return { marks: prev, undoStack: s.undoStack.slice(0, -1) };
      }),
    clearPerson: (personId) => mutate((m) => ({ ...m, [personId]: [] })),
    importMarks: (personId, marks) => mutate((m) => ({ ...m, [personId]: sortMarks(marks) })),
  };
});
