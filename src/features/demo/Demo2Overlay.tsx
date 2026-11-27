import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { addAfterEffect } from "@react-three/fiber";
import { Search, X } from "lucide-react";
import { securityCameras } from "../../config/cameras";
import { formatClock } from "../../lib/format";
import { useAppearanceStore } from "../reconstruction/useAppearanceStore";
import { evidenceAt } from "../sentry/useEvidence";
import { recordingSources } from "./recordingSources";
import { demoLook } from "./demoLook";
import { useLabelObstacle } from "./labelFit";
import {
  BEAT,
  chapterAt,
  CHAPTERS,
  DWELL_CHAPTER,
  flashAt,
  FREEZE_LOOKS,
  glitchAt,
  incidentTime,
  lookStateAt,
  namedCamAt,
  rateLabel,
  scanLinesAt,
  SEARCH,
  STATS_CHAPTER,
  wipeAt,
  wipeShown,
} from "./demo2Script";
import { CAMERA_ORDER, clamp01, DEMO_CLIP, DEMO_SUBJECT, easeInOut, easeOut, lerp, span } from "./demoScript";
import { useDemoStore } from "./useDemoStore";

type Kicker = "search" | "seen" | "looks" | "forecast" | null;
/** The row above the title: what the system is doing right now. */
const kickerAt = (e: number): Kicker => {
  if (e >= BEAT.wall && e < BEAT.reveal + 0.2) return "search";
  if (e >= BEAT.track + 0.3 && e < BEAT.free) return "seen";
  if (e >= BEAT.free && e < BEAT.predict) return "looks";
  if (e >= BEAT.predict + 0.3 && e < BEAT.stats) return "forecast";
  return null;
};
/** The cameras that see the subject at demo time e, as one string ("cam1 cam3"). */
const observersAt = (e: number) => (kickerAt(e) === "seen" ? (evidenceAt(DEMO_SUBJECT, incidentTime(e))?.observers ?? []).join(" ") : "");

const chip = (on: boolean) =>
  `rounded border px-[0.8em] py-[0.4em] tracking-[0.12em] whitespace-nowrap ${
    on ? "border-cyan-300 bg-cyan-400/20 text-cyan-50 shadow-[0_0_18px_-2px_rgba(34,211,238,0.85)]" : "border-ink-500 bg-ink-950/75 text-slate-500"
  }`;

/** The search bar's size once it has taken its place above the title (1 = as typed). */
const SEARCH_REST = 0.78;
/** Sizes follow the window's height; its width only caps them in a narrow (portrait) window. */
const SMALL = { fontSize: "clamp(9px, min(1.5vh, 2.6vw), 15px)" };
const SUB = { fontSize: "clamp(9px, min(1.7vh, 2.9vw), 17px)" };
const TITLE = { fontSize: "clamp(20px, min(6.4vh, 8.6vw), 78px)", textShadow: "0 0 34px rgba(34,211,238,0.5), 0 2px 18px rgba(2,6,12,0.9)" };
const STAT = { fontSize: "clamp(16px, min(4.6vh, 6.2vw), 56px)" };
/**
 * Everything that has to be read sits in this column in the middle of the picture: a 4:5 crop of a 16:9
 * recording (a feed post) keeps all of it.
 */
const COLUMN = "absolute inset-y-0 left-1/2 w-[min(100vw,80vh)] -translate-x-1/2";

/** The numbers of this reconstruction: label under the tile, label on the end card, decimals, unit. */
const STATS = [
  { label: "CCTV CAMERAS", short: "CAMERAS", digits: 0, unit: "" },
  { label: "SECONDS TRACKED", short: "TRACKED", digits: 1, unit: "s" },
  { label: "METRES OF PATH", short: "PATH", digits: 1, unit: "m" },
  { label: "SAM 2.1 CUT-OUTS", short: "CUT-OUTS", digits: 0, unit: "" },
] as const;

