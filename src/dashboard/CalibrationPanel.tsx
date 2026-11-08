import { useEffect, useRef, useState } from "react";
import { ClipboardCopy, Crosshair, Save, Undo2, X } from "lucide-react";
import { getCamera, securityCameras } from "../config/cameras";
import { posesEqual, useReplayStore } from "../store/useReplayStore";
import { useViewStore } from "../store/useViewStore";
import { round, sensorBox } from "../lib/cameraMath";
import { canSaveToProject, saveProjectConfig } from "../lib/saveConfig";
import { moveRelative, nudgePose } from "../scene/CalibrationControls";
import type { CameraId, CameraPoseConfig } from "../types/security";
import { VideoMirror } from "./VideoMirror";
import { Kbd } from "./ui";

/** Outline of the 16:9 sensor inside the viewport, with the real recording ghosted on top while calibrating. */
export function SensorFrame({ children }: { children?: React.ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const id = useReplayStore((s) => s.selectedCameraId);
  const feedReady = useReplayStore((s) => (id ? s.feeds[id].status === "ready" : false));
  const calibrating = useViewStore((s) => s.calibrating);
  const diagnostics = useViewStore((s) => s.trackingDiagnostics);
  const showGhost = calibrating || diagnostics;
  const opacity = useViewStore((s) => s.ghostOpacity);
  const blend = useViewStore((s) => s.ghostBlend);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const box = sensorBox(size.w, size.h);
  const cam = getCamera(id);
  return (
    <div ref={root} className="pointer-events-none absolute inset-0 overflow-hidden">
      {size.w > 0 && (
        <div
          className="absolute border border-cyan-300/70"
          style={{ left: box.x, top: box.y, width: box.w, height: box.h, boxShadow: "0 0 0 9999px rgba(2,6,12,0.55)" }}
        >
          {showGhost && cam && feedReady && opacity > 0 && (
            <div className="absolute inset-0" style={{ opacity, mixBlendMode: blend }}>
              <VideoMirror cameraId={cam.id} rotation={cam.videoRotation ?? 0} />
            </div>
          )}
          {calibrating && (
            <>
              {/* Rule-of-thirds guides help line up edges. */}
              <div className="absolute inset-y-0 left-1/3 w-px bg-cyan-300/25" />
              <div className="absolute inset-y-0 left-2/3 w-px bg-cyan-300/25" />
              <div className="absolute inset-x-0 top-1/3 h-px bg-cyan-300/25" />
              <div className="absolute inset-x-0 top-2/3 h-px bg-cyan-300/25" />
            </>
          )}
          {children}
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  hint,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-2">
        <span className="w-16 font-mono text-[10px] text-slate-400" title={hint}>
          {label}
        </span>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={Math.min(Math.max(value, min), max)}
          onChange={(e) => onChange(Number(e.target.value))}
          className="h-1 min-w-0 flex-1 accent-amber-400"
        />
        <input
          type="number"
          step={step}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const v = Number.parseFloat(e.target.value);
            if (Number.isFinite(v)) onChange(v);
          }}
          onBlur={() => setText(String(value))}
          onKeyDown={(e) => e.stopPropagation()}
          className="h-6 w-16 rounded border border-ink-500 bg-ink-950 px-1 text-right font-mono text-[11px] text-slate-100 outline-none focus:border-amber-400"
        />
        <span className="w-4 font-mono text-[10px] text-slate-500">{unit}</span>
      </div>
    </div>
  );
}

function Nudge({ children, onClick, title }: { children: React.ReactNode; onClick: () => void; title: string }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="h-6 flex-1 rounded border border-ink-500 bg-ink-800 font-mono text-[10px] text-slate-300 hover:border-amber-400/70 hover:text-amber-200"
    >
      {children}
    </button>
  );
}

