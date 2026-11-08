import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { Download, Footprints, Pause, Play, Plus, RefreshCw, Save, Trash2, Undo2, Upload, X } from "lucide-react";
import { getCamera, securityCameras } from "../../config/cameras";
import { useReplayStore } from "../../store/useReplayStore";
import { useViewStore } from "../../store/useViewStore";
import { VideoMirror } from "../../dashboard/VideoMirror";
import { frameInfoFor } from "../../lib/videoRegistry";
export { frameInfoFor };
import { getRoomMeshes } from "../../scene/viewportCamera";
import { formatClock } from "../../lib/format";
import { canSaveToProject, saveProjectConfig } from "../../lib/saveConfig";
import {
  displayedAspect,
  pixelError,
  videoPixelToWorld,
  worldToVideoPixel,
  type PixelToWorldResult,
  type VideoFrameInfo,
} from "../../lib/videoProjection";
import type { CameraId, PersonObservation, Vec3, VisibilityMark, VisibilityState } from "../../types/security";
import { useVisibilityStore } from "./useVisibilityStore";
import { CAMERA_STATE_COLOR, CAMERA_STATE_LABEL, useEvidenceStore } from "../sentry/useEvidence";
import { parseDatasets, useActiveObservations, useAnnotationStore } from "./useAnnotationStore";
import { useFrameState } from "./useFrameState";

const FRAME = 1 / 30;
const SAME_TIME = 0.02; // s: observation counts as "at the current frame"
const NEAR_TIME = 0.25; // s: other cameras' observations shown as cross-checks
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r4 = (v: number) => Math.round(v * 10000) / 10000;

const CONF_STYLE: Record<string, string> = {
  high: "bg-emerald-400 text-emerald-950",
  medium: "bg-amber-400 text-amber-950",
  low: "bg-red-400 text-red-950",
  none: "bg-slate-500 text-slate-950",
};

export function camLabel(id: CameraId) {
  return `CAM ${id.slice(3).padStart(2, "0")}`;
}

/** Re-run the projection for an observation (diagnostics + reprojection check). */
export function diagnose(o: PersonObservation, frame: VideoFrameInfo | null) {
  const s = useReplayStore.getState();
  const pose = s.cameraPoses[o.cameraId];
  const bounds = useViewStore.getState().roomBounds;
  if (!frame) return null;
  const proj = videoPixelToWorld(pose, o.pixel, frame, bounds, getRoomMeshes());
  const re = worldToVideoPixel(pose, o.worldPosition, frame);
  const err = re.pixel ? pixelError(o.pixel, re.pixel, frame) : null;
  return { proj, reprojected: re.pixel, inFrame: re.inFrame, reprojErrorPx: err };
}

function Marker({ u, v, className, title, children }: { u: number; v: number; className: string; title?: string; children?: React.ReactNode }) {
  return (
    <div className={`pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 ${className}`} style={{ left: `${u * 100}%`, top: `${v * 100}%` }} title={title}>
      {children}
    </div>
  );
}

function StatusBadge({ result }: { result: PixelToWorldResult | null | undefined }) {
  if (!result) return null;
  const cls = result.status === "invalid" ? CONF_STYLE.none : CONF_STYLE[result.confidence];
  return (
    <span className={`rounded px-1.5 py-px font-mono text-[9px] font-semibold uppercase ${cls}`} title={result.reason ?? undefined}>
      {result.status === "invalid" ? "invalid" : `${result.confidence} conf`}
    </span>
  );
}

