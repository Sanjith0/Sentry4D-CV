import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { addAfterEffect } from "@react-three/fiber";
import { X } from "lucide-react";
import { securityCameras } from "../../config/cameras";
import { formatClock } from "../../lib/format";
import { evidenceAt } from "../sentry/useEvidence";
import { demoLook } from "./demoLook";
import { useLabelObstacle } from "./labelFit";
import {
  BEAT,
  chapterAt,
  CHAPTERS,
  cctvGradeAt,
  clamp01,
  DEMO_SUBJECT,
  easeOut,
  flashAt,
  FREEZE_LOOKS,
  incidentTime,
  lockCamAt,
  lookStateAt,
  pathReadout,
  rateLabel,
  scanLinesAt,
  span,
  wallAt,
} from "./demoScript";
import { useDemoStore } from "./useDemoStore";

type Widget = "cameras" | "footage" | "path" | "tracking" | "looks" | null;
/** The little control that moves by itself at the bottom right. */
const widgetAt = (e: number): Widget => {
  if (e >= BEAT.lock + 0.3 && e < BEAT.reveal) return "cameras";
  if (e >= BEAT.reveal && e < BEAT.melt + 0.15) return "footage";
  if (pathReadout(e)) return "path";
  if (e >= BEAT.orbit && e < BEAT.isolate) return "tracking";
  if (e >= BEAT.freeze && e < BEAT.end) return "looks";
  return null;
};
/** Grain flickers at the recordings' own pace, not the screen's. */
const GRAIN_FPS = 15;
/** Grain is drawn at this fraction of the screen's size and stretched (coarser, like a security camera's). */
const GRAIN_SCALE = 0.5;
/**
 * One frame of CCTV grain on canvas c: faint, slightly blue speckle around the recordings' mid-dark level, so it
 * puts sensor noise on the picture without veiling it (the exposure itself is matched by cctvFilterAt on the
 * canvas). Seeded by the frame number, so the same moment of the demo always gets the same grain.
 */
function paintGrain(c: HTMLCanvasElement, frame: number) {
  const w = Math.max(2, Math.round(c.clientWidth * GRAIN_SCALE));
  const h = Math.max(2, Math.round(c.clientHeight * GRAIN_SCALE));
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  const g = c.getContext("2d");
  if (!g) return;
  const img = g.createImageData(w, h);
  const px = img.data;
  let seed = (frame * 2654435761) >>> 0 || 1;
  const rand = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  for (let i = 0; i < px.length; i += 4) {
    const v = 6 + 44 * (rand() + rand());
    px[i] = v * 0.88;
    px[i + 1] = v * 0.97;
    px[i + 2] = v * 1.12;
    px[i + 3] = 64;
  }
  g.putImageData(img, 0, 0);
}

/** The camera named in the top bar: the one whose picture is on screen (once the wall's own labels are gone). */
const namedCamAt = (e: number) => (e >= BEAT.lock + 0.3 ? lockCamAt(e) : null);
/** The cameras that see the subject at demo time e, as one string ("cam1 cam3"): the replay's SEEN BY chips. */
const observersAt = (e: number) => (e >= BEAT.orbit && e < BEAT.isolate ? (evidenceAt(DEMO_SUBJECT, incidentTime(e))?.observers ?? []).join(" ") : "");

const chip = (on: boolean) =>
  `rounded border px-[0.9em] py-[0.45em] tracking-[0.14em] whitespace-nowrap ${
    on ? "border-cyan-300 bg-cyan-400/20 text-cyan-50 shadow-[0_0_18px_-2px_rgba(34,211,238,0.85)]" : "border-ink-500 bg-ink-950/75 text-slate-500"
  }`;

/**
 * Everything the demo walkthrough draws on top of the viewport: brand, incident clock, captions, the
 * chapter rail, the little controls that move by themselves (footage slider, camera and look chips), the
 * tracking bracket, flashes and the end card. Positions that change every frame are written straight to
 * the elements from the demo clock, so a stepped recording and a live run look the same.
 */
