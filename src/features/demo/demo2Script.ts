import type { CameraId, Vec3 } from "../../types/security";
import {
  CAMERA_ORDER,
  clamp01,
  easeInOut,
  easeOut,
  fit,
  lerp,
  lerp3,
  pchip,
  pchip3,
  smooth,
  span,
  sub,
  throughCamera,
  unwrap,
  viewAxes,
  type BuildState,
  type DemoCam,
  type DemoContext,
  type DemoLookName,
  type LookState,
  type PathState,
  type WallState,
} from "./demoScript";

/**
 * DEMO 2: a second cut of the walkthrough, as data (see demoScript.ts for how a script is played). No title
 * card: it starts on the recordings and every beat is something the system does with them:
 *
 *   0.0  SEARCH     the wall of the four recordings; a query is typed, a sweep crosses every feed
 *   2.1  LOCK       his SAM 2.1 cut-out lights up in every feed
 *   3.4  REVEAL     push into CAM 01; a wipe crosses the picture: recording on one side, 3D view on the other
 *   5.7  TWIN       the viewport rises out of CAM 01 to the whole room seen from outside (only the room: what
 *                   the scan caught beyond its walls is left out) while it melts to its LiDAR wireframe; he
 *                   fades out, time rewinds, the four cameras' coverage unfolds, the texture comes back
 *   8.1  TRACK      replay from his entry (1.8x) in a tracking shot along the room: his path grows behind
 *                   him, a sight line from every camera that sees him at that moment, a forecast arrow ahead;
 *                   beside it the recording of the camera that sees him best, in step, handed on from camera
 *                   to camera
 *  12.8  DWELL      the seconds he stands at the table run through fast, counted; the camera comes down to him
 *  13.95 FREE CAM   half speed: round him from CAM 04's line of sight to CAM 01's as he lifts the chair and
 *                   turns (3D model, X-ray in the wireframe room, 3D + footage)
 *  18.35 PREDICT    he walks off; the camera swings out over the window wall to a view that holds him and the
 *                   door and closes in as he nears it: forecast arrow, the predicted route, the exit and the
 *                   time to it, from the fused track's position and velocity
 *  21.2  TIMELINE   the room turns to its wireframe and the camera comes round beside the track: his body at
 *                   five earlier moments stands along it, each with its time, he himself walks on among them
 *                   (white, "NOW"), under the numbers of this reconstruction
 *  23.8  END CARD
 */
export const DEMO_DURATION = 25.0;

export const BEAT = {
  wall: 0,
  lock: 2.1,
  reveal: 3.4,
  twin: 5.7,
  track: 8.1,
  free: 13.95,
  predict: 18.35,
  stats: 21.2,
  end: 23.8,
} as const;

// ---------------------------------------------------------------- incident time

/** Incident time when the wall comes up: he stands at the table with the chair, in sight of all four cameras. */
export const DEMO_START_TIME = 16.6;
/** Demo time applied behind the loading card while the recordings are brought to DEMO_START_TIME. */
export const PREP_E = BEAT.wall;
/** The wipe across CAM 01's picture. */
const WIPE = [BEAT.reveal + 0.7, BEAT.reveal + 1.9] as const;
/**
 * Behind the wipe's line the room's wireframe shows over the 3D view, faintly: from the line back to where the
 * line was WIRE_WAKE seconds ago, at most WIRE_BAND of the picture's width, strongest at the line.
 */
const WIRE_WAKE = 0.4;
const WIRE_BAND = 0.3;
const WIRE_STRENGTH = 0.13;
/** It leaves with the line once the wipe is through. */
const WIRE_OUT = [WIPE[1], WIPE[1] + 0.35] as const;
/** From the twin beat he walks on in slow motion until he has faded out; then time rewinds. */
const TWIN_TIME = DEMO_START_TIME + (BEAT.twin - BEAT.wall);
const TWIN_RATE = 0.5;
const TWIN_EASE = 0.5;
const SUBJECT_OUT = [BEAT.twin + 1.1, BEAT.twin + 1.5] as const;
const REWIND_FROM = SUBJECT_OUT[1];
/** Incident time from the twin beat on (rate 1 eased down to TWIN_RATE over TWIN_EASE seconds: its integral). */
function twinTime(e: number): number {
  const x = Math.max(e - BEAT.twin, 0);
  const u = Math.min(x / TWIN_EASE, 1);
  return TWIN_TIME + x - (1 - TWIN_RATE) * (TWIN_EASE * (u * u * u - (u * u * u * u) / 2) + Math.max(x - TWIN_EASE, 0));
}
const HELD_TIME = twinTime(REWIND_FROM);
/** Just before any camera has seen him. */
const REWOUND_TIME = 4.0;
/** The walk in, replayed at WALK_RATE up to where he slows at the table. */
const WALK_RATE = 1.8;
const WALK_END_TIME = 12.4;
const WALK_END = BEAT.track + (WALK_END_TIME - REWOUND_TIME) / WALK_RATE;
/** Free camera: from here (standing at the table, the chair in his hands), at FREE_RATE. */
export const FREEZE_TIME = 18.0;
const FREE_RATE = 0.5;
/** From the predict beat the pace eases up to END_RATE. */
const PREDICT_TIME = FREEZE_TIME + FREE_RATE * (BEAT.predict - BEAT.free);
const END_RATE = 0.58;
const END_EASE = 0.8;
/** In the timeline he slows once more (to TIMELINE_RATE), so he stays in the gap between two of his earlier selves. */
const TIMELINE_RATE = 0.3;
const TIMELINE_SLOW = BEAT.stats + 0.9;
/** Integral of smoothstep over x seconds of an ease of END_EASE seconds, then 1 per second. */
const eased = (x: number) => {
  const u = clamp01(x / END_EASE);
  return x <= 0 ? 0 : END_EASE * (u * u * u - (u * u * u * u) / 2) + Math.max(x - END_EASE, 0);
};

