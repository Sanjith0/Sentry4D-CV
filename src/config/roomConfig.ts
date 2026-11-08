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
  /**
   * Clean replacement for the glass wall (LiDAR captures glass as smeared reflections and grabs
   * fragments of the balcony through it). Scan geometry beyond `cutX` within [zMin, zMax] is hidden
   * at render time (room.glb is untouched); procedural glass, mullions and a balcony are drawn
   * instead. Room frame: metres, floor y = 0. Values measured from the scan's vertex density.
   */
  windowWall: {
    /** Hide scan fragments with x < cutX (just inside the mullions). */
    cutX: number;
    zMin: number;
    zMax: number;
    /** Glass plane position and height. */
    glassX: number;
    height: number;
    /** Mullion centres along z (measured density peaks, ~1.1 m spacing). */
    mullionsZ: number[];
    /** Scanned frame geometry is KEPT inside the wall slab (x > frameSlabX) within ±frameHalfWidth of a
     *  mullion, below sillHeight, or within headDepth of the top. Everything else there is hidden. */
    frameSlabX: number;
    frameHalfWidth: number;
    sillHeight: number;
    headDepth: number;
    /** Balcony floor extends from the glass out to this x. */
    balconyOuterX: number;
    railingHeight: number;
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
  windowWall: {
    cutX: -2.28,
    zMin: -6.95,
    zMax: 6.78,
    glassX: -2.47,
    height: 3.06,
    mullionsZ: [-6.9, -5.9, -4.7, -3.65, -2.55, -1.45, -0.3, 0.8, 1.85, 3.05, 4.15, 5.45, 6.5],
    frameSlabX: -2.8,
    frameHalfWidth: 0.12,
    sillHeight: 0.14,
    headDepth: 0.18,
    balconyOuterX: -6.2,
    railingHeight: 1.05,
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
