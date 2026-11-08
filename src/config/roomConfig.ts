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
    /** Shift the model so the room floor sits at y = 0 and the room's XZ center at the origin. */
    autoGround: boolean;
  };
  /**
   * The real room interior, in the GLB's native coordinates (before transform).
   * The scan also contains geometry captured outside through the window wall, so the
   * full bounding box is NOT the room. When set, this box (not the scan bbox) is used
   * for grounding, camera framing, the ceiling cut and the published roomBounds.
   * Set to null to fall back to the full scan bounding box.
   */
  interior: { min: Vec3; max: Vec3 } | null;
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
  /** Image quality settings (see also the PERF/BAL/ULTRA toggle in the viewer toolbar). */
  rendering: {
    /** Texture anisotropic filtering: "max" = GPU maximum (usually 16). Fixes floor/wall blur at grazing angles. */
    anisotropy: "max" | number;
    /** Unsharp-mask strength for the post-process sharpen pass (0 = off). */
    sharpen: number;
    /** Screen-space ambient occlusion (contact shadows the smoothed scan lost). */
    ao: boolean;
    aoIntensity: number;
    /** AO sample radius in meters. */
    aoRadius: number;
    /** Subtle grading; unlit scans tend to look washed out. Range -1..1. */
    contrast: number;
    saturation: number;
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
  // Measured from the scan's vertex density: window wall (mullions) at x≈-0.1,
  // orange wall at x≈4.7, end walls at z≈-5.25 / 8.3, floor y≈-2.28, ceiling y≈0.75.
  // Resulting room ≈ 4.8 m × 3.1 m × 13.55 m (W×H×D).
  interior: {
    min: [-0.1, -2.28, -5.25],
    max: [4.7, 0.85, 8.3],
  },
  materialMode: "unlit",
  lighting: {
    ambientIntensity: 0.6,
    hemisphereIntensity: 0.6,
    directionalIntensity: 1.2,
    directionalPosition: [4, 8, 3],
  },
  rendering: {
    anisotropy: "max",
    sharpen: 0.35,
    ao: true,
    aoIntensity: 1.5,
    aoRadius: 0.6,
    contrast: 0.08,
    saturation: 0.06,
  },
  ceilingCutOffset: 0.25,
  supplemental: {
    floor: false,
    walls: false,
    color: "#1b2433",
    opacity: 1,
  },
  placeholder: { width: 8, height: 3, depth: 10 },
};
