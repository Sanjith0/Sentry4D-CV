import { useState } from "react";
import { Box, Cctv, ClipboardCopy, Crosshair, Eye, EyeOff, Gamepad2, Map, Orbit, RotateCcw, Sparkles, Square, Video } from "lucide-react";
import * as THREE from "three";
import { securityCameras } from "../config/cameras";
import { useReplayStore } from "../store/useReplayStore";
import { useViewStore, type RenderQuality } from "../store/useViewStore";
import type { CameraMode } from "../types/security";
import { formatWallClock } from "../lib/format";
import { viewport } from "../scene/viewportCamera";
import { Kbd, ToolButton } from "./ui";


const MODES: { mode: CameraMode; label: string; icon: typeof Orbit; key: string }[] = [
  { mode: "free", label: "FREE", icon: Gamepad2, key: "F" },
  { mode: "orbit", label: "ORBIT", icon: Orbit, key: "O" },
  { mode: "topdown", label: "TOP", icon: Map, key: "T" },
  { mode: "cctv", label: "CCTV", icon: Cctv, key: "1-4" },
];

function CopyPoseButton() {
  const [copied, setCopied] = useState(false);
  return (
    <ToolButton
      title="Copy the current viewpoint as a SecurityCamera pose (for config/cameras.ts)"
      onClick={() => {
        const cam = viewport.camera;
        if (!cam) return;
        const dir = cam.getWorldDirection(new THREE.Vector3());
        const target = cam.position.clone().addScaledVector(dir, 3);
        const r = (v: number) => Math.round(v * 100) / 100;
        const json = JSON.stringify({
          position: cam.position.toArray().map(r),
          target: target.toArray().map(r),
          fov: r(cam.fov),
        });
        console.info("[Sentry3D] camera pose:", json);
        navigator.clipboard?.writeText(json).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      }}
    >
      <ClipboardCopy className="h-3.5 w-3.5" />
      {copied ? "COPIED" : "POSE"}
    </ToolButton>
  );
}

