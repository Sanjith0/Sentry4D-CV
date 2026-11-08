import type { CameraId, PersonObservation, VisibilityMark } from "../types/security";

/**
 * Sync offsets were corrected on 2026-11-08 from audio (clap transients + GCC-PHAT,
 * see experiments/reconstruction/REPORT.md). Data timed with the previous manual
 * offsets is re-timed so it still refers to the SAME video frames:
 *   masterTime_new = videoTime - offset_new = masterTime_old + offset_old - offset_new
 */
export const MANUAL_OFFSETS_V1: Record<CameraId, number> = { cam1: 0, cam2: 0, cam3: 0, cam4: 9.3 };
export const AUDIO_OFFSETS_V2: Record<CameraId, number> = { cam1: 0, cam2: 0.394, cam3: 0.111, cam4: 9.567 };

const r3 = (v: number) => Math.round(v * 1000) / 1000;

export function retimeObservationV1toV2(o: PersonObservation): PersonObservation {
  const videoTime = o.videoTime ?? o.masterTime + MANUAL_OFFSETS_V1[o.cameraId];
  return { ...o, masterTime: r3(videoTime - AUDIO_OFFSETS_V2[o.cameraId]), videoTime: r3(videoTime) };
}

export function retimeMarkV1toV2(m: VisibilityMark): VisibilityMark {
  return { ...m, masterTime: r3(m.masterTime + MANUAL_OFFSETS_V1[m.cameraId] - AUDIO_OFFSETS_V2[m.cameraId]) };
}
