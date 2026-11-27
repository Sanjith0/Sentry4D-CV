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
 *   2.0  push into CAM 02, then the viewport flies through the room to CAM 03, 04 and 01 (as the viewer's
 *        camera buttons do), each camera's recording dissolving in on arrival: the subject in every view
 *        (the pass starts in CAM 02, not CAM 01: one flight fewer, and that time goes to the replay)
 *   5.32 real footage 100% → 0% on CAM 01: the 3D reconstruction is underneath, same framing
 *   6.92 LIDAR DIGITAL TWIN: the room melts to its wireframe (held 1.4 s); he keeps walking (into 0.55x)
 *   8.32 the subject fades out mid-stride as a hologram; the camera swings out to the overview while time rewinds and the
 *        wireframe thins away evenly under a descending scan grid (no glowing front, no labels hopping)
 *   9.77 the empty grid and the four cameras' coverage; the room is rebuilt from the scan
 *  10.62 the replay starts (1.5x): he walks in as his whole path is drawn on (walked part cyan, rest red)
 *  11.62 straight above the room as he walks
 *  13.12 the replay carries on while the camera orbits the room and comes down to the subject (faster only
 *        while he stands at the table)
 *  19.1  wireframe room: the subject alone, lifting the chair
 *  21.8  slow motion; free camera round the subject as he walks: footage / X-ray / full texture, coming to
 *        rest on CAM 01's line of sight (his own recorded pixels) as he walks towards it with the chair
 *  23.8  end card over that view (a slow push in)
 */
export const DEMO_DURATION = 25.0;
/** How long the end card stays before the demo closes itself. */
export const END_HOLD_SECONDS = 5;
export const DEMO_SUBJECT = "subject-01";
/** Demo time applied behind the loading card while the recordings are brought to DEMO_START_TIME. */
export const PREP_E = 0;
/** Demo times drawn once behind the loading card: every look, and the path, has its shaders compiled by then. */
export const WARM_UP: readonly number[] = [3.7, 6.9, 8.1, 9.8, 11.5, 13.3, 14.5, 16.5, 18.7, 19.8, 21.6, 22.3, 23.1, 23.5];
export const DEMO_CLIP = "clip02";
/** Incident time shown at e = 0: the subject is walking up the room, in sight of all four cameras. */
export const DEMO_START_TIME = 10.8;
/** Incident time at the start of the free camera (the subject mid-stride, carrying the chair). */
export const FREEZE_TIME = 20.5;
/** Under the free camera the incident keeps playing, in slow motion at this rate. */
export const SLOW_RATE = 0.4;
/** Seconds over which the replay eases from the isolate beat's pace down to SLOW_RATE. */
const SLOW_EASE = 0.3;

