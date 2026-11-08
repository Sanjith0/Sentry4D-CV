import * as THREE from "three";
import type { CameraMode, RoomBounds, SecurityCamera, Vec3 } from "../types/security";

export interface CameraPose {
  position: Vec3;
  target: Vec3;
  fov: number;
}

export const DEFAULT_FOV = 60;

const FALLBACK: RoomBounds = { min: [-4, 0, -5], max: [4, 3, 5], size: [8, 3, 10], center: [0, 1.5, 0] };

export function homePose(mode: CameraMode, bounds: RoomBounds | null, aspect: number, cctv?: SecurityCamera): CameraPose {
  const b = bounds ?? FALLBACK;
  const [cx, , cz] = b.center;
  const [sx, sy, sz] = b.size;
  const floorY = b.min[1];
  const tanHalf = Math.tan((DEFAULT_FOV * Math.PI) / 360);

  switch (mode) {
    case "cctv":
      if (cctv) return { position: cctv.position, target: cctv.target, fov: cctv.fov };
      return homePose("orbit", bounds, aspect);
    case "topdown": {
      const halfExtent = Math.max(sz / 2, sx / 2 / aspect) * 1.12;
      const h = halfExtent / tanHalf;
      return { position: [cx, floorY + h, cz + 0.001], target: [cx, floorY, cz], fov: DEFAULT_FOV };
    }
    case "free":
      return {
        position: [cx, floorY + 1.6, cz + sz * 0.25],
        target: [cx, floorY + 1.4, cz - sz * 0.25],
        fov: DEFAULT_FOV,
      };
    case "orbit":
    default: {
      const radius = Math.hypot(sx, sy, sz) / 2;
      const dist = (radius / Math.sin((DEFAULT_FOV * Math.PI) / 360)) * 0.85;
      const dir = new THREE.Vector3(0.75, 0.85, 1).normalize().multiplyScalar(dist);
      const target: Vec3 = [cx, floorY + sy * 0.25, cz];
      return { position: [target[0] + dir.x, target[1] + dir.y, target[2] + dir.z], target, fov: DEFAULT_FOV };
    }
  }
}