/** Incident time and rate through the dwell (cubic Hermite, the neighbours' rates at both ends). */
function dwellAt(e: number): { t: number; rate: number } {
  const L = BEAT.free - WALK_END;
  const u = clamp01((e - WALK_END) / L);
  const u2 = u * u;
  const u3 = u2 * u;
  const dp = FREEZE_TIME - WALK_END_TIME;
  const t = WALK_END_TIME + (u3 - 2 * u2 + u) * L * WALK_RATE + (-2 * u3 + 3 * u2) * dp + (u3 - u2) * L * FREE_RATE;
  const rate = (3 * u2 - 4 * u + 1) * WALK_RATE + ((-6 * u2 + 6 * u) * dp) / L + (3 * u2 - 2 * u) * FREE_RATE;
  return { t, rate };
}
const endRate = (e: number) =>
  lerp(FREE_RATE, END_RATE, smooth(span(e, BEAT.predict, BEAT.predict + END_EASE))) +
  (TIMELINE_RATE - END_RATE) * smooth(span(e, TIMELINE_SLOW, TIMELINE_SLOW + END_EASE));

/** While true the recordings are on screen and play by themselves: the wall, and the feed beside the tracking shot. */
export const videosLive = (e: number) => e < BEAT.twin || (e >= BEAT.track && e < WALK_END);
export const videoRate = (e: number) => (e >= BEAT.track ? WALK_RATE : 1);

/** Master (incident) time shown at demo time e. */
export function incidentTime(e: number): number {
  if (e < BEAT.twin) return DEMO_START_TIME + Math.max(e - BEAT.wall, 0);
  if (e < REWIND_FROM) return twinTime(e);
  if (e < BEAT.track) return lerp(HELD_TIME, REWOUND_TIME, easeInOut(span(e, REWIND_FROM, BEAT.track)));
  if (e < WALK_END) return REWOUND_TIME + WALK_RATE * (e - BEAT.track);
  if (e < BEAT.free) return dwellAt(e).t;
  if (e < BEAT.predict) return FREEZE_TIME + FREE_RATE * (e - BEAT.free);
  const x = e - BEAT.predict;
  return PREDICT_TIME + FREE_RATE * x + (END_RATE - FREE_RATE) * eased(x) + (TIMELINE_RATE - END_RATE) * eased(e - TIMELINE_SLOW);
}

/** Footage frames the walkthrough draws (loaded and kept before the clock starts). */
export function frameWanted(masterTime: number): boolean {
  return masterTime >= WALK_END_TIME - 0.3 && masterTime <= incidentTime(DEMO_DURATION) + 0.3;
}

export function rateLabel(e: number): string {
  const slow = (r: number) => `\u25B6 ${r.toFixed(1)}\u00D7 SLOW-MO`;
  if (e < BEAT.twin) return "\u25B6 1.0\u00D7";
  if (e < REWIND_FROM) return slow(1 - (1 - TWIN_RATE) * smooth(span(e, BEAT.twin, BEAT.twin + TWIN_EASE)));
  if (e < BEAT.track) return "\u25C0\u25C0 REWIND";
  if (e < WALK_END) return `\u25B6\u25B6 ${WALK_RATE.toFixed(1)}\u00D7`;
  if (e < BEAT.free) return `\u25B6\u25B6 ${dwellAt(e).rate.toFixed(1)}\u00D7`;
  if (e < BEAT.predict) return slow(FREE_RATE);
  return slow(endRate(e));
}

// ---------------------------------------------------------------- room build

const ALL = 1e6;
const NONE = -1e6;
const WIRE_DIM = 0.5;
/** ...and under the timeline's bodies. */
const TIMELINE_DIM = 0.3;
/** The texture is back (rising behind the replay's first steps) over this span. */
const RISE = [BEAT.track - 0.5, BEAT.track + 0.8] as const;
/** The timeline: the camera's way back out to the whole room, and the room's texture dissolving on the way. */
const TIMELINE = { cam: [BEAT.stats - 0.2, BEAT.stats + 1.0], wire: [BEAT.stats + 0.1, BEAT.stats + 0.7] } as const;
/** Free camera: the room is wireframe under the X-ray look. */
const XRAY = { in: [BEAT.free + 0.95, BEAT.free + 1.5], out: [BEAT.free + 2.6, BEAT.free + 3.2] } as const;

