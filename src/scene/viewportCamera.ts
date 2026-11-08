import { useThree } from "@react-three/fiber";
import type * as THREE from "three";

/** The live viewport camera (and scene), readable from DOM UI (e.g. "Copy pose") and dev tools. */
export const viewport: { camera: THREE.PerspectiveCamera | null; scene: THREE.Scene | null } = { camera: null, scene: null };

export function ViewportCameraProbe() {
  viewport.camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  viewport.scene = useThree((s) => s.scene);
  return null;
}

/** Meshes of the loaded room scan (for occlusion checks). Empty while loading / placeholder. */
export function getRoomMeshes(): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  viewport.scene?.getObjectByName("RoomModel")?.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) out.push(o);
  });
  return out;
}
