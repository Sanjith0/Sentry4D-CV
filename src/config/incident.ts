import type { IncidentEvent } from "../types/security";

export const incidentConfig = {
  name: "INC-2026-1108 · Room Scan Investigation",
  /** Wall-clock start of master time 0, used to render recording timestamps. */
  recordingStart: "2026-11-08T00:00:00",
  /** Master duration (s) used until videos/events load; then duration = their full extent. */
  minDuration: 60,
};

/**
 * Timeline markers shown until the sentry feature calls `setEvents()`.
 * Empty on purpose: we do not fabricate incident events.
 */
export const initialEvents: IncidentEvent[] = [];

/** Event-type → color mapping. Unknown types fall back to `default`. */
export const eventTypeStyles: Record<string, { color: string; label: string }> = {
  person: { color: "#22d3ee", label: "Subject" },
  entry: { color: "#22d3ee", label: "Entry" },
  exit: { color: "#22d3ee", label: "Exit" },
  gap: { color: "#f59e0b", label: "Tracking gap" },
  object: { color: "#f59e0b", label: "Object" },
  "object-moved": { color: "#f59e0b", label: "Object moved" },
  alert: { color: "#ef4444", label: "Alert" },
  sentry: { color: "#ef4444", label: "Sentry" },
  default: { color: "#94a3b8", label: "Event" },
};

export function eventStyle(type: string) {
  return eventTypeStyles[type] ?? eventTypeStyles.default;
}