export function buildAt(e: number, floorY: number, topY: number): BuildState {
  const y0 = floorY - 0.16;
  const y1 = topY + 0.3;
  const minY = floorY - 0.12;
  const at = (texY: number, wireY: number, wireMode: number, gain = 1): BuildState => ({ texY, wireY, wireMode, minY, gain, grid: 1, lead: 0 });
  if (e < BEAT.twin) return { ...at(ALL, ALL, 0), sweep: wireWakeAt(e) };
  // the texture dissolves from the ceiling down as the viewport leaves CAM 01: the LiDAR wireframe is left
  if (e < RISE[0]) return at(e < BEAT.twin + 1.2 ? lerp(y1, y0, easeInOut(span(e, BEAT.twin, BEAT.twin + 1.2))) : NONE, ALL, 1, WIRE_DIM);
  if (e < RISE[1]) return at(lerp(y0, y1, easeInOut(span(e, RISE[0], RISE[1]))), ALL, 0, WIRE_DIM);
  if (e < XRAY.in[0]) return at(ALL, ALL, 0);
  if (e < XRAY.in[1]) return at(lerp(y1, y0, easeInOut(span(e, XRAY.in[0], XRAY.in[1]))), ALL, 1, WIRE_DIM);
  if (e < XRAY.out[0]) return at(NONE, ALL, 1, WIRE_DIM);
  if (e < XRAY.out[1]) return at(lerp(y0, y1, easeInOut(span(e, XRAY.out[0], XRAY.out[1]))), ALL, 0, WIRE_DIM);
  if (e < TIMELINE.wire[0]) return at(ALL, ALL, 0);
  // the timeline: the wireframe twin again, under his body at moments along the track
  return at(e < TIMELINE.wire[1] ? lerp(y1, y0, easeInOut(span(e, TIMELINE.wire[0], TIMELINE.wire[1]))) : NONE, ALL, 1, lerp(WIRE_DIM, TIMELINE_DIM, span(e, TIMELINE.wire[0], TIMELINE.wire[1])));
}

/** The ceiling is drawn while the viewport is inside CAM 01; never after. */
export const ceilingShown = (e: number, _cutY: number, _wireY: number) => e < BEAT.twin;
/** The scanned window frames stand between the outside views and him: open while the viewport is outside. */
export const glassWithFrames = true;
export const windowFramesAt = (e: number) =>
  e < BEAT.free ? 1 - smooth(span(e, BEAT.twin + 0.5, BEAT.twin + 1.1)) : smooth(span(e, BEAT.free, BEAT.free + 0.4)) * (1 - smooth(span(e, BEAT.predict - 0.15, BEAT.predict + 0.35)));
/** From the twin beat the room is seen from outside and above: what the scan caught beyond the walls is left out. */
export const roomMarginAt = (e: number) => (e >= BEAT.twin ? 0.45 : null);

/**
 * Incident times of his body in the timeline: along the walk in, at the table with the chair off the floor, on
 * his way out with it. (He walks out along the line he came in on: the gap in the middle of the walk in is
 * where he is himself while the timeline is up.)
 */
export const GHOST_TIMES: readonly number[] = [4.9, 6.5, 10.3, 19.0, 21.1];
/** 0..1: the body of GHOST_TIMES[i] in the timeline (they come up one after the other, along the track). */
export const ghostAt = (e: number, i: number) => smooth(span(e, BEAT.stats + 0.35 + i * 0.15, BEAT.stats + 0.65 + i * 0.15));
/** Timeline: strength of the hologram shell over the live subject's textured body. */
const NOW_GLOW = 0.9;
/** 0..1: "NOW" over him in the timeline. */
export const nowAt = (e: number) => smooth(span(e, BEAT.stats + 0.5, BEAT.stats + 0.8));

/** 0..1: the recording of the camera that sees him best, beside the tracking shot. */
export const pipAt = (e: number) => smooth(span(e, BEAT.track + 0.4, BEAT.track + 0.75)) * (1 - smooth(span(e, WALK_END - 0.15, WALK_END + 0.05)));
/** The cameras' coverage volumes: unfolded over the wireframe twin, folded away as the replay starts. */
export const coverageAt = (e: number) => (e < BEAT.track + 0.6 ? span(e, BEAT.twin + 1.2, BEAT.twin + 2.0) : 1 - span(e, BEAT.track + 0.6, BEAT.track + 1.2));

// ---------------------------------------------------------------- tracked path, sight lines, forecast

/** The tracked path grows behind him: through the walk in and the stop, and again on his way out. */
const PATH = { in: [BEAT.track, BEAT.track + 0.3], out: [BEAT.free - 0.45, BEAT.free + 0.1], back: [BEAT.predict + 0.9, BEAT.predict + 1.5] } as const;

