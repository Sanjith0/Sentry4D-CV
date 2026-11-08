import { create } from "zustand";
import { CAMERA_IDS, type CameraId, type PersonAnnotationDataset, type PersonObservation, type Vec3 } from "../../types/security";
import projectFile from "../../data/person-annotations.json";
import { parseVisibility, useVisibilityStore } from "./useVisibilityStore";
import { retimeObservationV1toV2 } from "../../lib/syncMigration";
import { useReplayStore } from "../../store/useReplayStore";

const STORAGE_KEY = "sentry3d.annotations.v2";
/** v1 = timed with the manual sync offsets; migrated (re-timed) once into v2. */
const LEGACY_KEY_V1 = "sentry3d.annotations.v1";
const UNDO_LIMIT = 50;

type Persons = Record<string, PersonObservation[]>;

interface Persisted {
  activePersonId: string;
  persons: Persons;
}

export interface AnnotationState extends Persisted {
  /** Observation being corrected (next click in video / top-down floor moves it). */
  selectedId: string | null;
  /** Id of the most recently added/edited observation (highlighted in 3D). */
  lastId: string | null;
  undoStack: Persons[];

  setActivePerson: (id: string) => void;
  addPerson: () => string;
  renamePerson: (from: string, to: string) => boolean;
  add: (obs: Omit<PersonObservation, "id">) => PersonObservation;
  update: (id: string, patch: Partial<Omit<PersonObservation, "id">>) => void;
  remove: (id: string) => void;
  select: (id: string | null) => void;
  undo: () => void;
  clearPerson: () => void;
  /** Replace/merge datasets (import). Returns number of observations imported. */
  importDatasets: (datasets: PersonAnnotationDataset[]) => number;
  exportDataset: (personId?: string) => PersonAnnotationDataset;
  exportAll: () => { version: 1; syncOffsets: Record<CameraId, number>; datasets: PersonAnnotationDataset[] };
}

const newId = () => `obs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
const sortObs = (a: PersonObservation[]) => [...a].sort((x, y) => x.masterTime - y.masterTime);
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r4 = (v: number) => Math.round(v * 10000) / 10000;

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Validate + normalize an imported observation; throws with a readable message. */
export function parseObservation(o: unknown, i: number): PersonObservation {
  const x = o as Record<string, unknown>;
  const where = `observation #${i + 1}`;
  if (!x || typeof x !== "object") throw new Error(`${where}: not an object`);
  if (!isNum(x.masterTime)) throw new Error(`${where}: masterTime must be a number`);
  if (!CAMERA_IDS.includes(x.cameraId as CameraId)) throw new Error(`${where}: unknown cameraId "${String(x.cameraId)}"`);
  const px = x.pixel as unknown[];
  if (!Array.isArray(px) || px.length !== 2 || !px.every(isNum)) throw new Error(`${where}: pixel must be [u, v]`);
  const wp = x.worldPosition as unknown[];
  if (!Array.isArray(wp) || wp.length !== 3 || !wp.every(isNum)) throw new Error(`${where}: worldPosition must be [x, y, z]`);
  const source = x.source === "manual-topdown" ? "manual-topdown" : "manual";
  return {
    id: typeof x.id === "string" && x.id ? x.id : newId(),
    masterTime: r3(x.masterTime),
    cameraId: x.cameraId as CameraId,
    pixel: [r4(px[0] as number), r4(px[1] as number)],
    worldPosition: (wp as number[]).map(r3) as Vec3,
    source,
    ...(isNum(x.videoTime) ? { videoTime: r3(x.videoTime) } : {}),
  };
}

export function parseDatasets(json: unknown): PersonAnnotationDataset[] {
  const j = json as Record<string, unknown>;
  const list = Array.isArray(j?.datasets) ? (j.datasets as unknown[]) : j && "observations" in j ? [j] : null;
  if (!list) throw new Error('Expected {"personId", "observations": [...]} or {"datasets": [...]}');
  return list.map((d, k) => {
    const ds = d as Record<string, unknown>;
    const personId = typeof ds.personId === "string" && ds.personId.trim() ? ds.personId.trim() : `person_${String(k + 1).padStart(2, "0")}`;
    if (!Array.isArray(ds.observations)) throw new Error(`${personId}: observations must be an array`);
    return { personId, observations: sortObs(ds.observations.map(parseObservation)), visibility: parseVisibility(ds.visibility) };
  });
}

function load(): Persisted {
  try {
    const legacy = localStorage.getItem(STORAGE_KEY) ? null : localStorage.getItem(LEGACY_KEY_V1);
    const raw = localStorage.getItem(STORAGE_KEY) ?? legacy;
    if (raw) {
      const p = JSON.parse(raw) as Persisted;
      if (legacy) {
        for (const k of Object.keys(p.persons ?? {})) p.persons[k] = p.persons[k].map(retimeObservationV1toV2);
        console.info("[Sentry3D] migrated browser annotations to the audio-corrected sync offsets");
      }
      if (p && p.persons && typeof p.activePersonId === "string") {
        const persons: Persons = {};
        for (const [k, v] of Object.entries(p.persons)) persons[k] = sortObs(v.map(parseObservation));
        if (!persons[p.activePersonId]) persons[p.activePersonId] = [];
        return { activePersonId: p.activePersonId, persons };
      }
    }
  } catch (e) {
    console.warn("[Sentry3D] could not restore annotations from localStorage", e);
  }
  // First run in this browser: seed from the committed project file.
  try {
    const ds = parseDatasets(projectFile);
    if (ds.length) return { activePersonId: ds[0].personId, persons: Object.fromEntries(ds.map((d) => [d.personId, d.observations])) };
  } catch (e) {
    console.warn("[Sentry3D] src/data/person-annotations.json is invalid", e);
  }
  return { activePersonId: "person_01", persons: { person_01: [] } };
}

