import { create } from "zustand";

export type DemoPhase = "idle" | "preparing" | "running" | "ended";

interface DemoState {
  phase: DemoPhase;
  /** Demo clock, seconds. */
  elapsed: number;
  /** 0..1 while preparing (assets loading). */
  progress: number;
  /** The clock only moves when it is stepped (frame-by-frame recording). */
  manual: boolean;
  start: (opts?: { manual?: boolean }) => void;
  stop: () => void;
}

/**
 * Lifecycle of the demo walkthrough. The director inside the canvas does the work: it prepares when the
 * phase turns "preparing", runs the clock while "running", and puts the viewer back when it returns to "idle".
 */
export const useDemoStore = create<DemoState>()((set, get) => ({
  phase: "idle",
  elapsed: 0,
  progress: 0,
  manual: false,
  start: (opts) => {
    if (get().phase !== "idle") return;
    set({ phase: "preparing", elapsed: 0, progress: 0, manual: !!opts?.manual });
  },
  stop: () => {
    if (get().phase !== "idle") set({ phase: "idle", elapsed: 0, progress: 0, manual: false });
  },
}));

export const demoActive = () => useDemoStore.getState().phase !== "idle";