/**
 * DEMO 2's overlay: brand and incident clock, the headline and chapter titles (large, inside the 4:5-safe
 * column), the search bar, the wipe between recording and 3D view, the labels of the forecast, the numbers of
 * this reconstruction and the end card. Positions that change every frame are written straight to the
 * elements from the demo clock, so a stepped recording and a live run look the same.
 */
export function Demo2Overlay() {
  const phase = useDemoStore((s) => s.phase);
  const stop = useDemoStore((s) => s.stop);
  const chapter = useDemoStore((s) => chapterAt(s.elapsed));
  const kicker = useDemoStore((s) => kickerAt(s.elapsed));
  const cctv = useDemoStore((s) => namedCamAt(s.elapsed));
  const observers = useDemoStore((s) => observersAt(s.elapsed));
  const look = useDemoStore((s) => lookStateAt(s.elapsed).name);
  const percent = useDemoStore((s) => Math.round(s.progress * 100));
  const clip = useAppearanceStore((s) => s.clips[DEMO_CLIP]);
  const [hint, setHint] = useState(false);
  const hintTimer = useRef(0);

  /** Recordings in the clip, and frames in which SAM 2.1 cut the subject out of one. */
  const counted = useMemo(() => {
    let cameras = 0;
    let cutouts = 0;
    for (const id of CAMERA_ORDER) {
      const frames = clip?.cameras[id]?.frames;
      if (!frames?.length) continue;
      cameras++;
      for (const f of frames) if (f.crop) cutouts++;
    }
    return { cameras, cutouts };
  }, [clip]);

  const host = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const time = useRef<HTMLSpanElement>(null);
  const rate = useRef<HTMLSpanElement>(null);
  const caption = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLDivElement>(null);
  const accent = useRef<HTMLDivElement>(null);
  const fills = useRef<(HTMLDivElement | null)[]>([]);
  const marks = useRef<(HTMLDivElement | null)[]>([]);
  const flash = useRef<HTMLDivElement>(null);
  const glitch = useRef<HTMLDivElement>(null);
  const lines = useRef<HTMLDivElement>(null);
  const wipe = useRef<HTMLDivElement>(null);
  const wipeLeft = useRef<HTMLDivElement>(null);
  const wipeRight = useRef<HTMLDivElement>(null);
  const searchDim = useRef<HTMLDivElement>(null);
  const searchBar = useRef<HTMLDivElement>(null);
  const searchText = useRef<HTMLSpanElement>(null);
  const searchCaret = useRef<HTMLSpanElement>(null);
  const searchStatus = useRef<HTMLSpanElement>(null);
  const slot = useRef<HTMLDivElement>(null);
  const speed = useRef<HTMLSpanElement>(null);
  const heading = useRef<HTMLSpanElement>(null);
  const pace = useRef<HTMLSpanElement>(null);
  const eta = useRef<HTMLSpanElement>(null);
  const ahead = useRef<HTMLDivElement>(null);
  const exit = useRef<HTMLDivElement>(null);
  const statValues = useRef<(HTMLSpanElement | null)[]>([]);
  const endValues = useRef<(HTMLSpanElement | null)[]>([]);
  const end = useRef<HTMLDivElement>(null);
  const bracket = useRef<HTMLDivElement>(null);
  const bracketText = useRef<HTMLDivElement>(null);
  const bracketSub = useRef<HTMLDivElement>(null);
  const side = useRef<HTMLDivElement>(null);
  useLabelObstacle(bracket);
  useLabelObstacle(side);
  useLabelObstacle(caption);
  useLabelObstacle(ahead);
  useLabelObstacle(exit);
  /** Writes the demo clock's state to the elements above. */
  const sync = useRef<() => void>(() => {});
  const countedRef = useRef(counted);
  useEffect(() => {
    countedRef.current = counted;
  }, [counted]);

  useEffect(() => {
    const text = (el: HTMLElement | null, v: string) => {
      if (el && el.textContent !== v) el.textContent = v;
    };
    const show = (el: HTMLElement | null, on: boolean) => {
      if (el) el.style.display = on ? "" : "none";
    };
    const update = () => {
      const s = useDemoStore.getState();
      if (s.phase !== "running" && s.phase !== "ended") return;
      const e = s.elapsed;
      const ch = chapterAt(e);
      const T = incidentTime(e);
      const out = 1 - span(e, BEAT.end, BEAT.end + 0.3); // the chrome leaves for the end card
      const W = host.current?.clientWidth ?? 0;
      const H = host.current?.clientHeight ?? 0;

      text(time.current, formatClock(T));
      text(rate.current, rateLabel(e));
      if (top.current) top.current.style.opacity = String(out);
      if (bottom.current) bottom.current.style.opacity = String(out);

      // title: on screen from the first frame of the cold open; later chapters' titles punch in
      if (caption.current && title.current && ch >= 0) {
        const u = ch === 0 ? 1 : span(e, CHAPTERS[ch].at, CHAPTERS[ch].at + 0.24);
        caption.current.style.opacity = String(clamp01(u * 1.8));
        title.current.style.transform = `scale(${(1.14 - 0.14 * easeOut(u)).toFixed(4)})`;
        if (accent.current) {
          // the cold open's last line lands a beat after the picture
          const pop = ch === 0 ? easeOut(span(e, 0.05, 0.5)) : 1;
          accent.current.style.transform = `scale(${(1.3 - 0.3 * pop).toFixed(4)})`;
          // the dwell: seconds he has stood at the table by the shown time, from the fused track
          const info = demoLook.pathInfo;
          if (ch === DWELL_CHAPTER) text(accent.current, `${Math.min(Math.max(T - info.dwellFrom, 0), info.dwell).toFixed(1)} S`);
        }
      }
      fills.current.forEach((el, i) => {
        if (!el) return;
        const to = i + 1 < CHAPTERS.length ? CHAPTERS[i + 1].at : BEAT.end;
        el.style.transform = `scaleX(${span(e, CHAPTERS[i].at, to).toFixed(4)})`;
      });

      // ---- search bar: typed in the middle of the wall, then it takes its place above the title
      if (searchBar.current && searchDim.current) {
        const on = e >= BEAT.wall && e < BEAT.reveal + 0.2;
        show(searchBar.current, on);
        show(searchDim.current, on);
        if (on) {
          const alpha = span(e, BEAT.wall + 0.05, BEAT.wall + 0.25) * (1 - span(e, BEAT.reveal - 0.1, BEAT.reveal + 0.2));
          const m = easeInOut(span(e, SEARCH.scan[0] - 0.05, SEARCH.scan[0] + 0.4));
          const h = searchBar.current.offsetHeight;
          const hostBox = host.current?.getBoundingClientRect();
          const slotBox = slot.current?.getBoundingClientRect();
          const scale = lerp(1, SEARCH_REST, m);
          // (at rest its lower edge sits on the row's)
          const rest = slotBox && hostBox ? slotBox.bottom - hostBox.top - h * SEARCH_REST - slotBox.height * 0.14 : H * 0.7;
          const y = lerp(H * 0.43 - h / 2, rest, m);
          searchBar.current.style.opacity = alpha.toFixed(3);
          searchBar.current.style.transform = `translate3d(-50%, ${y.toFixed(1)}px, 0) scale(${scale.toFixed(4)})`;
          searchDim.current.style.opacity = (0.5 * alpha * (1 - m)).toFixed(3);
          const typed = Math.round(SEARCH.query.length * span(e, SEARCH.type[0], SEARCH.type[1]));
          text(searchText.current, SEARCH.query.slice(0, typed));
          if (searchCaret.current) searchCaret.current.style.opacity = e < SEARCH.scan[0] && (typed < SEARCH.query.length ? typed > 0 || Math.floor(e * 4) % 2 === 0 : Math.floor(e * 6) % 2 === 0) ? "1" : "0";
          // (feeds in which SAM 2.1 has his cut-out at the shown moment)
          const feeds = Object.values(recordingSources(T)).filter((w) => (w ?? 0) > 0.5).length;
          text(searchStatus.current, e < SEARCH.scan[0] ? "" : e < BEAT.lock ? "SCANNING" : `${feeds}/4 FEEDS`);
        }
      }

      // ---- the wipe between the recording and the 3D view
      const w = wipeAt(e);
      if (wipe.current) {
        const on = wipeShown(e);
        show(wipe.current, on);
        if (on) {
          wipe.current.style.transform = `translate3d(${(w * W).toFixed(1)}px, 0, 0)`;
          wipe.current.style.opacity = (span(e, BEAT.reveal + 0.45, BEAT.reveal + 0.65) * (1 - span(e, BEAT.reveal + 1.95, BEAT.reveal + 2.15))).toFixed(3);
          if (wipeLeft.current) wipeLeft.current.style.opacity = span(w, 0.16, 0.3).toFixed(3);
          if (wipeRight.current) wipeRight.current.style.opacity = (1 - span(w, 0.7, 0.84)).toFixed(3);
        }
      }
      if (lines.current) {
        lines.current.style.opacity = scanLinesAt(e).toFixed(3);
        lines.current.style.clipPath = w > 0 ? `inset(0 0 0 ${(w * 100).toFixed(2)}%)` : "";
      }
      if (flash.current) flash.current.style.opacity = flashAt(e).toFixed(3);
      if (glitch.current) {
        const g = glitchAt(e);
        show(glitch.current, g > 0);
        if (g > 0) {
          const k = Math.floor(e * 30);
          glitch.current.style.opacity = (0.35 + 0.65 * g).toFixed(3);
          glitch.current.style.backgroundPosition = `0 ${(k * 37) % 100}%`;
          glitch.current.style.transform = `translate3d(${(((k * 13) % 7) - 3) * 3 * g}px, 0, 0)`;
        }
      }

      // ---- labels on the tracked path, riding on the points they name
      marks.current.forEach((el, i) => {
        const mark = demoLook.marks[i];
        if (!el || !mark) return;
        el.style.display = mark.on ? "block" : "none";
        if (!mark.on) return;
        text(el, mark.text);
        el.style.opacity = demoLook.path.labels.toFixed(3);
        el.style.transform = `translate3d(${mark.x.toFixed(1)}px, ${mark.y.toFixed(1)}px, 0) translate(-50%, ${i === 0 ? "calc(-100% - 1.5em)" : "1.5em"})`;
      });

      // ---- forecast: the arrow's reach and the exit, on their points; the values in the row above the title
      const f = demoLook.forecast;
      if (ahead.current) {
        const on = f.on && f.alpha > 0.02 && e >= BEAT.predict;
        show(ahead.current, on);
        if (on) {
          text(ahead.current, f.text);
          ahead.current.style.opacity = Math.min(1, f.alpha * 1.4).toFixed(3);
          ahead.current.style.transform = `translate3d(${f.x.toFixed(1)}px, ${f.y.toFixed(1)}px, 0) translate(-50%, 0.9em)`;
        }
      }
      if (exit.current) {
        show(exit.current, f.exitOn);
        if (f.exitOn) {
          text(exit.current, f.exitText);
          exit.current.style.opacity = String(out);
          exit.current.style.transform = `translate3d(${f.ex.toFixed(1)}px, ${f.ey.toFixed(1)}px, 0) translate(-50%, -100%)`;
        }
      }
      text(speed.current, `${f.speed.toFixed(1)} m/s`);
      text(pace.current, `${f.speed.toFixed(1)} m/s`);
      text(heading.current, f.speed > 0.45 ? `${Math.round(f.heading).toString().padStart(3, "0")}\u00B0` : "\u2014");
      text(eta.current, f.eta >= 0 ? `${f.eta.toFixed(1)} S` : "\u2014");

      // ---- the numbers of this reconstruction
      // (cameras and cut-outs from the clip's manifest; seconds and metres from the fused track)
      const info = demoLook.pathInfo;
      const values = [countedRef.current.cameras, Math.max(info.end - info.start, 0), info.length, countedRef.current.cutouts];
      const counting = easeOut(span(e, BEAT.stats + 0.05, BEAT.stats + 0.75));
      STATS.forEach((st, i) => {
        text(statValues.current[i], (values[i] * counting).toFixed(st.digits));
        text(endValues.current[i], `${values[i].toFixed(st.digits)}${st.unit ? ` ${st.unit.toUpperCase()}` : ""}`);
      });

      if (end.current) {
        const u = span(e, BEAT.end, BEAT.end + 0.45);
        end.current.style.opacity = String(u);
        end.current.style.transform = `scale(${(1.06 - 0.06 * easeOut(u)).toFixed(4)})`;
        end.current.style.visibility = u > 0 ? "visible" : "hidden";
      }

      // ---- tracking bracket
      const b = demoLook.bracket;
      if (bracket.current) {
        bracket.current.style.display = b.on ? "block" : "none";
        if (b.on) {
          const grow = 1 + 0.45 * (1 - b.lock);
          const h = (b.bottom - b.top) * grow;
          const bw = (b.bottom - b.top) * 0.5 * grow;
          bracket.current.style.transform = `translate3d(${(b.x - bw / 2).toFixed(1)}px, ${((b.top + b.bottom - h) / 2).toFixed(1)}px, 0)`;
          bracket.current.style.width = `${bw.toFixed(1)}px`;
          bracket.current.style.height = `${h.toFixed(1)}px`;
          bracket.current.style.opacity = (Math.min(1, b.lock * 1.6) * out).toFixed(3);
          text(bracketText.current, b.text);
          text(bracketSub.current, b.sub);
          if (side.current) {
            const over = b.x + bw / 2 + 12 + side.current.offsetWidth - W * 0.978;
            side.current.style.transform = over > 0 ? `translate3d(${(-over).toFixed(1)}px, 0, 0)` : "";
          }
        }
      }
    };
    sync.current = update;
    // Runs right after the viewport has drawn its frame, in the same animation frame (see DemoOverlay).
    return addAfterEffect(update);
  }, []);
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

  return (
    <div ref={host} className={`absolute inset-0 z-[60] overflow-hidden font-mono select-none ${hint ? "" : "cursor-none"}`} onPointerMove={onMove} onPointerDown={showHint}>
      {live && (
        <>
          <div className="vignette absolute inset-0 opacity-70" />
          <div ref={lines} className="scanlines absolute inset-0" style={{ opacity: 0 }} />
          <div ref={searchDim} className="absolute inset-0 bg-ink-950" style={{ display: "none", opacity: 0 }} />
          <div
            ref={glitch}
            className="absolute -inset-x-6 inset-y-0 mix-blend-screen"
            style={{ display: "none", backgroundImage: "repeating-linear-gradient(180deg, rgba(34,211,238,0) 0 9%, rgba(34,211,238,0.5) 9% 10.5%, rgba(34,211,238,0) 10.5% 23%, rgba(240,253,255,0.55) 23% 23.8%, rgba(34,211,238,0) 23.8% 41%)", backgroundSize: "100% 260%" }}
          />
          <div ref={flash} className="absolute inset-0 bg-cyan-50" style={{ opacity: 0 }} />

          {/* the wipe: 3D view on its left, the recording on its right */}
          <div ref={wipe} className="absolute inset-y-0 left-0 w-0" style={{ display: "none" }}>
            <div className="absolute inset-y-0 -left-px w-[2px] bg-cyan-100 shadow-[0_0_22px_3px_rgba(34,211,238,0.95)]" />
            <div ref={wipeLeft} className="absolute top-[13vh] right-[1.1em] rounded border border-cyan-300 bg-cyan-400/20 px-[0.9em] py-[0.45em] font-semibold tracking-[0.16em] whitespace-nowrap text-cyan-50 shadow-[0_0_18px_-2px_rgba(34,211,238,0.85)]" style={SUB}>
              3D RECONSTRUCTION
            </div>
            <div ref={wipeRight} className="absolute top-[13vh] left-[1.1em] flex items-center gap-[0.6em] rounded border border-ink-500 bg-ink-950/85 px-[0.9em] py-[0.45em] font-semibold tracking-[0.16em] whitespace-nowrap text-slate-200" style={SUB}>
              <span className="rec-dot h-[0.55em] w-[0.55em] rounded-full bg-red-400" />
              REAL FOOTAGE
            </div>
          </div>

          {/* tracking bracket */}
          <div ref={bracket} className="absolute top-0 left-0 border border-cyan-300/70 shadow-[0_0_18px_-4px_rgba(34,211,238,0.9)]" style={{ display: "none" }}>
            <div className="absolute -top-px -left-px h-3 w-3 border-t-2 border-l-2 border-cyan-200" />
            <div className="absolute -top-px -right-px h-3 w-3 border-t-2 border-r-2 border-cyan-200" />
            <div className="absolute -bottom-px -left-px h-3 w-3 border-b-2 border-l-2 border-cyan-200" />
            <div className="absolute -right-px -bottom-px h-3 w-3 border-r-2 border-b-2 border-cyan-200" />
            <div ref={side} className="absolute top-[12%] left-full ml-3 border-l-2 border-cyan-300 bg-ink-950/85 px-[0.8em] py-[0.5em] whitespace-nowrap portrait:hidden" style={SMALL}>
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
              className="absolute top-0 left-0 border-l-2 border-cyan-300 bg-ink-950/85 px-[0.7em] py-[0.35em] tracking-[0.12em] whitespace-nowrap text-cyan-50"
              style={{ ...SMALL, display: "none" }}
            />
          ))}

          {/* forecast: the arrow's reach, the exit */}
          <div ref={ahead} className="absolute top-0 left-0 border-l-2 border-amber-300 bg-ink-950/85 px-[0.7em] py-[0.35em] tracking-[0.12em] whitespace-nowrap text-amber-100" style={{ ...SMALL, display: "none" }} />
          <div
            ref={exit}
            className="absolute top-0 left-0 rounded border border-amber-300 bg-ink-950/90 px-[0.8em] py-[0.4em] font-semibold tracking-[0.12em] whitespace-nowrap text-amber-100 shadow-[0_0_18px_-2px_rgba(255,194,51,0.8)]"
            style={{ ...SMALL, display: "none" }}
          />

          {/* search bar (flies from the middle of the wall to the row above the title) */}
          <div
            ref={searchBar}
            className="absolute top-0 left-1/2 z-10 flex w-[min(90vw,72vh,620px)] origin-top items-center gap-[0.7em] rounded-[0.6em] border border-cyan-300/80 bg-ink-950/90 px-[0.9em] py-[0.62em] shadow-[0_0_40px_-6px_rgba(34,211,238,0.9)]"
            style={{ display: "none", fontSize: "clamp(13px, min(3vh, 4.3vw), 34px)" }}
          >
            <Search className="h-[1em] w-[1em] shrink-0 text-cyan-300" />
            <span className="min-w-0 whitespace-nowrap text-slate-50">
              <span ref={searchText} />
              <span ref={searchCaret} className="ml-[0.08em] inline-block h-[1em] w-[0.5em] translate-y-[0.12em] bg-cyan-300" />
            </span>
            <span ref={searchStatus} className="ml-auto shrink-0 text-[0.58em] font-semibold tracking-[0.12em] whitespace-nowrap text-cyan-300" />
          </div>

          <div className={COLUMN}>
            {/* brand, the camera on screen, the incident clock */}
            <div ref={top} className="absolute inset-x-0 top-0 flex items-center gap-[0.8em] px-[2.2vh] pt-[2vh]" style={SMALL}>
              <div className="flex items-center gap-[0.7em] rounded border border-cyan-400/50 bg-ink-950/80 px-[0.9em] py-[0.45em] whitespace-nowrap text-cyan-50 shadow-[0_0_18px_-6px_rgba(34,211,238,0.9)]">
                <span className="h-[0.6em] w-[0.6em] rotate-45 bg-cyan-300" />
                <span className="font-semibold tracking-[0.28em]">SENTRY4D</span>
              </div>
              {cctv && (
                <div className="flex items-center gap-[0.6em] rounded border border-ink-500 bg-ink-950/80 px-[0.9em] py-[0.45em] tracking-[0.14em] whitespace-nowrap text-slate-200 portrait:hidden">
                  <span className="rec-dot h-[0.55em] w-[0.55em] rounded-full bg-red-400" />
                  CAM 0{securityCameras.findIndex((c) => c.id === cctv) + 1}
                </div>
              )}
              <div className="ml-auto flex items-center gap-[0.8em] rounded border border-ink-500 bg-ink-950/80 px-[0.9em] py-[0.45em] whitespace-nowrap">
                <span ref={time} className="tracking-[0.08em] text-cyan-50 tabular-nums">
                  00:00.00
                </span>
                <span ref={rate} className="text-right tracking-[0.08em] text-cyan-300" />
              </div>
            </div>

            {/* what the system is doing, the title, the chapter rail */}
            <div ref={bottom} className="absolute inset-x-0 bottom-0 px-[2.2vh] pb-[2.2vh]">
              <div className="absolute -inset-x-[100vw] bottom-0 h-[34vh] bg-gradient-to-t from-ink-950/95 via-ink-950/60 to-transparent" />
              <div ref={caption} className="relative flex flex-col items-center text-center">
                <div ref={slot} className="flex min-h-[3em] items-end justify-center gap-[0.55em] pb-[0.4em]" style={SMALL}>
                  {kicker === "seen" && (
                    <>
                      <span className="mr-[0.2em] tracking-[0.2em] text-slate-300">SEEN BY</span>
                      {securityCameras.slice(0, 4).map((c, i) => (
                        <span key={c.id} className={chip(observers.split(" ").includes(c.id))}>
                          CAM 0{i + 1}
                        </span>
                      ))}
                      <span ref={speed} className="ml-[0.3em] min-w-[4.6em] text-left tracking-[0.08em] text-cyan-200 tabular-nums portrait:hidden" />
                    </>
                  )}
                  {kicker === "looks" &&
                    FREEZE_LOOKS.map((l) => (
                      <span key={l.name} className={chip(l.name === look)}>
                        {l.label}
                      </span>
                    ))}
                  {kicker === "forecast" && (
                    <div className="flex items-center gap-[1.4em] rounded border border-amber-300/70 bg-ink-950/85 px-[1em] py-[0.45em] tracking-[0.12em] whitespace-nowrap text-slate-300">
                      <span>
                        HEADING <span ref={heading} className="font-semibold text-amber-200" />
                      </span>
                      <span>
                        SPEED <span ref={pace} className="font-semibold text-amber-200 tabular-nums" />
                      </span>
                      <span>
                        EXIT IN <span ref={eta} className="font-semibold text-amber-200 tabular-nums" />
                      </span>
                    </div>
                  )}
                </div>
                {chapter === STATS_CHAPTER ? (
                  <div key="stats" ref={title} className="mt-[1vh] grid w-full origin-bottom grid-cols-4 gap-[1vh]">
                    {STATS.map((st, i) => (
                      <div key={st.label} className="rounded border border-cyan-400/40 bg-ink-950/80 px-[0.4em] py-[1.1vh] shadow-[0_0_22px_-8px_rgba(34,211,238,0.9)]">
                        <div className="leading-none font-semibold text-slate-50 tabular-nums" style={STAT}>
                          <span
                            ref={(el) => {
                              statValues.current[i] = el;
                            }}
                          />
                          {st.unit && <span className="ml-[0.12em] text-[0.5em] text-cyan-300">{st.unit}</span>}
                        </div>
                        <div className="mt-[0.9vh] tracking-[0.1em] text-cyan-200/90" style={{ fontSize: "clamp(7px, min(1.25vh, 2.1vw), 13px)" }}>
                          {st.label}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div ref={title} key={chapter} className="mt-[0.6vh] origin-bottom leading-[1.08] font-bold tracking-[0.03em] whitespace-nowrap text-slate-50" style={TITLE}>
                    {current?.title.map((line, i) =>
                      i === current.title.length - 1 && current.title.length > 1 ? (
                        <div key={i} ref={accent} className="origin-center text-cyan-300">
                          {line}
                        </div>
                      ) : (
                        <div key={i}>{line}</div>
                      ),
                    )}
                  </div>
                )}
                <div className="mt-[1vh] max-w-full tracking-[0.14em] text-cyan-100/90 uppercase" style={SUB}>
                  {chapter === STATS_CHAPTER ? "The whole incident in one frame \u00B7 measured on this clip" : current?.sub}
                </div>
              </div>
              <div className="relative mt-[1.6vh] flex gap-[0.5vh]">
                {CHAPTERS.map((c, i) => (
                  <div key={c.rail} className="h-[3px] min-w-0 flex-1 overflow-hidden rounded-full bg-slate-500/30">
                    <div
                      ref={(el) => {
                        fills.current[i] = el;
                      }}
                      className="h-full origin-left bg-cyan-300"
                      style={{ transform: "scaleX(0)" }}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* end card */}
          <div ref={end} className="absolute inset-0 bg-ink-950/78" style={{ opacity: 0, visibility: "hidden" }}>
            <div className={`${COLUMN} flex flex-col items-center justify-center px-[2.2vh] text-center`}>
              <div className="pl-[0.16em] font-semibold tracking-[0.16em] whitespace-nowrap text-slate-50" style={{ fontSize: "clamp(30px, min(10.5vh, 13.5vw), 132px)", textShadow: "0 0 60px rgba(34,211,238,0.55)" }}>
                SENTRY<span className="text-cyan-300">4D</span>
              </div>
              <div className="mt-[1.4vh] h-px w-[86%] bg-gradient-to-r from-transparent via-cyan-300 to-transparent" />
              <div className="mt-[2.6vh] font-bold tracking-[0.1em] whitespace-nowrap text-slate-50" style={{ fontSize: "clamp(16px, min(4.6vh, 6.2vw), 56px)" }}>
                CCTV IN. <span className="text-cyan-300">4D OUT.</span>
              </div>
              <div className="mt-[3vh] grid w-full grid-cols-4 gap-[1vh]">
                {STATS.map((st, i) => (
                  <div key={st.short} className="border-t border-cyan-400/40 pt-[1.2vh]">
                    <div className="font-semibold whitespace-nowrap text-slate-50 tabular-nums" style={{ fontSize: "clamp(12px, min(2.9vh, 3.9vw), 34px)" }}>
                      <span
                        ref={(el) => {
                          endValues.current[i] = el;
                        }}
                      />
                    </div>
                    <div className="mt-[0.6vh] tracking-[0.14em] text-slate-400" style={{ fontSize: "clamp(7px, min(1.25vh, 2.1vw), 13px)" }}>
                      {st.short}
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-[3.4vh] rounded border border-cyan-300 bg-cyan-400/15 px-[1.2em] py-[0.6em] font-semibold tracking-[0.16em] whitespace-nowrap text-cyan-50 shadow-[0_0_24px_-4px_rgba(34,211,238,0.9)]" style={{ fontSize: "clamp(11px, min(2.3vh, 3.4vw), 28px)" }}>
                SENTRY4D.VERCEL.APP
              </div>
              <div className="mt-[1.8vh] tracking-[0.16em] text-slate-400" style={SMALL}>
                RECONSTRUCTED FROM THE FOOTAGE {"\u00B7"} NOT GENERATED
              </div>
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
          <div className="mt-[1.6vh] pl-[0.2em] tracking-[0.2em] text-slate-400" style={SMALL}>
            LOADING RECONSTRUCTION {percent}%
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={stop}
        title="Exit the demo (Esc)"
        className={`absolute top-[2vh] left-1/2 flex -translate-x-1/2 items-center gap-2 rounded border border-ink-500 bg-ink-950/90 px-3 py-1.5 text-[11px] tracking-[0.14em] text-slate-300 transition-opacity duration-200 hover:border-slate-400 hover:text-white ${
          hint ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        <X className="h-3.5 w-3.5" /> EXIT DEMO <span className="text-slate-500">ESC</span>
      </button>
    </div>
  );
}
