import type { CameraId, CameraPoseConfig, RoomBounds, Vec3 } from "../../types/security";
import type { SubjectRenderMode } from "../../store/useViewStore";
import { CCTV_ASPECT } from "../../config/cctv";
import { poseForward } from "../../lib/cameraMath";
import { homePose } from "../../scene/cameraPoses";

/**
 * The demo walkthrough as data: everything on screen is a pure function of the demo clock `e` (seconds).
 * The director evaluates these every frame, so the walkthrough can be played in real time or stepped
 * frame by frame (recording) with the same result.
 *
 *   0.0  wall of the four CCTV feeds, already playing; the subject picked out in each
 *   2.0  push into CAM 01, then the viewport flies through the room to CAM 02, 03, 04 and back to 01 (as the
 *        viewer's camera buttons do), each camera's recording dissolving in on arrival: the subject in every view
 *   6.0  real footage 100% → 0% on CAM 01: the 3D reconstruction is underneath, same framing
 *   7.6  the room melts to its wireframe
 *   8.4  the camera swings out to the overview while time rewinds and the room drains to the floor grid
 *   9.85 the empty grid and the four cameras' coverage; the room is rebuilt from the scan
 *  11.7  straight above the room: the subject's whole path across the floor, drawn in red
 *  14.0  incident replay while the camera orbits the room and comes down to the subject
 *  18.4  wireframe room: the subject alone, lifting the chair
 *  20.7  freeze; free camera around the subject: footage / X-ray / tracking / full texture
 *  23.7  end card
 */
export const DEMO_DURATION = 24.9;
/** How long the end card stays before the demo closes itself. */
export const END_HOLD_SECONDS = 5;
export const DEMO_SUBJECT = "subject-01";
export const DEMO_CLIP = "clip02";
/** Incident time shown at e = 0: the subject is walking up the room, in sight of all four cameras. */
export const DEMO_START_TIME = 10.8;
/** Incident time of the freeze frame (the subject mid-stride, carrying the chair). */
export const FREEZE_TIME = 20.5;

export const BEAT = {
  wall: 0,
  lock: 2.0,
  reveal: 6.0,
  melt: 7.6,
  pivot: 8.4,
  rebuild: 9.85,
  path: 11.7,
  orbit: 14.0,
  isolate: 18.4,
  freeze: 20.7,
  end: 23.7,
} as const;

export const CAMERA_ORDER: CameraId[] = ["cam1", "cam2", "cam3", "cam4"];

// ---------------------------------------------------------------- easing

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Progress of e through [a, b], clamped to 0..1. */
export const span = (e: number, a: number, b: number) => clamp01((e - a) / (b - a));
export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
export const smooth = (t: number) => t * t * (3 - 2 * t);

/**
 * Monotone cubic interpolation (Fritsch-Carlson) through (xs, ys) with zero slope at both ends:
 * never overshoots a key, starts and stops at rest.
 */
export function pchip(xs: readonly number[], ys: readonly number[], x: number): number {
  const n = xs.length;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let i = 0;
  while (i < n - 2 && x > xs[i + 1]) i++;
  const h = (k: number) => xs[k + 1] - xs[k];
  const d = (k: number) => (ys[k + 1] - ys[k]) / h(k);
  const slope = (k: number) => {
    if (k === 0 || k === n - 1) return 0;
    const a = d(k - 1);
    const b = d(k);
    if (a * b <= 0) return 0;
    const w1 = 2 * h(k) + h(k - 1);
    const w2 = h(k) + 2 * h(k - 1);
    return (w1 + w2) / (w1 / a + w2 / b);
  };
  const hi = h(i);
  const t = (x - xs[i]) / hi;
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * hi * slope(i) + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * hi * slope(i + 1);
}

const pchip3 = (xs: readonly number[], vs: readonly Vec3[], x: number): Vec3 => [
  pchip(xs, vs.map((v) => v[0]), x),
  pchip(xs, vs.map((v) => v[1]), x),
  pchip(xs, vs.map((v) => v[2]), x),
];
const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

// ---------------------------------------------------------------- incident time

/** Rewind ends here: before any camera has seen the subject, so the rebuilt room is empty. */
const REWOUND_TIME = 3.6;
/** The wireframe starts to rise from the bare grid. */
const RISE = BEAT.rebuild + 0.25;

/**
 * The pass through the cameras at the lock. Leg by leg the viewport flies from one CCTV camera to the next
 * (as the viewer's own camera buttons move it), turned towards the subject on the way; the recording of the
 * camera it leaves dissolves out over the first LEAVE seconds of a leg, the next one's in over the last ARRIVE.
 * The long legs cross the whole room (CAM 02 → 03, CAM 04 → 01).
 */
