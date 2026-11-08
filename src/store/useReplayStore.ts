import { create } from "zustand";
import type { CameraMode, IncidentEvent, SelectedEntityInfo } from "../types/security";
import { incidentConfig, initialEvents } from "../config/incident";
import { securityCameras } from "../config/cameras";

export const PLAYBACK_SPEEDS = [0.5, 1, 2] as const;

export interface ReplayState {
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  playbackSpeed: number;
  selectedCameraId: string | null;
  cameraMode: CameraMode;
  xrayEnabled: boolean;
  sentryEnabled: boolean;

  /** Incremented on every explicit seek so video elements can hard-sync. */
  seekToken: number;
  /** Loaded video durations, used to extend `duration`. */
  videoDurations: Record<string, number>;
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
  selectCamera: (id: string | null) => void;
  /** Select a CCTV camera and switch the viewport to its perspective. */
  viewThroughCamera: (id: string) => void;
  setCameraMode: (mode: CameraMode) => void;
  toggleXray: () => void;
  toggleSentry: () => void;
  setXray: (on: boolean) => void;
  setSentry: (on: boolean) => void;

  /** Advance the master clock (called by useMasterClock). */
  tick: (dt: number) => void;
  registerVideoDuration: (cameraId: string, duration: number) => void;
  setEvents: (events: IncidentEvent[]) => void;
  setActiveSubjectCount: (count: number) => void;
  setSelectedEntity: (info: SelectedEntityInfo | null) => void;
}

const clamp = (t: number, d: number) => Math.min(Math.max(t, 0), d);

/** Duration covers all loaded recordings and events; falls back to minDuration when nothing is loaded. */
function computeDuration(videoDurations: Record<string, number>, events: IncidentEvent[]) {
  let d = 0;
  for (const cam of securityCameras) {
    const vd = videoDurations[cam.id];
    if (vd && Number.isFinite(vd)) d = Math.max(d, cam.timeOffset + vd);
  }
  for (const e of events) d = Math.max(d, e.time);
  return d > 0 ? d : incidentConfig.minDuration;
}

export const useReplayStore = create<ReplayState>()((set, get) => ({
  currentTime: 0,
  duration: computeDuration({}, initialEvents),
  isPlaying: false,
  playbackSpeed: 1,
  selectedCameraId: null,
  cameraMode: "orbit",
  xrayEnabled: false,
  sentryEnabled: false,
  seekToken: 0,
  videoDurations: {},
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
  seek: (time) =>
    set((s) => ({ currentTime: clamp(time, s.duration), seekToken: s.seekToken + 1 })),
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

  tick: (dt) => {
    const s = get();
    if (!s.isPlaying) return;
    const next = s.currentTime + dt * s.playbackSpeed;
    if (next >= s.duration) set({ currentTime: s.duration, isPlaying: false });
    else set({ currentTime: next });
  },
  registerVideoDuration: (cameraId, d) =>
    set((s) => {
      const videoDurations = { ...s.videoDurations, [cameraId]: d };
      return { videoDurations, duration: computeDuration(videoDurations, s.events) };
    }),
  setEvents: (events) =>
    set((s) => ({ events: [...events].sort((a, b) => a.time - b.time), duration: computeDuration(s.videoDurations, events) })),
  setActiveSubjectCount: (activeSubjectCount) => set({ activeSubjectCount }),
  setSelectedEntity: (selectedEntity) => set({ selectedEntity }),
}));
