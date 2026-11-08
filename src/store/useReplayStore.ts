import { create } from "zustand";
import type {
  CameraCoverage,
  CameraFeedState,
  CameraId,
  CameraMode,
  FeedStatus,
  IncidentEvent,
  SelectedEntityInfo,
} from "../types/security";
import { incidentConfig, initialEvents } from "../config/incident";
import { securityCameras } from "../config/cameras";

export const PLAYBACK_SPEEDS = [0.5, 1, 2] as const;
const OFFSETS_STORAGE_KEY = "sentry3d.cameraOffsets.v1";

export interface ReplayState {
  /** THE master timestamp (seconds). Drives videos, 3D replay, tracking, events. */
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  playbackSpeed: number;
  selectedCameraId: CameraId | null;
  cameraMode: CameraMode;
  xrayEnabled: boolean;
  sentryEnabled: boolean;

  /** Incremented on every explicit seek so video elements can hard-sync. */
  seekToken: number;
  /** Live per-camera sync offsets: videoTime = masterTime + offset. */
  cameraOffsets: Record<CameraId, number>;
  /** Load state + duration of each recording. */
  feeds: Record<CameraId, CameraFeedState>;
  /** Integration points for the sentry feature. */
  events: IncidentEvent[];
  activeSubjectCount: number;
  selectedEntity: SelectedEntityInfo | null;

  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  seek: (time: number) => void;
  restart: () => void;
  setPlaybackSpeed: (speed: number) => void;
  selectCamera: (id: CameraId | null) => void;
  /** Select a CCTV camera and switch the viewport to its perspective. */
  viewThroughCamera: (id: CameraId) => void;
  setCameraMode: (mode: CameraMode) => void;
  toggleXray: () => void;
  toggleSentry: () => void;
  setXray: (on: boolean) => void;
  setSentry: (on: boolean) => void;

  setCameraOffset: (id: CameraId, offset: number) => void;
  /** Restore offsets from config/camera-sync.json and clear the saved local copy. */
  resetCameraOffsets: () => void;
  setFeedState: (id: CameraId, patch: Partial<Omit<CameraFeedState, "cameraId">>) => void;

  /** Video position for a camera at a master time (defaults to currentTime). */
  getVideoTime: (id: CameraId, masterTime?: number) => number;
  /** Which cameras have footage at a master time (defaults to currentTime). */
  getCameraCoverage: (masterTime?: number) => CameraCoverage[];

  /** Advance the master clock (called by useMasterClock). */
  tick: (dt: number) => void;
  setEvents: (events: IncidentEvent[]) => void;
  setActiveSubjectCount: (count: number) => void;
  setSelectedEntity: (info: SelectedEntityInfo | null) => void;
}

const clamp = (t: number, d: number) => Math.min(Math.max(t, 0), d);

export const defaultOffsets = Object.fromEntries(securityCameras.map((c) => [c.id, c.offset])) as Record<CameraId, number>;

function loadOffsets(): Record<CameraId, number> {
  try {
    const raw = localStorage.getItem(OFFSETS_STORAGE_KEY);
    if (!raw) return { ...defaultOffsets };
    const saved = JSON.parse(raw) as Partial<Record<CameraId, unknown>>;
    const out = { ...defaultOffsets };
    for (const c of securityCameras) {
      const v = saved[c.id];
      if (typeof v === "number" && Number.isFinite(v)) out[c.id] = v;
    }
    return out;
  } catch {
    return { ...defaultOffsets };
  }
}

function saveOffsets(offsets: Record<CameraId, number> | null) {
  try {
    if (offsets) localStorage.setItem(OFFSETS_STORAGE_KEY, JSON.stringify(offsets));
    else localStorage.removeItem(OFFSETS_STORAGE_KEY);
  } catch {
    /* storage unavailable: offsets still work for this session */
  }
}

const initialFeeds = Object.fromEntries(
  securityCameras.map((c) => [c.id, { cameraId: c.id, status: "loading" as FeedStatus, duration: null }]),
) as Record<CameraId, CameraFeedState>;

/** Master range [start, end] in which a camera has footage. */
export function recordingWindow(offset: number, duration: number | null): [number, number] | null {
  if (duration == null || !Number.isFinite(duration)) return null;
  return [-offset, duration - offset];
}

/**
 * Master duration = end of the last recording (with offsets) or last event.
 * Falls back to incidentConfig.minDuration when nothing has loaded.
 */
function computeDuration(feeds: Record<CameraId, CameraFeedState>, offsets: Record<CameraId, number>, events: IncidentEvent[]) {
  let d = 0;
  for (const c of securityCameras) {
    const w = recordingWindow(offsets[c.id], feeds[c.id].duration);
    if (w) d = Math.max(d, w[1]);
  }
  for (const e of events) d = Math.max(d, e.time);
  return d > 0 ? d : incidentConfig.minDuration;
}

