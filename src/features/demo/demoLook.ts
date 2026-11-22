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
  /** World height of the hologram's bright band. */
  holoBand: -10,
  /** The scene's own floating tags on the subject are left out (the overlay labels it instead). */
  hideTags: false,
  /** 0..1: the cameras' coverage volumes unfold (1 = as the viewer draws them). */
  coverage: 1,
  /** The recordings are not on screen: leave the <video> elements alone instead of seeking them. */
  holdVideos: false,
  /** Tracking bracket around the subject, in viewport pixels (drawn by the overlay); lock 0..1: closing in. */
  bracket: { on: false, lock: 0, x: 0, top: 0, bottom: 0, text: "", sub: "" },
  /** Demo time the scene was last set to (recording waits for this to match the requested step). */
  applied: -1,
};
