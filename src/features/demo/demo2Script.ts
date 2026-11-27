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
 * card: it starts on the recordings and every beat is something the system does with them. One caption per
 * beat, in plain words (CHAPTERS): read one after the other they say what the product does.
 *
 *   0.0  WALL       "Four security cameras. One room."  the wall of the four recordings; a query is typed, a
 *                   sweep crosses every feed
 *   2.1  LOCK       "One person. Found in every camera."  his SAM 2.1 cut-out lights up in every feed
 *   3.4  REVEAL     "The same moment. Rebuilt in 3D."  push into CAM 01; a wipe crosses the picture: recording
 *                   on one side, 3D view on the other, the room's wireframe trailing its line
 *   5.7  TWIN       "The whole room. Scanned to scale."  the viewport rises out of CAM 01 to the whole room
 *                   seen from outside (only the room: what the scan caught beyond its walls is left out) while
 *                   it melts to its LiDAR wireframe; he fades out, time rewinds, the four cameras' coverage
 *                   unfolds, the texture comes back
 *   8.1  TRACK      "Every step. Tracked across cameras."  replay from his entry (1.6x, from 7.5: he is
 *                   already walking when the caption comes) in one shot that goes once round him: down from
 *                   the whole-room view to where CAM 01 hangs, then from one camera's line of sight to the
 *                   next (CAM 01, CAM 02, high over his far side, CAM 03, CAM 04). On a camera's line his
 *                   body is that camera's own picture of him. His path grows behind him, a sight line from
 *                   every camera that sees him at that moment, a forecast arrow ahead; beside it the
 *                   recording of the camera whose line the shot is on, in step. The seconds he stands at the
 *                   table (from 12.75) run through fast while the shot moves in on CAM 04's line
 *  13.95 FREE CAM   "Any angle. Any moment."  half speed: round him from CAM 04's line of sight to CAM 01's as
 *                   he lifts the chair and turns (3D model, X-ray in the wireframe room, 3D + footage)
 *  18.35 PREDICT    "His next move. Predicted."  he walks off; the camera swings out over the window wall to a
 *                   view that holds him and the door and closes in as he nears it: forecast arrow, the
 *                   predicted route, the exit and the time to it, from the fused track's position and velocity
 *  21.2  TIMELINE   "The whole incident. In one view."  the room turns to its wireframe and the camera comes
 *                   round beside the track: his body at five earlier moments stands along it, each with its
 *                   time, he himself walks on among them (white, "NOW")
 *  23.8  END CARD   "Security footage in. 3D replay out."
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
/** The wipe across CAM 01's picture: it sets off as the push comes to rest and is through just before the twin beat. */
const WIPE = [BEAT.reveal + 0.5, BEAT.reveal + 2.1] as const;
/**
 * Behind the wipe's line the room's wireframe shows over the 3D view, in a band from the line back over
 * WIRE_BAND of the picture's width: at full strength next to the line, fading out towards the band's far end
 * (see uBuildSweep). WIRE_STRENGTH: of a line whose triangles are large on screen, in a picture 720 pixels high.
 */
const WIRE_BAND = 0.4;
const WIRE_STRENGTH = 0.36;
/** As the line comes to rest at the right edge the band closes up on it; its lines are out by the twin beat. */
const WIRE_OUT = [WIPE[1] - 0.25, BEAT.twin - 0.04] as const;
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
/**
 * The walk in, replayed at WALK_RATE up to where he slows at the table. It sets off a little before the track
 * beat (he comes in through the door under the whole-room view, the caption follows): that, and a pace a
 * little under the earlier 1.8, is the time the tracking shot has for its turn round him.
 */
const WALK_FROM = BEAT.track - 0.6;
const WALK_RATE = 1.6;
const WALK_END_TIME = 12.4;
const WALK_END = WALK_FROM + (WALK_END_TIME - REWOUND_TIME) / WALK_RATE;
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
export const videosLive = (e: number) => e < BEAT.twin || (e >= WALK_FROM && e < WALK_END);
export const videoRate = (e: number) => (e >= WALK_FROM ? WALK_RATE : 1);