interface LockLeg {
  from: CameraId;
  to: CameraId;
  at: number;
  len: number;
}
const LOCK_LEGS: LockLeg[] = [
  { from: "cam1", to: "cam2", at: 2.6, len: 0.45 },
  { from: "cam2", to: "cam3", at: 3.35, len: 0.75 },
  { from: "cam3", to: "cam4", at: 4.4, len: 0.45 },
  { from: "cam4", to: "cam1", at: 5.15, len: 0.75 },
];
const LEAVE = 0.12;
const ARRIVE = 0.12;
/** Back in CAM 01. */
const LOCK_END = LOCK_LEGS[LOCK_LEGS.length - 1].at + LOCK_LEGS[LOCK_LEGS.length - 1].len;
const LOCK_TIME = DEMO_START_TIME + BEAT.lock;
/**
 * The recordings run faster through the lock: the subject stands at the table for five seconds, and the
 * pass ends (incident time REVEAL_TIME) as he lifts the chair, so the reveal that follows shows him carrying
 * it towards CAM 01.
 */
const REVEAL_TIME = 20.6;
const LOCK_RATE = (REVEAL_TIME - LOCK_TIME) / (LOCK_END - BEAT.lock);
/** Where the incident clock stops once the footage is gone (it coasts on for 0.4 s of incident time). */
const HELD_TIME = REVEAL_TIME + (BEAT.melt - LOCK_END) + 0.4;
/** The replay under the orbit: from the empty room (REWOUND_TIME) to the subject at the table (ISOLATE_TIME). */
const ISOLATE_TIME = 18.6;
const ORBIT_RATE = (ISOLATE_TIME - REWOUND_TIME) / (BEAT.isolate - BEAT.orbit);

/** The leg under way at e and its progress 0..1, or null while the viewport rests in a camera. */
function lockLegAt(e: number): { leg: LockLeg; u: number } | null {
  for (const leg of LOCK_LEGS) if (e > leg.at && e < leg.at + leg.len) return { leg, u: (e - leg.at) / leg.len };
  return null;
}

/** The camera the viewport is in, or (mid-leg) the nearer one; CAM 01 outside the pass. */
function lockStop(e: number): CameraId {
  let id: CameraId = "cam1";
  for (const leg of LOCK_LEGS) if (e >= leg.at + leg.len / 2) id = leg.to;
  return id;
}

/** 0..1: how much of the recording is on screen through the pass (0 while the viewport flies). */
function passFootage(e: number): number {
  const at = lockLegAt(e);
  if (!at) return 1;
  const { leg } = at;
  return Math.max(1 - smooth(span(e, leg.at, leg.at + LEAVE)), smooth(span(e, leg.at + leg.len - ARRIVE, leg.at + leg.len)));
}

/** While true the recordings are on screen and play by themselves (at videoRate). */
export const videosLive = (e: number) => e < BEAT.melt;
/** Playback rate of the recordings while they are on screen. */
export const videoRate = (e: number) => (e >= BEAT.lock && e < LOCK_END ? LOCK_RATE : 1);

/** Master (incident) time shown at demo time e. */
export function incidentTime(e: number): number {
  if (e < BEAT.lock) return DEMO_START_TIME + Math.max(e, 0);
  if (e < LOCK_END) return LOCK_TIME + LOCK_RATE * (e - BEAT.lock);
  if (e < BEAT.melt) return REVEAL_TIME + (e - LOCK_END);
  if (e < BEAT.pivot) {
    // coasts to a stop as the footage is gone
    const u = span(e, BEAT.melt, BEAT.pivot);
    return HELD_TIME - 0.4 * (1 - u) * (1 - u);
  }
  if (e < BEAT.rebuild) return lerp(HELD_TIME, REWOUND_TIME, easeInOut(span(e, BEAT.pivot, BEAT.rebuild)));
  if (e < BEAT.orbit) return REWOUND_TIME;
  if (e < BEAT.isolate) return REWOUND_TIME + ORBIT_RATE * (e - BEAT.orbit);
  if (e < BEAT.freeze) return lerp(ISOLATE_TIME, FREEZE_TIME, span(e, BEAT.isolate, BEAT.freeze));
  if (e < BEAT.end) return FREEZE_TIME;
  return FREEZE_TIME + 0.3 * span(e, BEAT.end, DEMO_DURATION);
}

/** Footage frames the walkthrough draws (loaded and kept before the clock starts). */
export function frameWanted(masterTime: number): boolean {
  return masterTime >= DEMO_START_TIME - 0.2 && masterTime <= HELD_TIME + 0.2;
}

