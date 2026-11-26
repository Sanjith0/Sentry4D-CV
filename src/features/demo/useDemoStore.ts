import { create } from "zustand";

export type DemoPhase = "idle" | "preparing" | "running" | "ended";
/** Which walkthrough plays: 1 the original (DEMO MODE), 2 the second cut (DEMO 2). */
export type DemoVariant = 1 | 2;

interface DemoState {
  phase: DemoPhase;
  /** Demo clock, seconds. */
  elapsed: number;
  /** 0..1 while preparing (assets loading). */
  progress: number;
  /** The clock only moves when it is stepped (frame-by-frame recording). */
  manual: boolean;
  variant: DemoVariant;
  start: (opts?: { manual?: boolean; variant?: DemoVariant }) => void;
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
  variant: 1,
  start: (opts) => {
    if (get().phase !== "idle") return;
    set({ phase: "preparing", elapsed: 0, progress: 0, manual: !!opts?.manual, variant: opts?.variant === 2 ? 2 : 1 });
  },
  stop: () => {
    if (get().phase !== "idle") set({ phase: "idle", elapsed: 0, progress: 0, manual: false });
  },
}));

export const demoActive = () => useDemoStore.getState().phase !== "idle";