/** Master (incident) time shown at demo time e. */
export function incidentTime(e: number): number {
  if (e < BEAT.twin) return DEMO_START_TIME + Math.max(e - BEAT.wall, 0);
  if (e < REWIND_FROM) return twinTime(e);
  if (e < WALK_FROM) return lerp(HELD_TIME, REWOUND_TIME, easeInOut(span(e, REWIND_FROM, WALK_FROM)));
  if (e < WALK_END) return REWOUND_TIME + WALK_RATE * (e - WALK_FROM);
  if (e < BEAT.free) return dwellAt(e).t;
  if (e < BEAT.predict) return FREEZE_TIME + FREE_RATE * (e - BEAT.free);
  const x = e - BEAT.predict;
  return PREDICT_TIME + FREE_RATE * x + (END_RATE - FREE_RATE) * eased(x) + (TIMELINE_RATE - END_RATE) * eased(e - TIMELINE_SLOW);
}

/** Footage frames the walkthrough draws (loaded and kept before the clock starts). */
export function frameWanted(masterTime: number): boolean {
  return masterTime >= REWOUND_TIME && masterTime <= incidentTime(DEMO_DURATION) + 0.3;
}

/** The replay's pace at demo time e, in times real time; negative while it rewinds. */
export function rateAt(e: number): number {
  if (e < BEAT.twin) return 1;
  if (e < REWIND_FROM) return 1 - (1 - TWIN_RATE) * smooth(span(e, BEAT.twin, BEAT.twin + TWIN_EASE));
  if (e < WALK_FROM) return (REWOUND_TIME - HELD_TIME) / (WALK_FROM - REWIND_FROM);
  if (e < WALK_END) return WALK_RATE;
  if (e < BEAT.free) return dwellAt(e).rate;
  if (e < BEAT.predict) return FREE_RATE;
  return endRate(e);
}

// ---------------------------------------------------------------- room build

const ALL = 1e6;
const NONE = -1e6;
const WIRE_DIM = 0.5;
/** ...and under the timeline's bodies. */
const TIMELINE_DIM = 0.3;
/** The texture is back (rising behind the replay's first steps, before the tracking shot is down in the room) over this span. */
const RISE = [WALK_FROM, WALK_FROM + 1.1] as const;
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
/**
 * The scanned window frames stand between the outside views and him: open while the viewport is outside (the
 * fly-out, the whole room, and the tracking shot's way down to CAM 01, which hangs on that wall: the shot comes
 * in through the open wall and stays right before it while it is on that camera's line). As the shot leaves
 * that line along the door end the wall rises from the floor (WALL_UP: to a little beyond its top, its last
 * cells come in under it); the forecast's view goes back out over it.
 */
export const glassWithFrames = true;
const WALL_UP = [BEAT.track + 1.35, BEAT.track + 1.85] as const;
export const windowFramesAt = (e: number) =>
  e < WALL_UP[0] ? 1 - smooth(span(e, BEAT.twin + 0.5, BEAT.twin + 1.1)) : 1 - smooth(span(e, BEAT.predict - 0.15, BEAT.predict + 0.35));
export const windowRiseAt = (e: number, floorY: number, topY: number) =>
  e >= WALL_UP[0] && e < WALL_UP[1] ? lerp(floorY, topY + 0.35, easeOut(span(e, WALL_UP[0], WALL_UP[1]))) : null;
/**
 * From the twin beat the room is seen from outside and above: what the scan caught beyond the walls is left out,
 * and with it the balcony drawn outside the window wall (its floor, its posts and its glass railing).
 */
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
/** 0..1: the times over the timeline's bodies (they leave as the end card comes, so nothing is written behind it). */
export const stampsAt = (e: number) => 1 - smooth(span(e, BEAT.end, BEAT.end + 0.35));

/** 0..1: the recording of the camera that sees him best, beside the tracking shot. */
export const pipAt = (e: number) => smooth(span(e, BEAT.track, BEAT.track + 0.35)) * (1 - smooth(span(e, WALK_END - 0.15, WALK_END + 0.05)));
/** The cameras' coverage volumes: unfolded over the wireframe twin, folded away as the tracking shot sets off (it flies in through them). */
export const coverageAt = (e: number) => (e < COVERAGE_OUT[0] ? span(e, BEAT.twin + 1.0, BEAT.twin + 1.8) : 1 - span(e, COVERAGE_OUT[0], COVERAGE_OUT[1]));
const COVERAGE_OUT = [BEAT.track - 0.3, BEAT.track + 0.2] as const;