export function ViewerToolbar() {
  const mode = useReplayStore((s) => s.cameraMode);
  const setCameraMode = useReplayStore((s) => s.setCameraMode);
  const showCoverage = useViewStore((s) => s.showCoverage);
  const showCeiling = useViewStore((s) => s.showCeiling);
  const toggleCoverage = useViewStore((s) => s.toggleCoverage);
  const toggleCeiling = useViewStore((s) => s.toggleCeiling);
  const resetView = useViewStore((s) => s.resetView);

  return (
    <div className="glass pointer-events-auto absolute top-3 left-3 flex items-center gap-1.5 rounded-lg p-1.5 fade-in">
      {MODES.map(({ mode: m, label, icon: Icon, key }) => (
        <ToolButton key={m} active={mode === m} onClick={() => setCameraMode(m)} title={`${label} camera (${key})`}>
          <Icon className="h-3.5 w-3.5" />
          {label}
        </ToolButton>
      ))}
      <div className="mx-1 h-5 w-px bg-ink-500" />
      <ToolButton onClick={resetView} title="Reset view (R)">
        <RotateCcw className="h-3.5 w-3.5" />
        RESET
      </ToolButton>
      <ToolButton active={showCoverage} onClick={toggleCoverage} title="Camera coverage frustums (C)">
        <Video className="h-3.5 w-3.5" />
        COVERAGE
      </ToolButton>
      <ToolButton active={showCeiling} tone="slate" onClick={toggleCeiling} title="Ceiling visibility (H)">
        {showCeiling ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
        CEILING
      </ToolButton>
      <CopyPoseButton />
      <div className="mx-1 h-5 w-px bg-ink-500" />
      <QualityToggle />
    </div>
  );
}

const QUALITIES: { q: RenderQuality; label: string; title: string }[] = [
  { q: "performance", label: "PERF", title: "Performance: lower resolution, no post-processing" },
  { q: "balanced", label: "BAL", title: "Balanced: native resolution + sharpen, AO, grading" },
  { q: "ultra", label: "ULTRA", title: "Ultra: supersampled resolution + all effects" },
];

function QualityToggle() {
  const quality = useViewStore((s) => s.quality);
  const setQuality = useViewStore((s) => s.setQuality);
  return (
    <div className="flex h-8 items-center gap-0.5 rounded-md border border-ink-500/70 bg-ink-800/80 p-0.5" title="Render quality">
      <Sparkles className="mx-1 h-3.5 w-3.5 text-slate-500" />
      {QUALITIES.map(({ q, label, title }) => (
        <button
          key={q}
          type="button"
          title={title}
          onClick={() => setQuality(q)}
          className={`h-6 rounded px-1.5 font-mono text-[10px] transition-colors ${
            quality === q ? "bg-cyan-400/20 text-cyan-200" : "text-slate-500 hover:text-slate-200"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function FreeHud() {
  const locked = useViewStore((s) => s.pointerLocked);
  const speed = useViewStore((s) => s.flySpeed);
  const setFlySpeed = useViewStore((s) => s.setFlySpeed);
  return (
    <>
      {locked && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <Crosshair className="h-5 w-5 text-cyan-300/80" strokeWidth={1.5} />
        </div>
      )}
      <div className="pointer-events-none absolute inset-0 rounded-sm ring-1 ring-cyan-400/30 ring-inset" />
      <div className="glass pointer-events-auto absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-lg px-3 py-2 font-mono text-[11px] text-slate-300 fade-in">
        <span className="flex items-center gap-1.5 whitespace-nowrap text-cyan-300">
          <Gamepad2 className="h-3.5 w-3.5" /> FREE CAM {locked ? "· LOOK ACTIVE" : ""}
        </span>
        <span className="text-slate-500">|</span>
        {locked ? (
          <span className="flex items-center gap-1.5">
            <Kbd>W</Kbd>
            <Kbd>A</Kbd>
            <Kbd>S</Kbd>
            <Kbd>D</Kbd> move <Kbd>Space</Kbd> up <Kbd>Shift</Kbd> down <Kbd>Ctrl</Kbd> sprint <Kbd>Esc</Kbd> release
          </span>
        ) : (
          <span className="whitespace-nowrap text-slate-200">Click scene to look · WASD move · Space/Shift up/down</span>
        )}
        <span className="text-slate-500">|</span>
        <label className="flex items-center gap-2 whitespace-nowrap" title="Fly speed (mouse wheel)">
          SPEED
          <input
            type="range"
            min={0.25}
            max={10}
            step={0.25}
            value={speed}
            onChange={(e) => setFlySpeed(Number(e.target.value))}
            className="h-1 w-20 accent-cyan-400"
          />
          <span className="w-12 text-right text-slate-200">{speed.toFixed(1)} m/s</span>
        </label>
      </div>
    </>
  );
}

function CctvHud() {
  const id = useReplayStore((s) => s.selectedCameraId);
  const setCameraMode = useReplayStore((s) => s.setCameraMode);
  const viewThroughCamera = useReplayStore((s) => s.viewThroughCamera);
  const t = useReplayStore((s) => Math.floor(s.currentTime));
  // The post-processing chain draws the vignette except in performance mode.
  const cssVignette = useViewStore((s) => s.quality === "performance");
  const idx = securityCameras.findIndex((c) => c.id === id);
  const cam = securityCameras[idx];
  if (!cam) return null;
  return (
    <>
      <div className="scanlines absolute inset-0" />
      {cssVignette && <div className="vignette absolute inset-0" />}
      {/* Corner brackets */}
      {["top-14 left-3 border-t-2 border-l-2", "top-14 right-3 border-t-2 border-r-2", "bottom-3 left-3 border-b-2 border-l-2", "bottom-3 right-3 border-b-2 border-r-2"].map((c) => (
        <div key={c} className={`pointer-events-none absolute h-6 w-6 border-cyan-300/70 ${c}`} />
      ))}
      <div className="glass pointer-events-auto absolute top-16 right-3 flex flex-col items-end gap-2 rounded-lg p-2.5 fade-in">
        <div className="flex items-center gap-2 font-mono text-xs text-slate-100">
          <span className="rec-dot h-2 w-2 rounded-full bg-red-500" />
          {cam.name}
        </div>
        <div className="font-mono text-[11px] text-slate-400">
          VIRTUAL VIEW · FOV {cam.fov}° · {formatWallClock(t)}
        </div>
        <div className="flex gap-1">
          {securityCameras.map((c, i) => (
            <ToolButton key={c.id} active={c.id === id} onClick={() => viewThroughCamera(c.id)} className="!h-7 !px-2" title={c.name}>
              {String(i + 1).padStart(2, "0")}
            </ToolButton>
          ))}
        </div>
        <ToolButton onClick={() => setCameraMode("free")} className="w-full justify-center">
          <Gamepad2 className="h-3.5 w-3.5" /> RETURN TO FREE CAMERA
        </ToolButton>
      </div>
    </>
  );
}

function TopHud() {
  return (
    <div className="glass pointer-events-none absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-lg px-3 py-2 font-mono text-[11px] text-slate-400 fade-in">
      <Square className="h-3.5 w-3.5 text-cyan-300" /> OVERHEAD · drag to pan · wheel to zoom · <Kbd>R</Kbd> reset
    </div>
  );
}

function OrbitHud() {
  return (
    <div className="glass pointer-events-none absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-lg px-3 py-2 font-mono text-[11px] text-slate-400 fade-in">
      <Box className="h-3.5 w-3.5 text-cyan-300" /> ORBIT · drag rotate · right-drag pan · wheel zoom · click a camera to view through it
    </div>
  );
}

function ModeBadges() {
  const xray = useReplayStore((s) => s.xrayEnabled);
  const sentry = useReplayStore((s) => s.sentryEnabled);
  return (
    <>
      {sentry && <div className="pointer-events-none absolute inset-0 shadow-[inset_0_0_60px_-10px_rgba(239,68,68,0.55)] ring-1 ring-red-500/50 ring-inset" />}
      <div className="absolute top-16 left-3 flex flex-col gap-1.5">
        {sentry && (
          <div className="glass flex items-center gap-2 rounded-md !border-red-500/60 px-2.5 py-1 font-mono text-[11px] text-red-200 fade-in">
            <span className="rec-dot h-1.5 w-1.5 rounded-full bg-red-500" /> SENTRY MODE ARMED
          </div>
        )}
        {xray && (
          <div className="glass flex items-center gap-2 rounded-md !border-cyan-400/60 px-2.5 py-1 font-mono text-[11px] text-cyan-200 fade-in">
            <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" /> X-RAY TRACKING
          </div>
        )}
      </div>
    </>
  );
}

export function ViewportHud() {
  const mode = useReplayStore((s) => s.cameraMode);
  const transitioning = useViewStore((s) => s.transitioning);
  return (
    <div className="pointer-events-none absolute inset-0 z-30">
      <ModeBadges />
      {!transitioning && mode === "free" && <FreeHud />}
      {mode === "cctv" && <CctvHud />}
      {!transitioning && mode === "topdown" && <TopHud />}
      {!transitioning && mode === "orbit" && <OrbitHud />}
      <ViewerToolbar />
    </div>
  );
}
