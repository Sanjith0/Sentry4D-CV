import { incidentConfig } from "../config/incident";

export function formatClock(t: number, withMs = true) {
  if (!Number.isFinite(t)) t = 0;
  const sign = t < 0 ? "-" : "";
  t = Math.abs(t);
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const ms = Math.floor((t % 1) * 100);
  const base = `${sign}${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return withMs ? `${base}.${String(ms).padStart(2, "0")}` : base;
}

const startMs = new Date(incidentConfig.recordingStart).getTime();

/** Wall-clock timestamp (HH:MM:SS) for a master time. */
export function formatWallClock(t: number) {
  const d = new Date(startMs + t * 1000);
  return d.toLocaleTimeString("en-GB", { hour12: false });
}

export function formatDate(t: number) {
  const d = new Date(startMs + t * 1000);
  return d.toISOString().slice(0, 10);
}
