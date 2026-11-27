/**
 * What the demo walkthrough asks of the renderers this frame. Plain mutable fields: the director writes
 * them before the scene's own per-frame work, render code reads them, nothing re-renders.
 */
export const demoLook = {
  /** The walkthrough owns the viewport (camera, room build, time). */
  active: false,
  /** 0..1: cyan hologram over the whole reconstructed body. */
  hologram: 0,
  /** Hologram only: the textured body is not drawn. */
  hideBody: false,
  /** 0: the hologram is a flat tint (as on the footage cut-out), 1: scan lines, rim light and a sweeping band. */
  holoStyle: 0,
  /** 0..1: the hologram is white instead of cyan. */
  holoWhite: 0,
  /** World height of the hologram's bright band. */
  holoBand: -10,
  /** The scene's own floating tags on the subject are left out (the overlay labels it instead). */
  hideTags: false,
  /** The scene's own tag on the subject is moved up by this many pixels (seen from far it would sit on him). */
  tagLift: 0,
  /** The scene's own trail of the subject's last seconds is left out (the whole path is on the floor instead). */
  hideTrail: false,
  /** The subject (body, footage, ring, tag, trail, carried chair) and the cameras' status on him are left out. */
  hideSubject: false,
  /** The subject's whole path on the floor: share of its length drawn, strength, and its labels (all 0..1). */
  path: { draw: 0, alpha: 0, labels: 0, follow: false, trail: false },
  /**
   * What the path component found, for the overlay: metres drawn so far and in all, first and last observation
   * (s), the longest stop (seconds, and since when), where he came in and where he is last seen.
   */
  pathInfo: { drawn: 0, length: 0, start: 0, end: 0, dwell: 0, dwellFrom: 0, entry: [0, 0, 0] as [number, number, number], exit: [0, 0, 0] as [number, number, number] },
  /** Labels on the path (entry, stop, exit), in viewport pixels (drawn by the overlay). */
  marks: [0, 1, 2].map(() => ({ on: false, x: 0, y: 0, text: "" })),
  /** 0..1: the cameras' coverage volumes unfold (1 = as the viewer draws them). */
  coverage: 1,
  /** 0..1: the cameras' labels in the scene (1 = as the viewer draws them). */
  cameraTags: 1,
  /** The cameras' labels give their name only, not what they see of the subject. */
  plainCameraTags: false,
  /** The recordings are not on screen: leave the <video> elements alone instead of seeking them. */
  holdVideos: false,
  /** Tracking bracket around the subject, in viewport pixels (drawn by the overlay); lock 0..1: closing in. */
  bracket: { on: false, lock: 0, x: 0, top: 0, bottom: 0, text: "", sub: "" },
  /**
   * Demo 2: the label on the exit the forecast points at (written by Demo2Scene from the fused track, drawn by
   * the overlay): where (viewport pixels), what it says, 0..1 how much of it is there.
   */
  forecast: { exitOn: false, ex: 0, ey: 0, exitText: "", exitAlpha: 0 },
  /** Demo time the scene was last set to (recording waits for this to match the requested step). */
  applied: -1,
};
