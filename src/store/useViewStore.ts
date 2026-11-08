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
  setPointerLocked: (pointerLocked) => set({ pointerLocked }),
  setFlySpeed: (flySpeed) => set({ flySpeed: Math.min(Math.max(flySpeed, 0.25), 20) }),
  resetView: () => set((s) => ({ resetToken: s.resetToken + 1 })),
  setTransitioning: (transitioning) => set({ transitioning }),
  setQuality: (quality) => set({ quality }),
}));