export function rateLabel(e: number): string {
  if (e < BEAT.lock) return "\u25B6 1.0\u00D7";
  if (e < LOCK_END) return `\u25B6\u25B6 ${LOCK_RATE.toFixed(1)}\u00D7`;
  if (e < BEAT.melt) return "\u25B6 1.0\u00D7";
  if (e < BEAT.pivot) return "\u275A\u275A HOLD";
  if (e < BEAT.rebuild) return "\u25C0\u25C0 REWIND";
  if (e < BEAT.orbit) return "\u275A\u275A PAUSED";
  if (e < BEAT.isolate) return `\u25B6\u25B6 ${ORBIT_RATE.toFixed(1)}\u00D7`;
  if (e < BEAT.freeze) return "\u25B6 REPLAY";
  if (e < BEAT.end) return "\u275A\u275A FREEZE";
  return "\u25B6 0.25\u00D7";
}

// ---------------------------------------------------------------- room build

export interface BuildState {
  /** World height below which the textured room is drawn. */
  texY: number;
  /** World height below which the wireframe is drawn. */
  wireY: number;
  wireMode: number;
  /** World height below which the wireframe is left out (scan geometry under the floor). */
  minY: number;
  /** Strength of the room's wireframe lines. */
  gain: number;
  /** Strength of the floor grid that rides the wireframe front. */
  grid: number;
}

const ALL = 1e6;
const NONE = -1e6;
/** Wireframe room behind the subject: its lines at this strength, so the subject stays the brightest thing. */
const WIRE_DIM = 0.5;
/** The subject alone in the wireframe room: the texture is gone by WIRE.in[1] and back from WIRE.out[0]. */
const WIRE = { in: [BEAT.isolate - 0.2, BEAT.isolate + 0.5], out: [BEAT.freeze + 2.2, BEAT.freeze + 2.9] } as const;
/** Demo time at share `f` of the orbit (its moments are set as shares, so they follow when it is retimed). */
const inOrbit = (f: number) => BEAT.orbit + f * (BEAT.isolate - BEAT.orbit);

/**
 * The scanned frames of the window wall: 1 drawn, 0 left out. The orbit passes outside that wall, where what
 * the scan caught of its frames would stand between the camera and the room. They go while the camera is still
 * at the end of the room, and are back, as wireframe first, once the room has turned to wire.
 */
export const windowFramesAt = (e: number) => (e < WIRE.in[1] ? 1 - smooth(span(e, inOrbit(0.4), inOrbit(0.54))) : 1);

/** Room build fronts at demo time e; floorY / topY = the room's floor and ceiling heights. */
export function buildAt(e: number, floorY: number, topY: number): BuildState {
  const y0 = floorY - 0.16;
  const y1 = topY + 0.3;
  const minY = floorY - 0.12; // above the drained front: nothing of the scan is left on the empty grid
  // the bare grid is the whole picture for a moment: brighter then, as built once the wireframe rises through it
  const grid = 1 + 0.9 * Math.min(span(e, BEAT.pivot + 0.9, BEAT.pivot + 1.4), 1 - span(e, RISE + 0.1, RISE + 0.6));
  const at = (texY: number, wireY: number, wireMode: number, gain = 1): BuildState => ({ texY, wireY, wireMode, minY, gain, grid });
  if (e < BEAT.melt) return at(ALL, ALL, 0);
  // texture dissolves from the ceiling down, leaving the wireframe
  if (e < BEAT.pivot) return at(lerp(y1, y0, easeInOut(span(e, BEAT.melt, BEAT.pivot))), ALL, 1, WIRE_DIM);
  // the wireframe drains down to the floor grid
  if (e < BEAT.rebuild) return at(NONE, lerp(y1, y0 + 0.02, easeInOut(span(e, BEAT.pivot, BEAT.rebuild))), 0, lerp(WIRE_DIM, 1, span(e, BEAT.pivot, BEAT.pivot + 0.7)));
  if (e < RISE) return at(NONE, y0 + 0.02, 0);
  // rebuild: wireframe rises from the floor, texture rises behind it
  if (e < BEAT.path) return at(e < RISE + 0.5 ? NONE : lerp(y0, y1, easeInOut(span(e, RISE + 0.5, BEAT.path))), lerp(y0 + 0.02, y1, easeInOut(span(e, RISE, RISE + 1.3))), 0);
  if (e < WIRE.in[0]) return at(ALL, ALL, 0);
  if (e < WIRE.in[1]) return at(lerp(y1, y0, easeInOut(span(e, WIRE.in[0], WIRE.in[1]))), ALL, 1, WIRE_DIM);
  if (e < WIRE.out[0]) return at(NONE, ALL, 1, WIRE_DIM);
  if (e < WIRE.out[1]) return at(lerp(y0, y1, easeInOut(span(e, WIRE.out[0], WIRE.out[1]))), ALL, 0, WIRE_DIM);
  return at(ALL, ALL, 0);
}

/**
 * Whether the ceiling is drawn. Off while the camera looks into the room from above (overview, top view,
 * orbit) and while it comes down to the subject; back on under the flash of the freeze.
 */
