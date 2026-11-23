import { useEffect, useRef, type RefObject } from "react";
import * as THREE from "three";

/**
 * The scene's floating labels (the subject's tag, the cameras' labels) during the demo walkthrough.
 *
 * The walkthrough flies the viewpoint through the room, so labels that hang on points in the room end up
 * anywhere in the frame: cut by its edge, under the walkthrough's own captions, or on top of each other.
 * Each label therefore registers where it hangs and how much it matters, and once per frame every label gets
 * the opacity it has room for: it is gone before it would touch the edge of the viewport, the caption bands,
 * or a label that matters more. The opacity is a function of this frame's geometry only (no history), so a
 * frame looks the same however the walkthrough got there.
 *
 * Outside the walkthrough nothing is touched.
 */
export interface LabelSlot {
  /** 0 matters most: a label gives way to every label with a lower rank. */
  rank: number;
  /** The point in the scene the label is centred on. */
  anchorRef: RefObject<THREE.Object3D | null>;
  /** The label itself. */
  elRef: RefObject<HTMLDivElement | null>;
  /** Pixels the label is moved up from its anchor. */
  liftRef: RefObject<number>;
}

const slots = new Set<LabelSlot>();

/** Registers one floating label and returns the refs for its anchor, its element and its lift. */
export function useLabelSlot(rank: number) {
  const anchorRef = useRef<THREE.Object3D>(null);
  const elRef = useRef<HTMLDivElement>(null);
  const liftRef = useRef(0);
  useEffect(() => {
    const slot: LabelSlot = { rank, anchorRef, elRef, liftRef };
    slots.add(slot);
    return () => {
      slots.delete(slot);
    };
  }, [rank]);
  return { anchorRef, elRef, liftRef };
}

const obstacles = new Set<RefObject<HTMLElement | null>>();

/** Registers something drawn over the scene that the labels keep clear of (the tracking bracket, its values). */
export function useLabelObstacle(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    obstacles.add(ref);
    return () => {
      obstacles.delete(ref);
    };
  }, [ref]);
}

/** Bands of the viewport the walkthrough's captions and readouts use (px from its top and bottom). */
const HUD_TOP = 50;
const HUD_BOTTOM = 112;
/** A label keeps this far from the left and right edge of the viewport (px). */
const EDGE = 6;
/** A label fades over this many pixels of remaining room (short: a label is there or it is not). */
const FADE = 5;

interface Box {
  l: number;
  t: number;
  r: number;
  b: number;
}

const point = new THREE.Vector3();
const eye = new THREE.Vector3();
const ahead = new THREE.Vector3();
const toPoint = new THREE.Vector3();

/**
 * Gives every registered label the opacity it has room for. `view`: the viewport's size and where it sits in
 * the window (px), as react-three-fiber reports it.
 */
export function fitLabels(camera: THREE.Camera, view: { width: number; height: number; left: number; top: number }) {
  const { width, height } = view;
  const placed: Box[] = [];
  for (const ref of obstacles) {
    const r = ref.current?.getBoundingClientRect();
    if (r && r.width > 0 && r.height > 0) placed.push({ l: r.left - view.left, t: r.top - view.top, r: r.right - view.left, b: r.bottom - view.top });
  }
  camera.getWorldPosition(eye);
  camera.getWorldDirection(ahead);
  for (const slot of [...slots].sort((a, b) => a.rank - b.rank)) {
    const el = slot.elRef.current;
    const anchor = slot.anchorRef.current;
    if (!el || !anchor) continue;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    // not laid out: hidden by its owner, or behind the viewpoint
    if (w === 0 || h === 0) continue;
    anchor.getWorldPosition(point);
    if (toPoint.subVectors(point, eye).dot(ahead) <= 0) continue;
    point.project(camera);
    const cx = (0.5 + point.x / 2) * width;
    const cy = (0.5 - point.y / 2) * height - slot.liftRef.current;
    const box: Box = { l: cx - w / 2, t: cy - h / 2, r: cx + w / 2, b: cy + h / 2 };
    let room = Math.min(box.l - EDGE, width - EDGE - box.r, box.t - HUD_TOP, height - HUD_BOTTOM - box.b);
    for (const other of placed) {
      // distance between the two rectangles along the axis that separates them; negative where they overlap
      const apart = -Math.min(Math.min(box.r, other.r) - Math.max(box.l, other.l), Math.min(box.b, other.b) - Math.max(box.t, other.t));
      room = Math.min(room, apart);
    }
    const fit = Math.min(1, Math.max(0, room / FADE));
    el.style.opacity = fit >= 1 ? "" : fit.toFixed(2);
    if (fit > 0.01) placed.push(box);
  }
}

/** Hands every label back as its owner drew it. */
export function releaseLabels() {
  for (const slot of slots) if (slot.elRef.current) slot.elRef.current.style.opacity = "";
}