export const BEAT = {
  wall: 0,
  lock: 2.0,
  reveal: 5.32,
  melt: 6.92,
  pivot: 8.32,
  rebuild: 9.77,
  path: 11.62,
  orbit: 13.12,
  isolate: 19.1,
  freeze: 21.8,
  end: 23.8,
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

export const pchip3 = (xs: readonly number[], vs: readonly Vec3[], x: number): Vec3 => [
  pchip(xs, vs.map((v) => v[0]), x),
  pchip(xs, vs.map((v) => v[1]), x),
  pchip(xs, vs.map((v) => v[2]), x),
];
export const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

// ---------------------------------------------------------------- incident time

/** Rewind ends here: just before any camera has seen the subject (4.2 s), so the rebuilt room is empty. */
const REWOUND_TIME = 4.0;
/** The wireframe starts to rise from the bare grid. */
const RISE = BEAT.rebuild + 0.25;

/**
 * The pass through the cameras at the lock. Leg by leg the viewport flies from one CCTV camera to the next
 * (as the viewer's own camera buttons move it), turned towards the subject on the way; the recording of the
 * camera it leaves dissolves out over the first LEAVE seconds of a leg, the next one's in over the last ARRIVE.
 * The long legs cross the whole room (CAM 02 → 03, CAM 04 → 01). The pass starts in CAM 02 (the wall pushes
 * into its tile) and ends in CAM 01, where the reveal and the twin play: every camera once, three flights.
 */
interface LockLeg {
  from: CameraId;
  to: CameraId;
  at: number;
  len: number;
}
const LOCK_LEGS: LockLeg[] = [
  { from: "cam2", to: "cam3", at: 2.55, len: 0.9 },
  { from: "cam3", to: "cam4", at: 3.53, len: 0.6 },
  { from: "cam4", to: "cam1", at: 4.21, len: 0.9 },
];
/** The camera the wall pushes into: the pass starts there. */
export const LOCK_FIRST: CameraId = LOCK_LEGS[0].from;
/** Each recording is up on its own for only this long between two legs: the pass keeps moving. */
const LEAVE = 0.1;
const ARRIVE = 0.1;
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
/**
 * Once the footage is gone he keeps walking: through the LIDAR DIGITAL TWIN beat the clock eases down to
 * TWIN_RATE (slow motion, so he is still in CAM 01's view) and runs on until he has faded out at the start
 * of the rewind (REWIND_FROM); the rewind starts from where he is then (HELD_TIME).
 */
const TWIN_RATE = 0.55;
const TWIN_EASE = 0.6;
const REWIND_FROM = BEAT.pivot + 0.3;
const MELT_TIME = REVEAL_TIME + (BEAT.melt - LOCK_END);
/** Incident time from the melt on (rate 1 eased down to TWIN_RATE over TWIN_EASE seconds: its integral). */
function twinTime(e: number): number {
  const x = Math.max(e - BEAT.melt, 0);
  const u = Math.min(x / TWIN_EASE, 1);
  return MELT_TIME + x - (1 - TWIN_RATE) * (TWIN_EASE * (u * u * u - (u * u * u * u) / 2) + Math.max(x - TWIN_EASE, 0));
}
const twinRate = (e: number) => 1 - (1 - TWIN_RATE) * smooth(span(e, BEAT.melt, BEAT.melt + TWIN_EASE));
const HELD_TIME = twinTime(REWIND_FROM);
/** The replay under the top view and the orbit: from the empty room (REWOUND_TIME) to the subject at the table (ISOLATE_TIME). */
const ISOLATE_TIME = 18.6;
/**
 * The replay starts while the room is still being rebuilt, so the subject walks in as it completes and the
 * red path is drawn behind him step by step, from the overview, through the top view and on under the orbit
 * (walking and drawing the path are one beat). He walks at WALK_RATE until he has slowed at the table
 * (WALK_END_TIME); only the time he stands there is run through faster, eased in and out, to reach
 * ISOLATE_TIME on the isolate beat.
 */
const WALK_FROM = BEAT.path - 1.0;
const WALK_RATE = 1.5;
const WALK_END_TIME = 11.8;
const WALK_END = WALK_FROM + (WALK_END_TIME - REWOUND_TIME) / WALK_RATE;

/** Incident time through the replay (WALK_FROM .. isolate) and its rate. */
function replayAt(e: number): { t: number; rate: number } {
  if (e < WALK_END) return { t: REWOUND_TIME + WALK_RATE * (e - WALK_FROM), rate: WALK_RATE };
  // cubic Hermite from (WALK_END, WALK_END_TIME) to (isolate, ISOLATE_TIME), WALK_RATE at both ends
  const L = BEAT.isolate - WALK_END;
  const u = clamp01((e - WALK_END) / L);
  const u2 = u * u;
  const u3 = u2 * u;
  const dp = ISOLATE_TIME - WALK_END_TIME;
  const t = WALK_END_TIME + (u3 - 2 * u2 + u) * L * WALK_RATE + (-2 * u3 + 3 * u2) * dp + (u3 - u2) * L * WALK_RATE;
  const rate = (3 * u2 - 4 * u + 1) * WALK_RATE + ((-6 * u2 + 6 * u) * dp) / L + (3 * u2 - 2 * u) * WALK_RATE;
  return { t, rate };
}

/** The leg under way at e and its progress 0..1, or null while the viewport rests in a camera. */
function lockLegAt(e: number): { leg: LockLeg; u: number } | null {
  for (const leg of LOCK_LEGS) if (e > leg.at && e < leg.at + leg.len) return { leg, u: (e - leg.at) / leg.len };
  return null;
}

/** The camera the viewport is in, or (mid-leg) the nearer one: the pass's first camera before it, CAM 01 after. */
function lockStop(e: number): CameraId {
  let id: CameraId = LOCK_FIRST;
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
  if (e < REWIND_FROM) return twinTime(e);
  if (e < BEAT.rebuild) return lerp(HELD_TIME, REWOUND_TIME, easeInOut(span(e, REWIND_FROM, BEAT.rebuild)));
  if (e < WALK_FROM) return REWOUND_TIME;
  if (e < BEAT.isolate) return replayAt(e).t;
  if (e < BEAT.freeze) return lerp(ISOLATE_TIME, FREEZE_TIME, span(e, BEAT.isolate, BEAT.freeze));
  // slow motion under the free camera: the pace eases down from the isolate beat's (no jump in his motion)
  const x = e - BEAT.freeze;
  const r0 = (FREEZE_TIME - ISOLATE_TIME) / (BEAT.freeze - BEAT.isolate);
  return FREEZE_TIME + SLOW_RATE * x + (r0 - SLOW_RATE) * SLOW_EASE * (1 - Math.exp(-x / SLOW_EASE));
}

/** Footage frames the walkthrough draws (loaded and kept before the clock starts). */
export function frameWanted(masterTime: number): boolean {
  return masterTime >= DEMO_START_TIME - 0.2 && masterTime <= HELD_TIME + 0.2;
}

export function rateLabel(e: number): string {
  if (e < BEAT.lock) return "\u25B6 1.0\u00D7";
  if (e < LOCK_END) return `\u25B6\u25B6 ${LOCK_RATE.toFixed(1)}\u00D7`;
  if (e < BEAT.melt) return "\u25B6 1.0\u00D7";
  if (e < REWIND_FROM) return `\u25B6 ${twinRate(e).toFixed(1)}\u00D7${twinRate(e) < 0.95 ? " SLOW-MO" : ""}`;
  if (e < BEAT.rebuild) return "\u25C0\u25C0 REWIND";
  if (e < WALK_FROM) return "\u275A\u275A PAUSED";
  if (e < BEAT.isolate) return `\u25B6\u25B6 ${replayAt(e).rate.toFixed(1)}\u00D7`;
  if (e < BEAT.freeze) return "\u25B6 REPLAY";
  return `\u25B6 ${SLOW_RATE.toFixed(1)}\u00D7 SLOW-MO`;
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
  /** 1: the wireframe's front glows white-hot (building up); 0: it fades out softly (draining). */
  lead: number;
  /**
   * The wireframe over the textured room in a band of the screen: its leading and trailing edge (0..1 of the
   * picture's width, from the left) and the strength of its lines in a picture 720 pixels high. (Demo 2: behind
   * the wipe from recording to 3D.)
   */
  sweep?: readonly [head: number, tail: number, strength: number];
}

const ALL = 1e6;
const NONE = -1e6;
/** Wireframe room behind the subject: its lines at this strength, so the subject stays the brightest thing. */
const WIRE_DIM = 0.5;
/** The subject alone in the wireframe room: the texture is gone by WIRE.in[1] and back from WIRE.out[0]. */
const WIRE = { in: [BEAT.isolate - 0.2, BEAT.isolate + 0.5], out: [BEAT.freeze + 1.1, BEAT.freeze + 1.75] } as const;
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
  // (it comes in once the camera has pulled out above the room: at the ceiling it would be a sheet across the view)
  const gridIn = e >= BEAT.pivot && e < BEAT.rebuild ? smooth(span(e, BEAT.pivot + 0.3, BEAT.pivot + 0.8)) : 1;
  const grid = gridIn * (1 + 0.9 * Math.min(span(e, BEAT.pivot + 0.9, BEAT.pivot + 1.4), 1 - span(e, RISE + 0.1, RISE + 0.6)));
  // The rise glows at its front, but only once it is clear of the floor: the scan's uneven floor and the bits
  // of it outside the room would otherwise flare up as scattered white patches over the empty grid.
  const lead = e < RISE ? 0 : span(e, RISE + 0.25, RISE + 0.6);
  const at = (texY: number, wireY: number, wireMode: number, gain = 1): BuildState => ({ texY, wireY, wireMode, minY, gain, grid, lead });
  if (e < BEAT.melt) return at(ALL, ALL, 0);
  // texture dissolves from the ceiling down, leaving the wireframe
  if (e < BEAT.pivot) return at(lerp(y1, y0, easeInOut(span(e, BEAT.melt, BEAT.pivot))), ALL, 1, WIRE_DIM);
  // The wireframe drains down to the floor grid: the grid plane sweeps down through it and the lines fade out
  // softly above it (no glowing front), while the whole wireframe dims, so the room thins away evenly instead
  // of breaking up into bright islands; it is gone a little before the front reaches the floor.
  if (e < BEAT.rebuild) {
    const u = span(e, BEAT.pivot, BEAT.rebuild);
    return at(NONE, lerp(y1, y0 + 0.02, easeInOut(u)), 1, WIRE_DIM * (1 - smooth(span(u, 0.3, 0.85))));
  }
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
  /** The part he has already walked (up to where he is at the shown time) is drawn in the walked colour. */
  follow: boolean;
  /** Only the part he has walked is drawn (it grows behind him); `draw` is not used. */
  trail?: boolean;
}

