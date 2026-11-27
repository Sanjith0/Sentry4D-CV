import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { addAfterEffect } from "@react-three/fiber";
import { Check, Search, X } from "lucide-react";
import { formatClock } from "../../lib/format";
import { demoLook } from "./demoLook";
import { useLabelObstacle } from "./labelFit";
import { BEAT, chapterAt, CHAPTERS, END_LINES, flashAt, glitchAt, incidentTime, rateAt, scanLinesAt, SEARCH, WALL_RESERVE, wipeAt, wipeLineAt, wipeShown } from "./demo2Script";
import { easeInOut, easeOut, lerp, span } from "./demoScript";
import { useDemoStore } from "./useDemoStore";

/** The search bar's size once it has taken its place between the wall and the caption (1 = as typed). */
const SEARCH_REST = 0.78;
/** Share of the picture's height above the wall of recordings (DemoWall's own margin). */
const WALL_TOP = 0.08;
/** Sizes follow the window's height; its width only caps them in a narrow (portrait) window. */
const LABEL = { fontSize: "clamp(10px, min(1.7vh, 2.9vw), 28px)" };
const CAPTION = { fontSize: "clamp(20px, min(5.6vh, 6.6vw), 104px)", textShadow: "0 1px 2px rgba(2,6,12,0.5), 0 0.06em 0.7em rgba(2,6,12,0.75)" };
/** A caption's line rises this far (em) while it fades in, over this long (s); its second line this much later. */
const RISE = 0.34;
const CAPTION_IN = 0.34;
const CAPTION_STAGGER = 0.09;
/** A caption is on its way out from this long before the next one, and gone this long before it (s). */
const CAPTION_OUT = [0.22, 0.04] as const;
/**
 * Everything that has to be read sits in this column in the middle of the picture: a 4:5 crop of a 16:9
 * recording (a feed post) keeps all of it.
 */
const COLUMN = "absolute inset-y-0 left-1/2 w-[min(100vw,80vh)] -translate-x-1/2";
/** A small label on the picture: what a thing is, in two or three words. */
const PILL = "flex items-center gap-[0.6em] rounded-full bg-ink-950/75 px-[1em] py-[0.62em] leading-none font-semibold tracking-[0.14em] whitespace-nowrap text-slate-50";
const DOT = "h-[0.5em] w-[0.5em] shrink-0 rounded-full";
/** The replay's pace as a sign: rewinding, playing, running fast. */
const PACE_ICONS = ["M11 5.5v13L2.5 12zM21.5 5.5v13L13 12z", "M7 4.5v15L19.5 12z", "M2.5 5.5v13L11 12zM13 5.5v13L21.5 12z"];
/** The tracking bracket: four corner ticks. */
const TICK = "absolute h-[3vh] w-[3vh] border-cyan-200";
const TICK_WIDTH = "max(2px, 0.28vh)";

/** Past its end and back (a check mark that pops in). */
const backOut = (t: number) => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2);

/**
 * DEMO 2's overlay: one caption per beat in plain words (inside the 4:5-safe column), the brand and the
 * incident's clock, the search bar, the wipe between recording and 3D view with a label on either side, the
 * tracking bracket, the label on the exit and the end card. Nothing else is written on the picture: what the
 * system does is shown by the picture itself. Everything that moves is written straight to the elements from
 * the demo clock, so a stepped recording and a live run look the same.
 */