export function DemoOverlay() {
  const phase = useDemoStore((s) => s.phase);
  const stop = useDemoStore((s) => s.stop);
  const chapter = useDemoStore((s) => chapterAt(s.elapsed));
  const widget = useDemoStore((s) => widgetAt(s.elapsed));
  const cctv = useDemoStore((s) => namedCamAt(s.elapsed));
  const observers = useDemoStore((s) => observersAt(s.elapsed));
  const look = useDemoStore((s) => lookStateAt(s.elapsed).name);
  const percent = useDemoStore((s) => Math.round(s.progress * 100));
  const [hint, setHint] = useState(false);
  const hintTimer = useRef(0);

  const top = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const time = useRef<HTMLSpanElement>(null);
  const rate = useRef<HTMLSpanElement>(null);
  const caption = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLDivElement>(null);
  const fills = useRef<(HTMLDivElement | null)[]>([]);
  const footFill = useRef<HTMLDivElement>(null);
  const footKnob = useRef<HTMLDivElement>(null);
  const footText = useRef<HTMLSpanElement>(null);
  const pathFill = useRef<HTMLDivElement>(null);
  const pathText = useRef<HTMLSpanElement>(null);
  const pathSub = useRef<HTMLDivElement>(null);
  const marks = useRef<(HTMLDivElement | null)[]>([]);
  const flash = useRef<HTMLDivElement>(null);
  const lines = useRef<HTMLDivElement>(null);
  const grain = useRef<HTMLCanvasElement>(null);
  const grainFrame = useRef(-1);
  const end = useRef<HTMLDivElement>(null);
  const bracket = useRef<HTMLDivElement>(null);
  const bracketText = useRef<HTMLDivElement>(null);
  const bracketSub = useRef<HTMLDivElement>(null);
  const side = useRef<HTMLDivElement>(null);
  const readout = useRef<HTMLDivElement>(null);
  const readoutText = useRef<HTMLDivElement>(null);
  const readoutSub = useRef<HTMLDivElement>(null);
  useLabelObstacle(bracket);
  useLabelObstacle(side);
  /** Writes the demo clock's state to the elements above. */
  const sync = useRef<() => void>(() => {});

  useEffect(() => {
    const text = (el: HTMLElement | null, v: string) => {
      if (el && el.textContent !== v) el.textContent = v;
    };
    const update = () => {
      const s = useDemoStore.getState();
      if (s.phase !== "running" && s.phase !== "ended") return;
      const e = s.elapsed;
      const ch = chapterAt(e);
      const out = 1 - span(e, BEAT.end, BEAT.end + 0.3); // the chrome leaves for the end card

      text(time.current, formatClock(incidentTime(e)));
      text(rate.current, rateLabel(e));
      if (top.current) top.current.style.opacity = String(out);
      if (bottom.current) bottom.current.style.opacity = String(out);

      // caption: wipes in at each chapter
      if (caption.current && title.current && ch >= 0) {
        const u = span(e, CHAPTERS[ch].at, CHAPTERS[ch].at + 0.26);
        caption.current.style.opacity = String(clamp01(u * 1.6));
        caption.current.style.transform = `translate3d(0, ${((1 - easeOut(u)) * 10).toFixed(2)}px, 0)`;
        title.current.style.clipPath = u >= 1 ? "none" : `inset(-10% ${((1 - easeOut(u)) * 100).toFixed(1)}% -10% 0)`;
      }
      fills.current.forEach((el, i) => {
        if (!el) return;
        const to = i + 1 < CHAPTERS.length ? CHAPTERS[i + 1].at : BEAT.end;
        el.style.transform = `scaleX(${span(e, CHAPTERS[i].at, to).toFixed(4)})`;
      });

      const footage = wallAt(e).footage;
      if (footFill.current) footFill.current.style.width = `${(footage * 100).toFixed(1)}%`;
      if (footKnob.current) footKnob.current.style.left = `${(footage * 100).toFixed(1)}%`;
      text(footText.current, `${Math.round(footage * 100)}%`);

      // the tracked path: metres so far, and its labels riding on the points they name
      const info = demoLook.pathInfo;
      if (pathFill.current) pathFill.current.style.width = `${(info.length > 0 ? clamp01(info.drawn / info.length) * 100 : 0).toFixed(1)}%`;
      text(pathText.current, `${info.drawn.toFixed(1)} m`);
      text(pathSub.current, info.length > 0 ? `${formatClock(info.start)} \u2192 ${formatClock(info.end)} \u00B7 ${(info.end - info.start).toFixed(1)} S ON SCENE` : "");
      marks.current.forEach((el, i) => {
        const mark = demoLook.marks[i];
        if (!el || !mark) return;
        el.style.display = mark.on ? "block" : "none";
        if (!mark.on) return;
        text(el, mark.text);
        el.style.opacity = demoLook.path.labels.toFixed(3);
        // the entry's label above its point, the others under theirs (entry and exit are half a metre apart)
        el.style.transform = `translate3d(${mark.x.toFixed(1)}px, ${mark.y.toFixed(1)}px, 0) translate(-50%, ${i === 0 ? "calc(-100% - 1.5em)" : "1.5em"})`;
      });

      if (flash.current) flash.current.style.opacity = flashAt(e).toFixed(3);
      // CCTV look (scan lines) while the viewport is one of the cameras
      if (lines.current) lines.current.style.opacity = scanLinesAt(e).toFixed(3);
      // ... and the recordings' grain while it flies between them
      const grade = cctvGradeAt(e);
      if (grain.current) {
        grain.current.style.opacity = grade.toFixed(3);
        grain.current.style.visibility = grade > 0.002 ? "visible" : "hidden";
        const f = Math.floor(e * GRAIN_FPS);
        if (grade > 0.002 && f !== grainFrame.current) {
          grainFrame.current = f;
          paintGrain(grain.current, f);
        }
      }
      if (end.current) {
        const u = span(e, BEAT.end, BEAT.end + 0.45);
        end.current.style.opacity = String(u);
        end.current.style.transform = `scale(${(1.06 - 0.06 * easeOut(u)).toFixed(4)})`;
        end.current.style.visibility = u > 0 ? "visible" : "hidden";
      }

      const b = demoLook.bracket;
      if (bracket.current) {
        bracket.current.style.display = b.on ? "block" : "none";
        if (b.on) {
          // closes in on the subject from a little wider, then holds
          const grow = 1 + 0.45 * (1 - b.lock);
          const h = (b.bottom - b.top) * grow;
          const w = (b.bottom - b.top) * 0.5 * grow;
          bracket.current.style.transform = `translate3d(${(b.x - w / 2).toFixed(1)}px, ${((b.top + b.bottom - h) / 2).toFixed(1)}px, 0)`;
          bracket.current.style.width = `${w.toFixed(1)}px`;
          bracket.current.style.height = `${h.toFixed(1)}px`;
          bracket.current.style.opacity = Math.min(1, b.lock * 1.6).toFixed(3);
          text(bracketText.current, b.text);
          text(bracketSub.current, b.sub);
          text(readoutText.current, b.text);
          text(readoutSub.current, b.sub);
          // the values sit beside the bracket; in a narrow window they slide back over it rather than leave the screen
          const host = bracket.current.parentElement;
          if (side.current && host) {
            const over = b.x + w / 2 + 12 + side.current.offsetWidth - host.clientWidth * 0.978;
            side.current.style.transform = over > 0 ? `translate3d(${(-over).toFixed(1)}px, 0, 0)` : "";
          }
        }
      }
      if (readout.current) readout.current.style.opacity = b.on ? Math.min(1, b.lock * 1.6).toFixed(3) : "0";
    };
    sync.current = update;
    // Runs right after the viewport has drawn its frame, in the same animation frame: the director has just
    // applied this demo time and projected the bracket, so the overlay and the picture never differ by a frame.
    return addAfterEffect(update);
  }, []);
  // ...and after every render of this component: elements React has just created (a chapter's title, a widget,
  // everything when the loading card goes) get their state before the browser paints them once without it.
  useLayoutEffect(() => sync.current());

  useEffect(() => () => window.clearTimeout(hintTimer.current), []);
  const showHint = () => {
    setHint(true);
    window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setHint(false), 2200);
  };
  const onMove = (ev: React.PointerEvent) => {
    if (ev.pointerType === "mouse" && !ev.movementX && !ev.movementY) return; // the page changed under a resting pointer
    showHint();
  };

  const live = phase === "running" || phase === "ended";
  const current = chapter >= 0 ? CHAPTERS[chapter] : null;
  // Sizes follow the window's height; the width only caps them in a portrait window (a phone held upright),
  // where the layout also stacks: see the `portrait:` classes.
  const small = { fontSize: "clamp(9px, min(1.45vh, 2.5vw), 15px)" };

  return (
    <div className={`absolute inset-0 z-[60] overflow-hidden font-mono select-none ${hint ? "" : "cursor-none"}`} onPointerMove={onMove} onPointerDown={showHint}>
      {live && (
        <>
          <div className="vignette absolute inset-0 opacity-70" />
          <canvas ref={grain} className="absolute inset-0 h-full w-full" style={{ opacity: 0, visibility: "hidden" }} />
          <div ref={lines} className="scanlines absolute inset-0" style={{ opacity: 0 }} />
          <div ref={flash} className="absolute inset-0 bg-cyan-50" style={{ opacity: 0 }} />

          {/* tracking bracket */}
          <div ref={bracket} className="absolute top-0 left-0 border border-cyan-300/70 shadow-[0_0_18px_-4px_rgba(34,211,238,0.9)]" style={{ display: "none" }}>
            <div className="absolute -top-px -left-px h-3 w-3 border-t-2 border-l-2 border-cyan-200" />
            <div className="absolute -top-px -right-px h-3 w-3 border-t-2 border-r-2 border-cyan-200" />
            <div className="absolute -bottom-px -left-px h-3 w-3 border-b-2 border-l-2 border-cyan-200" />
            <div className="absolute -right-px -bottom-px h-3 w-3 border-r-2 border-b-2 border-cyan-200" />
            <div ref={side} className="absolute top-[12%] left-full ml-3 border-l-2 border-cyan-300 bg-ink-950/85 px-[0.8em] py-[0.5em] whitespace-nowrap portrait:hidden" style={small}>
              <div ref={bracketText} className="tracking-[0.1em] text-cyan-100" />
              <div ref={bracketSub} className="mt-[0.3em] tracking-[0.1em] text-slate-400" />
            </div>
          </div>

          {/* labels on the tracked path */}
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              ref={(el) => {
                marks.current[i] = el;
              }}
              className="absolute top-0 left-0 border-l-2 border-red-400 bg-ink-950/85 px-[0.7em] py-[0.35em] tracking-[0.12em] whitespace-nowrap text-red-50"
              style={{ ...small, display: "none" }}
            />
          ))}

          {/* top bar (portrait: brand and clock on the first row, the camera's name on a row of its own) */}
          <div ref={top} className="absolute inset-x-0 top-0 flex items-center justify-between px-[2.2vw] pt-[2vh] portrait:flex-wrap portrait:gap-x-[0.9em] portrait:gap-y-[0.6em]" style={small}>
            <div className="flex items-center gap-[0.9em] portrait:contents">
              <div className="flex items-center gap-[0.7em] rounded border border-cyan-400/50 bg-ink-950/80 px-[0.9em] py-[0.45em] whitespace-nowrap text-cyan-50 shadow-[0_0_18px_-6px_rgba(34,211,238,0.9)]">
                <span className="h-[0.6em] w-[0.6em] rotate-45 bg-cyan-300" />
                <span className="font-semibold tracking-[0.28em]">SENTRY4D</span>
              </div>
              {cctv && (
                // (a short window has no room for it next to the labels in the scene: the camera row below names the view)
                <div className={`flex portrait:order-last portrait:basis-full ${widget === "cameras" ? "[@media(max-height:480px)]:hidden" : ""}`}>
                  <div className="flex items-center gap-[0.6em] rounded border border-ink-500 bg-ink-950/80 px-[0.9em] py-[0.45em] tracking-[0.14em] whitespace-nowrap text-slate-200">
                    <span className="rec-dot h-[0.55em] w-[0.55em] rounded-full bg-red-400" />
                    {securityCameras.find((c) => c.id === cctv)?.name.toUpperCase()}
                  </div>
                </div>
              )}
            </div>
            <div className="flex items-center gap-[0.9em] rounded border border-ink-500 bg-ink-950/80 px-[0.9em] py-[0.45em] whitespace-nowrap portrait:ml-auto">
              <span className="tracking-[0.2em] text-slate-500 portrait:hidden">INCIDENT</span>
              <span ref={time} className="tracking-[0.08em] text-cyan-50 tabular-nums">
                00:00.00
              </span>
              <span ref={rate} className="min-w-[7.5em] text-right tracking-[0.1em] text-cyan-300" />
            </div>
          </div>

          {/* caption, moving controls, chapter rail */}
          <div ref={bottom} className="absolute inset-x-0 bottom-0 px-[2.2vw] pb-[2.2vh]">
            <div className="absolute inset-x-0 bottom-0 h-[24vh] bg-gradient-to-t from-ink-950/95 via-ink-950/55 to-transparent" />
            <div className="relative flex items-end justify-between gap-[3vw] portrait:flex-col-reverse portrait:items-stretch portrait:gap-[1.4vh]">
              <div ref={caption} className="min-w-0">
                <div ref={title} key={chapter} className="leading-[1.12] font-semibold tracking-[0.06em] text-slate-50" style={{ fontSize: "clamp(17px, min(3.5vh, 5.4vw), 44px)", textShadow: "0 0 24px rgba(34,211,238,0.45)" }}>
                  {current?.title}
                </div>
                <div className="mt-[0.7vh] tracking-[0.16em] text-cyan-200/90 uppercase" style={small}>
                  {current?.sub}
                </div>
              </div>
              <div className="shrink-0" style={small}>
                {widget === "footage" && (
                  <div className="w-[clamp(190px,26vw,380px)] portrait:w-full">
                    <div className="flex items-baseline justify-between">
                      <span className="tracking-[0.2em] text-slate-300">REAL FOOTAGE</span>
                      <span ref={footText} className="text-[1.5em] font-semibold text-cyan-50 tabular-nums">
                        100%
                      </span>
                    </div>
                    <div className="relative mt-[0.7em] h-[0.45em] rounded-full bg-ink-600">
                      <div ref={footFill} className="absolute inset-y-0 left-0 rounded-full bg-cyan-300 shadow-[0_0_12px_rgba(34,211,238,0.9)]" style={{ width: "100%" }} />
                      <div ref={footKnob} className="absolute top-1/2 h-[1.1em] w-[1.1em] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-cyan-100 bg-ink-950" style={{ left: "100%" }} />
                    </div>
                  </div>
                )}
                {widget === "cameras" && (
                  <div className="flex gap-[0.6em] portrait:flex-wrap">
                    {securityCameras.slice(0, 4).map((c, i) => (
                      <span key={c.id} className={chip(c.id === cctv)}>
                        CAM 0{i + 1}
                      </span>
                    ))}
                  </div>
                )}
                {widget === "path" && (
                  <div className="w-[clamp(190px,26vw,380px)] portrait:w-full">
                    <div className="flex items-baseline justify-between">
                      <span className="tracking-[0.2em] text-slate-300">TRACKED PATH</span>
                      <span ref={pathText} className="text-[1.5em] font-semibold text-red-50 tabular-nums">
                        0.0 m
                      </span>
                    </div>
                    <div className="mt-[0.7em] h-[0.45em] overflow-hidden rounded-full bg-ink-600">
                      <div ref={pathFill} className="h-full rounded-full bg-red-500 shadow-[0_0_12px_rgba(248,60,70,0.9)]" style={{ width: "0%" }} />
                    </div>
                    <div ref={pathSub} className="mt-[0.7em] tracking-[0.12em] whitespace-nowrap text-slate-400" />
                  </div>
                )}
                {widget === "tracking" && (
                  <div className="flex items-center gap-[0.6em] portrait:flex-wrap">
                    <span className="mr-[0.3em] tracking-[0.2em] text-slate-400">SEEN BY</span>
                    {securityCameras.slice(0, 4).map((c, i) => (
                      <span key={c.id} className={chip(observers.split(" ").includes(c.id))}>
                        CAM 0{i + 1}
                      </span>
                    ))}
                  </div>
                )}
                {widget === "looks" && (
                  <div className="flex gap-[0.6em] portrait:flex-wrap">
                    {FREEZE_LOOKS.map((l) => (
                      <span key={l.name} className={chip(l.name === look)}>
                        {l.label}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              {/* portrait: the tracking values, which sit beside the bracket in a landscape window */}
              <div ref={readout} className="hidden border-l-2 border-cyan-300 bg-ink-950/85 px-[0.8em] py-[0.5em] portrait:block" style={{ ...small, opacity: 0 }}>
                <div ref={readoutText} className="tracking-[0.1em] text-cyan-100" />
                <div ref={readoutSub} className="mt-[0.3em] tracking-[0.1em] text-slate-400" />
              </div>
            </div>
            <div className="relative mt-[1.6vh] flex gap-[0.4vw]">
              {CHAPTERS.map((c, i) => (
                <div key={c.rail} className="min-w-0 flex-1">
                  <div className="h-[3px] overflow-hidden rounded-full bg-slate-500/30">
                    <div
                      ref={(el) => {
                        fills.current[i] = el;
                      }}
                      className="h-full origin-left bg-cyan-300"
                      style={{ transform: "scaleX(0)" }}
                    />
                  </div>
                  <div className={`mt-[0.6vh] hidden truncate tracking-[0.16em] md:block ${i === chapter ? "text-cyan-200" : "text-slate-500"}`} style={{ fontSize: "clamp(8px, 1.15vh, 12px)" }}>
                    {c.rail}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* end card */}
          <div ref={end} className="absolute inset-0 flex flex-col items-center justify-center bg-ink-950/72" style={{ opacity: 0, visibility: "hidden" }}>
            <div className="pl-[0.2em] font-semibold tracking-[0.2em] text-slate-50" style={{ fontSize: "clamp(34px, min(12vh, 8.5vw), 150px)", textShadow: "0 0 60px rgba(34,211,238,0.55)" }}>
              SENTRY<span className="text-cyan-300">4D</span>
            </div>
            <div className="mt-[1.6vh] h-px w-[min(62vw,720px)] bg-gradient-to-r from-transparent via-cyan-300 to-transparent" />
            <div className="mt-[2.4vh] pl-[0.3em] text-center tracking-[0.3em] text-slate-100" style={{ fontSize: "clamp(10px, min(2.1vh, 1.9vw), 26px)" }}>
              CCTV {"\u2192"} 4D FORENSIC RECONSTRUCTION
            </div>
            <div className="mt-[1.4vh] pl-[0.2em] text-center tracking-[0.2em] text-slate-300" style={{ fontSize: "clamp(8px, min(1.5vh, 1.35vw), 17px)" }}>
              4 CAMERAS {"\u00B7"} LIDAR TWIN {"\u00B7"} SAM 2.1 {"\u00B7"} MULTI-CAMERA FUSION
            </div>
          </div>
        </>
      )}

      {phase === "preparing" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-ink-950">
          <div className="pl-[0.28em] font-semibold tracking-[0.28em] text-slate-50" style={{ fontSize: "clamp(20px, 4.5vh, 54px)" }}>
            SENTRY<span className="text-cyan-300">4D</span>
          </div>
          <div className="mt-[2.2vh] h-[3px] w-[min(46vw,420px)] overflow-hidden rounded-full bg-ink-600">
            <div className="h-full bg-cyan-300 transition-[width] duration-200" style={{ width: `${percent}%` }} />
          </div>
          <div className="mt-[1.6vh] pl-[0.2em] tracking-[0.2em] text-slate-400" style={small}>
            LOADING RECONSTRUCTION {percent}%
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={stop}
        title="Exit the demo (Esc)"
        className={`absolute top-[2vh] left-1/2 flex -translate-x-1/2 items-center gap-2 rounded border border-ink-500 bg-ink-950/90 px-3 py-1.5 text-[11px] tracking-[0.14em] text-slate-300 transition-opacity duration-200 hover:border-slate-400 hover:text-slate-50 ${
          hint ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        <X className="h-3.5 w-3.5" /> EXIT DEMO <span className="text-slate-500">ESC</span>
      </button>
    </div>
  );
}
