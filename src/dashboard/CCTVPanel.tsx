import { ChevronRight, MonitorPlay } from "lucide-react";
import { securityCameras } from "../config/cameras";
import { useViewStore } from "../store/useViewStore";
import { CCTVFeed } from "./CCTVFeed";
import { IncidentPanel } from "./IncidentPanel";

export function CCTVPanel() {
  const collapsed = useViewStore((s) => s.feedsCollapsed);
  const toggle = useViewStore((s) => s.toggleFeedsCollapsed);
  const focusedId = useViewStore((s) => s.focusedFeedId);

  return (
    <aside
      className={`relative flex shrink-0 flex-col border-l border-ink-600/70 bg-ink-900 transition-[width] duration-300 ease-out ${
        collapsed ? "w-11" : "w-[440px]"
      }`}
    >
      <button
        type="button"
        onClick={toggle}
        title={collapsed ? "Show CCTV feeds" : "Collapse CCTV feeds"}
        className="flex h-10 shrink-0 items-center gap-2 border-b border-ink-600/70 px-3 text-left hover:bg-ink-800"
      >
        <ChevronRight className={`h-4 w-4 text-slate-400 transition-transform ${collapsed ? "rotate-180" : ""}`} />
        {!collapsed && (
          <>
            <MonitorPlay className="h-3.5 w-3.5 text-cyan-300" />
            <span className="label !text-slate-300">CCTV monitoring</span>
            <span className="ml-auto font-mono text-[10px] text-slate-500">{securityCameras.length} feeds · synced</span>
          </>
        )}
      </button>

      {/* Videos stay mounted while collapsed so sync and buffering continue. */}
      <div className={collapsed ? "hidden" : "flex min-h-0 flex-1 flex-col"}>
        <div className="grid shrink-0 grid-cols-2 gap-2 p-2">
          {/* Focused feed is moved first via CSS order (moving <video> nodes would pause them). */}
          {securityCameras.map((cam, i) => (
            <CCTVFeed key={cam.id} cam={cam} index={i} focused={cam.id === focusedId} />
          ))}
        </div>
        <div className="mx-2 h-px bg-ink-600/70" />
        <IncidentPanel />
      </div>
      {collapsed && (
        <div className="flex flex-1 items-start justify-center pt-4">
          <span className="label [writing-mode:vertical-rl]">CCTV · {securityCameras.length} feeds</span>
        </div>
      )}
    </aside>
  );
}
