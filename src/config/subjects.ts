/**
 * Tracked subjects rendered in 3D. Each maps to a Phase-1 annotation dataset
 * (personId in src/data/person-annotations.json / the annotation panel).
 */
export interface SubjectConfig {
  /** Stable entity id (used for selection + events). */
  id: string;
  label: string;
  /** Annotation dataset to follow. */
  personId: string;
  /** Standing height in meters (the humanoid is scaled to this). */
  heightM: number;
  /** Shoulder width relative to a 1.75 m reference build. */
  build: number;
  color: string;
}

export const subjects: SubjectConfig[] = [
  { id: "subject-01", label: "PERSON 01", personId: "person_01", heightM: 1.75, build: 1, color: "#22d3ee" },
];

export const trajectoryConfig = {
  /** Observations closer than this in time (s) are treated as simultaneous and fused. */
  clusterWindow: 0.2,
  /** Plausible max subject speed (m/s); faster implied jumps are treated as outliers. */
  maxSpeed: 3.0,
  /** Segments longer than this (s) between fused samples are rendered as ESTIMATED. */
  gapSeconds: 1.5,
  /** Below this displacement (m) between samples the subject counts as standing. */
  standThreshold: 0.15,
  /** Movement trail length (s). 0 disables the trail. */
  trailSeconds: 6,
  /**
   * Visibility evidence: a camera counts as TRACKING within ±evidenceHold (s) of a real
   * observation in that camera, and between two observations in the same camera that are
   * at most evidenceBridge (s) apart (annotations are sparse samples of a continuous view).
   */
  evidenceHold: 0.5,
  evidenceBridge: 2.0,
  /** Stride length (m) used for the walk cycle. */
  strideM: 0.75,
};