const startOffsets = loadOffsets();

export const useReplayStore = create<ReplayState>()((set, get) => ({
  currentTime: 0,
  duration: computeDuration(initialFeeds, startOffsets, initialEvents),
  isPlaying: false,
  playbackSpeed: 1,
  selectedCameraId: null,
  cameraMode: "orbit",
  xrayEnabled: false,
  sentryEnabled: false,
  seekToken: 0,
  cameraOffsets: startOffsets,
  feeds: initialFeeds,
  events: initialEvents,
  activeSubjectCount: 0,
  selectedEntity: null,

  play: () => {
    const { currentTime, duration } = get();
    // Restart from the beginning if we're parked at the end.
    if (currentTime >= duration - 0.01) {
      set((s) => ({ currentTime: 0, seekToken: s.seekToken + 1, isPlaying: true }));
    } else set({ isPlaying: true });
  },
  pause: () => set({ isPlaying: false }),
  togglePlay: () => (get().isPlaying ? get().pause() : get().play()),
  seek: (time) => set((s) => ({ currentTime: clamp(time, s.duration), seekToken: s.seekToken + 1 })),
  restart: () => set((s) => ({ currentTime: 0, seekToken: s.seekToken + 1 })),
  setPlaybackSpeed: (playbackSpeed) => set({ playbackSpeed }),
  selectCamera: (selectedCameraId) => set({ selectedCameraId }),
  viewThroughCamera: (id) => set({ selectedCameraId: id, cameraMode: "cctv" }),
  setCameraMode: (cameraMode) =>
    set((s) => ({
      cameraMode,
      selectedCameraId: cameraMode === "cctv" ? (s.selectedCameraId ?? securityCameras[0]?.id ?? null) : s.selectedCameraId,
    })),
  toggleXray: () => set((s) => ({ xrayEnabled: !s.xrayEnabled })),
  toggleSentry: () => set((s) => ({ sentryEnabled: !s.sentryEnabled })),
  setXray: (xrayEnabled) => set({ xrayEnabled }),
  setSentry: (sentryEnabled) => set({ sentryEnabled }),

  setCameraOffset: (id, offset) => {
    if (!Number.isFinite(offset)) return;
    set((s) => {
      const cameraOffsets = { ...s.cameraOffsets, [id]: Math.round(offset * 1000) / 1000 };
      saveOffsets(cameraOffsets);
      const duration = computeDuration(s.feeds, cameraOffsets, s.events);
      return { cameraOffsets, duration, currentTime: clamp(s.currentTime, duration) };
    });
  },
  resetCameraOffsets: () => {
    saveOffsets(null);
    set((s) => {
      const cameraOffsets = { ...defaultOffsets };
      const duration = computeDuration(s.feeds, cameraOffsets, s.events);
      return { cameraOffsets, duration, currentTime: clamp(s.currentTime, duration) };
    });
  },
  setFeedState: (id, patch) =>
    set((s) => {
      const feeds = { ...s.feeds, [id]: { ...s.feeds[id], ...patch } };
      return { feeds, duration: computeDuration(feeds, s.cameraOffsets, s.events) };
    }),

  getVideoTime: (id, masterTime) => {
    const s = get();
    return (masterTime ?? s.currentTime) + (s.cameraOffsets[id] ?? 0);
  },
  getCameraCoverage: (masterTime) => {
    const s = get();
    const t = masterTime ?? s.currentTime;
    return securityCameras.map((c) => {
      const feed = s.feeds[c.id];
      const offset = s.cameraOffsets[c.id] ?? 0;
      const videoTime = t + offset;
      const recording = feed.status === "ready" && feed.duration != null && videoTime >= 0 && videoTime <= feed.duration;
      return { cameraId: c.id, offset, videoTime, recording, status: feed.status };
    });
  },

  tick: (dt) => {
    const s = get();
    if (!s.isPlaying) return;
    const next = s.currentTime + dt * s.playbackSpeed;
    if (next >= s.duration) set({ currentTime: s.duration, isPlaying: false });
    else set({ currentTime: next });
  },
  setEvents: (events) =>
    set((s) => ({
      events: [...events].sort((a, b) => a.time - b.time),
      duration: computeDuration(s.feeds, s.cameraOffsets, events),
    })),
  setActiveSubjectCount: (activeSubjectCount) => set({ activeSubjectCount }),
  setSelectedEntity: (selectedEntity) => set({ selectedEntity }),
}));
