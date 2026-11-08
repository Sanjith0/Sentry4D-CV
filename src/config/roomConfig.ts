import type { Vec3 } from "../types/security";

export interface RoomConfig {
  /** GLB location (public/). */
  url: string;
  /** Applied on top of the raw GLB, in order: scale -> rotate -> translate. */
  transform: {
    /** Uniform or per-axis scale. Keep 1 to preserve real-world meters. */
    scale: number | Vec3;
    /** Euler degrees (XYZ). */
    rotationDeg: Vec3;
    /** Extra translation (meters) applied after auto-grounding. */
    position: Vec3;
    /** Shift the model so its bounding-box floor sits at y = 0 and its XZ center at origin. */
    autoGround: boolean;
  };
  /**
   * "unlit": show scan textures exactly as captured (baked lighting) — best for LiDAR scans.
   * "standard": PBR materials lit by scene lights (metalness forced to 0).
   * Materials are cloned at load, the GLB is never modified.
   */
  materialMode: "unlit" | "standard";
  lighting: {
    ambientIntensity: number;
    hemisphereIntensity: number;
    directionalIntensity: number;
    directionalPosition: Vec3;
  };
  /** Distance below the bbox top where the "hide ceiling" clipping plane cuts. */
  ceilingCutOffset: number;
  /** Simple patches for holes in the scan. Off by default. */
  supplemental: {
    floor: boolean;
    walls: boolean;
    color: string;
    opacity: number;
  };
  /** Procedural room used when room.glb is missing or fails to load. */
  placeholder: { width: number; height: number; depth: number };
}

export const roomConfig: RoomConfig = {
  url: "/assets/room.glb",
  transform: {
    scale: 1,
    rotationDeg: [0, 0, 0],
    position: [0, 0, 0],
    autoGround: true,
  },
  materialMode: "unlit",
  lighting: {
    ambientIntensity: 0.6,
    hemisphereIntensity: 0.6,
    directionalIntensity: 1.2,
    directionalPosition: [4, 8, 3],
  },
  ceilingCutOffset: 0.35,
  supplemental: {
    floor: false,
    walls: false,
    color: "#1b2433",
    opacity: 1,
  },
  placeholder: { width: 8, height: 3, depth: 10 },
};
