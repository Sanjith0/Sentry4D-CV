import * as THREE from "three";
import type { AvatarModel } from "./AvatarLayer";
import { floorAt, motionAt, useAvatarStore } from "./useAvatarStore";

/** The subjects' loaded models per clip id (kept by AvatarLayer while they are on screen). */
export const bakeSources = new Map<string, { models: Record<string, AvatarModel | "failed"> }>();

const bakeAt = new THREE.Vector3();
const bakeQuat = new THREE.Quaternion();
const bakeMatrix = new THREE.Matrix4();
const bakeRel = new THREE.Matrix4();

/**
 * Demo walkthrough: the subject's reconstructed body at master time t, and what he has in his hands then, as
 * plain geometries in room coordinates (the caller owns and disposes them). Null while his model is loading
 * and where there is no usable pose.
 */
export function bakeSubjectPose(subjectId: string, t: number): THREE.BufferGeometry[] | null {
  const motions = useAvatarStore.getState().bySubject[subjectId];
  const motion = motionAt(motions, t);
  const at = floorAt(motions, t);
  const model = at ? bakeSources.get(subjectId)?.models[at.clip] : undefined;
  if (!motion || !at?.valid || !model || model === "failed") return null;
  const out = [model.bake(at.clipTime)];
  const f = at.clipTime * motion.fps;
  motion.props?.forEach((data, i) => {
    const prop = model.props[i];
    const { pos, quat, lift, held, visible } = data.frames;
    const k = Math.min(Math.max(Math.round(f), 0), pos.length - 1);
    if (!prop || !held?.[k] || visible?.[k] === false) return;
    // where poseProp puts it at that frame (the object itself is left where it is)
    bakeAt.set(pos[k][0], pos[k][1] + lift[k], pos[k][2]);
    bakeMatrix.compose(bakeAt, bakeQuat.fromArray(quat[k]), prop.root.scale);
    if (prop.root.parent) bakeMatrix.premultiply(prop.root.parent.matrixWorld);
    prop.root.updateMatrixWorld(true);
    bakeRel.copy(prop.root.matrixWorld).invert();
    prop.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.geometry.getAttribute("position")) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", m.geometry.getAttribute("position").clone());
      if (m.geometry.index) g.setIndex(m.geometry.index.clone());
      g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(bakeMatrix, new THREE.Matrix4().multiplyMatrices(bakeRel, m.matrixWorld)));
      g.computeVertexNormals();
      out.push(g);
    });
  });
  return out;
}