function persist(s: Persisted) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ activePersonId: s.activePersonId, persons: s.persons }));
  } catch {
    /* storage unavailable */
  }
}

const initial = load();

export const useAnnotationStore = create<AnnotationState>()((set, get) => {
  /** Apply a change to persons with undo + persistence. */
  const mutate = (fn: (p: Persons, active: string) => Persons, extra: Partial<AnnotationState> = {}) =>
    set((s) => {
      const persons = fn(s.persons, s.activePersonId);
      const next = { ...s, ...extra, persons, undoStack: [...s.undoStack, s.persons].slice(-UNDO_LIMIT) };
      persist(next);
      return next;
    });

  return {
    ...initial,
    selectedId: null,
    lastId: null,
    undoStack: [],

    setActivePerson: (activePersonId) =>
      set((s) => {
        const persons = s.persons[activePersonId] ? s.persons : { ...s.persons, [activePersonId]: [] };
        const next = { ...s, activePersonId, persons, selectedId: null };
        persist(next);
        return next;
      }),
    addPerson: () => {
      const ids = Object.keys(get().persons);
      let n = ids.length + 1;
      while (ids.includes(`person_${String(n).padStart(2, "0")}`)) n++;
      const id = `person_${String(n).padStart(2, "0")}`;
      get().setActivePerson(id);
      return id;
    },
    renamePerson: (from, to) => {
      to = to.trim();
      const s = get();
      if (!to || to === from || s.persons[to] || !s.persons[from]) return false;
      const persons = Object.fromEntries(Object.entries(s.persons).map(([k, v]) => [k === from ? to : k, v]));
      const next = { ...s, persons, activePersonId: s.activePersonId === from ? to : s.activePersonId };
      persist(next);
      set(next);
      return true;
    },
    add: (o) => {
      const obs: PersonObservation = { ...o, id: newId() };
      mutate((p, a) => ({ ...p, [a]: sortObs([...(p[a] ?? []), obs]) }), { lastId: obs.id, selectedId: null });
      return obs;
    },
    update: (id, patch) =>
      mutate(
        (p, a) => ({ ...p, [a]: sortObs((p[a] ?? []).map((o) => (o.id === id ? { ...o, ...patch } : o))) }),
        { lastId: id },
      ),
    remove: (id) =>
      mutate((p, a) => ({ ...p, [a]: (p[a] ?? []).filter((o) => o.id !== id) }), {
        selectedId: get().selectedId === id ? null : get().selectedId,
        lastId: get().lastId === id ? null : get().lastId,
      }),
    select: (selectedId) => set({ selectedId }),
    undo: () =>
      set((s) => {
        const prev = s.undoStack[s.undoStack.length - 1];
        if (!prev) return {};
        const persons = prev[s.activePersonId] ? prev : { ...prev, [s.activePersonId]: [] };
        const next = { ...s, persons, undoStack: s.undoStack.slice(0, -1), selectedId: null };
        persist(next);
        return next;
      }),
    clearPerson: () => mutate((p, a) => ({ ...p, [a]: [] }), { selectedId: null, lastId: null }),
    importDatasets: (datasets) => {
      let n = 0;
      mutate((p) => {
        const out = { ...p };
        for (const d of datasets) {
          out[d.personId] = d.observations;
          n += d.observations.length;
          useVisibilityStore.getState().importMarks(d.personId, d.visibility ?? []);
        }
        return out;
      }, datasets.length ? { activePersonId: datasets[0].personId, selectedId: null } : {});
      return n;
    },
    exportDataset: (personId) => {
      const s = get();
      const id = personId ?? s.activePersonId;
      return { personId: id, observations: sortObs(s.persons[id] ?? []), visibility: useVisibilityStore.getState().marks[id] ?? [] };
    },
    exportAll: () => {
      const s = get();
      return {
        version: 1,
        /** Sync offsets these master times are based on (videoTime = masterTime + offset). */
        syncOffsets: { ...useReplayStore.getState().cameraOffsets },
        datasets: Object.keys(s.persons)
          .filter((k) => s.persons[k].length || useVisibilityStore.getState().marks[k]?.length)
          .map((k) => ({ personId: k, observations: sortObs(s.persons[k]), visibility: useVisibilityStore.getState().marks[k] ?? [] })),
      };
    },
  };
});

/** Observations of the active person (sorted by master time). */
export function useActiveObservations() {
  return useAnnotationStore((s) => s.persons[s.activePersonId] ?? EMPTY);
}
const EMPTY: PersonObservation[] = [];
