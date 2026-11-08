import { create } from "zustand";
import * as THREE from "three";
import type { CameraId } from "../../types/security";
import type { AppearanceClipManifest, AppearanceFrame, AppearanceStatus } from "./ReconstructionTypes";

/**
 * Clips of segmented real footage available to the renderer. Each is a folder in
 * public/reconstruction/<clip>/ produced by experiments/reconstruction (not committed:
 * derived from the private recordings). Missing clips are simply skipped.
 */
export const APPEARANCE_CLIPS = ["clip01"];
const BASE_URL = "/reconstruction";

interface AppearanceState {
  clips: Record<string, AppearanceClipManifest>;
  loadStatus: "idle" | "loading" | "ready" | "none" | "error";
  error: string | null;
  status: Record<string, AppearanceStatus>;
  load: () => Promise<void>;
  setStatus: (s: AppearanceStatus) => void;
}

export const useAppearanceStore = create<AppearanceState>()((set, get) => ({
  clips: {},
  loadStatus: "idle",
  error: null,
  status: {},
  load: async () => {
    if (get().loadStatus !== "idle") return;
    set({ loadStatus: "loading" });
    const clips: Record<string, AppearanceClipManifest> = {};
    for (const id of APPEARANCE_CLIPS) {
      try {
        const r = await fetch(`${BASE_URL}/${id}/manifest.json`);
        const type = r.headers.get("content-type") ?? "";
        if (!r.ok || type.includes("text/html")) continue; // not generated on this machine
        clips[id] = (await r.json()) as AppearanceClipManifest;
      } catch (e) {
        console.warn(`[Sentry3D] appearance clip ${id} failed to load`, e);
      }
    }
    set({ clips, loadStatus: Object.keys(clips).length ? "ready" : "none" });
  },
  setStatus: (s) =>
    set((st) => {
      const prev = st.status[s.subjectId];
      if (prev && JSON.stringify(prev) === JSON.stringify(s)) return {};
      return { status: { ...st.status, [s.subjectId]: s } };
    }),
}));

/** Frame of a clip at master time t (nearest sample), or null outside the clip. */
export function frameAt(clip: AppearanceClipManifest, cam: CameraId, t: number): AppearanceFrame | null {
  const frames = clip.cameras[cam]?.frames;
  if (!frames?.length) return null;
  const half = 0.5 / clip.fps;
  if (t < clip.t0 - half || t > clip.t1 + half) return null;
  const k = Math.min(Math.max(Math.round((t - clip.t0) * clip.fps), 0), frames.length - 1);
  const f = frames[k];
  return f?.file ? f : null;
}

/** Clips (for a subject) that cover master time t. */
export function clipsAt(subjectId: string, t: number): AppearanceClipManifest[] {
  const half = (c: AppearanceClipManifest) => 0.5 / c.fps;
  return Object.values(useAppearanceStore.getState().clips).filter((c) => c.subjectId === subjectId && t >= c.t0 - half(c) && t <= c.t1 + half(c));
}

/**
 * Small LRU texture cache: only frames near the playhead live on the GPU.
 * Crops are tiny (≈5-15 KB WebP, ≈300×500 px), so ~120 resident textures ≈ 70 MB worst case.
 */
const MAX_TEXTURES = 120;
const cache = new Map<string, { tex: THREE.Texture | null; promise: Promise<THREE.Texture> }>();
const loader = new THREE.TextureLoader();

export function getTexture(clip: string, file: string): THREE.Texture | null {
  const key = `${clip}/${file}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key); // refresh LRU order
    cache.set(key, hit);
    return hit.tex;
  }
  const entry: { tex: THREE.Texture | null; promise: Promise<THREE.Texture> } = { tex: null, promise: null as never };
  entry.promise = loader.loadAsync(`${BASE_URL}/${key}`).then((t) => {
    t.colorSpace = THREE.SRGBColorSpace;
    t.generateMipmaps = false;
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    entry.tex = t;
    return t;
  });
  entry.promise.catch(() => cache.delete(key));
  cache.set(key, entry);
  while (cache.size > MAX_TEXTURES) {
    const [oldKey, old] = cache.entries().next().value!;
    old.tex?.dispose();
    cache.delete(oldKey);
  }
  return null;
}

/** Warm the cache for frames around master time t (all cameras of the covering clips). */
export function prefetchAround(subjectId: string, t: number, seconds = 1) {
  for (const clip of clipsAt(subjectId, t)) {
    for (const [, cam] of Object.entries(clip.cameras)) {
      for (const f of cam!.frames) if (f.file && Math.abs(f.masterTime - t) <= seconds) getTexture(clip.clip, f.file);
    }
  }
}
