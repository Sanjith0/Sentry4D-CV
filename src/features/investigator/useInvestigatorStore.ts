import { create } from "zustand";
import { useReplayStore } from "../../store/useReplayStore";
import type { InvestigationReport, ReportMeta, TraceStep } from "./types";

type Status = "idle" | "running" | "done" | "error";

interface InvestigatorState {
  open: boolean;
  status: Status;
  model: string | null;
  configured: boolean | null;
  trace: TraceStep[];
  modelTurns: number;
  report: InvestigationReport | null;
  meta: ReportMeta | null;
  error: string | null;
  savedAt: string | null;
  toggle: () => void;
  setOpen: (open: boolean) => void;
  checkStatus: () => Promise<void>;
  analyze: () => Promise<void>;
  cancel: () => void;
}

let controller: AbortController | null = null;
const SAVE_KEY = "sentry4d.investigator.reports";

export const useInvestigatorStore = create<InvestigatorState>((set, get) => ({
  open: false,
  status: "idle",
  model: null,
  configured: null,
  trace: [],
  modelTurns: 0,
  report: null,
  meta: null,
  error: null,
  savedAt: null,
  toggle: () => {
    const open = !get().open;
    set({ open });
    if (open && get().configured === null) void get().checkStatus();
  },
  setOpen: (open) => set({ open }),
  checkStatus: async () => {
    try {
      const r = await fetch("/api/investigator/status");
      const j = (await r.json()) as { configured: boolean; model: string };
      set({ configured: j.configured, model: j.model });
    } catch {
      set({ configured: false });
    }
  },
  cancel: () => controller?.abort(),
  analyze: async () => {
    if (get().status === "running") return;
    controller?.abort();
    controller = new AbortController();
    set({ status: "running", trace: [], report: null, meta: null, error: null, modelTurns: 0, savedAt: null });
    try {
      const res = await fetch("/api/investigate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ duration: useReplayStore.getState().duration }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`Investigator API unavailable (HTTP ${res.status}). Run with \`npm run dev\`.`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let finished = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line) as Record<string, unknown>;
          switch (ev.type) {
            case "start":
              set({ model: String(ev.model) });
              break;
            case "model":
              set({ modelTurns: Number(ev.turn) });
              break;
            case "tool-start":
              set((s) => ({ trace: [...s.trace, { id: String(ev.id), name: String(ev.name), label: String(ev.label), args: String(ev.args ?? ""), status: "running" }] }));
              break;
            case "tool-done":
              set((s) => ({
                trace: s.trace.map((t) => (t.id === ev.id ? { ...t, status: ev.status === "ok" ? "ok" : "error", ms: Number(ev.ms), summary: String(ev.summary ?? "") } : t)),
              }));
              break;
            case "report":
              finished = true;
              set({ status: "done", report: ev.report as InvestigationReport, meta: ev.meta as ReportMeta });
              break;
            case "error":
              finished = true;
              set({ status: "error", error: String(ev.error) });
              break;
          }
        }
      }
      if (!finished) set({ status: "error", error: "Connection closed before the investigation finished." });
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === "AbortError";
      set({ status: aborted ? "idle" : "error", error: aborted ? null : e instanceof Error ? e.message : String(e) });
    }
  },
}));

export function saveReportLocally() {
  const { report, meta } = useInvestigatorStore.getState();
  if (!report) return;
  const savedAt = new Date().toISOString();
  try {
    const list = JSON.parse(localStorage.getItem(SAVE_KEY) ?? "[]") as unknown[];
    list.unshift({ savedAt, meta, report });
    localStorage.setItem(SAVE_KEY, JSON.stringify(list.slice(0, 20)));
    useInvestigatorStore.setState({ savedAt });
  } catch {
    /* storage unavailable */
  }
}