export function pathAt(e: number): PathState {
  if (e < PATH.in[0] || (e >= PATH.out[1] && e < PATH.back[0])) return { draw: 0, alpha: 0, labels: 0, follow: false };
  if (e >= PATH.back[0]) return { draw: 1, trail: true, follow: true, alpha: smooth(span(e, PATH.back[0], PATH.back[1])), labels: 0 };
  return {
    draw: 1,
    trail: true,
    follow: true,
    alpha: smooth(span(e, PATH.in[0], PATH.in[1])) * (1 - smooth(span(e, PATH.out[0], PATH.out[1]))),
    labels: 1 - span(e, WALK_END + 0.5, WALK_END + 0.8),
  };
}

export const tagLiftAt = (e: number) => (e >= BEAT.track && e < BEAT.free ? 26 : 0);

/** 0..1: the sight lines from the cameras to him (each camera's own line only while it sees him). */
export const raysAt = (e: number) => smooth(span(e, BEAT.track + 0.25, BEAT.track + 0.6)) * (1 - smooth(span(e, WALK_END + 0.35, WALK_END + 0.8)));

/** Seconds ahead the forecast arrow reaches. */
export const FORECAST_HORIZON = 1.5;
/** 0..1: the forecast arrow ahead of him; exit: the exit pin and the time to it. */
export function forecastAt(e: number): { arrow: number; exit: number } {
  const track = smooth(span(e, BEAT.track + 0.6, BEAT.track + 0.9)) * (1 - smooth(span(e, WALK_END, WALK_END + 0.3)));
  const out = 1 - smooth(span(e, BEAT.stats - 0.25, BEAT.stats + 0.15));
  const predict = smooth(span(e, BEAT.predict + 0.25, BEAT.predict + 0.7)) * out;
  return { arrow: Math.max(track, predict), exit: smooth(span(e, BEAT.predict + 0.7, BEAT.predict + 1.2)) * out };
}

// ---------------------------------------------------------------- subject look

/** The free camera's looks, named as the viewer's own modes are. */
export const FREEZE_LOOKS: { name: DemoLookName; at: number; label: string }[] = [
  { name: "texture", at: BEAT.free, label: "3D MODEL" },
  { name: "xray", at: BEAT.free + 1.2, label: "X-RAY" },
  { name: "footage", at: BEAT.free + 2.8, label: "3D + FOOTAGE" },
];
const look = (name: DemoLookName) => FREEZE_LOOKS.find((l) => l.name === name)!.at;

export function lookStateAt(e: number): LookState {
  const base: LookState = {
    mode: "hybrid",
    xray: false,
    hologram: 0,
    hideBody: false,
    holoStyle: 0,
    holoBand: -10,
    bracket: 0,
    hideTags: e < BEAT.track + 1.2 || e >= WALK_END + 0.3,
    hideTrail: true,
    hideSubject: e >= SUBJECT_OUT[1] && e < BEAT.track,
    name: null,
  };
  if (e < SUBJECT_OUT[0]) return base;
  // rewind: he turns to the hologram as the viewport pulls out, and is gone
  if (e < SUBJECT_OUT[1]) return { ...base, mode: "model", hologram: smooth(span(e, SUBJECT_OUT[0], SUBJECT_OUT[1])), hideBody: e > SUBJECT_OUT[1] - 0.06, holoStyle: 1 };
  // the walk in and the stop, seen from outside and run fast: the 3D model with its baked texture
  if (e < BEAT.free) return { ...base, mode: "model" };
  if (e < look("xray")) return { ...base, mode: "model", name: "texture" };
  if (e < look("footage")) return { ...base, xray: true, hologram: 1, hideBody: true, holoStyle: 1, holoBand: lerp(-0.25, 2.1, span(e, look("xray"), look("footage") - 0.1)), name: "xray" };
  // on CAM 01's line of sight the body carries that camera's own pixels; the fused track's values beside him
  if (e < BEAT.predict) return { ...base, name: "footage", bracket: easeOut(span(e, look("footage") + 0.15, look("footage") + 0.5)) * (1 - span(e, BEAT.predict - 0.25, BEAT.predict)) };
  if (e < BEAT.stats + 0.1) return base;
  // the timeline: the real, textured him in a white outline, among the cyan holograms of where he has been
  return { ...base, mode: "model", hologram: NOW_GLOW * smooth(span(e, BEAT.stats + 0.1, BEAT.stats + 0.5)), holoStyle: 1, holoWhite: 1 };
}

// ---------------------------------------------------------------- CCTV wall

/** The camera the wall pushes into. */
export const LOCK_FIRST: CameraId = "cam1";
/** The search: typed from, typed by, sweep until (= the lock). */
export const SEARCH = { type: [BEAT.wall + 0.3, BEAT.wall + 1.45], scan: [BEAT.wall + 1.5, BEAT.lock], query: "man carrying a chair" } as const;
/** The cut-outs light up one feed after the other. */
const MATCH_STAGGER = 0.11;
/** The lock's marks leave before the wipe: the recording as filmed on one side, the 3D view on the other. */
const UNMARK = [BEAT.reveal + 0.4, BEAT.reveal + 0.7] as const;