export function Demo2Overlay() {
  const phase = useDemoStore((s) => s.phase);
  const stop = useDemoStore((s) => s.stop);
  const percent = useDemoStore((s) => Math.round(s.progress * 100));
  const [hint, setHint] = useState(false);
  const hintTimer = useRef(0);

  const host = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const time = useRef<HTMLSpanElement>(null);
  const rate = useRef<HTMLSpanElement>(null);
  const paceIcons = useRef<(SVGPathElement | null)[]>([]);
  const caption = useRef<HTMLDivElement>(null);
  const captionLines = useRef<(HTMLDivElement | null)[]>([]);
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
  const searchBusy = useRef<HTMLSpanElement>(null);
  const searchDone = useRef<HTMLSpanElement>(null);
  const exit = useRef<HTMLDivElement>(null);
  const exitText = useRef<HTMLSpanElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const endParts = useRef<(HTMLDivElement | null)[]>([]);
  const bracket = useRef<HTMLDivElement>(null);
  useLabelObstacle(bracket);
  useLabelObstacle(caption);
  useLabelObstacle(exit);
  /** Writes the demo clock's state to the elements above. */
  const sync = useRef<() => void>(() => {});

  useEffect(() => {
    const text = (el: Element | null, v: string) => {
      if (el && el.textContent !== v) el.textContent = v;
    };
    const show = (el: HTMLElement | SVGElement | null, on: boolean) => {
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

      // ---- the incident's clock and the replay's pace (a figure only where it is not real time)
      text(time.current, formatClock(T));
      const pace = rateAt(e);
      const sign = pace < 0 ? 0 : pace > 1.05 ? 2 : 1;
      paceIcons.current.forEach((el, i) => show(el, i === sign));
      text(rate.current, pace < 0 || Math.abs(pace - 1) < 0.05 ? "" : `${pace.toFixed(1)}\u00D7`);
      if (top.current) top.current.style.opacity = String(out);
      if (bottom.current) bottom.current.style.opacity = String(out);

      // ---- caption: its two lines rise in one after the other, and are gone just before the next beat
      // (the first one is there from the first frame)
      if (caption.current) {
        show(caption.current, ch >= 0);
        if (ch >= 0) {
          const c = CHAPTERS[ch];
          const next = ch + 1 < CHAPTERS.length ? CHAPTERS[ch + 1].at : BEAT.end;
          const leave = 1 - span(e, next - CAPTION_OUT[0], next - CAPTION_OUT[1]);
          captionLines.current.forEach((el, i) => {
            if (!el) return;
            text(el, c.lines[i]);
            const from = c.at + (c.delay ?? 0) + 0.02 + i * CAPTION_STAGGER;
            const u = ch === 0 ? 1 : easeOut(span(e, from, from + CAPTION_IN));
            el.style.opacity = (u * leave).toFixed(3);
            el.style.transform = `translate3d(0, ${((1 - u) * RISE).toFixed(3)}em, 0)`;
          });
        }
      }

      // ---- search bar: typed over the middle of the wall, then it takes its place between the wall and the caption
      if (searchBar.current && searchDim.current) {
        const on = e >= BEAT.wall && e < BEAT.reveal + 0.2;
        show(searchBar.current, on);
        show(searchDim.current, on);
        if (on) {
          const alpha = span(e, BEAT.wall + 0.05, BEAT.wall + 0.25) * (1 - span(e, BEAT.reveal - 0.1, BEAT.reveal + 0.2));
          const m = easeInOut(span(e, SEARCH.scan[0] - 0.05, SEARCH.scan[0] + 0.4));
          const h = searchBar.current.offsetHeight;
          const hostTop = host.current?.getBoundingClientRect().top ?? 0;
          const captionTop = caption.current ? caption.current.getBoundingClientRect().top - hostTop : H * 0.83;
          const wallBottom = H * (1 - WALL_RESERVE);
          const scale = lerp(1, SEARCH_REST, m);
          const y = lerp((H * WALL_TOP + wallBottom) / 2 - h / 2, (wallBottom + captionTop) / 2 - (h * SEARCH_REST) / 2, m);
          searchBar.current.style.opacity = alpha.toFixed(3);
          searchBar.current.style.transform = `translate3d(-50%, ${y.toFixed(1)}px, 0) scale(${scale.toFixed(4)})`;
          searchDim.current.style.opacity = (0.5 * alpha * (1 - m)).toFixed(3);
          const typed = Math.round(SEARCH.query.length * span(e, SEARCH.type[0], SEARCH.type[1]));
          text(searchText.current, SEARCH.query.slice(0, typed));
          if (searchCaret.current) searchCaret.current.style.opacity = e < SEARCH.scan[0] && (typed < SEARCH.query.length ? typed > 0 || Math.floor(e * 4) % 2 === 0 : Math.floor(e * 6) % 2 === 0) ? "1" : "0";
          // busy while the sweep crosses the feeds; a check once his cut-outs light up
          if (searchBusy.current) {
            searchBusy.current.style.opacity = e >= SEARCH.scan[0] && e < BEAT.lock ? "1" : "0";
            searchBusy.current.style.transform = `rotate(${((e * 600) % 360).toFixed(1)}deg)`;
          }
          if (searchDone.current) {
            const u = span(e, BEAT.lock, BEAT.lock + 0.3);
            searchDone.current.style.opacity = Math.min(1, u * 3).toFixed(3);
            searchDone.current.style.transform = `scale(${(0.4 + 0.6 * backOut(u)).toFixed(3)})`;
          }
        }
      }

      // ---- the wipe between the recording and the 3D view
      const w = wipeAt(e);
      if (wipe.current) {
        const on = wipeShown(e);
        show(wipe.current, on);
        if (on) {
          wipe.current.style.transform = `translate3d(${(w * W).toFixed(1)}px, 0, 0)`;
          wipe.current.style.opacity = wipeLineAt(e).toFixed(3);
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

      // ---- the exit the forecast points at: its name and the time to it, over its pin
      const f = demoLook.forecast;
      if (exit.current) {
        const on = f.exitOn && f.exitAlpha > 0.02;
        show(exit.current, on);
        if (on) {
          text(exitText.current, f.exitText);
          exit.current.style.opacity = (Math.min(1, f.exitAlpha * 1.4) * out).toFixed(3);
          exit.current.style.transform = `translate3d(${f.ex.toFixed(1)}px, ${f.ey.toFixed(1)}px, 0) translate(-50%, -100%)`;
        }
      }

      // ---- end card: the name, what it does, where to find it, one after the other
      if (end.current) {
        const u = span(e, BEAT.end, BEAT.end + 0.45);
        end.current.style.opacity = String(u);
        end.current.style.visibility = u > 0 ? "visible" : "hidden";
        endParts.current.forEach((el, i) => {
          if (!el) return;
          const from = BEAT.end + 0.1 + i * 0.1;
          const v = easeOut(span(e, from, from + 0.4));
          el.style.opacity = v.toFixed(3);
          el.style.transform = `translate3d(0, ${((1 - v) * 1.6).toFixed(3)}vh, 0)`;
        });
      }

      // ---- tracking bracket: four ticks that close in on him
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

  return (
    <div ref={host} className={`absolute inset-0 z-[60] overflow-hidden font-demo select-none ${hint ? "" : "cursor-none"}`} onPointerMove={onMove} onPointerDown={showHint}>
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

          {/* the wipe: 3D view on its left, the recording on its right, each under its name */}
          <div ref={wipe} className="absolute inset-y-0 left-0 w-0" style={{ display: "none" }}>
            <div className="absolute inset-y-0 -left-px w-[2px] bg-cyan-100 shadow-[0_0_22px_3px_rgba(34,211,238,0.95)]" />
            <div ref={wipeLeft} className={`absolute top-[13vh] right-[1.2em] ${PILL}`} style={LABEL}>
              <span className={`${DOT} bg-cyan-300`} />
              3D RECONSTRUCTION
            </div>
            <div ref={wipeRight} className={`absolute top-[13vh] left-[1.2em] ${PILL}`} style={LABEL}>
              <span className={`${DOT} bg-red-400`} />
              REAL FOOTAGE
            </div>
          </div>

          {/* tracking bracket */}
          <div ref={bracket} className="absolute top-0 left-0" style={{ display: "none", filter: "drop-shadow(0 0 0.5vh rgba(2,6,12,0.6))" }}>
            <div className={`${TICK} top-0 left-0`} style={{ borderTopWidth: TICK_WIDTH, borderLeftWidth: TICK_WIDTH }} />
            <div className={`${TICK} top-0 right-0`} style={{ borderTopWidth: TICK_WIDTH, borderRightWidth: TICK_WIDTH }} />
            <div className={`${TICK} bottom-0 left-0`} style={{ borderBottomWidth: TICK_WIDTH, borderLeftWidth: TICK_WIDTH }} />
            <div className={`${TICK} right-0 bottom-0`} style={{ borderRightWidth: TICK_WIDTH, borderBottomWidth: TICK_WIDTH }} />
          </div>

          {/* the exit the forecast points at */}
          <div ref={exit} className={`absolute top-0 left-0 ${PILL}`} style={{ ...LABEL, display: "none" }}>
            <span className={`${DOT} bg-amber-300`} />
            <span ref={exitText} className="text-amber-50 tabular-nums" />
          </div>

          {/* search bar (flies from the middle of the wall to its place over the caption) */}
          <div
            ref={searchBar}
            className="absolute top-0 left-1/2 z-10 flex w-[min(88vw,70vh)] origin-top items-center gap-[0.7em] rounded-full border border-white/15 bg-ink-950/85 px-[1.1em] py-[0.62em] shadow-[0_0.6em_2em_rgba(2,6,12,0.6),0_0_0_1px_rgba(34,211,238,0.14)]"
            style={{ display: "none", fontSize: "clamp(13px, min(3vh, 4.3vw), 60px)" }}
          >
            <Search className="h-[1em] w-[1em] shrink-0 text-slate-400" />
            <span className="min-w-0 font-medium whitespace-nowrap text-slate-50">
              <span ref={searchText} />
              <span ref={searchCaret} className="ml-[0.08em] inline-block h-[1.05em] w-[2px] translate-y-[0.18em] bg-cyan-300" />
            </span>
            <span className="relative ml-auto h-[1em] w-[1em] shrink-0">
              <span ref={searchBusy} className="absolute inset-[0.06em] rounded-full border-[0.11em] border-cyan-300/25 border-t-cyan-300" style={{ opacity: 0 }} />
              <span ref={searchDone} className="absolute inset-0 flex items-center justify-center text-cyan-300" style={{ opacity: 0 }}>
                <Check className="h-[1em] w-[1em]" strokeWidth={2.8} />
              </span>
            </span>
          </div>

          <div className={COLUMN}>
            {/* the brand; the incident's clock and the replay's pace */}
            <div ref={top} className="absolute inset-x-0 top-0 px-[2.2vh] pt-[2.4vh]">
              <div className="absolute -inset-x-[100vw] top-0 h-[12vh] bg-gradient-to-b from-ink-950/70 to-transparent" />
              <div className="relative flex items-center leading-none font-semibold whitespace-nowrap text-slate-50" style={{ ...LABEL, textShadow: "0 1px 3px rgba(2,6,12,0.7)" }}>
                <span className="mr-[0.7em] h-[0.62em] w-[0.62em] rotate-45 bg-cyan-300" />
                <span className="tracking-[0.24em]">SENTRY4D</span>
                <svg viewBox="0 0 24 24" className="ml-auto h-[1.05em] w-[1.05em] fill-cyan-300">
                  {PACE_ICONS.map((d, i) => (
                    <path
                      key={d}
                      d={d}
                      ref={(el) => {
                        paceIcons.current[i] = el;
                      }}
                      style={{ display: i === 1 ? undefined : "none" }}
                    />
                  ))}
                </svg>
                <span ref={rate} className="ml-[0.35em] tracking-[0.04em] text-cyan-300 tabular-nums" />
                <span ref={time} className="ml-[0.9em] tracking-[0.06em] tabular-nums" />
              </div>
            </div>

            {/* the caption: what the picture shows, in plain words */}
            <div ref={bottom} className="absolute inset-x-0 bottom-0 px-[2.2vh] pb-[4.6vh]">
              <div
                className="absolute -inset-x-[100vw] bottom-0 h-[30vh]"
                style={{ background: "linear-gradient(to top, rgba(4,7,12,0.9) 0%, rgba(4,7,12,0.66) 36%, rgba(4,7,12,0.26) 70%, rgba(4,7,12,0) 100%)" }}
              />
              <div ref={caption} className="relative text-center leading-[1.12] font-semibold tracking-[-0.022em] whitespace-nowrap" style={CAPTION}>
                {["text-white", "text-cyan-300"].map((tone, i) => (
                  <div
                    key={tone}
                    ref={(el) => {
                      captionLines.current[i] = el;
                    }}
                    className={tone}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* end card */}
          <div ref={end} className="absolute inset-0 bg-ink-950/85" style={{ opacity: 0, visibility: "hidden" }}>
            <div className={`${COLUMN} flex flex-col items-center justify-center px-[2.2vh] text-center whitespace-nowrap`}>
              <div
                ref={(el) => {
                  endParts.current[0] = el;
                }}
                className="pl-[0.22em] leading-none font-semibold tracking-[0.22em] text-white"
                style={{ fontSize: "clamp(24px, min(8vh, 10vw), 150px)" }}
              >
                SENTRY<span className="text-cyan-300">4D</span>
              </div>
              <div className="mt-[3.2vh] leading-[1.14] font-semibold tracking-[-0.022em]" style={{ fontSize: "clamp(17px, min(4.6vh, 6.2vw), 86px)" }}>
                {["text-white", "text-cyan-300"].map((tone, i) => (
                  <div
                    key={tone}
                    ref={(el) => {
                      endParts.current[1 + i] = el;
                    }}
                    className={tone}
                  >
                    {END_LINES[i]}
                  </div>
                ))}
              </div>
              <div
                ref={(el) => {
                  endParts.current[3] = el;
                }}
                className="mt-[4.4vh] rounded-full border border-white/25 px-[1.3em] py-[0.62em] leading-none font-medium tracking-[0.01em] text-slate-50"
                style={{ fontSize: "clamp(12px, min(2.5vh, 3.7vw), 46px)" }}
              >
                sentry4d.vercel.app
              </div>
              <div
                ref={(el) => {
                  endParts.current[4] = el;
                }}
                className="mt-[2.4vh] font-medium tracking-[0.01em] text-slate-400"
                style={{ fontSize: "clamp(10px, min(1.8vh, 3vw), 32px)" }}
              >
                Reconstructed from real footage {"\u00B7"} not generated
              </div>
            </div>
          </div>
        </>
      )}

      {phase === "preparing" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-ink-950">
          <div className="pl-[0.22em] leading-none font-semibold tracking-[0.22em] text-white" style={{ fontSize: "clamp(18px, 3.8vh, 54px)" }}>
            SENTRY<span className="text-cyan-300">4D</span>
          </div>
          <div className="mt-[2.8vh] h-[2px] w-[min(40vw,380px)] overflow-hidden rounded-full bg-white/10">
            <div className="h-full bg-cyan-300 transition-[width] duration-200" style={{ width: `${percent}%` }} />
          </div>
          <div className="mt-[2vh] font-medium text-slate-400 tabular-nums" style={LABEL}>
            Loading the reconstruction {"\u00B7"} {percent}%
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={stop}
        title="Exit the demo (Esc)"
        className={`absolute top-[2vh] left-1/2 flex -translate-x-1/2 items-center gap-2 rounded border border-ink-500 bg-ink-950/90 px-3 py-1.5 font-mono text-[11px] tracking-[0.14em] text-slate-300 transition-opacity duration-200 hover:border-slate-400 hover:text-white ${
          hint ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        <X className="h-3.5 w-3.5" /> EXIT DEMO <span className="text-slate-500">ESC</span>
      </button>
    </div>
  );
}