export function CalibrationPanel() {
  const id = useReplayStore((s) => s.selectedCameraId) as CameraId | null;
  const pose = useReplayStore((s) => (id ? s.cameraPoses[id] : null));
  const saved = useReplayStore((s) => (id ? s.savedCameraPoses[id] : null));
  const allPoses = useReplayStore((s) => s.cameraPoses);
  const allSaved = useReplayStore((s) => s.savedCameraPoses);
  const setCameraPose = useReplayStore((s) => s.setCameraPose);
  const revertCameraPose = useReplayStore((s) => s.revertCameraPose);
  const markPosesSaved = useReplayStore((s) => s.markPosesSaved);
  const setCalibrating = useViewStore((s) => s.setCalibrating);
  const viewThroughCamera = useReplayStore((s) => s.viewThroughCamera);
  const opacity = useViewStore((s) => s.ghostOpacity);
  const setOpacity = useViewStore((s) => s.setGhostOpacity);
  const blend = useViewStore((s) => s.ghostBlend);
  const setBlend = useViewStore((s) => s.setGhostBlend);
  const [status, setStatus] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  if (!id || !pose || !saved) return null;
  const cam = getCamera(id)!;
  const dirtyThis = !posesEqual(pose, saved);
  const dirtyCount = Object.keys(allPoses).filter((k) => !posesEqual(allPoses[k as CameraId], allSaved[k as CameraId])).length;
  const set = (patch: Partial<CameraPoseConfig>) => nudgePose(id, () => patch);
  const setAxis = (i: 0 | 1 | 2, v: number) => {
    const p = [...pose.position] as CameraPoseConfig["position"];
    p[i] = v;
    setCameraPose(id, { position: p.map((x) => round(x, 3)) as CameraPoseConfig["position"] });
  };
  const hfov = round((2 * Math.atan(Math.tan((pose.fov * Math.PI) / 360) * (16 / 9)) * 180) / Math.PI, 1);

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const file = await saveProjectConfig("camera-poses", allPoses);
      markPosesSaved();
      setStatus({ kind: "ok", text: `Saved all cameras to ${file}. Commit it to share.` });
    } catch (e) {
      setStatus({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="glass pointer-events-auto absolute top-16 left-3 z-10 flex max-h-[calc(100%-5rem)] w-[300px] flex-col gap-2 overflow-y-auto rounded-lg !border-amber-400/50 p-2.5 fade-in"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2">
        <Crosshair className="h-4 w-4 text-amber-300" />
        <span className="font-mono text-[11px] tracking-[0.15em] text-slate-100">CALIBRATE</span>
        <span className="truncate font-mono text-[10px] text-slate-400">{cam.name}</span>
        <button type="button" title="Close calibration" onClick={() => setCalibrating(false)} className="ml-auto text-slate-400 hover:text-slate-100">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex gap-1">
        {securityCameras.map((c, i) => (
          <button
            key={c.id}
            type="button"
            onClick={() => viewThroughCamera(c.id)}
            className={`h-6 flex-1 rounded border font-mono text-[10px] ${
              c.id === id ? "border-amber-400/70 bg-amber-400/15 text-amber-100" : "border-ink-500 text-slate-400 hover:text-slate-100"
            }`}
          >
            CAM {String(i + 1).padStart(2, "0")}
            {!posesEqual(allPoses[c.id], allSaved[c.id]) && <span className="ml-0.5 text-amber-300">•</span>}
          </button>
        ))}
      </div>
      <div className="text-[11px] leading-snug text-slate-400">
        Line the 3D room up with the real footage (ghosted on top). <b className="text-slate-300">Drag</b> to aim, <b className="text-slate-300">wheel</b> = FOV.
      </div>

      <div className="space-y-1 rounded-md border border-ink-600 p-2">
        <div className="label">Real footage overlay</div>
        <Row label="OPACITY" value={Math.round(opacity * 100)} min={0} max={100} step={1} unit="%" onChange={(v) => setOpacity(v / 100)} />
        <div className="flex gap-1">
          {(["normal", "difference"] as const).map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => setBlend(b)}
              title={b === "difference" ? "Matching areas turn black: align until the image is darkest" : "Plain transparency"}
              className={`h-6 flex-1 rounded font-mono text-[10px] uppercase ${blend === b ? "bg-amber-400/20 text-amber-200" : "text-slate-500 hover:text-slate-200"}`}
            >
              {b}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1 rounded-md border border-ink-600 p-2">
        <div className="label">Position (m)</div>
        <Row label="X  L/R" hint="World X: window wall is −" value={pose.position[0]} min={-5} max={5} step={0.01} unit="m" onChange={(v) => setAxis(0, v)} />
        <Row label="Y  HEIGHT" hint="Height above floor" value={pose.position[1]} min={0} max={4} step={0.01} unit="m" onChange={(v) => setAxis(1, v)} />
        <Row label="Z  F/B" hint="World Z" value={pose.position[2]} min={-8} max={8} step={0.01} unit="m" onChange={(v) => setAxis(2, v)} />
        <div className="flex gap-1 pt-0.5">
          <Nudge title="Move down 5 cm (Q)" onClick={() => moveRelative(id, 0, 0, -0.05)}>DOWN</Nudge>
          <Nudge title="Move up 5 cm (E)" onClick={() => moveRelative(id, 0, 0, 0.05)}>UP</Nudge>
          <Nudge title="Move back 5 cm (S)" onClick={() => moveRelative(id, -0.05, 0, 0)}>BACK</Nudge>
          <Nudge title="Move forward 5 cm (W)" onClick={() => moveRelative(id, 0.05, 0, 0)}>FWD</Nudge>
        </div>
      </div>

      <div className="space-y-1 rounded-md border border-ink-600 p-2">
        <div className="label">Orientation (°)</div>
        <Row label="PAN" hint="Yaw: + turns left" value={pose.yaw} min={-180} max={180} step={0.1} unit="°" onChange={(v) => set({ yaw: v })} />
        <Row label="TILT" hint="Pitch: + looks up" value={pose.pitch} min={-89} max={89} step={0.1} unit="°" onChange={(v) => set({ pitch: v })} />
        <Row label="ROLL" hint="+ rotates image counter-clockwise" value={pose.roll} min={-45} max={45} step={0.1} unit="°" onChange={(v) => set({ roll: v })} />
      </div>

      <div className="space-y-1 rounded-md border border-ink-600 p-2">
        <div className="flex items-center justify-between">
          <span className="label">Lens</span>
          <span className="font-mono text-[9px] text-slate-500">horizontal {hfov}°</span>
        </div>
        <Row label="FOV" hint="Vertical field of view of the 16:9 frame" value={pose.fov} min={15} max={120} step={0.1} unit="°" onChange={(v) => set({ fov: v })} />
        <div className="flex gap-1 pt-0.5">
          <Nudge title="Narrower (zoom in)" onClick={() => nudgePose(id, (p) => ({ fov: p.fov - 1 }))}>NARROWER</Nudge>
          <Nudge title="Wider (zoom out)" onClick={() => nudgePose(id, (p) => ({ fov: p.fov + 1 }))}>WIDER</Nudge>
        </div>
      </div>

      <div className="space-y-1.5">
        <button
          type="button"
          disabled={saving || !canSaveToProject}
          onClick={save}
          title={canSaveToProject ? "Write all four camera poses to src/config/camera-poses.json" : "Only available under npm run dev"}
          className={`flex h-8 w-full items-center justify-center gap-1.5 rounded-md border font-mono text-[11px] transition-colors disabled:opacity-40 ${
            dirtyCount ? "border-amber-400/70 bg-amber-400/20 text-amber-100 hover:bg-amber-400/30" : "border-ink-500 bg-ink-800 text-slate-300"
          }`}
        >
          <Save className="h-3.5 w-3.5" />
          {saving ? "SAVING…" : dirtyCount ? `SAVE TO PROJECT (${dirtyCount} changed)` : "SAVED"}
        </button>
        <div className="flex gap-1.5">
          <button
            type="button"
            disabled={!dirtyThis}
            onClick={() => revertCameraPose(id)}
            className="flex h-7 flex-1 items-center justify-center gap-1 rounded border border-ink-500 bg-ink-800 font-mono text-[10px] text-slate-300 hover:text-slate-100 disabled:opacity-40"
            title="Undo unsaved changes to this camera"
          >
            <Undo2 className="h-3 w-3" /> REVERT CAM
          </button>
          <button
            type="button"
            onClick={() => {
              const json = JSON.stringify(allPoses, null, 2);
              navigator.clipboard?.writeText(json).catch(() => {});
              console.info("[Sentry3D] camera-poses.json:\n" + json);
              setStatus({ kind: "ok", text: "Copied camera-poses.json to clipboard." });
            }}
            className="flex h-7 flex-1 items-center justify-center gap-1 rounded border border-ink-500 bg-ink-800 font-mono text-[10px] text-slate-300 hover:text-slate-100"
          >
            <ClipboardCopy className="h-3 w-3" /> COPY JSON
          </button>
        </div>
        {status && <div className={`text-[10px] leading-snug ${status.kind === "ok" ? "text-emerald-300" : "text-red-300"}`}>{status.text}</div>}
      </div>

      <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 border-t border-ink-600 pt-1.5 text-[10px] text-slate-500">
        <span><Kbd>W</Kbd><Kbd>A</Kbd><Kbd>S</Kbd><Kbd>D</Kbd> move</span>
        <span><Kbd>Q</Kbd>/<Kbd>E</Kbd> down/up</span>
        <span><Kbd>←</Kbd><Kbd>→</Kbd> pan <Kbd>↑</Kbd><Kbd>↓</Kbd> tilt</span>
        <span><Kbd>[</Kbd>/<Kbd>]</Kbd> FOV</span>
        <span><Kbd>,</Kbd>/<Kbd>.</Kbd> roll</span>
        <span><Kbd>Shift</Kbd> = fine</span>
      </div>
    </div>
  );
}