export function ceilingShown(e: number, cutY: number, wireY: number): boolean {
  if (e < BEAT.pivot) return true;
  if (e < RISE) return wireY >= cutY; // nothing is drawn above the wire front anyway
  return e >= BEAT.freeze;
}

/**
 * 0..1: the cameras' coverage volumes. They unfold over the bare grid, stay while the room is rebuilt and
 * fold away as the camera rises to the top view (the floor is the path's from there).
 */
export const coverageAt = (e: number) => (e < BEAT.path ? span(e, BEAT.rebuild - 0.25, BEAT.rebuild + 0.55) : 1 - span(e, BEAT.path + 0.05, BEAT.path + 0.5));

// ---------------------------------------------------------------- tracked path

export interface PathState {
  /** 0..1 of the path's length drawn, from the first observation on. */
  draw: number;
  /** 0..1: strength of the whole path (0 = not drawn). */
  alpha: number;
  /** 0..1: the labels on it (entry, stop, exit). */
  labels: number;
}

/** The path is drawn from PATH.draw[0] to PATH.draw[1], stays under the orbit and is gone as the room turns to wire. */
const PATH = { draw: [BEAT.path + 0.55, BEAT.path + 1.7], out: [BEAT.isolate - 0.35, BEAT.isolate + 0.25] } as const;

/** The subject's whole path on the floor, in red: drawn from above, then walked along under the orbit. */
export function pathAt(e: number): PathState {
  if (e < PATH.draw[0] || e >= PATH.out[1]) return { draw: 0, alpha: 0, labels: 0 };
  return {
    draw: easeInOut(span(e, PATH.draw[0], PATH.draw[1])),
    alpha: 1 - smooth(span(e, PATH.out[0], PATH.out[1])),
    // they belong to the view from above: gone as the orbit leaves it, before the subject walks in under them
    labels: 1 - span(e, BEAT.orbit - 0.05, BEAT.orbit + 0.2),
  };
}

/**
 * Pixels by which the scene's tag on the subject is moved up: the orbit sees him from far and from above,
 * where a tag just over his head would cover him.
 */
export const tagLiftAt = (e: number) => (e >= BEAT.path && e < BEAT.isolate ? 26 * (1 - smooth(span(e, inOrbit(0.52), BEAT.isolate))) : 0);

/** Whether the path's own readout (length so far) is on screen. */
export const pathReadout = (e: number) => e >= PATH.draw[0] - 0.1 && e < BEAT.orbit;

// ---------------------------------------------------------------- subject look

export type DemoLookName = "footage" | "xray" | "tracking" | "texture";
export const FREEZE_LOOKS: { name: DemoLookName; at: number; label: string }[] = [
  { name: "footage", at: BEAT.freeze, label: "REAL FOOTAGE" },
  { name: "xray", at: BEAT.freeze + 0.66, label: "X-RAY" },
  { name: "tracking", at: BEAT.freeze + 1.41, label: "TRACKING" },
  { name: "texture", at: BEAT.freeze + 2.07, label: "FULL 3D" },
];

export interface LookState {
  mode: SubjectRenderMode;
  /** The viewer's own X-RAY toggle (subject visible through obstacles). */
  xray: boolean;
  /** 0..1: cyan hologram drawn over the whole body. */
  hologram: number;
  /** Hologram only: the textured body is not drawn. */
  hideBody: boolean;
  /** 0: the hologram is a flat tint (as on the footage cut-out); 1: scan lines, rim light, a sweeping band. */
  holoStyle: number;
  /** World height of the hologram's bright band above the floor. */
  holoBand: number;
  /** 0..1: tracking bracket with the live fused values (0 = off; below 1 it is still closing in). */
  bracket: number;
  /** The scene's own floating tag on the subject is left out (the footage or the overlay labels it instead). */
  hideTags: boolean;
  /** The scene's own trail of the last seconds is left out (the whole path is on the floor instead). */
  hideTrail: boolean;
  /** Which look chip is lit during the freeze orbit. */
  name: DemoLookName | null;
}

const look = (name: DemoLookName) => FREEZE_LOOKS.find((l) => l.name === name)!.at;
/** The scene's own tag on the subject appears once the footage (which carries its own tag) is gone. */
const TAGS_FROM = BEAT.reveal + 1.3;

