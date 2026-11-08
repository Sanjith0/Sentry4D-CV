import { useState } from "react";
import { ClipboardCopy, Laptop, Save, Undo2, X } from "lucide-react";
import { securityDevices } from "../config/devices";
import { positionsEqual, useDeviceStore } from "../features/devices/useDeviceStore";
import { canSaveToProject, saveProjectConfig } from "../lib/saveConfig";
import { useReplayStore } from "../store/useReplayStore";

/**
 * Placement mode for the three laptops: click LAPTOP N, then click the laptop in
 * the 3D scan (ORBIT or TOP view) to drop its marker there via a real raycast —
 * see RoomModel.tsx's onClick. Positions save to src/config/device-positions.json,
 * the same dev-server-write pattern as camera-poses.json / camera-sync.json.
 */
export function DevicePlacementPanel({ onClose }: { onClose: () => void }) {
  const positions = useDeviceStore((s) => s.positions);
  const savedPositions = useDeviceStore((s) => s.savedPositions);
  const placingDeviceId = useDeviceStore((s) => s.placingDeviceId);
  const setPlacing = useDeviceStore((s) => s.setPlacing);
  const revertPosition = useDeviceStore((s) => s.revertPosition);
  const markSaved = useDeviceStore((s) => s.markSaved);
  const cameraMode = useReplayStore((s) => s.cameraMode);
  const [status, setStatus] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const dirtyCount = securityDevices.filter((d) => !positionsEqual(positions[d.id], savedPositions[d.id])).length;
  const canClickToPlace = cameraMode === "orbit" || cameraMode === "topdown";

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const file = await saveProjectConfig("device-positions", positions);
      markSaved();
      setStatus({ kind: "ok", text: `Saved all devices to ${file}. Commit it to share.` });
    } catch (e) {
      setStatus({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="glass pointer-events-auto absolute top-16 left-3 z-10 flex max-h-[calc(100%-5rem)] w-[280px] flex-col gap-2 overflow-y-auto rounded-lg !border-cyan-400/50 p-2.5 fade-in"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2">
        <Laptop className="h-4 w-4 text-cyan-300" />
        <span className="font-mono text-[11px] tracking-[0.15em] text-slate-100">PLACE DEVICES</span>
        <button type="button" title="Close device placement" onClick={onClose} className="ml-auto text-slate-400 hover:text-slate-100">
          <X className="h-4 w-4" />
        </button>
      </div>

      {!canClickToPlace && (
        <div className="rounded-md border border-amber-400/40 bg-amber-400/10 px-2 py-1.5 text-[11px] leading-snug text-amber-200">
          Switch to ORBIT or TOP view, then click a laptop to place its marker.
        </div>
      )}

      <div className="space-y-1.5">
        {securityDevices.map((d) => {
          const placed = !!positions[d.id];
          const dirty = !positionsEqual(positions[d.id], savedPositions[d.id]);
          const placing = placingDeviceId === d.id;
          return (
            <div key={d.id} className="flex items-center gap-1.5 rounded-md border border-ink-600 p-1.5">
              <span className="flex-1 font-mono text-[11px] text-slate-200">
                {d.name}
                {dirty && <span className="ml-1 text-cyan-300">•</span>}
              </span>
              <span className={`font-mono text-[10px] ${placed ? "text-emerald-300" : "text-slate-500"}`}>{placed ? "PLACED" : "UNPLACED"}</span>
              <button
                type="button"
                onClick={() => setPlacing(placing ? null : d.id)}
                title={`Click, then click the laptop in the 3D view`}
                className={`h-6 rounded border px-2 font-mono text-[10px] ${
                  placing ? "border-cyan-400/70 bg-cyan-400/20 text-cyan-100" : "border-ink-500 text-slate-400 hover:text-slate-100"
                }`}
              >
                {placing ? "CLICK LAPTOP…" : "PLACE"}
              </button>
              <button
                type="button"
                disabled={!dirty}
                onClick={() => revertPosition(d.id)}
                title="Revert to the last saved position"
                className="h-6 rounded border border-ink-500 px-1.5 text-slate-400 hover:text-slate-100 disabled:opacity-30"
              >
                <Undo2 className="h-3 w-3" />
              </button>
            </div>
          );
        })}
      </div>

      <div className="space-y-1.5">
        <button
          type="button"
          disabled={saving || !canSaveToProject}
          onClick={save}
          title={canSaveToProject ? "Write all device positions to src/config/device-positions.json" : "Only available under npm run dev"}
          className={`flex h-8 w-full items-center justify-center gap-1.5 rounded-md border font-mono text-[11px] transition-colors disabled:opacity-40 ${
            dirtyCount ? "border-cyan-400/70 bg-cyan-400/20 text-cyan-100 hover:bg-cyan-400/30" : "border-ink-500 bg-ink-800 text-slate-300"
          }`}
        >
          <Save className="h-3.5 w-3.5" />
          {saving ? "SAVING…" : dirtyCount ? `SAVE TO PROJECT (${dirtyCount} changed)` : "SAVED"}
        </button>
        <button
          type="button"
          onClick={() => {
            const json = JSON.stringify(positions, null, 2);
            navigator.clipboard?.writeText(json).catch(() => {});
            console.info("[Sentry3D] device-positions.json:\n" + json);
            setStatus({ kind: "ok", text: "Copied device-positions.json to clipboard." });
          }}
          className="flex h-7 w-full items-center justify-center gap-1 rounded border border-ink-500 bg-ink-800 font-mono text-[10px] text-slate-300 hover:text-slate-100"
        >
          <ClipboardCopy className="h-3 w-3" /> COPY JSON
        </button>
        {status && <div className={`text-[10px] leading-snug ${status.kind === "ok" ? "text-emerald-300" : "text-red-300"}`}>{status.text}</div>}
      </div>
    </div>
  );
}
