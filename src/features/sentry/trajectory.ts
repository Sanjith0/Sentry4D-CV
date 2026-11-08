/**
 * Deterministic subject trajectory from Phase-1 annotations.
 *
 *  observations ──► clusters (same instant, any camera)
 *              ──► fused samples (priority + outlier rejection, weighted mean)
 *              ──► spike rejection (implausible speed)
 *              ──► piecewise cubic Hermite through fused samples (linear across gaps)
 *              ──► dense 60 Hz table (arc length → gait phase, speed)
 *
 * Every output is a pure function of master time, so seeking/scrubbing in any
 * direction reproduces exactly the same state.
 */
import { trajectoryConfig as CFG } from "../../config/subjects";
import { videoPixelToWorld, type VideoFrameInfo } from "../../lib/videoProjection";
import type { CameraId, CameraPoseConfig, ObservationSource, PersonObservation, RoomBounds, Vec3 } from "../../types/security";

export type SampleStatus = "tracked" | "estimated";

export interface ObservationVerdict {
  id: string;
  cameraId: CameraId;
  masterTime: number;
  accepted: boolean;
  /** Why it was rejected (or null). */
  reason: string | null;
  sigma: number;
}

export interface FusedSample {
  t: number;
  p: [number, number]; // x, z
  sigma: number;
  cameras: CameraId[];
  observationIds: string[];
  /** Highest-priority source used. */
  source: ObservationSource | "auto";
}

export interface SubjectState {
  visible: boolean;
  position: Vec3;
  /** Yaw for a model that faces +Z. */
  rotationY: number;
  speed: number;
  status: SampleStatus;
  /** Walk-cycle phase (radians), from distance travelled. */
  gaitPhase: number;
  /** Cameras of the bracketing fused samples. */
  cameras: CameraId[];
  /** Seconds to the nearest fused sample. */
  nearestSampleDt: number;
}

export interface Trajectory {
  samples: FusedSample[];
  verdicts: ObservationVerdict[];
  start: number;
  end: number;
  /** Gaps rendered as estimated: [t0, t1]. */
  gaps: [number, number][];
  sample: (t: number) => SubjectState;
  /** Positions over [t0, t1] (for trails). */
  path: (t0: number, t1: number, step?: number) => Vec3[];
}

const PRIORITY: Record<string, number> = { "manual-topdown": 3, manual: 2, auto: 1 };
const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

interface Meas {
  o: PersonObservation;
  p: [number, number];
  sigma: number;
  rank: number;
}

/** Measurement σ (m) from projection geometry: grazing/distant views are less certain. */
function measurementSigma(o: PersonObservation, pose: CameraPoseConfig | undefined, frame: VideoFrameInfo, bounds: RoomBounds | null) {
  if (o.source === "manual-topdown") return { sigma: 0.08, valid: true, reason: null as string | null };
  if (!pose) return { sigma: 0.3, valid: true, reason: null };
  const r = videoPixelToWorld(pose, o.pixel, frame, bounds);
  if (!r.valid) return { sigma: Infinity, valid: false, reason: `invalid projection: ${r.reason}` };
  // expectedErrorM is the floor error for a ~6 px click error ≈ 2σ.
  return { sigma: Math.max(0.05, (r.expectedErrorM ?? 0.3) / 2), valid: true, reason: null };
}

function weightedMean(ms: Meas[]): { p: [number, number]; sigma: number } {
  let wx = 0;
  let wz = 0;
  let w = 0;
  for (const m of ms) {
    const k = 1 / (m.sigma * m.sigma);
    wx += m.p[0] * k;
    wz += m.p[1] * k;
    w += k;
  }
  return { p: [wx / w, wz / w], sigma: Math.sqrt(1 / w) };
}

/** Linear prediction at time t from rough samples, excluding index `skip`. */
function predict(rough: { t: number; p: [number, number] }[], t: number, skip: number): [number, number] | null {
  const pts = rough.filter((_, i) => i !== skip);
  if (!pts.length) return null;
  let i = pts.findIndex((s) => s.t >= t);
  if (i === -1) return pts[pts.length - 1].p;
  if (i === 0) return pts[0].p;
  const a = pts[i - 1];
  const b = pts[i];
  const s = (t - a.t) / (b.t - a.t || 1);
  return [a.p[0] + (b.p[0] - a.p[0]) * s, a.p[1] + (b.p[1] - a.p[1]) * s];
}

