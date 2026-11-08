import { useProgress } from "@react-three/drei";
import { useViewStore } from "../store/useViewStore";

export function LoadingOverlay() {
  const { progress, active } = useProgress();
  const status = useViewStore((s) => s.roomStatus);
  const error = useViewStore((s) => s.roomError);
  return (
    <>
      {(status === "loading" || (active && status !== "loaded")) && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="glass w-72 rounded-lg p-4 text-center">
            <div className="label mb-2 !text-cyan-300">Reconstructing room</div>
            <div className="h-1 overflow-hidden rounded-full bg-ink-600">
              <div className="h-full bg-cyan-400 transition-[width]" style={{ width: `${progress}%` }} />
            </div>
            <div className="mt-2 font-mono text-[11px] text-slate-400">{progress.toFixed(0)}% · LiDAR mesh + textures</div>
          </div>
        </div>
      )}
      {status === "error" && (
        <div className="glass absolute bottom-3 left-3 max-w-sm rounded-lg border-red-500/50 p-3 font-mono text-[11px] text-red-200">
          Room scan failed to load — showing placeholder.
          <div className="mt-1 text-slate-400">{error}</div>
        </div>
      )}
      {status === "missing" && (
        <div className="glass absolute bottom-16 left-3 max-w-sm rounded-lg p-3 font-mono text-[11px] text-amber-200">
          public/assets/room.glb not found — showing procedural placeholder room.
        </div>
      )}
    </>
  );
}