export function lookStateAt(e: number): LookState {
  const base: LookState = {
    mode: "hybrid",
    xray: false,
    hologram: 0,
    hideBody: false,
    holoStyle: 0,
    holoBand: -10,
    bracket: 0,
    hideTags: e < TAGS_FROM || e >= BEAT.isolate,
    hideTrail: e >= BEAT.path && e < PATH.out[1],
    name: null,
  };
  if (e < LOCK_LEGS[0].at - 0.1) return { ...base, mode: "model" };
  // the pass through the cameras: between two recordings the subject is the reconstruction, tinted like the cut-outs
  if (e < BEAT.reveal - 0.5) return { ...base, hologram: 1 };
  // the X-ray highlight carries over from the footage onto the reconstruction, then lets go
  if (e < BEAT.pivot) return { ...base, hologram: 1 - span(e, BEAT.reveal + 1.1, BEAT.reveal + 1.55) };
  // rewind, overview, top view and orbit: baked texture only (time runs backwards, then three times as fast)
  if (e < WIRE.in[0]) return { ...base, mode: "model" };
  // isolated in the wireframe room: the fused track's values ride along
  if (e < BEAT.freeze) return { ...base, bracket: easeOut(span(e, BEAT.isolate + 0.65, BEAT.isolate + 1.0)) };
  if (e < look("xray")) return { ...base, name: "footage" };
  // (the viewer's own X-ray switch goes on here too: the debug figure of the next look then has its see-through pass ready)
  if (e < look("tracking")) return { ...base, xray: true, hologram: 1, hideBody: true, holoStyle: 1, holoBand: lerp(-0.25, 2.1, span(e, look("xray"), look("tracking") - 0.1)), name: "xray" };
  if (e < look("texture")) return { ...base, mode: "avatar", xray: true, bracket: easeOut(span(e, look("tracking"), look("tracking") + 0.25)), name: "tracking" };
  if (e < BEAT.end) return { ...base, name: "texture" };
  return base;
}

// ---------------------------------------------------------------- CCTV wall

/** One recording filling the screen. */
export interface WallView {
  cam: CameraId;
  /** Closer in on the subject: 0 the whole picture (the pass keeps it there: the 3D view under it must match). */
  punch: number;
  /** Incident time whose cut-out frames the punch-in (it does not chase the subject from frame to frame). */
  focusTime: number;
}

export interface WallState {
  visible: boolean;
  /** 0: 2x2 wall, 1: one camera fills the screen. */
  zoom: number;
  /** 0..1: the subject's cut-out lit, with bracket and tag. */
  highlight: number;
  /** 0..1: the feeds dimmed around the cut-out. */
  dim: number;
  /** 0..1: X-ray tint on the cut-out. */
  tint: number;
  /** "Real footage" slider: 1 = recording, 0 = reconstruction only. */
  footage: number;
  /** The camera on screen once the wall has zoomed in (the one the viewport is in, or nearest to). */
  view: WallView;
}

/** The wall's tile 1 has grown into the whole screen by here. */
const PUSHED = BEAT.lock + 0.5;

export function wallAt(e: number): WallState {
  // "real footage" slider at the reveal, and the dissolves between the cameras of the pass before it
  const footage = (1 - easeInOut(span(e, BEAT.reveal + 0.25, BEAT.reveal + 1.35))) * passFootage(e);
  const highlight = easeOut(span(e, 0.7, 1.1));
  return {
    visible: e < BEAT.reveal + 1.4 && footage > 0.002,
    zoom: easeInOut(span(e, BEAT.lock, PUSHED)),
    highlight,
    // "100% real footage" is the recording as filmed: the dimming lifts before the slider moves
    dim: highlight * (1 - smooth(span(e, LOCK_END - 0.05, BEAT.reveal + 0.2))),
    tint: smooth(span(e, 1.2, 1.6)),
    footage,
    view: { cam: lockStop(e), punch: 0, focusTime: incidentTime(e) },
  };
}

// ---------------------------------------------------------------- chapters

export interface Chapter {
  at: number;
  rail: string;
  title: string;
  sub: string;
}

export const CHAPTERS: Chapter[] = [
  { at: BEAT.wall, rail: "FEEDS", title: "4 CCTV CAMERAS. ONE INCIDENT.", sub: "SAM 2.1 isolates the subject in every feed" },
  { at: BEAT.lock, rail: "LOCK", title: "SUBJECT LOCKED", sub: "The same person in all four views \u00B7 X-ray" },
  { at: BEAT.reveal, rail: "REVEAL", title: "REAL FOOTAGE \u2192 3D RECONSTRUCTION", sub: "Same camera, same instant, no video left" },
  { at: BEAT.melt, rail: "TWIN", title: "LIDAR DIGITAL TWIN", sub: "Every surface of the room, to scale" },
  { at: BEAT.pivot, rail: "REBUILD", title: "REWIND. REBUILD.", sub: "The scene reassembles from the scan" },
  { at: BEAT.path, rail: "PATH", title: "EVERY STEP. TRACKED.", sub: "His route across the floor, fused from four cameras" },
  { at: BEAT.orbit, rail: "REPLAY", title: "INCIDENT REPLAY", sub: "Four recordings fused on one clock" },
  { at: BEAT.isolate, rail: "ISOLATE", title: "SUBJECT ISOLATED", sub: "Tracked in 3D, lifted out of the video" },
  { at: BEAT.freeze, rail: "FREE CAM", title: "FREE CAMERA. INFINITE ANGLES.", sub: "Freeze any moment and walk around it" },
];

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
  return Math.max(pulse(BEAT.freeze, 0.28, 0.55), ...FREEZE_LOOKS.slice(1).map((l) => pulse(l.at, 0.16, 0.2)));
}