export interface BuildInput {
  observations: PersonObservation[];
  poses: Record<CameraId, CameraPoseConfig>;
  frameFor: (id: CameraId) => VideoFrameInfo;
  bounds: RoomBounds | null;
}

export function buildTrajectory({ observations, poses, frameFor, bounds }: BuildInput): Trajectory | null {
  const verdicts: ObservationVerdict[] = [];
  const meas: Meas[] = [];
  for (const o of [...observations].sort((a, b) => a.masterTime - b.masterTime)) {
    const m = measurementSigma(o, poses[o.cameraId], frameFor(o.cameraId), bounds);
    const v: ObservationVerdict = { id: o.id, cameraId: o.cameraId, masterTime: o.masterTime, accepted: m.valid, reason: m.reason, sigma: m.sigma };
    verdicts.push(v);
    if (m.valid) meas.push({ o, p: [o.worldPosition[0], o.worldPosition[2]], sigma: m.sigma, rank: PRIORITY[o.source] ?? 1 });
  }
  const reject = (id: string, reason: string) => {
    const v = verdicts.find((x) => x.id === id);
    if (v) {
      v.accepted = false;
      v.reason = reason;
    }
  };

  // 1) Cluster observations made at (nearly) the same instant, possibly by different cameras.
  const clusters: Meas[][] = [];
  for (const m of meas) {
    const last = clusters[clusters.length - 1];
    if (last && m.o.masterTime - last[0].o.masterTime <= CFG.clusterWindow) last.push(m);
    else clusters.push([m]);
  }
  if (!clusters.length) return null;

  // Rough track (plain weighted means) used to arbitrate conflicts inside a cluster.
  const rough = clusters.map((c) => ({ t: c.reduce((a, m) => a + m.o.masterTime, 0) / c.length, p: weightedMean(c).p }));

  // 2) Fuse each cluster: highest-priority source wins; lower-priority measurements are kept
  //    only if they agree; disagreeing same-priority pairs are resolved by the neighbours.
  const samples: FusedSample[] = [];
  clusters.forEach((cluster, ci) => {
    const topRank = Math.max(...cluster.map((m) => m.rank));
    let use = cluster.filter((m) => m.rank === topRank);
    const gate = (a: Meas, b: { sigma: number }, dt: number) => Math.max(0.35, 3 * Math.hypot(a.sigma, b.sigma)) + CFG.maxSpeed * dt;

    // Robust same-priority agreement.
    while (use.length >= 2) {
      const mean = weightedMean(use);
      const tMean = use.reduce((a, m) => a + m.o.masterTime, 0) / use.length;
      const worst = use
        .map((m) => ({ m, excess: dist(m.p, mean.p) - gate(m, mean, Math.abs(m.o.masterTime - tMean)) }))
        .sort((a, b) => b.excess - a.excess)[0];
      if (worst.excess <= 0) break;
      if (use.length === 2) {
        // Two disagreeing cameras: keep the one consistent with the surrounding track.
        const pred = predict(rough, tMean, ci);
        if (!pred) break;
        const [a, b] = use;
        const drop = dist(a.p, pred) > dist(b.p, pred) ? a : b;
        reject(drop.o.id, `conflicts with ${use.find((x) => x !== drop)!.o.cameraId} at the same time and with the surrounding track`);
        use = use.filter((x) => x !== drop);
      } else {
        reject(worst.m.o.id, "outlier vs. other cameras at the same time");
        use = use.filter((x) => x !== worst.m);
      }
    }
    const anchor = weightedMean(use);
    // Lower-priority measurements: include only if they agree with the higher-priority anchor.
    for (const m of cluster) {
      if (m.rank === topRank) continue;
      if (dist(m.p, anchor.p) <= gate(m, anchor, 0)) use.push(m);
      else reject(m.o.id, "conflicts with a higher-priority manual correction");
    }
    const fused = weightedMean(use);
    const top = use.reduce((a, m) => (m.rank > a.rank ? m : a), use[0]);
    samples.push({
      t: use.reduce((a, m) => a + m.o.masterTime, 0) / use.length,
      p: fused.p,
      sigma: fused.sigma,
      cameras: [...new Set(use.map((m) => m.o.cameraId))],
      observationIds: use.map((m) => m.o.id),
      source: top.o.source,
    });
  });

  // 3) Temporal outlier rejection (leave-one-out). A sample is dropped when it lies far from
  //    the straight path between its neighbours AND reaching/leaving it needs an implausible
  //    speed. Worst offender first, then re-evaluate. Manual top-down corrections are trusted.
  const speed = (a: FusedSample, b: FusedSample) => dist(a.p, b.p) / Math.max(b.t - a.t, 1e-3);
  for (;;) {
    let worst = -1;
    let worstExcess = 0;
    let worstInfo = "";
    for (let i = 1; i < samples.length - 1; i++) {
      const [a, b, c] = [samples[i - 1], samples[i], samples[i + 1]];
      if (b.source === "manual-topdown") continue;
      if (c.t - a.t > 2 * CFG.gapSeconds) continue; // neighbours too far apart to judge
      const s = (b.t - a.t) / (c.t - a.t || 1e-3);
      const pred: [number, number] = [a.p[0] + (c.p[0] - a.p[0]) * s, a.p[1] + (c.p[1] - a.p[1]) * s];
      const residual = dist(b.p, pred);
      // Slack for genuine turns/accelerations (~2 m/s²) plus measurement noise.
      const allowed = Math.max(0.4, 3 * b.sigma) + 0.5 * 2.0 * (b.t - a.t) * (c.t - b.t);
      const vmax = Math.max(speed(a, b), speed(b, c));
      const excess = residual - allowed;
      if (excess > 0 && vmax > CFG.maxSpeed && speed(a, c) <= CFG.maxSpeed && excess > worstExcess) {
        worst = i;
        worstExcess = excess;
        worstInfo = `${residual.toFixed(2)} m off the surrounding track, implies ${vmax.toFixed(1)} m/s (> ${CFG.maxSpeed} m/s)`;
      }
    }
    if (worst < 0) break;
    samples[worst].observationIds.forEach((id) => reject(id, `outlier: ${worstInfo}`));
    samples.splice(worst, 1);
  }
  if (!samples.length) return null;

  // 4) Curve: cubic Hermite through samples; straight lines across gaps (estimated).
  const n = samples.length;
  const isGap = (i: number) => samples[i + 1].t - samples[i].t > CFG.gapSeconds;
  const segVel = (i: number): [number, number] => {
    const dt = samples[i + 1].t - samples[i].t || 1e-3;
    return [(samples[i + 1].p[0] - samples[i].p[0]) / dt, (samples[i + 1].p[1] - samples[i].p[1]) / dt];
  };
  const tangents: [number, number][] = samples.map((_, i) => {
    const left = i > 0 && !isGap(i - 1) ? segVel(i - 1) : null;
    const right = i < n - 1 && !isGap(i) ? segVel(i) : null;
    if (!left && !right) return [0, 0];
    const still = (k: number) => dist(samples[k].p, samples[k + 1].p) < CFG.standThreshold;
    if ((left && still(i - 1)) || (right && still(i))) return [0, 0]; // standing: no drift
    const m: [number, number] = left && right ? [(left[0] + right[0]) / 2, (left[1] + right[1]) / 2] : (left ?? right)!;
    // Limit overshoot: no faster than the slower adjacent segment × 1.5.
    const cap = 1.5 * Math.min(...[left, right].filter(Boolean).map((v) => Math.hypot(v![0], v![1])));
    const mag = Math.hypot(m[0], m[1]);
    return mag > cap && mag > 0 ? [(m[0] * cap) / mag, (m[1] * cap) / mag] : m;
  });

  const segAt = (t: number) => {
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (samples[mid].t <= t) lo = mid;
      else hi = mid;
    }
    return lo;
  };

  const posAt = (t: number): [number, number] => {
    if (n === 1) return samples[0].p;
    const i = Math.min(segAt(t), n - 2);
    const a = samples[i];
    const b = samples[i + 1];
    const h = b.t - a.t || 1e-3;
    const s = Math.min(Math.max((t - a.t) / h, 0), 1);
    if (isGap(i)) return [a.p[0] + (b.p[0] - a.p[0]) * s, a.p[1] + (b.p[1] - a.p[1]) * s];
    const s2 = s * s;
    const s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1;
    const h10 = s3 - 2 * s2 + s;
    const h01 = -2 * s3 + 3 * s2;
    const h11 = s3 - s2;
    const [m0, m1] = [tangents[i], tangents[i + 1]];
    return [
      h00 * a.p[0] + h10 * h * m0[0] + h01 * b.p[0] + h11 * h * m1[0],
      h00 * a.p[1] + h10 * h * m0[1] + h01 * b.p[1] + h11 * h * m1[1],
    ];
  };

  // Heading per sample from the surrounding motion; carried forward while standing.
  const heading: (number | null)[] = samples.map((_, i) => {
    const a = samples[Math.max(0, i - 1)].p;
    const b = samples[Math.min(n - 1, i + 1)].p;
    return dist(a, b) >= CFG.standThreshold ? Math.atan2(b[0] - a[0], b[1] - a[1]) : null;
  });
  for (let i = 1; i < n; i++) if (heading[i] == null) heading[i] = heading[i - 1];
  for (let i = n - 2; i >= 0; i--) if (heading[i] == null) heading[i] = heading[i + 1];
  const yaws = heading.map((h) => h ?? 0);
  const lerpAngle = (a: number, b: number, s: number) => {
    let d = ((b - a + Math.PI) % (2 * Math.PI)) - Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    return a + d * s;
  };

  // Dense table for arc length (gait) and speed.
  const start = samples[0].t;
  const end = samples[n - 1].t;
  const STEP = 1 / 60;
  const count = Math.max(2, Math.ceil((end - start) / STEP) + 1);
  const cum = new Float64Array(count);
  let prev = posAt(start);
  for (let k = 1; k < count; k++) {
    const p = posAt(Math.min(start + k * STEP, end));
    cum[k] = cum[k - 1] + dist(prev, p);
    prev = p;
  }
  const distanceAt = (t: number) => {
    const f = (t - start) / STEP;
    const k = Math.min(Math.max(Math.floor(f), 0), count - 2);
    return cum[k] + (cum[k + 1] - cum[k]) * Math.min(Math.max(f - k, 0), 1);
  };

  const gaps: [number, number][] = [];
  for (let i = 0; i < n - 1; i++) if (isGap(i)) gaps.push([samples[i].t, samples[i + 1].t]);

  const hidden: SubjectState = {
    visible: false,
    position: [0, 0, 0],
    rotationY: 0,
    speed: 0,
    status: "estimated",
    gaitPhase: 0,
    cameras: [],
    nearestSampleDt: Infinity,
  };

  const sample = (t: number): SubjectState => {
    // Not present before the first observation or after the last one.
    if (t < start - 1e-6 || t > end + 1e-6) return hidden;
    const p = posAt(t);
    const i = Math.min(segAt(t), Math.max(n - 2, 0));
    const a = samples[i];
    const b = samples[Math.min(i + 1, n - 1)];
    const s = b.t > a.t ? Math.min(Math.max((t - a.t) / (b.t - a.t), 0), 1) : 0;
    const smooth = s * s * (3 - 2 * s);
    const rotationY = lerpAngle(yaws[i], yaws[Math.min(i + 1, n - 1)], smooth);
    const dt = 0.1;
    const spd = (distanceAt(Math.min(t + dt, end)) - distanceAt(Math.max(t - dt, start))) / (Math.min(t + dt, end) - Math.max(t - dt, start) || 1);
    const gap = n > 1 && isGap(i) && t > a.t + 1e-6 && t < b.t - 1e-6;
    return {
      visible: true,
      position: [p[0], 0, p[1]],
      rotationY,
      speed: spd,
      status: gap ? "estimated" : "tracked",
      gaitPhase: (distanceAt(t) / CFG.strideM) * Math.PI,
      cameras: [...new Set([...a.cameras, ...b.cameras])],
      nearestSampleDt: Math.min(Math.abs(t - a.t), Math.abs(t - b.t)),
    };
  };

  const path = (t0: number, t1: number, step = 1 / 15): Vec3[] => {
    const a = Math.max(t0, start);
    const b = Math.min(t1, end);
    const out: Vec3[] = [];
    if (b <= a) return out;
    for (let t = a; t < b; t += step) {
      const p = posAt(t);
      out.push([p[0], 0.02, p[1]]);
    }
    const p = posAt(b);
    out.push([p[0], 0.02, p[1]]);
    return out;
  };

  return { samples, verdicts, start, end, gaps, sample, path };
}
