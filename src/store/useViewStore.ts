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
  /** Subject annotation mode (click feet in real video → floor position). */
  annotating: boolean;
  annotationCameraId: CameraId;
  /** Calibration mode for the selected CCTV camera. */
  calibrating: boolean;
  /** Sidebar state to restore when calibration ends. */
  collapsedBeforeCalibrate: boolean;
  /** Opacity of the real recording overlaid on the virtual CCTV view (0..1). */
  ghostOpacity: number;
  ghostBlend: "normal" | "difference";
  /** CCTV view: overlay real footage + annotated video point vs. projected 3D subject. */
  trackingDiagnostics: boolean;
  pointerLocked: boolean;
  /** Free-camera base speed (m/s). */
  flySpeed: number;
  /** One-shot request for the free camera to move to `position` and look at `target`. */
  flyFocus: { position: [number, number, number]; target: [number, number, number]; token: number } | null;
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
  setAnnotating: (v: boolean) => void;
  setAnnotationCamera: (id: CameraId) => void;
  setGhostOpacity: (v: number) => void;
  setGhostBlend: (v: "normal" | "difference") => void;
  toggleTrackingDiagnostics: () => void;
  setPointerLocked: (v: boolean) => void;
  setFlySpeed: (v: number) => void;
  resetView: () => void;
  focusFreeCamera: (position: [number, number, number], target: [number, number, number]) => void;
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
  annotating: false,
  annotationCameraId: "cam1",
  collapsedBeforeCalibrate: false,
  ghostOpacity: 0.5,
  ghostBlend: "normal",
  trackingDiagnostics: false,
  pointerLocked: false,
  flySpeed: 2.5,
  resetToken: 0,
  flyFocus: null,
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
  // Annotating auto-collapses the CCTV sidebar (videos stay mounted) like calibration does.
  setAnnotating: (annotating) =>
    set((s) =>
      annotating === s.annotating
        ? {}
        : annotating
          ? {
              annotating,
              calibrating: false,
              collapsedBeforeCalibrate: s.calibrating ? s.collapsedBeforeCalibrate : s.feedsCollapsed,
              feedsCollapsed: true,
            }
          : { annotating, feedsCollapsed: s.collapsedBeforeCalibrate },
    ),
  setAnnotationCamera: (annotationCameraId) => set({ annotationCameraId }),
  setGhostOpacity: (ghostOpacity) => set({ ghostOpacity: Math.min(Math.max(ghostOpacity, 0), 1) }),
  setGhostBlend: (ghostBlend) => set({ ghostBlend }),
  toggleTrackingDiagnostics: () => set((s) => ({ trackingDiagnostics: !s.trackingDiagnostics })),
  setPointerLocked: (pointerLocked) => set({ pointerLocked }),
  setFlySpeed: (flySpeed) => set({ flySpeed: Math.min(Math.max(flySpeed, 0.25), 20) }),
  resetView: () => set((s) => ({ resetToken: s.resetToken + 1 })),
  focusFreeCamera: (position, target) => set((s) => ({ flyFocus: { position, target, token: (s.flyFocus?.token ?? 0) + 1 } })),
  setTransitioning: (transitioning) => set({ transitioning }),
  setQuality: (quality) => set({ quality }),
}));
