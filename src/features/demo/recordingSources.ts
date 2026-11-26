import type { CameraId } from "../../types/security";
import { clipsAt, frameAt } from "../reconstruction/useAppearanceStore";
import { DEMO_SUBJECT } from "./demoScript";

/**
 * Per CCTV camera, 0..1: the Gaussian-weighted share of moments within ±SOURCE_REACH s of incident time t at
 * which that camera's recording has his cut-out. Smooth in t, so the free camera's lingering never jumps when
 * a camera loses him.
 */
const SOURCE_REACH = 0.6;
const SOURCE_TAPS = 13;
export function recordingSources(t: number): Partial<Record<CameraId, number>> {
  const out: Partial<Record<CameraId, number>> = {};
  let wsum = 0;
  for (let i = 0; i < SOURCE_TAPS; i++) {
    const dt = SOURCE_REACH * ((2 * i) / (SOURCE_TAPS - 1) - 1);
    const w = Math.exp(-0.5 * (dt / (SOURCE_REACH / 2)) ** 2);
    wsum += w;
    for (const clip of clipsAt(DEMO_SUBJECT, t + dt)) {
      for (const cam of Object.keys(clip.cameras) as CameraId[]) {
        if (frameAt(clip, cam, t + dt)?.crop) out[cam] = (out[cam] ?? 0) + w;
      }
    }
  }
  for (const cam of Object.keys(out) as CameraId[]) out[cam] = Math.min(1, (out[cam] ?? 0) / wsum);
  return out;
}