export function wallAt(e: number): WallState {
  const off = 1 - smooth(span(e, UNMARK[0], UNMARK[1]));
  const lit = (i: number) => easeOut(span(e, BEAT.lock + i * MATCH_STAGGER, BEAT.lock + i * MATCH_STAGGER + 0.35)) * off;
  const highlight = lit(0);
  const pip = pipAt(e);
  if (e >= WIPE[1]) return { visible: pip > 0.002, zoom: 0, highlight: 1, dim: 0, tint: 0, footage: 1, view: { cam: LOCK_FIRST, punch: 0, focusTime: incidentTime(e) }, tag: "TRACKED", pip };
  return {
    visible: true,
    zoom: easeInOut(span(e, BEAT.reveal, BEAT.reveal + 0.5)),
    highlight,
    highlights: [0, 1, 2, 3].map(lit),
    dim: highlight,
    tint: smooth(span(e, BEAT.lock + 0.45, BEAT.lock + 0.85)) * off,
    footage: 1,
    view: { cam: LOCK_FIRST, punch: 0, focusTime: incidentTime(e) },
    scan: e >= SEARCH.scan[0] && e < SEARCH.scan[1] ? span(e, SEARCH.scan[0], SEARCH.scan[1]) : undefined,
    wipe: easeInOut(span(e, WIPE[0], WIPE[1])),
    tag: "MATCH \u00B7 SAM 2.1",
    reserve: 0.25,
  };
}

/** 0..1: share of the picture's width, from the left, that is the 3D view (the wipe). */
export const wipeAt = (e: number) => (e < WIPE[0] ? 0 : e >= WIPE[1] ? 1 : easeInOut(span(e, WIPE[0], WIPE[1])));
/** The wireframe in the wake of the wipe's line: [leading edge, trailing edge, strength] (see WIRE_WAKE). */
function wireWakeAt(e: number): readonly [number, number, number] | undefined {
  if (e <= WIPE[0] || e >= WIRE_OUT[1]) return undefined;
  const head = wipeAt(e);
  const tail = Math.max(wipeAt(e - WIRE_WAKE), head - WIRE_BAND);
  return [head, tail, WIRE_STRENGTH * (1 - smooth(span(e, WIRE_OUT[0], WIRE_OUT[1])))];
}
/** Whether the wipe's line and its two labels are on screen. */
export const wipeShown = (e: number) => e >= BEAT.reveal + 0.45 && e < WIPE[1] + 0.25;

// ---------------------------------------------------------------- chapters

export interface Chapter2 {
  at: number;
  rail: string;
  /** Lines of the title (short: they stay inside a 4:5 crop of a 16:9 recording). */
  title: string[];
  sub: string;
}

export const CHAPTERS: Chapter2[] = [
  { at: BEAT.wall, rail: "SEARCH", title: ["ASK THE FOOTAGE."], sub: "Four recordings, one question" },
  { at: BEAT.lock, rail: "LOCK", title: ["SUBJECT LOCKED."], sub: "SAM 2.1 isolates him in every feed" },
  { at: BEAT.reveal, rail: "REVEAL", title: ["SAME CAMERA.", "NOW IN 3D."], sub: "Reconstructed from the footage, not generated" },
  { at: BEAT.twin, rail: "TWIN", title: ["THE ROOM.", "TO SCALE."], sub: "LiDAR digital twin \u00B7 4 calibrated cameras" },
  { at: BEAT.track, rail: "TRACK", title: ["4 CAMERAS.", "1 TRACK."], sub: "Every sight line fused on one clock" },
  { at: WALK_END, rail: "DWELL", title: ["DWELL TIME.", "0.0 S"], sub: "Measured from the fused track" },
  { at: BEAT.free, rail: "FREE CAM", title: ["ANY ANGLE.", "ANY MOMENT."], sub: "A camera that was never there \u00B7 time still running" },
  { at: BEAT.predict, rail: "PREDICT", title: ["NEXT MOVE.", "PREDICTED."], sub: "Heading, speed and time to the exit, from the track" },
  { at: BEAT.stats, rail: "TIMELINE", title: [], sub: "" },
];
/** Index of the chapter whose title's last line is the running dwell counter. */
export const DWELL_CHAPTER = 5;
export const STATS_CHAPTER = 8;

/** Index into CHAPTERS, or -1 during the end card. */
export function chapterAt(e: number): number {
  if (e >= BEAT.end) return -1;
  let i = 0;
  while (i < CHAPTERS.length - 1 && e >= CHAPTERS[i + 1].at) i++;
  return i;
}

