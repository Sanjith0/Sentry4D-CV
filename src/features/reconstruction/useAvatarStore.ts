import { create } from "zustand";
import { CAMERA_IDS } from "../../types/security";
import { APPEARANCE_CLIPS } from "./useAppearanceStore";
import type { AvatarFloorSample, AvatarMotion, AvatarProjection, AvatarProp, AvatarStatus } from "./ReconstructionTypes";

/**
 * Reconstructed 3D body ("3D MODEL" render mode): one articulated, textured, skinned mesh per
 * clip, fitted offline to all cameras (experiments/reconstruction/avatar) and delivered as
 *   public/reconstruction/<clip>/avatar/avatar.json   per-frame root / floor / heading / support
 *   public/reconstruction/<clip>/avatar/<subject>.glb skeleton + skin + ONE baked clip "motion"
 * Like the footage sprites they live under the git-ignored public/reconstruction and are
 * force-added per clip; clips without an avatar folder are skipped silently.
 *
 * Everything exported here is a pure function of master time (frame k <-> t0 + k / fps).
 */
const BASE_URL = "/reconstruction";

type LoadStatus = "idle" | "loading" | "ready" | "none";

interface AvatarState {
  /** Avatar motions by clip id. */
  avatars: Record<string, AvatarMotion>;
  /** The same motions grouped by subject id (in APPEARANCE_CLIPS priority order). */
  bySubject: Record<string, AvatarMotion[]>;
  loadStatus: LoadStatus;
  status: Record<string, AvatarStatus>;
  load: () => Promise<void>;
  setStatus: (s: AvatarStatus) => void;
}

const isNumberArray = (v: unknown, n: number): v is number[] => Array.isArray(v) && v.length >= n;

/** Structural check: a malformed file must never reach the per-frame code. */
function parseAvatar(raw: unknown, clipId: string): AvatarMotion | null {
  const a = raw as Partial<AvatarMotion> | null;
  const f = a?.frames;
  if (!a || !f || typeof a.subjectId !== "string" || typeof a.glb !== "string") return null;
  if (!(Number(a.fps) > 0) || !Number.isFinite(a.t0) || !Number.isFinite(a.t1)) return null;
  const n = Math.min(f.floor?.length ?? 0, f.heading?.length ?? 0, f.valid?.length ?? 0, f.cameras?.length ?? 0);
  if (n < 1 || !isNumberArray(f.floor[0], 2)) return null;
  const frameCount = Math.min(a.frameCount ?? n, n);
  return {
    ...(a as AvatarMotion),
    clip: a.clip ?? clipId,
    frameCount,
    projection: parseProjection(a.projection, frameCount),
    props: (Array.isArray(a.props) ? a.props : []).filter((p) => isProp(p, frameCount)),
  };
}

/** The footage projection is optional: without it (or malformed) the body keeps its baked texture. */
function parseProjection(raw: unknown, frameCount: number): AvatarProjection | undefined {
  const p = raw as Partial<AvatarProjection> | null | undefined;
  if (!p || !isNumberArray(p.frame, 2) || !isNumberArray(p.lift, frameCount) || !p.cameras) return undefined;
  const cameras: AvatarProjection["cameras"] = {};
  for (const id of CAMERA_IDS) {
    const c = p.cameras[id];
    if (!c || ![c.f, c.cx, c.cy, c.k1, c.dt].every(Number.isFinite)) continue;
    if (!isNumberArray(c.t, 3) || !isNumberArray(c.C, 3) || !Array.isArray(c.R) || c.R.length < 3 || !c.R.every((r) => isNumberArray(r, 3))) continue;
    cameras[id] = c;
  }
  return Object.keys(cameras).length ? { ...(p as AvatarProjection), cameras } : undefined;
}

function isProp(raw: unknown, frameCount: number): raw is AvatarProp {
  const p = raw as Partial<AvatarProp> | null;
  const f = p?.frames;
  if (!p || !f || typeof p.id !== "string" || typeof p.glb !== "string") return false;
  return isNumberArray(f.lift, frameCount) && Array.isArray(f.pos) && f.pos.length >= frameCount && Array.isArray(f.quat) && f.quat.length >= frameCount && isNumberArray(f.pos[0], 3) && isNumberArray(f.quat[0], 4);
}

