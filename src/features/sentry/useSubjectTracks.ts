import { useMemo } from "react";
import { subjects, type SubjectConfig } from "../../config/subjects";
import { useReplayStore } from "../../store/useReplayStore";
import { useViewStore } from "../../store/useViewStore";
import { frameInfoOrDefault } from "../../lib/videoRegistry";
import { useAnnotationStore } from "../annotation/useAnnotationStore";
import { buildTrajectory, type Trajectory } from "./trajectory";

export interface SubjectTrack {
  subject: SubjectConfig;
  trajectory: Trajectory;
}

/**
 * Trajectories for every configured subject, rebuilt whenever the annotations,
 * calibration or room bounds change (cheap: tens of observations).
 */
export function useSubjectTracks(): SubjectTrack[] {
  const persons = useAnnotationStore((s) => s.persons);
  const poses = useReplayStore((s) => s.cameraPoses);
  const bounds = useViewStore((s) => s.roomBounds);
  return useMemo(() => {
    const out: SubjectTrack[] = [];
    for (const subject of subjects) {
      const obs = persons[subject.personId];
      if (!obs?.length) continue;
      const trajectory = buildTrajectory({ observations: obs, poses, frameFor: frameInfoOrDefault, bounds });
      if (trajectory) out.push({ subject, trajectory });
    }
    return out;
  }, [persons, poses, bounds]);
}