/** Brief white flashes at the cuts (0..1). */
export function flashAt(e: number): number {
  const pulse = (at: number, len: number, gain: number) => (e >= at && e < at + len ? gain * (1 - (e - at) / len) : 0);
  return Math.max(
    pulse(BEAT.lock, 0.2, 0.25),
    pulse(BEAT.twin, 0.26, 0.3),
    pulse(BEAT.stats + 0.1, 0.24, 0.25),
    pulse(BEAT.free, 0.24, 0.35),
    pulse(BEAT.predict, 0.24, 0.3),
    ...FREEZE_LOOKS.slice(1).map((l) => pulse(l.at, 0.16, 0.2)),
  );
}

/** 0..1: the picture tears (a glitch) as the timeline comes up. */
export const glitchAt = (e: number) => (e >= BEAT.stats + 0.02 && e < BEAT.stats + 0.2 ? 1 - span(e, BEAT.stats + 0.02, BEAT.stats + 0.2) : 0);
/** 0..1: CCTV scan lines over the recording (the wall and CAM 01's picture, on the recording's side of the wipe). */
export const scanLinesAt = (e: number) => (e >= BEAT.wall && e < WIPE[1] ? 1 : 0);

// ---------------------------------------------------------------- camera

const DEG = Math.PI / 180;

/** The CCTV camera the viewport looks through, else null. */
export function cctvAt(e: number): CameraId | null {
  return e < BEAT.twin + 0.2 ? LOCK_FIRST : null;
}
/** The camera named in the top bar (once the wall's own labels are gone). */
export const namedCamAt = (e: number) => (e >= BEAT.reveal + 0.3 && e < BEAT.twin + 0.2 ? LOCK_FIRST : null);
export const cctvFilterAt = (_e: number) => "";

const chestOf = (feet: Vec3): Vec3 => [feet[0], feet[1] + 0.98, feet[2]];
/** Where `p` is seen from `c`: degrees round it, degrees above it, metres away. */
function polarOf(p: Vec3, c: Vec3) {
  const d = sub(p, c);
  const h = Math.hypot(d[0], d[2]);
  return { az: Math.atan2(d[0], d[2]) / DEG, el: Math.atan2(d[1], h) / DEG, d: Math.hypot(h, d[1]) };
}
function fromPolar(c: Vec3, az: number, el: number, d: number): Vec3 {
  const a = az * DEG;
  const b = el * DEG;
  return [c[0] + d * Math.cos(b) * Math.sin(a), c[1] + d * Math.sin(b), c[2] + d * Math.cos(b) * Math.cos(a)];
}

/** The outside view of the room: from the window side with its long side across a wide picture; cornerwise in a tall one. */
const outsideAngles = (ctx: DemoContext) => (ctx.aspect < 1 ? { az: 232, el: 50 } : { az: 270, el: 50 });
/** The tracking shot's distance to him (m). */
const FOLLOW_D = 7.0;
const FOLLOW_FOV = 42;
/** Where in the picture (above its middle, as a share of half its height) the tracking shot holds him. */
const FOLLOW_UP = 0.3;
/** The tracking shot is on him this long after the replay starts. */
const FOLLOW_IN = [BEAT.track + 0.7, BEAT.track + 2.2] as const;

/** The whole room from outside, fitted into the part of the picture the title leaves free. */
function wholeRoom(ctx: DemoContext): DemoCam {
  const { az, el } = outsideAngles(ctx);
  return fit(ctx, az, el);
}

/** The tracking shot: the same direction as the whole-room view, closer, moving along the room with him. */
function followCamera(ctx: DemoContext): DemoCam {
  const { az, el } = outsideAngles(ctx);
  const { dir, up } = viewAxes(az, el);
  const feet = ctx.live ?? ctx.subject;
  const fov = FOLLOW_FOV;
  const drop = FOLLOW_UP * FOLLOW_D * Math.tan((fov * DEG) / 2);
  const t: Vec3 = [feet[0] - up[0] * drop, feet[1] + 0.9 - up[1] * drop, feet[2] - up[2] * drop];
  return { p: [t[0] + dir[0] * FOLLOW_D, t[1] + dir[1] * FOLLOW_D, t[2] + dir[2] * FOLLOW_D], t, roll: 0, fov };
}

/**
 * Out of CAM 01: up through where the ceiling was, then out over the window wall to the whole room (the wall
 * is crossed above its top: nothing of it passes in front of the lens).
 */
function flyOut(e: number, ctx: DemoContext): DemoCam {
  const cam1 = throughCamera("cam1", ctx);
  const R = wholeRoom(ctx);
  const [cx, , cz] = ctx.bounds.center;
  const top = ctx.bounds.max[1];
  const mid: Vec3 = [lerp(cam1.p[0], cx, 0.35), top + 2.6, lerp(cam1.p[2], cz, 0.3)];
  const xs = [BEAT.twin, BEAT.twin + 0.75, BEAT.twin + 1.8];
  return {
    p: pchip3(xs, [cam1.p, mid, R.p], e),
    t: pchip3(xs, [cam1.t, [lerp(cam1.t[0], R.t[0], 0.5), R.t[1], lerp(cam1.t[2], R.t[2], 0.5)], R.t], e),
    roll: pchip(xs, [cam1.roll, 0, 0], e),
    fov: pchip(xs, [cam1.fov, lerp(cam1.fov, R.fov, 0.6), R.fov], e),
  };
}