// ---------------------------------------------------------------- tracked path, sight lines, forecast

/** The tracked path grows behind him: through the walk in and the stop, and again on his way out. */
const PATH = { in: [WALK_FROM + 0.1, WALK_FROM + 0.4], out: [BEAT.free - 0.45, BEAT.free + 0.1], back: [BEAT.predict + 0.9, BEAT.predict + 1.5] } as const;

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

/** (The scene's own tag on him is left out all the way through: see lookStateAt.) */
export const tagLiftAt = (_e: number) => 0;

/**
 * The cameras' own labels in the scene: 0..1 shown, and plain (their name only, without what they see of him).
 * Out while the viewport looks through CAM 01 (the wipe compares the recording with the bare 3D view), in
 * while the cameras are what the picture is about (their coverage, their sight lines to him), out again from
 * the free camera on.
 */
export const cameraTagsAt = (e: number) => ({ show: smooth(span(e, BEAT.twin + 0.9, BEAT.twin + 1.3)) * (1 - smooth(span(e, WALK_END + 0.35, WALK_END + 0.8))), plain: true });

/** 0..1: the sight lines from the cameras to him (each camera's own line only while it sees him). */
export const raysAt = (e: number) => smooth(span(e, BEAT.track - 0.2, BEAT.track + 0.15)) * (1 - smooth(span(e, WALK_END + 0.35, WALK_END + 0.8)));
/**
 * A sight line fades out as the viewport comes to look along it (it would run from just beside the lens across
 * the picture to him): degrees between the viewport and that camera, seen from him, at which it is gone / back.
 */
export const RAY_CLEAR = [5, 14] as const;

/** Seconds ahead the forecast arrow reaches. */
export const FORECAST_HORIZON = 1.5;
/** 0..1: the forecast arrow ahead of him; exit: the exit pin and the time to it. */
export function forecastAt(e: number): { arrow: number; exit: number } {
  const track = smooth(span(e, BEAT.track - 0.1, BEAT.track + 0.2)) * (1 - smooth(span(e, WALK_END, WALK_END + 0.3)));
  const out = 1 - smooth(span(e, BEAT.stats - 0.25, BEAT.stats + 0.15));
  const predict = smooth(span(e, BEAT.predict + 0.25, BEAT.predict + 0.7)) * out;
  return { arrow: Math.max(track, predict), exit: smooth(span(e, BEAT.predict + 0.7, BEAT.predict + 1.2)) * out };
}

// ---------------------------------------------------------------- subject look

/** The free camera's looks (the viewer's own modes: 3D model, X-ray, 3D + footage). */
export const FREEZE_LOOKS: { name: DemoLookName; at: number }[] = [
  { name: "texture", at: BEAT.free },
  { name: "xray", at: BEAT.free + 1.2 },
  { name: "footage", at: BEAT.free + 2.8 },
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
    hideTags: true,
    hideTrail: true,
    hideSubject: e >= SUBJECT_OUT[1] && e < WALK_FROM,
    name: null,
  };
  if (e < SUBJECT_OUT[0]) return base;
  // rewind: he turns to the hologram as the viewport pulls out, and is gone
  if (e < SUBJECT_OUT[1]) return { ...base, mode: "model", hologram: smooth(span(e, SUBJECT_OUT[0], SUBJECT_OUT[1])), hideBody: e > SUBJECT_OUT[1] - 0.06, holoStyle: 1 };
  // the walk in and the stop: 3D + footage. His body carries the pixels of the cameras that see him, and the
  // tracking shot goes from one of their lines of sight to the next (see trackCamera)
  if (e < BEAT.free) return base;
  if (e < look("xray")) return { ...base, mode: "model", name: "texture" };
  if (e < look("footage")) return { ...base, xray: true, hologram: 1, hideBody: true, holoStyle: 1, holoBand: lerp(-0.25, 2.1, span(e, look("xray"), look("footage") - 0.1)), name: "xray" };
  // on CAM 01's line of sight the body carries that camera's own pixels; the tracking bracket closes on him
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
/** Share of the picture's height kept free under the wall: the caption's two lines, and the search bar above them. */
export const WALL_RESERVE = 0.28;
/** The cut-outs light up one feed after the other. */
const MATCH_STAGGER = 0.11;
/** The lock's marks leave as the wipe sets off: the recording as filmed on one side, the 3D view on the other. */
const UNMARK = [BEAT.reveal + 0.3, BEAT.reveal + 0.6] as const;