// ---------------------------------------------------------------- camera

export interface DemoCam {
  p: Vec3;
  /** Look-at point. */
  t: Vec3;
  /** Screen-up direction; left out: the world's up. (Needed looking straight down, where the world's up is the view axis.) */
  up?: Vec3;
  /** Degrees about the view axis (CCTV mounts are not level). */
  roll: number;
  /** Vertical field of view of the viewport, degrees. */
  fov: number;
}

export interface DemoContext {
  poses: Record<CameraId, CameraPoseConfig>;
  bounds: RoomBounds;
  aspect: number;
  /** Feet of the subject at FREEZE_TIME: centre of the free-camera orbit. */
  subject: Vec3;
  /** Feet of the subject at the shown time (null while absent). */
  live: Vec3 | null;
}

const DEG = Math.PI / 180;

/** Portrait windows: the viewport opens up to this vertical FOV to keep more of a CCTV camera's width. */
const PORTRAIT_FOV = 102;

/**
 * Vertical FOV of the viewport when it looks through a CCTV camera (calibrated vertical FOV `fov`).
 * Landscape window: the 16:9 recording fills it edge to edge (cover fit), so the reconstruction lines up
 * with the footage drawn the same way in the CCTV wall. Portrait window (a phone held upright): a cover fit
 * would keep only a quarter of the picture's width, so the viewport opens up instead and the recording is
 * a band across its middle (see footageBand), with the reconstruction carrying on above and below it.
 */
export function coverFov(fov: number, aspect: number) {
  if (aspect >= 1) return (2 * Math.atan(Math.tan((fov * DEG) / 2) * Math.min(1, CCTV_ASPECT / aspect))) / DEG;
  const whole = (2 * Math.atan((Math.tan((fov * DEG) / 2) * CCTV_ASPECT) / aspect)) / DEG; // the full width fits
  return lerp(fov, Math.max(fov, Math.min(whole, PORTRAIT_FOV)), smooth(clamp01((1 - aspect) / 0.25)));
}

/** Share of the viewport's height that the recording's picture takes at coverFov (1 = fills it, or more). */
export function footageBand(fov: number, aspect: number) {
  return Math.tan((fov * DEG) / 2) / Math.tan((coverFov(fov, aspect) * DEG) / 2);
}

function throughCamera(id: CameraId, ctx: DemoContext, reach = 7): DemoCam {
  const pose = ctx.poses[id];
  const f = poseForward(pose);
  const p = pose.position;
  return { p: [p[0], p[1], p[2]], t: [p[0] + f[0] * reach, p[1] + f[1] * reach, p[2] + f[2] * reach], roll: pose.roll, fov: coverFov(pose.fov, ctx.aspect) };
}

/** Until here the viewport still counts as CAM 01 (its own marker, a few centimetres away, is not drawn). */
const LEFT_CAM1 = BEAT.pivot + 0.25;

/** The CCTV camera the viewport looks through, else null. */
export function cctvAt(e: number): CameraId | null {
  return e < LEFT_CAM1 ? lockStop(e) : null;
}

/** The camera whose picture is on screen from the lock until the viewport leaves CAM 01, else null. */
export function lockCamAt(e: number): CameraId | null {
  return e < BEAT.lock || e >= LEFT_CAM1 ? null : lockStop(e);
}

/** 0..1: the CCTV look (scan lines) over the viewport while it is CAM 01. */
export const scanLinesAt = (e: number) => 1 - span(e, LEFT_CAM1, LEFT_CAM1 + 0.2);

const unwrap = (deg: number, near: number) => deg + 360 * Math.round((near - deg) / 360);

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Part of the frame the room may fill in the overview: clear of the top bar and of the caption. */
const FRAME = { halfWidth: 0.9, top: 0.84, bottom: -0.62 };

/** Direction of the viewer's home view: degrees around the room and above the floor. */
function homeAngles(ctx: DemoContext) {
  const home = homePose("orbit", ctx.bounds, ctx.aspect);
  const away = sub(home.position, home.target);
  return { az: Math.atan2(away[0], away[2]) / DEG, el: Math.atan2(away[1], Math.hypot(away[0], away[2])) / DEG, fov: home.fov };
}

/**
 * The room seen from outside: from `azimuth` degrees around it and `elevation` degrees above the floor
 * (90 = straight down, with the side the camera came up from at the bottom of the screen), moved in until
 * the room fills the frame and centred in the part of it the overlay leaves free.
 */