/** The twin and the replay of his walk in: the whole room, then the tracking shot. */
function outsideCamera(e: number, ctx: DemoContext): DemoCam {
  if (e < BEAT.twin + 1.8) return flyOut(e, ctx);
  const R = wholeRoom(ctx);
  const w = easeInOut(span(e, FOLLOW_IN[0], FOLLOW_IN[1]));
  if (w <= 0) return R;
  const F = followCamera(ctx);
  return { p: lerp3(R.p, F.p, w), t: lerp3(R.t, F.t, w), roll: 0, fov: lerp(R.fov, F.fov, w) };
}

/** The free camera: metres from him at its start (CAM 04's line of sight), half way round, and at its end (CAM 01's). */
const FREE_D = [3.5, 3.0, 3.3] as const;
/** Per degree near a recording camera's bearing the free camera spends (1 + LINGER x closeness) as long. */
const LINGER = 1.6;
const LINGER_SIGMA = 14;

/** A CCTV camera's line of sight to his chest, as seen from him (az unwrapped next to `near`). */
function sightOf(id: CameraId, chest: Vec3, ctx: DemoContext, near: number) {
  const s = polarOf(ctx.poses[id].position, chest);
  return { az: unwrap(s.az, near), el: s.el };
}

/**
 * Share 0..1 of the way round him at share `u` of the free camera's time, re-paced so that it lingers where it
 * looks along a recording camera's line of sight (there the body is that camera's own footage) and hurries
 * across the stretch between them.
 */
function lingered(u: number, a0: number, a1: number, centre: Vec3, ctx: DemoContext): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const bearings: { az: number; w: number }[] = [];
  for (const id of CAMERA_ORDER) {
    const w = ctx.sources ? (ctx.sources[id] ?? 0) : 1;
    if (w <= 0.001) continue;
    const p = ctx.poses[id].position;
    bearings.push({ az: Math.atan2(p[0] - centre[0], p[2] - centre[2]) / DEG, w });
  }
  const g = (a: number) => {
    let k = 1;
    for (const b of bearings) {
      const d = unwrap(b.az, a) - a;
      k += LINGER * b.w * Math.exp(-0.5 * (d / LINGER_SIGMA) ** 2);
    }
    return k;
  };
  const n = 240;
  const G = new Float64Array(n + 1);
  let prev = g(a0);
  for (let i = 1; i <= n; i++) {
    const cur = g(lerp(a0, a1, i / n));
    G[i] = G[i - 1] + 0.5 * (prev + cur);
    prev = cur;
  }
  const want = G[n] * u;
  let lo = 0;
  let hi = n;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (G[mid] <= want) lo = mid;
    else hi = mid;
  }
  return (lo + (G[hi] > G[lo] ? (want - G[lo]) / (G[hi] - G[lo]) : 0)) / n;
}

/**
 * Free camera at share `u` of its time: from CAM 04's line of sight round the window side to CAM 01's, which he
 * has turned to face by then (there his body carries that camera's own pixels).
 */
function freeCamera(u: number, ctx: DemoContext): DemoCam {
  const feet = ctx.live ?? ctx.subject;
  const chest = chestOf(feet);
  const from = sightOf("cam4", chest, ctx, 340);
  const to = sightOf("cam1", chest, ctx, 200);
  const w = lingered(u, from.az, to.az, ctx.subject, ctx);
  const d = pchip([0, 0.5, 1], FREE_D, w);
  // (aimed below his chest: he stands in the upper part of the picture, clear of the title)
  return { p: fromPolar(chest, lerp(from.az, to.az, w), lerp(from.el, to.el, w), d), t: [feet[0], feet[1] + 0.74, feet[2]], roll: 0, fov: lerp(55, 52, w) };
}

/** The view for the forecast: from where, and how far apart (shares of the picture's width and height) he and the door may stand in it. */
const exitAngles = (ctx: DemoContext) => (ctx.aspect < 1 ? { az: 199, el: 55, sx: 0.5, sy: 0.4 } : { az: 258, el: 46, sx: 0.36, sy: 0.5 });
const EXIT_FOV = 42;
/** Its distance (m): no closer, no farther. */
const EXIT_D = [6.2, 16] as const;
/** Where it holds the middle between him and the door: above the picture's middle, as a share of half its height. */
const EXIT_UP = 0.24;
/** Seconds the camera takes from the free camera's last view to it. */
const EXIT_IN = 2.0;

/**
 * The view for the forecast: from outside the window wall, aimed at the middle between him and the door he is
 * heading for, as far away as it takes to hold both in the middle of the picture (a 4:5 crop of a wide recording
 * keeps both). As he nears the door the two close up and the view moves in.
 */
