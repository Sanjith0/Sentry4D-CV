import type { CameraId } from "../../types/security";

/** Mirrors server/investigator.ts (validated server-side before it reaches the client). */
export interface EvidenceRef {
  cameraId: CameraId | null;
  timestamp: number;
  eventId: string | null;
  evidenceType: string;
}

export interface InvestigationReport {
  title: string;
  summary: string;
  keyEvents: { title: string; timestamp: number; description: string; cameraIds: CameraId[]; evidenceStatus: string; evidence: EvidenceRef[] }[];
  cameraEvidence: { cameraId: CameraId; summary: string; timestamps: number[] }[];
  uncertainties: { description: string; timestamp?: number; endTimestamp?: number; cameraIds?: string[] }[];
  recommendedActions: { action: string; timestamp?: number; cameraId?: string; priority: string }[];
}

export interface ReportMeta {
  model: string;
  toolCalls: number;
  turns: number;
  incidentId: string;
  generatedAt: string;
}

export interface TraceStep {
  id: string;
  name: string;
  label: string;
  args: string;
  status: "running" | "ok" | "error";
  ms?: number;
  summary?: string;
}