function fit(ctx: DemoContext, azimuth: number, elevation: number): DemoCam & { up: Vec3 } {
  const b = ctx.bounds;
  const home = homePose("orbit", b, ctx.aspect);
  const az = azimuth * DEG;
  const el = elevation * DEG;
  const dir: Vec3 = [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];
  const f: Vec3 = [-dir[0], -dir[1], -dir[2]];
  const right: Vec3 = [Math.cos(az), 0, -Math.sin(az)];
  const up: Vec3 = [-Math.sin(el) * Math.sin(az), Math.cos(el), -Math.sin(el) * Math.cos(az)];
  const tan = Math.tan((home.fov * DEG) / 2);
  const corners: Vec3[] = [];
  for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) corners.push([x, y, z]);
  // the room's rectangle on screen (NDC) from distance d, looking at t
  const rect = (t: Vec3, d: number) => {
    const p: Vec3 = [t[0] + dir[0] * d, t[1] + dir[1] * d, t[2] + dir[2] * d];
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const c of corners) {
      const v = sub(c, p);
      const z = Math.max(dot(v, f), 0.05);
      const x = dot(v, right) / (z * tan * ctx.aspect);
      const y = dot(v, up) / (z * tan);
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
    return { x0, x1, y0, y1 };
  };
  let t: Vec3 = [home.target[0], home.target[1], home.target[2]];
  let d = Math.hypot(...sub(home.position, home.target));
  for (let pass = 0; pass < 4; pass++) {
    let lo = 1;
    let hi = 80;
    for (let i = 0; i < 22; i++) {
      const mid = (lo + hi) / 2;
      const r = rect(t, mid);
      if (r.x1 - r.x0 <= 2 * FRAME.halfWidth && r.y1 - r.y0 <= FRAME.top - FRAME.bottom) hi = mid;
      else lo = mid;
    }
    d = hi;
    const r = rect(t, d);
    const dx = ((r.x0 + r.x1) / 2) * d * tan * ctx.aspect;
    const dy = ((r.y0 + r.y1) / 2 - (FRAME.top + FRAME.bottom) / 2) * d * tan;
    t = [t[0] + right[0] * dx + up[0] * dy, t[1] + right[1] * dx + up[1] * dy, t[2] + right[2] * dx + up[2] * dy];
  }
  return { p: [t[0] + dir[0] * d, t[1] + dir[1] * d, t[2] + dir[2] * d], t, up, roll: 0, fov: home.fov };
}

/** Straight above the room its long side lies across the screen, the end the subject comes in by on the right. */
const TOP_AZ = 90;
/** The camera is straight above the room by here; the path is drawn under it. */
const TOP_AT = BEAT.path + 1.05;
/** From here the orbit leaves the whole room for the subject. */
const CLOSE_FROM = inOrbit(0.52);
/** Where the orbit hands over to the free camera: metres from the subject, and above the floor. */
const CLOSE = { r: 3.6, h: 4.2 };

/** Mid-leg the viewport drops this far (m) below the cameras' height, opens its view by FLY_WIDEN degrees and turns this share of the way to the subject. */
const FLY_DIP = 0.25;
const FLY_WIDEN = 8;
const FLY_AIM = 0.75;
const smoother = (t: number) => t * t * t * (t * (6 * t - 15) + 10);
const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
/** Angle in (-PI, PI]. */
const wrapPi = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));

/**
 * The viewport through the pass: in a camera, or flying from one to the next. Position, heading and FOV run
 * from camera to camera at rest at both ends (so each recording dissolves in over its own view); on the way it
 * dips, opens up a little and turns towards the subject. A half turn goes the way that looks into the room.
 */
function passCamera(e: number, ctx: DemoContext): DemoCam {
  const at = lockLegAt(e);
  if (!at) return throughCamera(lockStop(e), ctx);
  const A = throughCamera(at.leg.from, ctx);
  const B = throughCamera(at.leg.to, ctx);
  const k = smoother(at.u);
  const bump = Math.sin(Math.PI * k);
  const p = lerp3(A.p, B.p, k);
  p[1] -= FLY_DIP * bump;
  const fa = norm(sub(A.t, A.p));
  const fb = norm(sub(B.t, B.p));
  const ya = Math.atan2(fa[0], fa[2]);
  let yb = ya + wrapPi(Math.atan2(fb[0], fb[2]) - ya);
  if (Math.abs(yb - ya) > (100 * Math.PI) / 180) {
    const alt = yb - 2 * Math.PI * Math.sign(yb - ya);
    const mid = lerp3(A.p, B.p, 0.5);
    const c = ctx.bounds.center;
    const faces = (y: number) => Math.sin(y) * (c[0] - mid[0]) + Math.cos(y) * (c[2] - mid[2]);
    if (faces((ya + alt) / 2) > faces((ya + yb) / 2)) yb = alt;
  }
  const yaw = lerp(ya, yb, k);
  const pitch = lerp(Math.asin(fa[1]), Math.asin(fb[1]), k);
  const heading: Vec3 = [Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw)];
  const feet = ctx.live ?? ctx.subject;
  const aim = norm(sub([feet[0], feet[1] + 0.98, feet[2]], p));
  const d = norm(lerp3(heading, aim, FLY_AIM * bump));
  return { p, t: [p[0] + d[0] * 7, p[1] + d[1] * 7, p[2] + d[2] * 7], roll: lerp(A.roll, B.roll, k), fov: lerp(A.fov, B.fov, k) + FLY_WIDEN * bump };
}