function exitView(ctx: DemoContext): DemoCam {
  return holdBoth(ctx, ctx.live ?? ctx.subject, exitAngles(ctx));
}

/** The timeline's view: the door and the table, his whole way between them across the picture. */
const timelineAngles = (ctx: DemoContext) => (ctx.aspect < 1 ? { az: 199, el: 52, sx: 0.5, sy: 0.4 } : { az: 270, el: 42, sx: 0.6, sy: 0.5 });
const timelineView = (ctx: DemoContext) => holdBoth(ctx, ctx.subject, timelineAngles(ctx));

/** The view from (az, el) that holds a point on the floor and the door at most (sx, sy) of the picture apart. */
function holdBoth(ctx: DemoContext, feet: Vec3, { az, el, sx, sy }: { az: number; el: number; sx: number; sy: number }): DemoCam {
  const { dir, right, up } = viewAxes(az, el);
  const door: Vec3 = ctx.door ?? [-1.41, feet[1], -6.14];
  const A: Vec3 = [feet[0], feet[1] + 0.9, feet[2]];
  const B: Vec3 = [door[0], door[1] + 0.8, door[2]];
  const gap = sub(A, B);
  const along = (v: Vec3) => Math.abs(gap[0] * v[0] + gap[1] * v[1] + gap[2] * v[2]);
  const tanV = Math.tan((EXIT_FOV * DEG) / 2);
  const d = Math.min(Math.max(along(right) / (2 * tanV * ctx.aspect * sx), along(up) / (2 * tanV * sy), EXIT_D[0]), EXIT_D[1]);
  const drop = EXIT_UP * d * tanV;
  const t: Vec3 = [(A[0] + B[0]) / 2 - up[0] * drop, (A[1] + B[1]) / 2 - up[1] * drop, (A[2] + B[2]) / 2 - up[2] * drop];
  return { p: [t[0] + dir[0] * d, t[1] + dir[1] * d, t[2] + dir[2] * d], t, roll: 0, fov: EXIT_FOV };
}

export function cameraAt(e: number, ctx: DemoContext): DemoCam {
  if (e < BEAT.twin) return throughCamera(LOCK_FIRST, ctx);
  if (e < WALK_END) return outsideCamera(e, ctx);

  if (e < BEAT.free) {
    // down from the tracking shot to him, onto CAM 04's line of sight: round him, closer (evenly in scale) and lower
    const O = outsideCamera(WALK_END, ctx);
    const K = freeCamera(0, ctx);
    const chest = chestOf(ctx.live ?? ctx.subject);
    const o = polarOf(O.p, chest);
    const k = polarOf(K.p, chest);
    const u = easeInOut(span(e, WALK_END, BEAT.free));
    const az = lerp(o.az, unwrap(k.az, o.az), u);
    const d = o.d * Math.pow(k.d / o.d, u);
    return { p: fromPolar(chest, az, lerp(o.el, k.el, Math.pow(u, 1.4)), d), t: lerp3(O.t, K.t, smooth(clamp01(u * 1.5))), roll: 0, fov: lerp(O.fov, K.fov, u) };
  }

  // (two keys: at rest on CAM 04's line of sight, at rest on CAM 01's)
  if (e < BEAT.predict) return freeCamera(pchip([BEAT.free, BEAT.predict], [0, 1], e), ctx);

  // He walks off towards the door; the camera swings out over the window wall (rising first: it crosses the
  // wall above its top) to the view that holds him and the door, and closes in as he nears it.
  const K = freeCamera(1, ctx);
  const X = exitView(ctx);
  const u = easeInOut(span(e, BEAT.predict, BEAT.predict + EXIT_IN));
  const rise = 1 - Math.pow(1 - u, 2.2);
  const P: DemoCam = { p: [lerp(K.p[0], X.p[0], u), lerp(K.p[1], X.p[1], rise), lerp(K.p[2], X.p[2], u)], t: lerp3(K.t, X.t, smooth(clamp01(u * 1.3))), roll: 0, fov: lerp(K.fov, X.fov, u) };
  // the timeline: back out to his whole way through the room
  const w = easeInOut(span(e, TIMELINE.cam[0], TIMELINE.cam[1]));
  if (w <= 0) return P;
  const R = timelineView(ctx);
  return { p: lerp3(P.p, R.p, w), t: lerp3(P.t, R.t, w), roll: 0, fov: lerp(P.fov, R.fov, w) };
}

/**
 * Demo times drawn once behind the loading card (every look has its shaders compiled by then). 4.7 is the wipe
 * with its wireframe wake, which also prepares the scan's vertex data for it (see prepareBuildSweep).
 */
export const WARM_UP: readonly number[] = [0.6, 4.7, 6.4, 7.1, 7.9, 9.1, 10.9, 13.4, 14.4, 15.8, 17.3, 19.0, 20.4, 22.1, 23.0];

export { clamp01, easeOut, lerp, span };
