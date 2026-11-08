import { AlertTriangle, ListTree, MousePointerClick } from "lucide-react";
import { eventStyle } from "../config/incident";
import { useReplayStore } from "../store/useReplayStore";
import { formatClock } from "../lib/format";

function useActiveEventId() {
  return useReplayStore((s) => {
    let id: string | null = null;
    for (const e of s.events) if (e.time <= s.currentTime + 0.05) id = e.id;
    return id;
  });
}

export function IncidentPanel() {
  const events = useReplayStore((s) => s.events);
  const seek = useReplayStore((s) => s.seek);
  const entity = useReplayStore((s) => s.selectedEntity);
  const activeId = useActiveEventId();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2">
          <ListTree className="h-3.5 w-3.5 text-cyan-300" />
          <span className="label !text-slate-300">Incident log</span>
        </div>
        <span className="font-mono text-[10px] text-slate-500">{events.length} events</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {events.length === 0 ? (
          <div className="mx-1 rounded-md border border-dashed border-ink-500 p-4 text-center">
            <AlertTriangle className="mx-auto mb-1.5 h-4 w-4 text-slate-500" />
            <div className="font-mono text-[11px] text-slate-400">No incident events loaded</div>
            <div className="mt-1 text-[11px] text-slate-500">Events from the tracking module appear here and on the timeline.</div>
          </div>
        ) : (
          <ul className="space-y-1">
            {events.map((e) => {
              const st = eventStyle(e.type);
              const active = e.id === activeId;
              return (
                <li key={e.id}>
                  <button
                    type="button"
                    onClick={() => seek(e.time)}
                    className={`flex w-full items-start gap-2 rounded-md border px-2 py-1.5 text-left transition-colors ${
                      active ? "border-cyan-400/50 bg-cyan-400/10" : "border-transparent hover:border-ink-500 hover:bg-ink-800"
                    }`}
                  >
                    <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: st.color, boxShadow: `0 0 8px ${st.color}` }} />
                    <span className="w-14 shrink-0 font-mono text-[11px] text-slate-400">{formatClock(e.time, false)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-mono text-[9px] tracking-wider uppercase" style={{ color: st.color }}>
                        {st.label}
                        {e.entityId ? ` · ${e.entityId}` : ""}
                      </span>
                      <span className="block text-[12px] leading-snug text-slate-200">{e.description}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="border-t border-ink-600/70 px-3 py-2">
        <div className="label mb-1">Selection</div>
        {entity ? (
          <div className="fade-in">
            <div className="text-[13px] text-slate-100">{entity.label}</div>
            <div className="font-mono text-[10px] text-slate-500 uppercase">
              {entity.kind} · {entity.id}
            </div>
            {entity.details && (
              <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-[11px]">
                {Object.entries(entity.details).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-slate-500">{k}</dt>
                    <dd className="text-slate-200">{v}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
            <MousePointerClick className="h-3.5 w-3.5" /> Select a subject or object in the scene
          </div>
        )}
      </div>
    </div>
  );
}