export function wallAt(e: number): WallState {
  const off = 1 - smooth(span(e, UNMARK[0], UNMARK[1]));
  const lit = (i: number) => easeOut(span(e, BEAT.lock + i * MATCH_STAGGER, BEAT.lock + i * MATCH_STAGGER + 0.35)) * off;
  const highlight = lit(0);
  const pip = pipAt(e);
  if (e >= WIPE[1]) return { visible: pip > 0.002, zoom: 0, highlight: 1, dim: 0, tint: 0, footage: 1, view: { cam: LOCK_FIRST, punch: 0, focusTime: incidentTime(e) }, tag: "", pip, pipCam: pipCamAt(e) };
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
    wipe: wipeAt(e),
    tag: "",
    plain: true,
    reserve: WALL_RESERVE,
  };
}

/**
 * 0..1: share of the picture's width, from the left, that is the 3D view (the wipe). An even pace: the line
 * is slow only as it leaves the left edge and as it reaches the right one.
 */
export const wipeAt = (e: number) => (e < WIPE[0] ? 0 : e >= WIPE[1] ? 1 : smooth(span(e, WIPE[0], WIPE[1])));
/** The wireframe behind the wipe's line: [leading edge, trailing edge, strength] (see WIRE_BAND). */
function wireWakeAt(e: number): readonly [number, number, number] | undefined {
  if (e <= WIPE[0] || e >= WIRE_OUT[1]) return undefined;
  const head = wipeAt(e);
  const tail = lerp(Math.max(head - WIRE_BAND, 0), head, smooth(span(e, WIRE_OUT[0], WIRE_OUT[1])));
  return [head, tail, WIRE_STRENGTH * (1 - smooth(span(e, WIPE[1], WIRE_OUT[1])))];
}
/** 0..1: the wipe's line and its two labels: up at the left edge as the push comes to rest, out once it is through. */
export const wipeLineAt = (e: number) => span(e, WIPE[0] - 0.05, WIPE[0] + 0.15) * (1 - span(e, WIPE[1] + 0.03, WIPE[1] + 0.17));
/** Whether they are on screen. */
export const wipeShown = (e: number) => e >= WIPE[0] - 0.05 && e < WIPE[1] + 0.17;

// ---------------------------------------------------------------- chapters

export interface Chapter2 {
  at: number;
  /** The caption: two short lines in plain words (short: they stay inside a 4:5 crop of a 16:9 recording). */
  lines: readonly [string, string];
  /** Seconds after the beat that the caption waits before it comes in (0 if left out). */
  delay?: number;
}

export const CHAPTERS: Chapter2[] = [
  { at: BEAT.wall, lines: ["Four security cameras.", "One room."] },
  { at: BEAT.lock, lines: ["One person.", "Found in every camera."] },
  { at: BEAT.reveal, lines: ["The same moment.", "Rebuilt in 3D."] },
  // (in CAM 01's picture he stands where the caption goes: it comes in once the viewport has lifted him off it)
  { at: BEAT.twin, lines: ["The whole room.", "Scanned to scale."], delay: 0.25 },
  { at: BEAT.track, lines: ["Every step.", "Tracked across cameras."] },
  { at: BEAT.free, lines: ["Any angle.", "Any moment."] },
  { at: BEAT.predict, lines: ["His next move.", "Predicted."] },
  { at: BEAT.stats, lines: ["The whole incident.", "In one view."] },
];
/** The end card's two lines: what goes in, what comes out. */
export const END_LINES = ["Security footage in.", "3D replay out."] as const;
/** Fonts the captions are set in, fetched before the clock starts (CSS font shorthand, see document.fonts.load). */
export const FONTS: readonly string[] = ['600 40px "Inter Variable"'];

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

