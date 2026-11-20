import { useEffect, useMemo } from "react";
import { subjects, type SubjectConfig } from "../../config/subjects";
import { useReplayStore } from "../../store/useReplayStore";
import { useViewStore } from "../../store/useViewStore";
import { frameInfoOrDefault } from "../../lib/videoRegistry";
import type { Vec3 } from "../../types/security";
import { useAnnotationStore } from "../annotation/useAnnotationStore";
import type { AvatarMotion } from "../reconstruction/ReconstructionTypes";
import { floorAt, useAvatarStore } from "../reconstruction/useAvatarStore";
import { buildTrajectory, type SubjectState, type Trajectory } from "./trajectory";

export interface SubjectTrack {
  subject: SubjectConfig;
  trajectory: Trajectory;
}

/**
 * Makes the subject's floor position agree with the reconstructed 3D body. Wherever avatar
 * motion covers t with a usable pose, `sample(t)` takes x / z and the heading from the body
 * (dense, fitted to all cameras) instead of the interpolation between sparse manual
 * annotations, and y from the scanned floor the body stands on (a few centimetres off the
 * nominal y = 0, so ring and trail are not buried in the room scan); `path()` returns the
 * same refined positions. Presence (`visible`, `start`,
 * `end`), evidence (`status`, `cameras`, `gaps`, `samples`, `verdicts`) and gait / speed stay
 * those of the annotation track, and outside the avatar clip or on unusable frames the base
 * trajectory is returned unchanged. Still a pure function of master time.
 */
export function refineTrajectory(base: Trajectory, motions: readonly AvatarMotion[] | undefined): Trajectory {
  if (!motions?.length) return base;
  const sample = (t: number): SubjectState => {
    const st = base.sample(t);
    if (!st.visible) return st;
    const at = floorAt(motions, t);
    return at?.valid ? { ...st, position: [at.x, at.y, at.z], rotationY: at.heading } : st;
  };
  // Same sampling instants and count as the base path (the trail maps point index back to time).
  const path = (t0: number, t1: number, step = 1 / 15): Vec3[] => {
    const a = Math.max(t0, base.start);
    const b = Math.min(t1, base.end);
    const out: Vec3[] = [];
    if (b <= a) return out;
    const push = (t: number) => {
      const p = sample(t).position;
      out.push([p[0], p[1] + 0.02, p[2]]);
    };
    for (let t = a; t < b; t += step) push(t);
    push(b);
    return out;
  };
  return { ...base, sample, path };
}

/**
 * Trajectories for every configured subject, rebuilt whenever the annotations,
 * calibration or room bounds change (cheap: tens of observations), and again once the
 * reconstructed-body motion has loaded (it then drives the floor position, see refineTrajectory).
 */
export function useSubjectTracks(): SubjectTrack[] {
  const persons = useAnnotationStore((s) => s.persons);
  const poses = useReplayStore((s) => s.cameraPoses);
  const bounds = useViewStore((s) => s.roomBounds);
  const avatarMotions = useAvatarStore((s) => s.bySubject);
  useEffect(() => {
    void useAvatarStore.getState().load(); // idempotent; also requested by AvatarLayer
  }, []);
  return useMemo(() => {
    const out: SubjectTrack[] = [];
    for (const subject of subjects) {
      const obs = persons[subject.personId];
      if (!obs?.length) continue;
      const trajectory = buildTrajectory({ observations: obs, poses, frameFor: frameInfoOrDefault, bounds });
      if (trajectory) out.push({ subject, trajectory: refineTrajectory(trajectory, avatarMotions[subject.id]) });
    }
    return out;
  }, [persons, poses, bounds, avatarMotions]);
}