export function AnnotationPanel() {
  const cameraId = useViewStore((s) => s.annotationCameraId);
  const setCameraId = useViewStore((s) => s.setAnnotationCamera);
  const setAnnotating = useViewStore((s) => s.setAnnotating);
  const t = useReplayStore((s) => s.currentTime);
  const isPlaying = useReplayStore((s) => s.isPlaying);
  const offset = useReplayStore((s) => s.cameraOffsets[cameraId] ?? 0);
  const pose = useReplayStore((s) => s.cameraPoses[cameraId]);
  const feeds = useReplayStore((s) => s.feeds);
  const cam = getCamera(cameraId)!;
  const fs = useFrameState(cameraId, cam.videoRotation ?? 0);

  const obs = useActiveObservations();
  const activePersonId = useAnnotationStore((s) => s.activePersonId);
  const personIds = useAnnotationStore(useShallow((s) => Object.keys(s.persons)));
  const selectedId = useAnnotationStore((s) => s.selectedId);
  const lastId = useAnnotationStore((s) => s.lastId);
  const canUndo = useAnnotationStore((s) => s.undoStack.length > 0);
  const store = useAnnotationStore.getState;

  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [lastResult, setLastResult] = useState<PixelToWorldResult | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const r = useReplayStore.getState;
  const step = (d: number) => {
    r().pause();
    r().seek(r().currentTime + d);
  };

  // The panel narrows the 3D canvas: re-frame the current view once layout settles (and again on close).
  useEffect(() => {
    const id = window.setTimeout(() => useViewStore.getState().resetView(), 450); // after the sidebar collapse animation
    return () => {
      window.clearTimeout(id);
      window.setTimeout(() => useViewStore.getState().resetView(), 450);
    };
  }, []);

  // Keyboard: ←/→ = ±1 frame (Shift ±0.5 s), Cmd/Ctrl+Z = undo, Esc = deselect.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA")) return;
      let handled = true;
      if (e.code === "ArrowLeft") step(e.shiftKey ? -0.5 : -FRAME);
      else if (e.code === "ArrowRight") step(e.shiftKey ? 0.5 : FRAME);
      else if (e.code === "KeyZ" && (e.metaKey || e.ctrlKey)) store().undo();
      else if (e.code === "Escape" && store().selectedId) store().select(null);
      else if (/^Digit[1-4]$/.test(e.code) && !e.metaKey && !e.ctrlKey) setCameraId(`cam${e.code.slice(-1)}` as CameraId);
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation(); // capture phase: keep global shortcuts (seek ±5 s, view camera) from firing
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = obs.find((o) => o.id === selectedId) ?? null;
  const focus = selected ?? obs.find((o) => o.id === lastId) ?? null;
  const focusDiag = useMemo(() => (focus ? diagnose(focus, fs.frame) : null), [focus, fs.frame, pose]);

  const here = obs.filter((o) => o.cameraId === cameraId);
  const others = obs.filter((o) => o.cameraId !== cameraId && Math.abs(o.masterTime - t) <= NEAR_TIME);
  const canClick = !!fs.frame && fs.settled && !isPlaying;

  const onFrameClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!fs.frame) return setMessage({ ok: false, text: "Video not loaded yet." });
    if (isPlaying) return setMessage({ ok: false, text: "Pause playback before annotating." });
    if (!fs.inRange) return setMessage({ ok: false, text: "This camera has no footage at the current master time." });
    if (!fs.settled) return setMessage({ ok: false, text: "Frame is still seeking; click again in a moment." });
    const rect = e.currentTarget.getBoundingClientRect();
    // The container has exactly the displayed frame's aspect and VideoMirror fills it, so
    // this maps CSS position → normalized source-frame pixel with no letterbox offset.
    const pixel: [number, number] = [r4((e.clientX - rect.left) / rect.width), r4((e.clientY - rect.top) / rect.height)];
    const s = useReplayStore.getState();
    const res = videoPixelToWorld(s.cameraPoses[cameraId], pixel, fs.frame, useViewStore.getState().roomBounds, getRoomMeshes());
    setLastResult(res);
    if (!res.valid || !res.worldPosition) {
      setMessage({ ok: false, text: `Rejected: ${res.reason}` });
      return;
    }
    const masterTime = r3(s.currentTime);
    const data = {
      masterTime,
      cameraId,
      pixel,
      worldPosition: res.worldPosition.map(r3) as Vec3,
      source: "manual" as const,
      videoTime: r3(masterTime + (s.cameraOffsets[cameraId] ?? 0)),
    };
    if (selected) {
      store().update(selected.id, data);
      setMessage({ ok: true, text: `Moved observation @ ${formatClock(selected.masterTime)}.` });
    } else {
      store().add(data);
      setMessage({ ok: res.status === "ok", text: res.status === "ok" ? "Added." : `Added with warning: ${res.reason}` });
    }
  };

  const exportJson = (all = false) => JSON.stringify(all ? store().exportAll() : store().exportDataset(), null, 2);
  const download = () => {
    const blob = new Blob([exportJson()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${activePersonId}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const onImport = async (file: File) => {
    try {
      const n = store().importDatasets(parseDatasets(JSON.parse(await file.text())));
      setMessage({ ok: true, text: `Imported ${n} observations from ${file.name}.` });
    } catch (e) {
      setMessage({ ok: false, text: `Import failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  };
  const reprojectAll = () => {
    const s = useReplayStore.getState();
    let n = 0;
    for (const o of obs) {
      if (o.source !== "manual") continue;
      const v = frameInfoFor(o.cameraId);
      if (!v) continue;
      const res = videoPixelToWorld(s.cameraPoses[o.cameraId], o.pixel, v, useViewStore.getState().roomBounds);
      if (res.valid && res.worldPosition) {
        store().update(o.id, { worldPosition: res.worldPosition.map(r3) as Vec3 });
        n++;
      }
    }
    setMessage({ ok: true, text: `Recomputed ${n} positions from their pixels with the current calibration.` });
  };

  const aspect = fs.frame ? displayedAspect(fs.frame) : 16 / 9;
  const feed = feeds[cameraId];

  return (
    <section className="flex w-[min(56%,860px)] shrink-0 flex-col overflow-y-auto border-r border-cyan-400/30 bg-ink-900">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-ink-600 px-3 py-2">
        <Footprints className="h-4 w-4 text-cyan-300" />
        <span className="font-mono text-xs tracking-[0.18em] text-slate-100">ANNOTATE SUBJECT</span>
        <select
          value={activePersonId}
          onChange={(e) => store().setActivePerson(e.target.value)}
          className="ml-2 h-7 rounded border border-ink-500 bg-ink-950 px-1.5 font-mono text-[11px] text-slate-100"
          title="Person being annotated"
        >
          {personIds.map((p) => (
            <option key={p} value={p}>
              {p} ({useAnnotationStore.getState().persons[p]?.length ?? 0})
            </option>
          ))}
        </select>
        <button type="button" onClick={() => store().addPerson()} title="Add another person" className="grid h-7 w-7 place-items-center rounded border border-ink-500 text-slate-400 hover:text-slate-100">
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={() => setAnnotating(false)} title="Close annotation" className="ml-auto rounded p-1 text-slate-400 hover:text-slate-100">
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Camera tabs */}
      <div className="flex gap-1 px-3 pt-2">
        {securityCameras.map((c) => {
          const n = obs.filter((o) => o.cameraId === c.id).length;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => setCameraId(c.id)}
              className={`h-7 flex-1 rounded border font-mono text-[11px] ${
                c.id === cameraId ? "border-cyan-400/70 bg-cyan-400/15 text-cyan-100" : "border-ink-500 text-slate-400 hover:text-slate-100"
              }`}
            >
              {camLabel(c.id)} {n > 0 && <span className="text-cyan-300">·{n}</span>}
            </button>
          );
        })}
      </div>

      {/* Frame */}
      <div className="px-3 pt-2">
        <div
          onClick={onFrameClick}
          className={`relative mx-auto overflow-hidden rounded-md border bg-black ${canClick ? "cursor-crosshair border-cyan-400/50" : "cursor-not-allowed border-ink-600"}`}
          // Exact frame aspect (so clicks map 1:1 to source pixels); height capped so the
          // observation list keeps room for several rows.
          style={{ aspectRatio: String(aspect), width: `min(100%, calc(max(260px, 100vh - 540px) * ${aspect}))` }}
        >
          {feed.status === "ready" ? (
            <VideoMirror cameraId={cameraId} rotation={cam.videoRotation ?? 0} className={fs.inRange ? "" : "opacity-30"} />
          ) : (
            <div className="grid h-full place-items-center font-mono text-xs text-slate-400">{feed.status === "loading" ? "LOADING…" : (feed.error ?? feed.status)}</div>
          )}

          {/* Other annotations of this camera (trajectory) */}
          {here.map((o) =>
            Math.abs(o.masterTime - t) <= SAME_TIME ? null : (
              <Marker key={o.id} u={o.pixel[0]} v={o.pixel[1]} className="h-1.5 w-1.5 rounded-full bg-cyan-300/50" title={formatClock(o.masterTime)} />
            ),
          )}
          {/* Cross-check: other cameras' points at ~this time, reprojected into this view */}
          {fs.frame &&
            others.map((o) => {
              const re = worldToVideoPixel(pose, o.worldPosition, fs.frame!);
              return re.pixel && re.inFrame ? (
                <Marker key={o.id} u={re.pixel[0]} v={re.pixel[1]} className="text-[10px]">
                  <div className="h-3 w-3 rotate-45 border-2 border-amber-300" />
                  <div className="mt-0.5 -ml-3 rounded bg-black/70 px-1 font-mono text-[9px] whitespace-nowrap text-amber-200">{camLabel(o.cameraId)}</div>
                </Marker>
              ) : null;
            })}
          {/* Annotations at the current frame: clicked pixel + reprojection of its world point */}
          {fs.frame &&
            here
              .filter((o) => Math.abs(o.masterTime - t) <= SAME_TIME)
              .map((o) => {
                const re = worldToVideoPixel(pose, o.worldPosition, fs.frame!);
                const sel = o.id === selectedId;
                return (
                  <div key={o.id}>
                    <Marker u={o.pixel[0]} v={o.pixel[1]} className="">
                      <div className={`h-4 w-4 rounded-full border-2 ${sel ? "border-amber-300" : "border-cyan-300"} bg-cyan-300/30 shadow-[0_0_10px_rgba(34,211,238,0.9)]`} />
                    </Marker>
                    {re.pixel && (
                      <Marker u={re.pixel[0]} v={re.pixel[1]} className="" title="Reprojection of the 3D point">
                        <div className="h-7 w-7 rounded-full border border-dashed border-white/80" />
                      </Marker>
                    )}
                  </div>
                );
              })}

          <div className="pointer-events-none absolute top-1.5 left-1.5 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-slate-100">
            {cam.name}
          </div>
          <div className="pointer-events-none absolute top-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-right font-mono text-[10px] leading-tight text-slate-200">
            <div>MASTER {formatClock(t)}</div>
            <div className="text-slate-400">
              VIDEO {formatClock(fs.videoTime)} ({offset >= 0 ? "+" : ""}
              {offset.toFixed(2)}s)
            </div>
          </div>
          {!fs.inRange && fs.frame && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center font-mono text-xs text-slate-300">NO FOOTAGE AT THIS MASTER TIME</div>
          )}
          {fs.inRange && !fs.settled && !isPlaying && (
            <div className="pointer-events-none absolute bottom-1.5 left-1.5 font-mono text-[10px] text-amber-300">SEEKING…</div>
          )}
          <div className="pointer-events-none absolute right-1.5 bottom-1.5 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-cyan-200">
            {selected ? `CLICK TO MOVE SELECTED (${formatClock(selected.masterTime)})` : isPlaying ? "PAUSE TO ANNOTATE" : "CLICK THE PERSON'S FEET"}
          </div>
        </div>
      </div>

      {/* Time controls */}
      <div className="flex items-center gap-1 px-3 pt-2">
        <button
          type="button"
          onClick={() => r().togglePlay()}
          className="grid h-7 w-7 place-items-center rounded border border-cyan-400/60 bg-cyan-400/10 text-cyan-200"
          title="Play / pause (K)"
        >
          {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </button>
        {(
          [
            ["-1s", -1],
            ["-.5s", -0.5],
            ["-1f", -FRAME],
            ["+1f", FRAME],
            ["+.5s", 0.5],
            ["+1s", 1],
          ] as const
        ).map(([label, d]) => (
          <button
            key={label}
            type="button"
            onClick={() => step(d)}
            className="h-7 flex-1 rounded border border-ink-500 bg-ink-800 font-mono text-[11px] text-slate-300 hover:text-slate-100"
            title="Step master time (←/→ = ±1 frame, Shift = ±0.5 s)"
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          disabled={!canUndo}
          onClick={() => store().undo()}
          title="Undo (Cmd/Ctrl+Z)"
          className="flex h-7 items-center gap-1 rounded border border-ink-500 bg-ink-800 px-2 font-mono text-[11px] text-slate-300 hover:text-slate-100 disabled:opacity-40"
        >
          <Undo2 className="h-3.5 w-3.5" /> UNDO
        </button>
      </div>

      <VisibilityRow cameraId={cameraId} personId={activePersonId} canMark={!!fs.frame && fs.settled && !isPlaying} />

      {/* Focused observation details */}
      <div className="mx-3 mt-2 rounded-md border border-ink-600 bg-ink-850 px-2.5 py-1.5">
        {focus && focusDiag ? (
          <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-0.5 font-mono text-[11px]">
            <span className="text-slate-500">{selected ? "SELECTED" : "LAST"}</span>
            <span className="text-slate-200">
              {camLabel(focus.cameraId)} · master {formatClock(focus.masterTime)} · video {formatClock(focus.videoTime ?? focus.masterTime)}
            </span>
            <StatusBadge result={focusDiag.proj} />
            <span className="text-slate-500">WORLD</span>
            <span className="text-cyan-200">
              X {focus.worldPosition[0].toFixed(2)} · Y {focus.worldPosition[1].toFixed(2)} · Z {focus.worldPosition[2].toFixed(2)} m
            </span>
            <span className="text-[10px] text-slate-500">{focus.source}</span>
            <span className="text-slate-500">CHECK</span>
            <span className="col-span-2 text-[10px] text-slate-400">
              reprojection {focusDiag.reprojErrorPx == null ? "n/a" : `${focusDiag.reprojErrorPx.toFixed(1)} px`}
              {focusDiag.proj.valid && (
                <>
                  {" "}
                  · range {focusDiag.proj.distance!.toFixed(1)} m · ray {focusDiag.proj.incidenceDeg!.toFixed(0)}° to floor · ±{(focusDiag.proj.expectedErrorM! * 100).toFixed(0)} cm per 6 px
                </>
              )}
              {focusDiag.proj.reason && <span className="text-amber-300"> · {focusDiag.proj.reason}</span>}
            </span>
          </div>
        ) : (
          <div className="font-mono text-[11px] text-slate-500">
            Pause on a frame, click the person's feet. Cyan dot = your click, dashed ring = 3D point projected back into this camera,
            amber ◆ = other cameras' points at this time.
          </div>
        )}
        {message && <div className={`mt-1 text-[10px] ${message.ok ? "text-emerald-300" : "text-red-300"}`}>{message.text}</div>}
        {lastResult && !lastResult.valid && !message && <div className="mt-1 text-[10px] text-red-300">{lastResult.reason}</div>}
      </div>

      {/* Observation list */}
      <div className="flex items-center justify-between px-3 pt-2 pb-1">
        <span className="label">
          {activePersonId} · {obs.length} observations
        </span>
        <span className="text-[10px] text-slate-500">click row = jump · ✎ = correct (re-click video, or click floor in TOP view)</span>
      </div>
      <div ref={listRef} className="min-h-[96px] flex-1 overflow-y-auto px-3">
        {obs.length === 0 ? (
          <div className="rounded border border-dashed border-ink-500 p-3 text-center text-[11px] text-slate-500">No observations yet.</div>
        ) : (
          <table className="w-full font-mono text-[11px]">
            <tbody>
              {obs.map((o, i) => {
                const atNow = Math.abs(o.masterTime - t) <= SAME_TIME;
                const sel = o.id === selectedId;
                return (
                  <tr
                    key={o.id}
                    onClick={() => {
                      r().pause();
                      r().seek(o.masterTime);
                      setCameraId(o.cameraId);
                    }}
                    className={`cursor-pointer border-b border-ink-700/60 ${sel ? "bg-amber-400/10" : atNow ? "bg-cyan-400/10" : "hover:bg-ink-800"}`}
                  >
                    <td className="py-1 pr-2 text-slate-500">{i + 1}</td>
                    <td className="pr-2 text-slate-200">{formatClock(o.masterTime)}</td>
                    <td className="pr-2 text-slate-400">{camLabel(o.cameraId)}</td>
                    <td className="pr-2 text-cyan-200">
                      {o.worldPosition[0].toFixed(2)}, {o.worldPosition[2].toFixed(2)}
                    </td>
                    <td className="pr-2 text-[10px] text-slate-500">{o.source === "manual" ? "video" : "top-down"}</td>
                    <td className="w-16 text-right whitespace-nowrap">
                      <button
                        type="button"
                        title={sel ? "Stop correcting" : "Correct this point"}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (sel) return store().select(null);
                          r().pause();
                          r().seek(o.masterTime);
                          setCameraId(o.cameraId);
                          store().select(o.id);
                        }}
                        className={`mr-1 rounded px-1 ${sel ? "text-amber-300" : "text-slate-400 hover:text-amber-200"}`}
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        title="Delete"
                        onClick={(e) => {
                          e.stopPropagation();
                          store().remove(o.id);
                        }}
                        className="rounded px-1 text-slate-400 hover:text-red-300"
                      >
                        <Trash2 className="inline h-3 w-3" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Import / export */}
      <div className="flex flex-wrap items-center gap-1.5 border-t border-ink-600 px-3 py-2">
        <button type="button" onClick={download} className="flex h-7 items-center gap-1 rounded border border-ink-500 bg-ink-800 px-2 font-mono text-[10px] text-slate-200 hover:text-white">
          <Download className="h-3 w-3" /> EXPORT JSON
        </button>
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          className="flex h-7 items-center gap-1 rounded border border-ink-500 bg-ink-800 px-2 font-mono text-[10px] text-slate-200 hover:text-white"
        >
          <Upload className="h-3 w-3" /> IMPORT
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onImport(f);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          disabled={!canSaveToProject}
          onClick={async () => {
            try {
              const file = await saveProjectConfig("person-annotations", store().exportAll());
              setMessage({ ok: true, text: `Saved all persons to ${file}. Commit it to share.` });
            } catch (e) {
              setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
            }
          }}
          title={canSaveToProject ? "Write all persons to src/data/person-annotations.json" : "Only under npm run dev"}
          className="flex h-7 items-center gap-1 rounded border border-cyan-400/60 bg-cyan-400/15 px-2 font-mono text-[10px] text-cyan-100 hover:bg-cyan-400/25 disabled:opacity-40"
        >
          <Save className="h-3 w-3" /> SAVE TO PROJECT
        </button>
        <button
          type="button"
          onClick={reprojectAll}
          title="Recompute world positions from the clicked pixels using the current camera calibration"
          className="flex h-7 items-center gap-1 rounded border border-ink-500 bg-ink-800 px-2 font-mono text-[10px] text-slate-300 hover:text-white"
        >
          <RefreshCw className="h-3 w-3" /> RE-PROJECT
        </button>
        <button
          type="button"
          onClick={() => {
            if (!confirmClear) {
              setConfirmClear(true);
              setTimeout(() => setConfirmClear(false), 2500);
              return;
            }
            store().clearPerson();
            setConfirmClear(false);
          }}
          className="ml-auto flex h-7 items-center gap-1 rounded border border-ink-500 bg-ink-800 px-2 font-mono text-[10px] text-slate-400 hover:text-red-300"
        >
          <Trash2 className="h-3 w-3" /> {confirmClear ? "CLICK AGAIN TO CLEAR" : "CLEAR PERSON"}
        </button>
      </div>
    </section>
  );
}

const VIS_BUTTONS: { state: VisibilityState; label: string; title: string; cls: string }[] = [
  { state: "observed", label: "OBSERVED", title: "Person visible in this camera (feet may be hidden). Clicking feet also counts as observed.", cls: "hover:border-cyan-400 hover:text-cyan-200" },
  { state: "occluded", label: "OCCLUDED", title: "Person is within this camera's view but blocked (furniture, pillar, other person)", cls: "hover:border-amber-400 hover:text-amber-200" },
  { state: "out-of-frame", label: "OUT OF FRAME", title: "Person is outside this camera's frame", cls: "hover:border-orange-400 hover:text-orange-200" },
  { state: "unknown", label: "UNKNOWN", title: "Can't tell from this footage", cls: "hover:border-violet-400 hover:text-violet-200" },
];

/** Mark this camera's visibility of the person at the current master time. */
function VisibilityRow({ cameraId, personId, canMark }: { cameraId: CameraId; personId: string; canMark: boolean }) {
  const t = useReplayStore((s) => s.currentTime);
  const marks = useVisibilityStore((s) => s.marks[personId] ?? EMPTY_MARKS);
  const setMark = useVisibilityStore((s) => s.setMark);
  const removeMark = useVisibilityStore((s) => s.remove);
  const derived = useEvidenceStore((s) => s.byCamera[cameraId]);
  const here = marks.filter((m) => m.cameraId === cameraId);
  const atNow = here.find((m) => Math.abs(m.masterTime - t) <= 0.02);
  const [showAll, setShowAll] = useState(false);
  const r = useReplayStore.getState;

  return (
    <div className="mx-3 mt-2 rounded-md border border-ink-600 bg-ink-850 px-2.5 py-1.5">
      <div className="flex items-center gap-1.5">
        <span className="label mr-1 whitespace-nowrap">{camLabel(cameraId)} sees person?</span>
        {VIS_BUTTONS.map((b) => (
          <button
            key={b.state}
            type="button"
            disabled={!canMark}
            title={b.title}
            onClick={() => setMark(personId, cameraId, Math.round(r().currentTime * 1000) / 1000, b.state)}
            className={`h-6 flex-1 rounded border font-mono text-[10px] disabled:opacity-40 ${
              atNow?.state === b.state ? "border-cyan-400/70 bg-cyan-400/15 text-cyan-100" : `border-ink-500 bg-ink-800 text-slate-300 ${b.cls}`
            }`}
          >
            {b.label}
          </button>
        ))}
      </div>
      <div className="mt-1 flex items-center gap-2 font-mono text-[10px] text-slate-500">
        <span>
          now:{" "}
          <span style={{ color: derived ? CAMERA_STATE_COLOR[derived] : undefined }}>{derived ? CAMERA_STATE_LABEL[derived] : "n/a"}</span>
        </span>
        <span>·</span>
        <button type="button" onClick={() => setShowAll(!showAll)} className="underline-offset-2 hover:text-slate-300 hover:underline">
          {here.length} mark{here.length === 1 ? "" : "s"} in {camLabel(cameraId)} {showAll ? "▴" : "▾"}
        </button>
        <span className="ml-auto">marks hold until the next evidence in this camera</span>
      </div>
      {showAll && here.length > 0 && (
        <div className="mt-1 max-h-24 space-y-px overflow-y-auto">
          {here.map((m) => (
            <div key={m.id} className="flex items-center gap-2 font-mono text-[10px]">
              <button
                type="button"
                className="text-slate-300 hover:text-cyan-200"
                onClick={() => {
                  r().pause();
                  r().seek(m.masterTime);
                }}
              >
                {formatClock(m.masterTime)}
              </button>
              <span style={{ color: CAMERA_STATE_COLOR[m.state === "observed" ? "tracking" : m.state] }}>{m.state.toUpperCase()}</span>
              <button type="button" title="Delete mark" onClick={() => removeMark(personId, m.id)} className="ml-auto text-slate-500 hover:text-red-300">
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
const EMPTY_MARKS: VisibilityMark[] = [];