/** The whole room from outside, fitted into the part of the picture the title leaves free. */
function wholeRoom(ctx: DemoContext): DemoCam {
  const { az, el } = outsideAngles(ctx);
  return fit(ctx, az, el);
}

/**
 * Out of CAM 01: straight up through where the ceiling was, tilting down along the room, then out over the
 * window wall to the whole room (the wall is crossed above its top: nothing of it passes in front of the
 * lens). The viewport does not fly on over him: he stays in the picture, clear of the caption, until he has
 * faded out (FLY.aim: how far below the floor the viewport aims half way, which is what lifts him in the picture).
 */
const FLY = { up: 2.6, at: 0.5, aim: -0.3, end: 1.8 } as const;
function flyOut(e: number, ctx: DemoContext): DemoCam {
  const cam1 = throughCamera("cam1", ctx);
  const R = wholeRoom(ctx);
  const mid: Vec3 = [cam1.p[0], ctx.bounds.max[1] + FLY.up, cam1.p[2]];
  const xs = [BEAT.twin, BEAT.twin + FLY.at, BEAT.twin + FLY.end];
  return {
    p: pchip3(xs, [cam1.p, mid, R.p], e),
    t: pchip3(xs, [cam1.t, [lerp(cam1.t[0], R.t[0], 0.5), ctx.bounds.min[1] + FLY.aim, lerp(cam1.t[2], R.t[2], 0.5)], R.t], e),
    roll: pchip(xs, [cam1.roll, 0, 0], e),
    fov: pchip(xs, [cam1.fov, lerp(cam1.fov, R.fov, 0.6), R.fov], e),
  };
}

/** The free camera: metres from him at its start (CAM 04's line of sight), half way round, and at its end (CAM 01's). */
const FREE_D = [3.5, 3.0, 3.3] as const;
/** Its field of view at its start, and how far above his feet it aims (below his chest: he stands in the upper part of the picture, clear of the caption). */
const FREE_FOV = 55;
const AIM_UP = 0.74;
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
  return { p: fromPolar(chest, lerp(from.az, to.az, w), lerp(from.el, to.el, w), d), t: [feet[0], feet[1] + AIM_UP, feet[2]], roll: 0, fov: lerp(FREE_FOV, 52, w) };
}

/**
 * The tracking shot's stations, in the order it passes them (always turning the same way round him, the way
 * the free camera then goes on):
 *   0 the whole-room view, outside the window wall    4 CAM 02's line of sight
 *   1, 2 thirds of the straight way down to 3         5 high over his left side, which no camera looks at
 *   3 CAM 01's line of sight, just before its lens    6 CAM 03's line of sight
 *                                                     7 CAM 04's (the free camera's first view)
 * SPIN_U is where among them the shot is at the demo times SPIN_E. It comes straight down from the whole-room
 * view to where CAM 01 hangs (through the window wall beside it, which is open while the viewport is outside)
 * and lands on that camera's line of sight behind him, slides along the door end onto CAM 02's, rises over
 * his left side and overtakes him, comes down in front of him onto CAM 03's and settles onto CAM 04's as he
 * reaches the table. No stop on the way: it slows where a camera looks and never stands still.
 */
const SPIN_E = [
  BEAT.track - 0.55,
  BEAT.track - 0.35,
  BEAT.track - 0.1,
  BEAT.track + 0.15,
  BEAT.track + 0.55,
  BEAT.track + 0.95,
  BEAT.track + 1.35,
  BEAT.track + 2.15,
  BEAT.track + 2.4,
  BEAT.track + 3.35,
  BEAT.track + 4.3,
  BEAT.track + 5.0,
  BEAT.free,
] as const;
const SPIN_U = [0, 0.12, 0.82, 1.62, 2.44, 2.94, 3.07, 3.93, 4.07, 5, 6, 6.93, 7] as const;
/** Metres from him on the lines of sight of CAM 01 .. CAM 04 (never nearer a lens than SPIN_CLEAR, nor the door-end wall than SPIN_DOOR). */
const SPIN_D = { cam1: 3.0, cam2: 3.8, cam3: 4.4, cam4: 4.3 } as const;
const SPIN_CLEAR = 0.3;
const SPIN_DOOR = 0.6;
/**
 * Over the top: metres to his left, above his chest and ahead of him; `wall`: and no nearer the far wall than
 * this (its shelves and the tall cabinet stand out from it).
 */
