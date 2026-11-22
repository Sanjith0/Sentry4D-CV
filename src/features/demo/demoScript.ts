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
 *   0.0  wall of the four CCTV feeds, the subject picked out in each
 *   2.0  push into CAM 01, subject in X-ray tint
 *   2.9  real footage 100% → 0%: the 3D reconstruction is underneath, same framing
 *   4.5  the room melts to its wireframe
 *   5.3  the camera swings out to the overview while time rewinds and the room drains to the floor grid
 *   6.75 the empty grid and the four cameras' coverage; the room is rebuilt from the scan
 *   8.6  incident replay, the camera dives down the room into CAM 01's lens
 *  10.4  through CAM 01 → 02 → 03 → 04, fast-forward
 *  12.9  wireframe room: the subject alone, lifting the chair
 *  15.2  freeze; free camera around the subject: footage / X-ray / tracking / full texture
 *  18.6  end card
 */
export const DEMO_DURATION = 19.8;
/** How long the end card stays before the demo closes itself. */
export const END_HOLD_SECONDS = 5;
export const DEMO_SUBJECT = "subject-01";
export const DEMO_CLIP = "clip02";
/** Incident time shown at e = 0. */
export const DEMO_START_TIME = 17.8;
/** Incident time of the freeze frame (the subject mid-stride, carrying the chair). */
export const FREEZE_TIME = 20.5;

