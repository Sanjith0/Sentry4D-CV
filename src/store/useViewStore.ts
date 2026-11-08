import { create } from "zustand";
import type { CameraId, RoomBounds } from "../types/security";

export type RenderQuality = "performance" | "balanced" | "ultra";

export type RoomStatus = "checking" | "loading" | "loaded" | "missing" | "error";

interface ViewState {
  roomBounds: RoomBounds | null;
  roomStatus: RoomStatus;
  roomError: string | null;
  showCoverage: boolean;
  showCeiling: boolean;
  showMarkers: boolean;
  feedsCollapsed: boolean;
  /** Feed shown enlarged over the viewport. */
  focusedFeedId: CameraId | null;
  hoveredCameraId: CameraId | null;
  syncPanelOpen: boolean;
  /** Calibration mode for the selected CCTV camera. */
  calibrating: boolean;
  /** Sidebar state to restore when calibration ends. */
  collapsedBeforeCalibrate: boolean;
  /** Opacity of the real recording overlaid on the virtual CCTV view (0..1). */
  ghostOpacity: number;
  ghostBlend: "normal" | "difference";
  pointerLocked: boolean;
  /** Free-camera base speed (m/s). */
  flySpeed: number;
  /** Incremented to request the current mode's home view. */
  resetToken: number;
  /** True while the camera rig animates between modes. */
  transitioning: boolean;
  quality: RenderQuality;

  setRoomBounds: (b: RoomBounds | null) => void;
  setRoomStatus: (s: RoomStatus, error?: string | null) => void;
  toggleCoverage: () => void;
  toggleCeiling: () => void;
  toggleMarkers: () => void;
  toggleFeedsCollapsed: () => void;
  setFocusedFeed: (id: CameraId | null) => void;
  setHoveredCamera: (id: CameraId | null) => void;
  setSyncPanelOpen: (open: boolean) => void;
  setCalibrating: (v: boolean) => void;
  setGhostOpacity: (v: number) => void;
  setGhostBlend: (v: "normal" | "difference") => void;
  setPointerLocked: (v: boolean) => void;
  setFlySpeed: (v: number) => void;
  resetView: () => void;
  setTransitioning: (v: boolean) => void;
  setQuality: (q: RenderQuality) => void;
}

export const useViewStore = create<ViewState>()((set) => ({
  roomBounds: null,
  roomStatus: "checking",
  roomError: null,
  showCoverage: true,
  showCeiling: false,
  showMarkers: true,
  feedsCollapsed: false,
  focusedFeedId: null,
  hoveredCameraId: null,
  syncPanelOpen: false,
  calibrating: false,
  collapsedBeforeCalibrate: false,
  ghostOpacity: 0.5,
  ghostBlend: "normal",
  pointerLocked: false,
  flySpeed: 2.5,
  resetToken: 0,
  transitioning: false,
  quality: "balanced",

  setRoomBounds: (roomBounds) => set({ roomBounds }),
  setRoomStatus: (roomStatus, roomError = null) => set({ roomStatus, roomError }),
  toggleCoverage: () => set((s) => ({ showCoverage: !s.showCoverage })),
  toggleCeiling: () => set((s) => ({ showCeiling: !s.showCeiling })),
  toggleMarkers: () => set((s) => ({ showMarkers: !s.showMarkers })),
  toggleFeedsCollapsed: () => set((s) => ({ feedsCollapsed: !s.feedsCollapsed })),
  setFocusedFeed: (focusedFeedId) => set({ focusedFeedId }),
  setHoveredCamera: (hoveredCameraId) => set({ hoveredCameraId }),
  setSyncPanelOpen: (syncPanelOpen) => set({ syncPanelOpen }),
  // Calibrating auto-collapses the CCTV sidebar for a bigger frame; restored afterwards.
  setCalibrating: (calibrating) =>
    set((s) =>
      calibrating === s.calibrating
        ? {}
        : calibrating
          ? { calibrating, collapsedBeforeCalibrate: s.feedsCollapsed, feedsCollapsed: true }
          : { calibrating, feedsCollapsed: s.collapsedBeforeCalibrate },
    ),
  setGhostOpacity: (ghostOpacity) => set({ ghostOpacity: Math.min(Math.max(ghostOpacity, 0), 1) }),
  setGhostBlend: (ghostBlend) => set({ ghostBlend }),
  setPointerLocked: (pointerLocked) => set({ pointerLocked }),
  setFlySpeed: (flySpeed) => set({ flySpeed: Math.min(Math.max(flySpeed, 0.25), 20) }),
  resetView: () => set((s) => ({ resetToken: s.resetToken + 1 })),
  setTransitioning: (transitioning) => set({ transitioning }),
  setQuality: (quality) => set({ quality }),
}));