const SPIN_TOP = { side: 1.8, up: 3.4, ahead: -0.2, wall: 1.05 } as const;
/** The lens stays as wide as the whole-room view's down to CAM 01's line (he is close there), then closes to the free camera's. */
const SPIN_WIDE = 60;
/** Seconds from its start by which the shot aims at him (the aim goes first: he stays in the picture as it closes in). */
const SPIN_AIM = 0.8;

/**
 * The tracking shot at demo time e: once round him as he walks in. Its stations are points in the room that
 * move with him (a camera's line of sight to him turns as he walks); between them every coordinate goes
 * monotonically from one to the next, so the way stays in the clear space the stations are set in. On a
 * camera's line his body is that camera's own picture of him (see lookStateAt): that is what the shot goes
 * from one to the next for. On CAM 04's line it moves in on him, to the free camera's first view.
 */
function trackCamera(e: number, ctx: DemoContext): DemoCam {
  const R = wholeRoom(ctx);
  const u = pchip(SPIN_E, SPIN_U, e);
  if (u <= 0) return R;
  const feet = ctx.live ?? ctx.door ?? ctx.subject;
  const chest = chestOf(feet);
  const on = (id: CameraId, d: number): Vec3 => {
    const to = sub(ctx.poses[id].position, chest);
    const length = Math.hypot(to[0], to[1], to[2]);
    // (he walks in past the door: behind him the room ends before the shot's distance does)
    const wall = to[2] < -1e-6 ? ((ctx.bounds.min[2] + SPIN_DOOR - chest[2]) / to[2]) * length : Infinity;
    const k = Math.min(d, Math.max(length - SPIN_CLEAR, 1), Math.max(wall, 1)) / length;
    return [chest[0] + to[0] * k, chest[1] + to[1] * k, chest[2] + to[2] * k];
  };
  const cam1 = on("cam1", SPIN_D.cam1);
  const top: Vec3 = [Math.min(chest[0] + SPIN_TOP.side, ctx.bounds.max[0] - SPIN_TOP.wall), chest[1] + SPIN_TOP.up, chest[2] + SPIN_TOP.ahead];
  const cam4 = on("cam4", lerp(SPIN_D.cam4, FREE_D[0], easeInOut(span(e, SPIN_E[SPIN_E.length - 2], BEAT.free))));
  const stations: Vec3[] = [R.p, lerp3(R.p, cam1, 1 / 3), lerp3(R.p, cam1, 2 / 3), cam1, on("cam2", SPIN_D.cam2), top, on("cam3", SPIN_D.cam3), cam4];
  const xs = stations.map((_, i) => i);
  const wide = Math.max(SPIN_WIDE, FREE_FOV);
  return {
    p: pchip3(xs, stations, u),
    t: lerp3(R.t, [feet[0], feet[1] + AIM_UP, feet[2]], smooth(span(e, SPIN_E[0], SPIN_E[0] + SPIN_AIM))),
    roll: 0,
    fov: pchip(xs, [R.fov, wide, wide, wide, FREE_FOV, FREE_FOV, FREE_FOV, FREE_FOV], u),
  };
}

/**
 * The recording shown beside the tracking shot: that of the camera whose line of sight the shot is on, or is
 * next to on its way round him (CAM 04 has him only once that picture has gone). The 3D view and the camera's
 * own picture of the same moment, from the same side.
 */
function pipCamAt(e: number): CameraId {
  const u = pchip(SPIN_E, SPIN_U, e);
  return u < 3.5 ? "cam1" : u < 5 ? "cam2" : "cam3";
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
  // the twin: out of CAM 01 to the whole room, which stays until he has come in
  if (e < BEAT.twin + FLY.end) return flyOut(e, ctx);
  if (e < BEAT.free) return trackCamera(e, ctx);

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