/**
 * The path is drawn on from end to end as the replay starts (PATH.in to PATH.drawn), stays under the orbit
 * and is gone as the room turns to wire.
 */
const PATH = { in: [WALK_FROM, WALK_FROM + 0.3], drawn: WALK_FROM + 1.4, out: [BEAT.isolate - 0.35, BEAT.isolate + 0.25] } as const;

/**
 * The subject's whole path on the floor, drawn on as the replay starts: the part he has already walked in
 * cyan, the part still ahead of him in red, from above and on under the orbit.
 */
export function pathAt(e: number): PathState {
  if (e < PATH.in[0] || e >= PATH.out[1]) return { draw: 0, alpha: 0, labels: 0, follow: false };
  const u = span(e, PATH.in[0], PATH.drawn);
  return {
    draw: 1 - (1 - u) * (1 - u) * (1 - u),
    follow: true,
    alpha: smooth(span(e, PATH.in[0], PATH.in[1])) * (1 - smooth(span(e, PATH.out[0], PATH.out[1]))),
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
export const pathReadout = (e: number) => e >= BEAT.path && e < BEAT.orbit;

// ---------------------------------------------------------------- subject look

export type DemoLookName = "footage" | "xray" | "texture";
export const FREEZE_LOOKS: { name: DemoLookName; at: number; label: string }[] = [
  { name: "footage", at: BEAT.freeze, label: "REAL FOOTAGE" },
  { name: "xray", at: BEAT.freeze + 0.55, label: "X-RAY" },
  { name: "texture", at: BEAT.freeze + 1.1, label: "FULL 3D" },
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
  /** 0..1: the hologram is white instead of cyan (demo 2's timeline: the live subject among his earlier selves). */
  holoWhite?: number;
  /** World height of the hologram's bright band above the floor. */
  holoBand: number;
  /** 0..1: tracking bracket with the live fused values (0 = off; below 1 it is still closing in). */
  bracket: number;
  /** The scene's own floating tag on the subject is left out (the footage or the overlay labels it instead). */
  hideTags: boolean;
  /** The scene's own trail of the last seconds is left out (the whole path is on the floor instead). */
  hideTrail: boolean;
  /** The subject (body, footage, ring, tag, trail, carried chair) and the cameras' status on him are left out. */
  hideSubject: boolean;
  /** Which look chip is lit during the freeze orbit. */
  name: DemoLookName | null;
}

const look = (name: DemoLookName) => FREEZE_LOOKS.find((l) => l.name === name)!.at;
/** The scene's own tag on the subject appears once the footage (which carries its own tag) is gone. */
const TAGS_FROM = BEAT.reveal + 1.3;
/** The subject fades to the hologram and is gone over this span at the start of the rewind. */
const SUBJECT_OUT = [BEAT.pivot, REWIND_FROM] as const;

export function lookStateAt(e: number): LookState {
  const base: LookState = {
    mode: "hybrid",
    xray: false,
    hologram: 0,
    hideBody: false,
    holoStyle: 0,
    holoBand: -10,
    bracket: 0,
    // (from above, the path's own ENTRY label names him while it is drawn; his tag would sit on top of it)
    hideTags: e < TAGS_FROM || e >= BEAT.isolate || (e >= WALK_FROM && e < BEAT.orbit + 0.2),
    hideTrail: e >= BEAT.path && e < PATH.out[1],
    hideSubject: e >= SUBJECT_OUT[1] && e < BEAT.rebuild,
    name: null,
  };
  if (e < LOCK_LEGS[0].at - 0.1) return { ...base, mode: "model" };
  // the pass through the cameras: between two recordings the subject is the reconstruction, tinted like the cut-outs
  if (e < BEAT.reveal - 0.5) return { ...base, hologram: 1 };
  // the X-ray highlight carries over from the footage onto the reconstruction, then lets go
  if (e < BEAT.pivot) return { ...base, hologram: 1 - span(e, BEAT.reveal + 1.1, BEAT.reveal + 1.55) };
  // Rewind: rather than run backwards across the room at speed (with the chair), the subject turns to the
  // cyan hologram as the camera pulls out and is gone; the rewind runs on the emptying room.
  if (e < SUBJECT_OUT[1]) return { ...base, mode: "model", hideTags: true, hologram: smooth(span(e, SUBJECT_OUT[0], SUBJECT_OUT[1])), hideBody: e > SUBJECT_OUT[1] - 0.06, holoStyle: 1 };
  if (e < BEAT.rebuild) return { ...base, mode: "model", hideTags: true };
  // rewind, overview, top view and orbit: baked texture only (time runs backwards, then three times as fast)
  if (e < WIRE.in[0]) return { ...base, mode: "model" };
  // isolated in the wireframe room: the fused track's values ride along
  if (e < BEAT.freeze) return { ...base, bracket: easeOut(span(e, BEAT.isolate + 0.65, BEAT.isolate + 1.0)) };
  if (e < look("xray")) return { ...base, name: "footage" };
  // (the viewer's own X-ray switch goes on here too: the debug figure of the next look then has its see-through pass ready)
  if (e < look("texture")) return { ...base, xray: true, hologram: 1, hideBody: true, holoStyle: 1, holoBand: lerp(-0.25, 2.1, span(e, look("xray"), look("texture") - 0.1)), name: "xray" };
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
  /** Per feed (wall order), 0..1: its cut-out lit; left out: `highlight` for all four. */
  highlights?: readonly number[];
  /** 0..1: a search sweep crossing every feed, left to right; left out: none. */
  scan?: number;
  /** 0..1: share of the screen's width, from the left, where the recording is wiped away (the 3D view shows). */
  wipe?: number;
  /** The tag on the cut-out; left out: the subject's label and "SAM 2.1". */
  tag?: string;
  /** Share of the screen's height kept free under the wall for the captions; left out: 0.165. */
  reserve?: number;
  /**
   * 0..1: instead of the wall, one recording as a small picture beside the 3D view: that of the camera in which
   * he is largest at the shown moment (handed on from camera to camera as he walks). Left out: none.
   */
  pip?: number;
}

/** The wall's tile of the pass's first camera has grown into the whole screen by here. */
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
  { at: BEAT.freeze, rail: "FREE CAM", title: "FREE CAMERA. INFINITE ANGLES.", sub: "Slow motion: walk around him while it plays" },
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
  /** Feet of the subject at FREEZE_TIME (the free camera's centre when his live position is unknown). */
  subject: Vec3;
  /** Feet of the subject at the shown time (null while absent). */
  live: Vec3 | null;
  /**
   * Per CCTV camera, 0..1: how much of the recording around the shown time has his cut-out (time-smoothed).
   * The free camera lingers where it looks along these cameras' lines of sight. All 1 when not given.
   */
  sources?: Partial<Record<CameraId, number>>;
  /** Where the subject came in (the first point of his track), once the track is known. */
  door?: Vec3;
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

export function throughCamera(id: CameraId, ctx: DemoContext, reach = 7): DemoCam {
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
/**
 * 0..1: the CCTV grain over the 3D view while the viewport flies between cameras in the pass, so the flights
 * keep the texture of the recordings they dissolve out of and into (their exposure: cctvExposureAt).
 */
export const cctvGradeAt = (e: number) => (e >= BEAT.lock && e < LOCK_END ? 1 - passFootage(e) : 0);
/**
 * 0..1: the recordings' exposure over the 3D view. Through the pass the feeds are dimmed around the subject's
 * cut-out, so the room they dissolve into gets the same darker picture (a CSS filter on the viewport's canvas,
 * matched against the frames on either side of each dissolve). It is on for the whole pass, under the
 * recordings as well, so a dissolve never mixes a dimmed feed with a bright room; it lifts with the feeds'
 * dimming after the pass, before the "real footage" slider shows the room.
 */
export const cctvExposureAt = (e: number) => (e < BEAT.lock ? 0 : 1 - smooth(span(e, LOCK_END - 0.05, BEAT.reveal + 0.2)));
export const CCTV_EXPOSURE = { brightness: 0.46, contrast: 1.12, saturate: 0.94 };
export function cctvFilterAt(e: number): string {
  const g = cctvExposureAt(e);
  if (g <= 0.002) return "";
  const { brightness: b, contrast: c, saturate: s } = CCTV_EXPOSURE;
  return `brightness(${lerp(1, b, g).toFixed(3)}) contrast(${lerp(1, c, g).toFixed(3)}) saturate(${lerp(1, s, g).toFixed(3)})`;
}

export const unwrap = (deg: number, near: number) => deg + 360 * Math.round((near - deg) / 360);

export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Part of the frame the room may fill in the overview: clear of the top bar and of the caption. */
const FRAME = { halfWidth: 0.9, top: 0.84, bottom: -0.62 };

/** Direction of the viewer's home view: degrees around the room and above the floor. */
export function homeAngles(ctx: DemoContext) {
  const home = homePose("orbit", ctx.bounds, ctx.aspect);
  const away = sub(home.position, home.target);
  return { az: Math.atan2(away[0], away[2]) / DEG, el: Math.atan2(away[1], Math.hypot(away[0], away[2])) / DEG, fov: home.fov };
}

/**
 * The room seen from outside: from `azimuth` degrees around it and `elevation` degrees above the floor
 * (90 = straight down, with the side the camera came up from at the bottom of the screen), moved in until
 * the room fills the frame and centred in the part of it the overlay leaves free.
 */
/** From the target towards the camera, the screen's right and up, for a view from azimuth/elevation (degrees). */
export function viewAxes(azimuth: number, elevation: number) {
  const az = azimuth * DEG;
  const el = elevation * DEG;
  const dir: Vec3 = [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];
  const right: Vec3 = [Math.cos(az), 0, -Math.sin(az)];
  const up: Vec3 = [-Math.sin(el) * Math.sin(az), Math.cos(el), -Math.sin(el) * Math.cos(az)];
  return { dir, right, up };
}

export function fit(ctx: DemoContext, azimuth: number, elevation: number): DemoCam & { up: Vec3 } {
  const b = ctx.bounds;
  const home = homePose("orbit", b, ctx.aspect);
  const { dir, right, up } = viewAxes(azimuth, elevation);
  const f: Vec3 = [-dir[0], -dir[1], -dir[2]];
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
const TOP_AT = BEAT.path + 0.9;
/** From here the orbit leaves the whole room for the subject. */
const CLOSE_FROM = inOrbit(0.52);
/**
 * The whole room framed from above and round it (top view and orbit), from azimuth/elevation in degrees.
 * fit() alone moves in jerks: its distance and aim change speed abruptly whenever another corner of the room
 * becomes the one touching the frame's edge, which made the orbit look choppy. So fit() is sampled along the
 * way and its aim and distance are smoothed over time (Gaussian, WIDE_SIGMA s); the view direction itself is
 * already smooth. The room may come a few per cent closer to the frame's edge than fit() allows.
 */
const WIDE_STEP = 1 / 60;
const WIDE_SIGMA = 0.32;
/** Smoothed framing from here (the camera is straight above the room) to the end of the orbit. */
const WIDE_FROM = TOP_AT;
let wideCache: { key: string; t: Vec3[]; d: number[] } | null = null;

function wideAngles(e: number, ctx: DemoContext): { az: number; el: number } {
  if (e < BEAT.orbit) {
    const home = homeAngles(ctx);
    const u = easeInOut(span(e, BEAT.path, TOP_AT));
    return { az: lerp(home.az + 8, TOP_AZ, u) + 2 * span(e, TOP_AT, BEAT.orbit), el: lerp(home.el, 90, u) };
  }
  return { az: orbitAz(e, ctx), el: pchip([BEAT.orbit, CLOSE_FROM, BEAT.isolate], [90, 46, 40], e) };
}

function wideView(e: number, ctx: DemoContext): DemoCam & { up: Vec3 } {
  const { az, el } = wideAngles(e, ctx);
  if (e < WIDE_FROM) return fit(ctx, az, el);
  const b = ctx.bounds;
  const key = [ctx.aspect, ...b.min, ...b.max, ...ctx.subject, ...ctx.poses.cam1.position, ...ctx.poses.cam4.position].map((v) => v.toFixed(4)).join(",");
  if (wideCache?.key !== key) {
    const t: Vec3[] = [];
    const d: number[] = [];
    for (let x = WIDE_FROM; x <= BEAT.isolate + WIDE_STEP / 2; x += WIDE_STEP) {
      const a = wideAngles(x, ctx);
      const f = fit(ctx, a.az, a.el);
      t.push(f.t);
      d.push(Math.hypot(...sub(f.p, f.t)));
    }
    wideCache = { key, t, d };
  }
  const { t: ts, d: ds } = wideCache;
  const n = ds.length;
  const at = clamp01((e - WIDE_FROM) / (BEAT.isolate - WIDE_FROM)) * (n - 1);
  const reach = Math.ceil((3 * WIDE_SIGMA) / WIDE_STEP);
  const c = Math.round(at);
  let wsum = 0;
  let dd = 0;
  const tt: Vec3 = [0, 0, 0];
  for (let i = Math.max(0, c - reach); i <= Math.min(n - 1, c + reach); i++) {
    const w = Math.exp(-0.5 * (((i - at) * WIDE_STEP) / WIDE_SIGMA) ** 2);
    wsum += w;
    dd += w * ds[i];
    for (let k = 0; k < 3; k++) tt[k] += w * ts[i][k];
  }
  const raw = fit(ctx, az, el);
  // eased in from fit() itself while the camera has only just arrived above the room (it barely moves there)
  const s = smooth(span(e, WIDE_FROM, WIDE_FROM + 0.3));
  const dist = lerp(Math.hypot(...sub(raw.p, raw.t)), (dd / wsum) * 1.02, s);
  const tgt = lerp3(raw.t, [tt[0] / wsum, tt[1] / wsum, tt[2] / wsum], s);
  const { dir, up } = viewAxes(az, el);
  return { p: [tgt[0] + dir[0] * dist, tgt[1] + dir[1] * dist, tgt[2] + dir[2] * dist], t: tgt, up, roll: 0, fov: raw.fov };
}

/**
 * Degrees round the subject from the orbit on: round the room, in to him, round him as he walks, ending in
 * front of him just inside CAM 01's line of sight (HERO_OFF degrees off it, away from the window wall): he
 * walks towards the camera carrying the chair, seen from where CAM 01 filmed him. The last of the way the
 * camera is drawn onto CAM 01's own line of sight to him (heroCam), where the body is CAM 01's cut-out pixel
 * for pixel: a few degrees off it the cut-out is blended with the projected mesh, and his face (a few dozen
 * pixels in the recording) came out smeared and doubled, close up under the end card.
 */
const HERO_OFF = 0;
function orbitAz(e: number, ctx: DemoContext) {
  const cam1 = throughCamera("cam1", ctx);
  const cam4 = throughCamera("cam4", ctx);
  const S = ctx.subject;
  const az4 = unwrap(Math.atan2(cam4.p[0] - S[0], cam4.p[2] - S[2]) / DEG, TOP_AZ + 260);
  const azEnd = unwrap(Math.atan2(cam1.p[0] - S[0], cam1.p[2] - S[2]) / DEG + HERO_OFF, az4 + 180);
  return pchip([BEAT.orbit, BEAT.isolate, BEAT.freeze, BEAT.end, DEMO_DURATION], [TOP_AZ + 2, az4 - 18, az4 + 95, azEnd, azEnd], e);
}

/**
 * Close orbit (isolate and free camera) lingering on the recorded views. Seen from along a CCTV camera's line
 * of sight the subject is that camera's own footage (the viewer's observed view); away from those lines he is
 * filled in by the mesh, which looks rougher the further round the camera goes. So the camera's progress round
 * him is re-paced: per degree it spends (1 + LINGER × closeness to a recording camera's bearing) as long, with
 * closeness a Gaussian of width LINGER_SIGMA degrees. Start and end bearings and the overall timing stay; it
 * hovers near the cameras and hurries across the stretches between them.
 */
const LINGER = 3;
const LINGER_SIGMA = 14;
const LINGER_STEP = 0.5;

function lingerAz(az0: number, a0: number, a1: number, centre: Vec3, ctx: DemoContext): number {
  if (a1 - a0 < 1 || az0 <= a0 || az0 >= a1) return az0;
  const bearings: { az: number; w: number }[] = [];
  for (const id of CAMERA_ORDER) {
    const w = ctx.sources ? (ctx.sources[id] ?? 0) : 1;
    if (w <= 0.001) continue;
    const p = ctx.poses[id].position;
    bearings.push({ az: Math.atan2(p[0] - centre[0], p[2] - centre[2]) / DEG, w });
  }
  if (!bearings.length) return az0;
  const g = (a: number) => {
    let k = 1;
    for (const b of bearings) {
      const d = unwrap(b.az, a) - a;
      k += LINGER * b.w * Math.exp(-0.5 * (d / LINGER_SIGMA) ** 2);
    }
    return k;
  };
  // cumulative time-per-degree from a0, on a LINGER_STEP grid
  const n = Math.ceil((a1 - a0) / LINGER_STEP);
  const step = (a1 - a0) / n;
  const G = new Float64Array(n + 1);
  let prev = g(a0);
  for (let i = 1; i <= n; i++) {
    const cur = g(a0 + i * step);
    G[i] = G[i - 1] + 0.5 * (prev + cur) * step;
    prev = cur;
  }
  const want = (G[n] * (az0 - a0)) / (a1 - a0);
  let lo = 0;
  let hi = n;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (G[mid] <= want) lo = mid;
    else hi = mid;
  }
  const f = G[hi] > G[lo] ? (want - G[lo]) / (G[hi] - G[lo]) : 0;
  return a0 + (lo + f) * step;
}

/** The free camera is drawn onto CAM 01's line of sight over this span; metres from him along it (then, end card, last frame). */
const HERO_IN = [BEAT.end - 1.0, BEAT.end - 0.15] as const;
const HERO_R = [3.0, 2.95, 2.7] as const;
/** Where the orbit hands over to the free camera: metres from the subject, and above the floor. */
const CLOSE = { r: 3.6, h: 4.2 };

/** Mid-leg the viewport drops this far (m) below the cameras' height, opens its view by FLY_WIDEN degrees and turns this share of the way to the subject. */
const FLY_DIP = 0.25;
const FLY_WIDEN = 8;
const FLY_AIM = 0.75;
/** Leg easing: at rest at both cameras, but quicker off and onto them than a quintic (less dead time at each). */
const smoother = smooth;
export const norm = (v: Vec3): Vec3 => {
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

  // Up to straight above the room, turning its long side across the screen; a slow creep while the path is drawn.
  if (e < BEAT.orbit) return wideView(e, ctx);

  // From here on the camera keeps turning the same way: round the room and down (orbit), in to the subject
  // (isolate), round him as he walks on in slow motion (free camera), ending on CAM 01's side of him (filmed sharpest).
  // The circle is centred on him (his time-smoothed position), so it walks with him; during the orbit's
  // descent its centre slides over from where he will be at the free camera's start.
  const S = ctx.subject;
  const feet = ctx.live ?? S;
  const C = lerp3(S, feet, smooth(span(e, CLOSE_FROM, BEAT.isolate)));
  const xs = [BEAT.isolate, BEAT.freeze, BEAT.end, DEMO_DURATION];
  const az0 = orbitAz(e, ctx);
  const lingered = lingerAz(az0, orbitAz(BEAT.isolate, ctx), orbitAz(DEMO_DURATION, ctx), feet, ctx);
  // eased in once the camera is down with him (until then it was following the room orbit's pace)
  const az = lerp(az0, lingered, smooth(span(e, BEAT.isolate, BEAT.isolate + 0.8))) * DEG;
  // (under the end card a slow push in: pulling back would take the camera through the window wall)
  const r = pchip(xs, [CLOSE.r, 2.3, 2.35, 2.15], e);
  const h = pchip(xs, [CLOSE.h, S[1] + 1.5, S[1] + 1.5, S[1] + 1.45], e);
  const chest: Vec3 = [feet[0], feet[1] + 0.98, feet[2]];
  const close: DemoCam = { p: [C[0] + r * Math.sin(az), h, C[2] + r * Math.cos(az)], t: chest, roll: 0, fov: pchip(xs, [home.fov, 58, 55, 52], e) };
  if (e >= HERO_IN[0]) {
    // onto CAM 01's line of sight to him, and on it under the end card (a slow push in along it)
    const body: Vec3 = [feet[0], feet[1] + 0.96, feet[2]];
    const ray = norm(sub(ctx.poses.cam1.position, body));
    const d = pchip([HERO_IN[1], BEAT.end, DEMO_DURATION], [HERO_R[0], HERO_R[1], HERO_R[2]], e);
    const hero: Vec3 = [body[0] + ray[0] * d, body[1] + ray[1] * d, body[2] + ray[2] * d];
    return { ...close, p: lerp3(close.p, hero, smooth(span(e, HERO_IN[0], HERO_IN[1]))) };
  }
  if (e >= BEAT.isolate) return close;

  // Orbit: the whole room in the frame, from straight above down to a three-quarter view, then in to the subject.
  const wide = wideView(e, ctx);
  const w = easeInOut(span(e, CLOSE_FROM, BEAT.isolate));
  // (straight down the world's up is the view axis: the fit's own up keeps the room's long side across the screen)
  return { p: lerp3(wide.p, close.p, w), t: lerp3(wide.t, close.t, w), up: w > 0 ? undefined : wide.up, roll: 0, fov: close.fov };
}
