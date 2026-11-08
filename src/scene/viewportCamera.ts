import { useThree } from "@react-three/fiber";
import type * as THREE from "three";

/** The live viewport camera, readable from DOM UI (e.g. "Copy pose"). */
export const viewport: { camera: THREE.PerspectiveCamera | null } = { camera: null };

export function ViewportCameraProbe() {
  viewport.camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  return null;
}
