import { create } from "zustand";
import { DEVICE_IDS, type DeviceId } from "../../config/devices";

/**
 * Mirrors the BLACKSITE agent-worker's WebSocket messages (server.py /
 * ws_backend.py), which wrap the pydantic records in services/agent-worker/
 * blacksite_agent/schemas.py serialized camelCase via model_dump(by_alias=True).
 */
export type AlertStage = "idle" | "alert" | "investigating" | "resolved";

export type StepId = "triage" | "contain" | "recover";
export type OptionId = "A" | "B" | "C" | "D";

export interface TrainingOption {
  optionId: OptionId;
  label: string;
  action: string;
}

export interface StepPresentation {
  stepId: StepId;
  stepNumber: number;
  totalSteps: number;
  title: string;
  objective: string;
  narrative: string;
  leadingQuestion: string;
  evidenceIds: string[];
  options: TrainingOption[];
}

export interface SimulatedOutcome {
  strategy: string;
  serviceDisruption: "low" | "medium" | "high";
  assetsAffected: string[];
  recoveryComplexity: "low" | "medium" | "high";
  responseTimeMinutes: number;
  assumptions: string[];
}

export interface ChoiceResult {
  selection: { stepId: StepId; attempt: number; optionId: OptionId };
  correct: boolean;
  points: number;
  stepResolved: boolean;
  consequence: SimulatedOutcome;
  explanation: string;
  hint: string | null;
  correctOptionId: OptionId | null;
  totalScore: number;
  sessionComplete: boolean;
}

export interface Debrief {
  summary: string;
  strengths: string[];
  improvements: string[];
}

export interface SessionSummary {
  sessionId: string;
  alertId: string;
  scenarioTitle: string;
  status: "active" | "complete";
  currentStepIndex: number;
  score: number;
}

export interface TrainingSessionState {
  deviceId: DeviceId | null;
  summary: SessionSummary;
  step: StepPresentation | null;
  lastResult: ChoiceResult | null;
  debrief: Debrief | null;
  /** Option IDs already tried on the current step, so the panel can grey them out. */
  tried: OptionId[];
}

function stageFor(summary: SessionSummary): AlertStage {
  if (summary.status === "complete") return "resolved";
  return summary.currentStepIndex > 0 ? "investigating" : "alert";
}

function idleStages(): Record<DeviceId, AlertStage> {
  return DEVICE_IDS.reduce(
    (acc, id) => ({ ...acc, [id]: "idle" as AlertStage }),
    {} as Record<DeviceId, AlertStage>,
  );
}

interface CyberAlertState {
  connected: boolean;
  /** Current highlight stage per device marker (see DeviceMarkers.tsx). */
  stages: Record<DeviceId, AlertStage>;
  sessions: Record<string, TrainingSessionState>;
  /** Which session's guide panel is open, if any. */
  activeSessionId: string | null;
  lastError: string | null;

  setConnected: (v: boolean) => void;
  onSession: (assetId: DeviceId | null, summary: SessionSummary) => void;
  onStep: (sessionId: string, step: StepPresentation) => void;
  onResult: (sessionId: string, result: ChoiceResult) => void;
  onDebrief: (sessionId: string, debrief: Debrief) => void;
  onError: (sessionId: string | null, message: string) => void;
  openSession: (sessionId: string | null) => void;
}

export const useCyberAlertStore = create<CyberAlertState>()((set) => ({
  connected: false,
  stages: idleStages(),
  sessions: {},
  activeSessionId: null,
  lastError: null,

  setConnected: (connected) => set({ connected }),

  onSession: (assetId, summary) =>
    set((s) => {
      const existing = s.sessions[summary.sessionId];
      const deviceId = assetId ?? existing?.deviceId ?? null;
      const sessions = {
        ...s.sessions,
        [summary.sessionId]: {
          deviceId,
          summary,
          step: existing?.step ?? null,
          lastResult: existing?.lastResult ?? null,
          debrief: existing?.debrief ?? null,
          tried: existing?.tried ?? [],
        },
      };
      const stages = deviceId ? { ...s.stages, [deviceId]: stageFor(summary) } : s.stages;
      return { sessions, stages, activeSessionId: deviceId ? summary.sessionId : s.activeSessionId };
    }),

  onStep: (sessionId, step) =>
    set((s) => {
      const existing = s.sessions[sessionId];
      if (!existing) return {};
      return {
        sessions: {
          ...s.sessions,
          [sessionId]: { ...existing, step, lastResult: null, tried: [] },
        },
      };
    }),

  onResult: (sessionId, result) =>
    set((s) => {
      const existing = s.sessions[sessionId];
      if (!existing) return {};
      return {
        sessions: {
          ...s.sessions,
          [sessionId]: {
            ...existing,
            lastResult: result,
            tried: [...existing.tried, result.selection.optionId],
          },
        },
      };
    }),

  onDebrief: (sessionId, debrief) =>
    set((s) => {
      const existing = s.sessions[sessionId];
      if (!existing) return {};
      return { sessions: { ...s.sessions, [sessionId]: { ...existing, debrief } } };
    }),

  onError: (_sessionId, message) => set({ lastError: message }),

  openSession: (activeSessionId) => set({ activeSessionId }),
}));
