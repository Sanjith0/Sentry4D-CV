import * as THREE from "three";

/**
 * Shared clipping plane used to hide the ceiling (non-destructively) on room materials.
 * Keeps geometry with y <= constant. constant = +Infinity-ish when the ceiling is shown.
 */
export const ceilingPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e6);
export const ceilingPlanes = [ceilingPlane];

export function setCeilingCut(visible: boolean, cutY: number) {
  ceilingPlane.constant = visible ? 1e6 : cutY;
}