export const useAvatarStore = create<AvatarState>()((set, get) => ({
  avatars: {},
  bySubject: {},
  loadStatus: "idle",
  status: {},
  load: async () => {
    if (get().loadStatus !== "idle") return;
    set({ loadStatus: "loading" });
    const avatars: Record<string, AvatarMotion> = {};
    const bySubject: Record<string, AvatarMotion[]> = {};
    for (const id of APPEARANCE_CLIPS) {
      try {
        const r = await fetch(`${BASE_URL}/${id}/avatar/avatar.json`);
        const type = r.headers.get("content-type") ?? "";
        if (!r.ok || type.includes("text/html")) continue; // not generated for this clip / on this machine
        const motion = parseAvatar(await r.json(), id);
        if (!motion) {
          console.warn(`[Sentry3D] avatar motion for ${id} is malformed, ignored`);
          continue;
        }
        avatars[id] = motion;
        (bySubject[motion.subjectId] ??= []).push(motion);
      } catch (e) {
        console.warn(`[Sentry3D] avatar motion for ${id} failed to load`, e);
      }
    }
    set({ avatars, bySubject, loadStatus: Object.keys(avatars).length ? "ready" : "none" });
  },
  setStatus: (s) =>
    set((st) => {
      const prev = st.status[s.subjectId];
      if (prev && JSON.stringify(prev) === JSON.stringify(s)) return {};
      return { status: { ...st.status, [s.subjectId]: s } };
    }),
}));

/** URL of an avatar's GLB (the manifest path is relative to the clip folder). */
export function avatarModelUrl(motion: AvatarMotion) {
  return `${BASE_URL}/${motion.clip}/${motion.glb}`;
}

/** First of the given motions that covers master time t (half-frame tolerance at both ends). */
export function motionAt(motions: readonly AvatarMotion[] | undefined, t: number): AvatarMotion | null {
  if (!motions) return null;
  for (const m of motions) {
    const half = 0.5 / m.fps;
    if (t >= m.t0 - half && t <= m.t1 + half) return m;
  }
  return null;
}

/** Shortest-arc interpolation between two yaw angles. */
function lerpAngle(a: number, b: number, s: number) {
  const TAU = 2 * Math.PI;
  const d = ((((b - a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
  return a + d * s;
}

/**
 * Floor point / heading / support of the reconstructed body at master time t, linearly
 * interpolated between frames exactly like the baked animation (shortest arc for heading).
 * `valid`, `cameras` and `k` are those of the nearest frame; when only one of the two
 * bracketing frames is usable the sample snaps to it instead of blending into a bad pose.
 * `clipTime` is the matching time on the GLB clip: clamp(t - t0, 0, (frameCount - 1) / fps),
 * snapped the same way, so the mesh and its floor point always describe the same instant.
 */
export function floorAt(motions: readonly AvatarMotion[] | undefined, t: number): AvatarFloorSample | null {
  const m = motionAt(motions, t);
  if (!m) return null;
  const { floor, heading, cameras, valid, floorY } = m.frames;
  const last = m.frameCount - 1;
  const f = Math.min(Math.max((t - m.t0) * m.fps, 0), last);
  const k = Math.min(Math.round(f), last);
  let k0 = Math.min(Math.floor(f), last);
  let k1 = Math.min(k0 + 1, last);
  if (!valid[k0] || !valid[k1]) k0 = k1 = k;
  const s = k1 > k0 ? f - k0 : 0;
  const a = floor[k0];
  const b = floor[k1];
  const ya = floorY?.[k0] ?? 0;
  const yb = floorY?.[k1] ?? 0;
  return {
    x: a[0] + (b[0] - a[0]) * s,
    y: ya + (yb - ya) * s,
    z: a[1] + (b[1] - a[1]) * s,
    heading: lerpAngle(heading[k0], heading[k1], s),
    cameras: cameras[k] ?? 0,
    valid: !!valid[k],
    k,
    clipTime: (k0 + s) / m.fps,
    clip: m.clip,
  };
}

/** Avatar clip (for a subject) that covers master time t, or null. */
export function avatarClipAt(subjectId: string, t: number): AvatarMotion | null {
  return motionAt(useAvatarStore.getState().bySubject[subjectId], t);
}

/** Where the reconstructed body stands at master time t (see floorAt), or null outside its clips. */
export function avatarFloorAt(subjectId: string, t: number): AvatarFloorSample | null {
  return floorAt(useAvatarStore.getState().bySubject[subjectId], t);
}

/** True while the 3D MODEL renderer is drawing this subject (SceneActors hides the debug avatar). */
export function avatarActive(subjectId: string) {
  return !!useAvatarStore.getState().status[subjectId]?.active;
}
