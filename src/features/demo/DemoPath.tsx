import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { formatClock } from "../../lib/format";
import { useReplayStore } from "../../store/useReplayStore";
import type { Vec3 } from "../../types/security";
import type { Trajectory } from "../sentry/trajectory";
import { useSubjectTracks } from "../sentry/useSubjectTracks";
import { demoLook } from "./demoLook";
import { DEMO_SUBJECT } from "./demoScript";
import { useDemoStore } from "./useDemoStore";

/** Half-width of the line itself, and how far its glow reaches from the centre line (m). */
const CORE = 0.1;
const GLOW = 0.56;
/** Above the scanned floor (m). */
const LIFT = 0.035;
/** Spacing of the path's points (m). */
const STEP = 0.05;
const SAMPLE = 1 / 15;
/** One texel of the baked distance field (m), and the spacing of the sheet's vertices (m). */
const TEXEL = 0.0125;
const CELL = 0.25;
/** Distance stored where the path is nowhere near (m). */
const FAR = 4;

interface Built {
  trajectory: Trajectory;
  geometry: THREE.BufferGeometry;
  /** RG: metres to the way in and metres along the path at its nearest point; BA: the same for the way back. */
  field: THREE.DataTexture;
  length: number;
  /** The path, one point every STEP metres, and the incident time at each. */
  line: Vec3[];
  times: number[];
  /** Labelled points: entry, longest stop, exit (world position, metres along the path, text). */
  marks: { p: Vec3; s: number; text: string }[];
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Metres along the path at incident time t. */
function alongAt(b: Built, t: number) {
  const { times } = b;
  if (t <= times[0]) return 0;
  let lo = 0;
  let hi = times.length - 1;
  if (t >= times[hi]) return b.length;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  return Math.min(b.length, (lo + (t - times[lo]) / Math.max(times[hi] - times[lo], 1e-6)) * STEP);
}

/** The point s metres along the path. */
function pointAt(b: Built, s: number, out: THREE.Vector2) {
  const f = Math.min(Math.max(s / STEP, 0), b.line.length - 1);
  const i = Math.min(Math.floor(f), b.line.length - 2);
  const a = b.line[i];
  const c = b.line[i + 1];
  return out.set(a[0] + (c[0] - a[0]) * (f - i), a[2] + (c[2] - a[2]) * (f - i));
}

/** The whole fused track as a sheet on the floor that carries the path's distance field. */
function build(trajectory: Trajectory): Built | null {
  const raw = trajectory.path(trajectory.start, trajectory.end, SAMPLE);
  const count = raw.length;
  if (count < 8) return null;
  // 1. the tracker's jitter out: lightly where the subject walks, heavily where he stands (most of it is
  //    there, and a line drawn through it is a knot); the two ends stay where they are
  const W = 6;
  const pts = raw.map((_, i) => {
    const i0 = Math.max(i - W, 0);
    const i1 = Math.min(i + W, count - 1);
    const speed = Math.hypot(raw[i1][0] - raw[i0][0], raw[i1][2] - raw[i0][2]) / ((i1 - i0) * SAMPLE);
    const r = Math.min(Math.round(18 - 13 * clamp01((speed - 0.15) / 0.5)), i, count - 1 - i);
    const sum = [0, 0, 0];
    for (let j = i - r; j <= i + r; j++) for (let c = 0; c < 3; c++) sum[c] += raw[j][c];
    return sum.map((v) => v / (2 * r + 1)) as Vec3;
  });
  // 2. one point every STEP metres
  const line: Vec3[] = [pts[0]];
  const times: number[] = [trajectory.start];
  let next = STEP; // metres into the current segment at which the next point falls
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
    while (next <= len) {
      const u = next / len;
      line.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]);
      times.push(Math.min(trajectory.start + (i - 1 + u) * SAMPLE, trajectory.end));
      next += STEP;
    }
    next -= len;
  }
  const n = line.length;
  if (n < 4) return null;
  const length = (n - 1) * STEP;

  // 3. the longest stop: where the most time passes within one step of the path
  let stop = 1;
  for (let i = 1; i < n; i++) if (times[i] - times[i - 1] > times[stop] - times[stop - 1]) stop = i;
  const at = line[stop];
  const near = raw.filter((p) => Math.hypot(p[0] - at[0], p[2] - at[2]) < 0.4).length * SAMPLE;
  const marks = [
    { p: line[0], s: 0, text: `ENTRY ${formatClock(trajectory.start)}` },
    { p: at, s: stop * STEP, text: `DWELL ${near.toFixed(1)} S` },
    { p: line[n - 1], s: length, text: `EXIT ${formatClock(trajectory.end)}` },
  ];

  // 4. distance field on a grid over the floor, one layer for the way in (up to the stop) and one for the
  //    way back: the two run side by side, and each is drawn on, and glows, by itself
  const reach = GLOW + 2 * TEXEL;
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const p of line) {
    x0 = Math.min(x0, p[0]);
    x1 = Math.max(x1, p[0]);
    z0 = Math.min(z0, p[2]);
    z1 = Math.max(z1, p[2]);
  }
  x0 -= reach + TEXEL;
  z0 -= reach + TEXEL;
  const w = Math.ceil((x1 + reach + TEXEL - x0) / TEXEL);
  const h = Math.ceil((z1 + reach + TEXEL - z0) / TEXEL);
  const dist = [new Float32Array(w * h).fill(FAR), new Float32Array(w * h).fill(FAR)];
  const along = [new Float32Array(w * h), new Float32Array(w * h)];
  for (let k = 0; k < n - 1; k++) {
    const a = line[k];
    const b = line[k + 1];
    const D = dist[k < stop ? 0 : 1];
    const S = along[k < stop ? 0 : 1];
    const ex = b[0] - a[0];
    const ez = b[2] - a[2];
    const ee = ex * ex + ez * ez || 1e-9;
    const i0 = Math.max(0, Math.floor((Math.min(a[0], b[0]) - reach - x0) / TEXEL));
    const i1 = Math.min(w - 1, Math.ceil((Math.max(a[0], b[0]) + reach - x0) / TEXEL));
    const j0 = Math.max(0, Math.floor((Math.min(a[2], b[2]) - reach - z0) / TEXEL));
    const j1 = Math.min(h - 1, Math.ceil((Math.max(a[2], b[2]) + reach - z0) / TEXEL));
    for (let j = j0; j <= j1; j++) {
      const pz = z0 + (j + 0.5) * TEXEL - a[2];
      for (let i = i0; i <= i1; i++) {
        const px = x0 + (i + 0.5) * TEXEL - a[0];
        const u = Math.min(1, Math.max(0, (px * ex + pz * ez) / ee));
        const d = Math.hypot(px - ex * u, pz - ez * u);
        if (d < D[j * w + i]) {
          D[j * w + i] = d;
          S[j * w + i] = (k + u) * STEP;
        }
      }
    }
  }
  const half = THREE.DataUtils.toHalfFloat;
  const data = new Uint16Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[4 * i] = half(dist[0][i]);
    data[4 * i + 1] = half(along[0][i]);
    data[4 * i + 2] = half(dist[1][i]);
    data[4 * i + 3] = half(along[1][i]);
  }
  const field = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
  field.minFilter = THREE.LinearFilter;
  field.magFilter = THREE.LinearFilter;
  field.generateMipmaps = false;
  field.needsUpdate = true;

  // 5. the sheet: over the grid, at the height of the floor the nearest piece of the path stands on
  const nx = Math.max(1, Math.ceil((w * TEXEL) / CELL));
  const nz = Math.max(1, Math.ceil((h * TEXEL) / CELL));
  const position: number[] = [];
  const uv: number[] = [];
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const x = x0 + (i / nx) * w * TEXEL;
      const z = z0 + (j / nz) * h * TEXEL;
      let best = Infinity;
      let y = line[0][1];
      for (let k = 0; k < n; k += 2) {
        const d = (line[k][0] - x) ** 2 + (line[k][2] - z) ** 2;
        if (d < best) {
          best = d;
          y = line[k][1];
        }
      }
      position.push(x, y + LIFT, z);
      uv.push(i / nx, j / nz);
    }
  }
  const index: number[] = [];
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const v = j * (nx + 1) + i;
      index.push(v, v + nx + 1, v + 1, v + 1, v + nx + 1, v + nx + 2);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(index);
  return { trajectory, geometry, field, length, line, times, marks };
}

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  varying vec2 vAt;
  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vAt = world.xz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uField;
  uniform float uHead;   // metres of the path drawn
  uniform float uAlpha;
  uniform float uTip;    // 0..1: the bright tip that draws the path
  uniform vec2 uTipAt;   // (world x, z)
  uniform float uNow;    // 0..1: the marker where the subject is at the shown incident time
  uniform vec2 uNowAt;
  uniform vec2 uEntry;
  uniform vec3 uStop;    // x, z, strength
  uniform vec3 uExit;
  uniform float uTime;
  uniform vec3 uCore;
  uniform vec3 uGlow;
  uniform vec3 uHot;
  varying vec2 vUv;
  varying vec2 vAt;
  const float CORE = ${CORE.toFixed(3)};
  const float GLOW = ${GLOW.toFixed(3)};

  // metres to the part of one pass drawn so far (f: metres to the pass, metres along the path at its nearest
  // point); the end of the drawn part comes out round
  float drawn(vec2 f) {
    return length(vec2(f.x, max(f.y - uHead, 0.0)));
  }
  float halo(float d) {
    float t = clamp((d - CORE * 0.6) / (GLOW - CORE * 0.6), 0.0, 1.0);
    return pow(1.0 - t, 2.0);
  }

  void main() {
    vec4 f = texture2D(uField, vUv);
    float dIn = drawn(f.rg);
    float dBack = drawn(f.ba);
    float d = min(dIn, dBack);
    if (d >= GLOW || uHead <= 0.0) discard;
    float s = dIn <= dBack ? f.g : f.a;

    float soft = max(fwidth(d), 0.002);
    float core = 1.0 - smoothstep(CORE - soft, CORE + soft, d);
    // where the way in and the way back run side by side, the floor between them is redder
    float glow = 1.0 - (1.0 - 0.8 * halo(dIn)) * (1.0 - 0.8 * halo(dBack));
    vec3 color = mix(uGlow, uCore, core);
    // a lighter thread down the middle, and light running along it the way the subject walked
    float thread = 1.0 - smoothstep(CORE * 0.08, CORE * 0.5, d);
    float run = pow(0.5 + 0.5 * sin((s - uTime * 2.6) * 3.6), 6.0);
    color = mix(color, uHot, thread * (0.2 + 0.7 * run));
    float alpha = max(core * 0.97, glow);

    // the tip that draws it
    float tip = uTip * exp(-pow(distance(vAt, uTipAt) / 0.24, 2.0));
    color = mix(color, vec3(1.0), tip * 0.9);
    alpha = max(alpha, tip);
    // where the subject is on it right now
    float here = uNow * exp(-pow(distance(vAt, uNowAt) / 0.3, 2.0));
    color = mix(color, uHot, here * 0.55);
    alpha = max(alpha, here * 0.8);
    // entry: a ring; longest stop: a wider, thinner ring; exit: a dot
    float ring = 1.0 - smoothstep(0.0, 0.022, abs(distance(vAt, uEntry) - 0.21));
    float halt = uStop.z * (1.0 - smoothstep(0.0, 0.016, abs(distance(vAt, uStop.xy) - 0.3)));
    float spot = uExit.z * (1.0 - smoothstep(0.1, 0.125, distance(vAt, uExit.xy)));
    float mark = max(max(ring, halt), spot);
    color = mix(color, vec3(1.0), mark * 0.92);
    alpha = max(alpha, mark);

    gl_FragColor = vec4(color, alpha * uAlpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const point = new THREE.Vector3();
/** Shared by the one path there is; written every frame of the walkthrough. */
const uniforms = {
  uField: { value: null as THREE.Texture | null },
  uHead: { value: 0 },
  uAlpha: { value: 0 },
  uTip: { value: 0 },
  uTipAt: { value: new THREE.Vector2() },
  uNow: { value: 0 },
  uNowAt: { value: new THREE.Vector2() },
  uEntry: { value: new THREE.Vector2() },
  uStop: { value: new THREE.Vector3() },
  uExit: { value: new THREE.Vector3() },
  uTime: { value: 0 },
  uCore: { value: new THREE.Color("#ff1022") },
  uGlow: { value: new THREE.Color("#ff1428") },
  uHot: { value: new THREE.Color("#ffe1d6") },
};

function Path() {
  const mesh = useRef<THREE.Mesh>(null);
  // (the track is rebuilt when calibration or annotations change, and once the body's motion has loaded)
  const trajectory = useSubjectTracks().find((t) => t.subject.id === DEMO_SUBJECT)?.trajectory;
  const built = useMemo(() => (trajectory ? build(trajectory) : null), [trajectory]);
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -4,
        toneMapped: false,
      }),
    [],
  );
  useEffect(() => () => material.dispose(), [material]);
  useEffect(
    () => () => {
      built?.geometry.dispose();
      built?.field.dispose();
    },
    [built],
  );

  useFrame(({ camera, size }) => {
    const m = mesh.current;
    if (!m) return;
    const { path, marks, pathInfo } = demoLook;
    m.visible = !!built && path.alpha > 0.001 && path.draw > 0;
    if (!built || !m.visible) {
      for (const mark of marks) mark.on = false;
      return;
    }
    const head = path.draw * built.length;
    const t = useReplayStore.getState().currentTime;
    const [entry, stop, exit] = built.marks;
    uniforms.uField.value = built.field;
    uniforms.uHead.value = head;
    uniforms.uAlpha.value = path.alpha;
    uniforms.uTip.value = path.draw < 1 ? Math.min(1, path.draw * 12) : 0;
    pointAt(built, head, uniforms.uTipAt.value);
    uniforms.uNow.value = path.draw >= 1 && t > built.trajectory.start && t < built.trajectory.end ? 1 : 0;
    pointAt(built, alongAt(built, t), uniforms.uNowAt.value);
    uniforms.uEntry.value.set(entry.p[0], entry.p[2]);
    // (the stop's ring belongs to its label: it goes with it)
    uniforms.uStop.value.set(stop.p[0], stop.p[2], head >= stop.s ? path.labels : 0);
    uniforms.uExit.value.set(exit.p[0], exit.p[2], head >= exit.s - 1e-3 ? 1 : 0);
    uniforms.uTime.value = demoLook.applied;

    pathInfo.drawn = head;
    pathInfo.length = built.length;
    pathInfo.start = built.trajectory.start;
    pathInfo.end = built.trajectory.end;
    built.marks.forEach((mark, i) => {
      const out = marks[i];
      point.set(mark.p[0], mark.p[1] + LIFT, mark.p[2]).project(camera);
      out.on = path.labels > 0 && head >= mark.s - 1e-3 && point.z < 1;
      out.x = (0.5 + point.x / 2) * size.width;
      out.y = (0.5 - point.y / 2) * size.height;
      out.text = mark.text;
    });
  });

  if (!built) return null;
  return <mesh ref={mesh} geometry={built.geometry} material={material} visible={false} frustumCulled={false} renderOrder={2} raycast={() => null} />;
}

/**
 * Demo walkthrough: the subject's whole path across the floor as a glowing red line, from the same fused
 * track that moves the body. It is drawn on from the entry (demoLook.path.draw), keeps a marker where the
 * subject is at the shown time, and publishes its length and its labelled points for the overlay.
 *
 * The line is not a strip of triangles along the path (that folds over itself where the subject turns round
 * or stands): the distance to the path is baked once into a texture over the floor, and the line, its glow
 * and the drawn-so-far front are cut out of that distance per pixel.
 */
export function DemoPath() {
  const demo = useDemoStore((s) => s.phase !== "idle");
  return demo ? <Path /> : null;
}