export function cameraAt(e: number, ctx: DemoContext): DemoCam {
  const cam1 = throughCamera("cam1", ctx);
  if (e < BEAT.pivot) return passCamera(e, ctx);

  const home = homeAngles(ctx);
  if (e < BEAT.path) {
    // Out of CAM 01 and round to the overview over the empty floor grid, then a slow drift while the room is rebuilt.
    const [cx, , cz] = ctx.bounds.center;
    const A = fit(ctx, home.az - 10, home.el);
    const B = fit(ctx, home.az + 8, home.el);
    const polar = (p: Vec3) => ({ az: Math.atan2(p[0] - cx, p[2] - cz) / DEG, r: Math.hypot(p[0] - cx, p[2] - cz), h: p[1] });
    const a = polar(A.p);
    const b = polar(B.p);
    const c1 = polar(cam1.p);
    const xs = [BEAT.pivot, BEAT.pivot + 1.4, BEAT.path];
    const az = pchip(xs, [unwrap(c1.az, a.az - 180), a.az, b.az], e) * DEG; // CAM 01 is across the room from the overview
    const r = pchip(xs, [c1.r, a.r, b.r], e);
    return {
      p: [cx + r * Math.sin(az), pchip(xs, [c1.h, a.h, b.h], e), cz + r * Math.cos(az)],
      t: pchip3(xs, [cam1.t, A.t, B.t], e),
      roll: pchip(xs, [cam1.roll, 0, 0], e),
      fov: pchip(xs, [cam1.fov, A.fov, B.fov], e),
    };
  }

  if (e < BEAT.orbit) {
    // Up to straight above the room, turning its long side across the screen; a slow creep while the path is drawn.
    const u = easeInOut(span(e, BEAT.path, TOP_AT));
    return fit(ctx, lerp(home.az + 8, TOP_AZ, u) + 2 * span(e, TOP_AT, BEAT.orbit), lerp(home.el, 90, u));
  }

  // From here on the camera keeps turning the same way: round the room and down (orbit), in to the subject
  // (isolate), round the frozen moment (free camera), ending on CAM 01's side of the subject (filmed sharpest).
  const cam4 = throughCamera("cam4", ctx);
  const S = ctx.subject;
  const xs = [BEAT.isolate, BEAT.freeze, BEAT.end, DEMO_DURATION];
  const az4 = unwrap(Math.atan2(cam4.p[0] - S[0], cam4.p[2] - S[2]) / DEG, TOP_AZ + 260);
  const azEnd = unwrap(Math.atan2(cam1.p[0] - S[0], cam1.p[2] - S[2]) / DEG, az4 + 180);
  const azDeg = pchip([BEAT.orbit, ...xs], [TOP_AZ + 2, az4 - 18, az4 + 52, azEnd, azEnd + 15], e);
  const az = azDeg * DEG;
  const r = pchip(xs, [CLOSE.r, 2.3, 2.35, 3.1], e);
  const h = pchip(xs, [CLOSE.h, S[1] + 1.5, S[1] + 1.5, S[1] + 1.8], e);
  const feet = ctx.live ?? S;
  const chest: Vec3 = [feet[0], feet[1] + 0.98, feet[2]];
  const close: DemoCam = { p: [S[0] + r * Math.sin(az), h, S[2] + r * Math.cos(az)], t: chest, roll: 0, fov: pchip(xs, [home.fov, 58, 55, 55], e) };
  if (e >= BEAT.isolate) return close;

  // Orbit: the whole room in the frame, from straight above down to a three-quarter view, then in to the subject.
  const wide = fit(ctx, azDeg, pchip([BEAT.orbit, CLOSE_FROM, BEAT.isolate], [90, 46, 40], e));
  const w = easeInOut(span(e, CLOSE_FROM, BEAT.isolate));
  // (straight down the world's up is the view axis: the fit's own up keeps the room's long side across the screen)
  return { p: lerp3(wide.p, close.p, w), t: lerp3(wide.t, close.t, w), up: w > 0 ? undefined : wide.up, roll: 0, fov: close.fov };
}