export const BEAT = {
  wall: 0,
  lock: 2.0,
  reveal: 2.9,
  melt: 4.5,
  pivot: 5.3,
  rebuild: 6.75,
  replay: 8.6,
  cameras: 10.4,
  isolate: 12.9,
  freeze: 15.2,
  end: 18.6,
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

const CLIP_T0 = 4.2;
const CLIP_FPS = 15;
/** Rewind ends here: before any camera has seen the subject, so the rebuilt room is empty. */
const REWOUND_TIME = 3.6;
/** The wireframe starts to rise from the bare grid. */
const RISE = 7.0;

/** While true the recordings are on screen and play at their own 1x rate. */
export const videosLive = (e: number) => e < BEAT.melt;

/** Master (incident) time shown at demo time e. */
export function incidentTime(e: number): number {
  if (e < BEAT.melt) return DEMO_START_TIME + Math.max(e, 0);
  const meltEnd = DEMO_START_TIME + BEAT.melt + 0.4;
  if (e < BEAT.pivot) {
    // coasts to a stop as the footage is gone
    const u = span(e, BEAT.melt, BEAT.pivot);
    return DEMO_START_TIME + BEAT.melt + 0.4 * (1 - (1 - u) * (1 - u));
  }
  if (e < BEAT.rebuild) return lerp(meltEnd, REWOUND_TIME, easeInOut(span(e, BEAT.pivot, BEAT.rebuild)));
  if (e < 8.3) return REWOUND_TIME;
  // replay starts gently and is at fast-forward speed by the time the camera is back inside
  if (e < BEAT.cameras) return REWOUND_TIME + (8.0 - REWOUND_TIME) * Math.pow(span(e, 8.3, BEAT.cameras), 1.8);
  if (e < BEAT.isolate) return lerp(8.0, 18.6, span(e, BEAT.cameras, BEAT.isolate));
  if (e < BEAT.freeze) return lerp(18.6, FREEZE_TIME, span(e, BEAT.isolate, BEAT.freeze));
  if (e < BEAT.end) return FREEZE_TIME;
  return FREEZE_TIME + 0.3 * span(e, BEAT.end, DEMO_DURATION);
}

/** Fast-forward shows every second footage frame (the ones loaded up front): snap the time onto them. */
export function shownTime(e: number): number {
  const t = incidentTime(e);
  if (e >= 10.3 && e < BEAT.isolate) return CLIP_T0 + (Math.round(((t - CLIP_T0) * CLIP_FPS) / 2) * 2) / CLIP_FPS;
  return t;
}

/** Footage frames the walkthrough draws (loaded and kept before the clock starts). */
export function frameWanted(masterTime: number, k: number): boolean {
  if (masterTime >= 17.5 && masterTime <= 23.0) return true;
  return masterTime >= 7.5 && masterTime < 17.5 && k % 2 === 0;
}

export function rateLabel(e: number): string {
  if (e < BEAT.melt) return "\u25B6 1.0\u00D7";
  if (e < BEAT.pivot) return "\u275A\u275A HOLD";
  if (e < BEAT.rebuild) return "\u25C0\u25C0 REWIND";
  if (e < 8.3) return "\u275A\u275A PAUSED";
  if (e < BEAT.cameras) return "\u25B6 REPLAY";
  if (e < BEAT.isolate) return "\u25B6\u25B6 4\u00D7";
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

/** Room build fronts at demo time e; floorY / topY = the room's floor and ceiling heights. */
export function buildAt(e: number, floorY: number, topY: number): BuildState {
  const y0 = floorY - 0.16;
  const y1 = topY + 0.3;
  const minY = floorY - 0.12; // above the drained front: nothing of the scan is left on the empty grid
  // the bare grid is the whole picture for a moment: brighter then, as built once the wireframe rises through it
  const grid = 1 + 0.9 * Math.min(span(e, 6.2, 6.7), 1 - span(e, RISE + 0.1, RISE + 0.6));
  const at = (texY: number, wireY: number, wireMode: number, gain = 1): BuildState => ({ texY, wireY, wireMode, minY, gain, grid });
  if (e < BEAT.melt) return at(ALL, ALL, 0);
  // texture dissolves from the ceiling down, leaving the wireframe
  if (e < BEAT.pivot) return at(lerp(y1, y0, easeInOut(span(e, BEAT.melt, BEAT.pivot))), ALL, 1, WIRE_DIM);
  // the wireframe drains down to the floor grid
  if (e < BEAT.rebuild) return at(NONE, lerp(y1, y0 + 0.02, easeInOut(span(e, BEAT.pivot, BEAT.rebuild))), 0, lerp(WIRE_DIM, 1, span(e, BEAT.pivot, 6.0)));
  if (e < RISE) return at(NONE, y0 + 0.02, 0);
  // rebuild: wireframe rises from the floor, texture rises behind it
  if (e < BEAT.replay) return at(e < 7.5 ? NONE : lerp(y0, y1, easeInOut(span(e, 7.5, BEAT.replay))), lerp(y0 + 0.02, y1, easeInOut(span(e, RISE, 8.3))), 0);
  if (e < 12.7) return at(ALL, ALL, 0);
  if (e < 13.4) return at(lerp(y1, y0, easeInOut(span(e, 12.7, 13.4))), ALL, 1, WIRE_DIM);
  if (e < 17.7) return at(NONE, ALL, 1, WIRE_DIM);
  if (e < 18.5) return at(lerp(y0, y1, easeInOut(span(e, 17.7, 18.5))), ALL, 0, WIRE_DIM);
  return at(ALL, ALL, 0);
}

/** Whether the ceiling is drawn (hidden while the camera looks into the room from above). */
export function ceilingShown(e: number, cutY: number, wireY: number): boolean {
  if (e < BEAT.pivot) return true;
  if (e < RISE) return wireY >= cutY; // nothing is drawn above the wire front anyway
  return e >= BEAT.cameras; // back on with the cut into CAM 01
}

/**
 * 0..1: the cameras' coverage volumes. They unfold over the bare grid, stay while the room is rebuilt and
 * replayed, and are gone before the camera reaches CAM 01's lens.
 */
export const coverageAt = (e: number) => (e < 9 ? span(e, 6.5, 7.3) : 1 - span(e, 10.0, 10.25));

// ---------------------------------------------------------------- subject look

export type DemoLookName = "footage" | "xray" | "tracking" | "texture";
export const FREEZE_LOOKS: { name: DemoLookName; at: number; label: string }[] = [
  { name: "footage", at: BEAT.freeze, label: "REAL FOOTAGE" },
  { name: "xray", at: 15.95, label: "X-RAY" },
  { name: "tracking", at: 16.8, label: "TRACKING" },
  { name: "texture", at: 17.55, label: "FULL 3D" },
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
  /** Which look chip is lit during the freeze orbit. */
  name: DemoLookName | null;
}

const look = (name: DemoLookName) => FREEZE_LOOKS.find((l) => l.name === name)!.at;
/** The scene's own tag on the subject appears once the footage (which carries its own tag) is gone. */
const TAGS_FROM = 4.2;

export function lookStateAt(e: number): LookState {
  const base: LookState = { mode: "hybrid", xray: false, hologram: 0, hideBody: false, holoStyle: 0, holoBand: -10, bracket: 0, hideTags: e < TAGS_FROM || e >= BEAT.isolate, name: null };
  if (e < 2.4) return { ...base, mode: "model" };
  // the X-ray highlight carries over from the footage onto the reconstruction, then lets go
  if (e < BEAT.pivot) return { ...base, hologram: 1 - span(e, 4.0, 4.45) };
  // rewind and overview: baked texture only (no footage frames exist for a time that runs backwards)
  if (e < 10.3) return { ...base, mode: "model" };
  // isolated in the wireframe room: the fused track's values ride along
  if (e < BEAT.freeze) return { ...base, bracket: easeOut(span(e, 13.55, 13.9)) };
  if (e < look("xray")) return { ...base, name: "footage" };
  // (the viewer's own X-ray switch goes on here too: the debug figure of the next look then has its see-through pass ready)
  if (e < look("tracking")) return { ...base, xray: true, hologram: 1, hideBody: true, holoStyle: 1, holoBand: lerp(-0.25, 2.1, span(e, look("xray"), look("tracking") - 0.1)), name: "xray" };
  if (e < look("texture")) return { ...base, mode: "avatar", xray: true, bracket: easeOut(span(e, look("tracking"), look("tracking") + 0.25)), name: "tracking" };
  if (e < BEAT.end) return { ...base, name: "texture" };
  return base;
}

// ---------------------------------------------------------------- CCTV wall

export interface WallState {
  visible: boolean;
  /** 0: 2x2 wall, 1: CAM 01 fills the screen. */
  zoom: number;
  /** 0..1: feeds dimmed, the subject's cut-out lit. */
  highlight: number;
  /** 0..1: X-ray tint on the cut-out. */
  tint: number;
  /** "Real footage" slider: 1 = recording, 0 = reconstruction only. */
  footage: number;
}

export function wallAt(e: number): WallState {
  const footage = 1 - easeInOut(span(e, 3.15, 4.25));
  return {
    visible: e < 4.3 && footage > 0.002,
    zoom: easeInOut(span(e, BEAT.lock, BEAT.reveal)),
    highlight: easeOut(span(e, 0.7, 1.1)),
    tint: smooth(span(e, 1.2, 1.6)),
    footage,
  };
}

/** CRT power-on of tile i (0..1). */
export const tilePower = (e: number, i: number) => span(e, 0.05 + 0.09 * i, 0.38 + 0.09 * i);

// ---------------------------------------------------------------- chapters

export interface Chapter {
  at: number;
  rail: string;
  title: string;
  sub: string;
}

export const CHAPTERS: Chapter[] = [
  { at: BEAT.wall, rail: "FEEDS", title: "4 CCTV CAMERAS. ONE INCIDENT.", sub: "SAM 2.1 isolates the subject in every feed" },
  { at: BEAT.lock, rail: "LOCK", title: "SUBJECT LOCKED", sub: "CAM 01 \u00B7 X-ray" },
  { at: BEAT.reveal, rail: "REVEAL", title: "REAL FOOTAGE \u2192 3D RECONSTRUCTION", sub: "Same camera, same instant, no video left" },
  { at: BEAT.melt, rail: "TWIN", title: "LIDAR DIGITAL TWIN", sub: "Every surface of the room, to scale" },
  { at: BEAT.pivot, rail: "REBUILD", title: "REWIND. REBUILD.", sub: "The scene reassembles from the scan" },
  { at: BEAT.replay, rail: "REPLAY", title: "INCIDENT REPLAY", sub: "Four recordings fused on one clock" },
  { at: BEAT.cameras, rail: "CAMERAS", title: "THROUGH EVERY CAMERA", sub: "Calibrated views, one timeline" },
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
  // into CAM 01's lens: the frame whites out, and the camera's own view comes out of it
  const lens = e < BEAT.cameras ? 0.92 * Math.pow(span(e, BEAT.cameras - 0.22, BEAT.cameras), 2) : 0.92 * (1 - span(e, BEAT.cameras, BEAT.cameras + 0.3));
  return Math.max(lens, pulse(BEAT.freeze, 0.28, 0.55), pulse(15.95, 0.16, 0.2), pulse(16.8, 0.16, 0.2), pulse(17.55, 0.16, 0.2));
}

// ---------------------------------------------------------------- camera

export interface DemoCam {
  p: Vec3;
  /** Look-at point. */
  t: Vec3;
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
/** The same for CAM 04 as the free camera pulls away from it: its housing is behind the viewport by then. */
const LEFT_CAM4 = BEAT.isolate + 0.3;
/** The camera leaves the overview at `from` and reaches CAM 01's lens at BEAT.cameras. */
const DIVE = { from: 8.6 };

/** Camera-to-camera whips of the CCTV run: [start, end, from, to]. */
const HOPS: [number, number, CameraId, CameraId][] = [
  [10.85, 11.2, "cam1", "cam2"],
  [11.55, 11.95, "cam2", "cam3"],
  [12.25, 12.6, "cam3", "cam4"],
];

/** The CCTV camera the viewport is (or is flying to) during the camera run, else null. */
export function cctvAt(e: number): CameraId | null {
  if (e < LEFT_CAM1) return "cam1";
  if (e < BEAT.cameras || e >= LEFT_CAM4) return null;
  let id: CameraId = "cam1";
  for (const [a, b, , to] of HOPS) if (e >= (a + b) / 2) id = to;
  return id;
}

/** 0..1: the CCTV look (scan lines) over the viewport while it is one of the cameras. */
export const scanLinesAt = (e: number) => 1 - (e < BEAT.cameras ? span(e, LEFT_CAM1, LEFT_CAM1 + 0.2) : span(e, LEFT_CAM4, LEFT_CAM4 + 0.2));

const unwrap = (deg: number, near: number) => deg + 360 * Math.round((near - deg) / 360);

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => {
  const n = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};

/** Part of the frame the room may fill in the overview: clear of the top bar and of the caption. */
const FRAME = { halfWidth: 0.9, top: 0.84, bottom: -0.62 };

/**
 * The viewer's home view (from above, `azimuth` degrees around the room), moved in until the room fills
 * the frame and centred in the part of it the overlay leaves free.
 */
function overview(ctx: DemoContext, azimuth: number): { p: Vec3; t: Vec3; fov: number } {
  const b = ctx.bounds;
  const home = homePose("orbit", b, ctx.aspect);
  const away = sub(home.position, home.target);
  const flat = Math.hypot(away[0], away[2]);
  const dir = unit([flat * Math.sin(azimuth * DEG), away[1], flat * Math.cos(azimuth * DEG)]);
  const f: Vec3 = [-dir[0], -dir[1], -dir[2]];
  const right = unit(cross(f, [0, 1, 0]));
  const up = cross(right, f);
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
  let d = Math.hypot(away[0], away[1], away[2]);
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
  return { p: [t[0] + dir[0] * d, t[1] + dir[1] * d, t[2] + dir[2] * d], t, fov: home.fov };
}

export function cameraAt(e: number, ctx: DemoContext): DemoCam {
  const cam1 = throughCamera("cam1", ctx);
  if (e < BEAT.pivot) return cam1;

  if (e < BEAT.cameras) {
    const [cx, , cz] = ctx.bounds.center;
    const home = homePose("orbit", ctx.bounds, ctx.aspect);
    const azHome = Math.atan2(home.position[0] - home.target[0], home.position[2] - home.target[2]) / DEG;
    // over the empty floor grid, then drifting round while the room is rebuilt
    const A = overview(ctx, azHome + 8);
    const B = overview(ctx, azHome - 10);
    if (e < DIVE.from) {
      // Out of CAM 01 and up to the overview, then a slow drift while the room is rebuilt.
      const polar = (p: Vec3) => ({ az: Math.atan2(p[0] - cx, p[2] - cz) / DEG, r: Math.hypot(p[0] - cx, p[2] - cz), h: p[1] });
      const a = polar(A.p);
      const b = polar(B.p);
      const c1 = polar(cam1.p);
      const xs = [BEAT.pivot, 6.7, DIVE.from];
      const az = pchip(xs, [unwrap(c1.az, a.az + 180), a.az, b.az], e) * DEG; // CAM 01 is across the room from the overview
      const r = pchip(xs, [c1.r, a.r, b.r], e);
      return {
        p: [cx + r * Math.sin(az), pchip(xs, [c1.h, a.h, b.h], e), cz + r * Math.cos(az)],
        t: pchip3(xs, [cam1.t, A.t, B.t], e),
        roll: pchip(xs, [cam1.roll, 0, 0], e),
        fov: pchip(xs, [cam1.fov, A.fov, B.fov], e),
      };
    }
    // The dive: straight down the room to CAM 01's lens, faster and faster; the cut into its view is a flash.
    const f = sub(cam1.t, cam1.p);
    const lens: Vec3 = [cam1.p[0] + (f[0] / 7) * 0.55, cam1.p[1] + (f[1] / 7) * 0.55 + 0.02, cam1.p[2] + (f[2] / 7) * 0.55];
    const u = Math.pow(span(e, DIVE.from, BEAT.cameras), 2.4);
    return {
      p: lerp3(B.p, lens, u),
      t: lerp3(B.t, cam1.p, easeInOut(span(e, DIVE.from + 0.15, 9.75))),
      roll: 0,
      fov: B.fov,
    };
  }

  if (e < BEAT.isolate) {
    let at = throughCamera("cam1", ctx);
    for (const [a, b, from, to] of HOPS) {
      if (e < a) break;
      const A = throughCamera(from, ctx);
      const B = throughCamera(to, ctx);
      const u = easeInOut(span(e, a, b));
      at = u >= 1 ? B : { p: lerp3(A.p, B.p, u), t: lerp3(A.t, B.t, u), roll: lerp(A.roll, B.roll, u), fov: lerp(A.fov, B.fov, u) };
    }
    return at;
  }

  // Free camera: leaves CAM 04, closes in on the subject, then walks around the frozen moment and ends on
  // CAM 01's side of the subject (the side filmed sharpest).
  const cam4 = throughCamera("cam4", ctx);
  const S = ctx.subject;
  const xs = [BEAT.isolate, BEAT.freeze, BEAT.end, DEMO_DURATION];
  const az4 = Math.atan2(cam4.p[0] - S[0], cam4.p[2] - S[2]) / DEG;
  const azEnd = unwrap(Math.atan2(cam1.p[0] - S[0], cam1.p[2] - S[2]) / DEG, az4 + 180);
  const az = pchip(xs, [az4, az4 + 52, azEnd, azEnd + 15], e) * DEG;
  const r = pchip(xs, [Math.hypot(cam4.p[0] - S[0], cam4.p[2] - S[2]), 2.3, 2.35, 3.1], e);
  const h = pchip(xs, [cam4.p[1], S[1] + 1.5, S[1] + 1.5, S[1] + 1.8], e);
  const feet = ctx.live ?? S;
  const chest: Vec3 = [feet[0], feet[1] + 0.98, feet[2]];
  return {
    p: [S[0] + r * Math.sin(az), h, S[2] + r * Math.cos(az)],
    t: lerp3(cam4.t, chest, easeInOut(span(e, BEAT.isolate, 13.7))),
    roll: lerp(cam4.roll, 0, easeInOut(span(e, BEAT.isolate, 13.7))),
    fov: pchip(xs, [cam4.fov, 58, 55, 55], e),
  };
}
