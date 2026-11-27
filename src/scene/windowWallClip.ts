import * as THREE from "three";
import { roomConfig } from "../config/roomConfig";

/**
 * Shared uniforms that hide scanned geometry behind the window line (world space).
 * Injected into the room's materials at compile time; toggled live without recompiling.
 */
const W = roomConfig.windowWall;
export const MAX_MULLIONS = 16;
const mz = new Array(MAX_MULLIONS).fill(1e6);
W.mullionsZ.slice(0, MAX_MULLIONS).forEach((z, i) => (mz[i] = z));

export const windowClipUniforms = {
  uWinEnabled: { value: 1 },
  /** 1: the scanned frames are drawn; towards 0 they dissolve, leaving the wall open (demo walkthrough). */
  uWinFrames: { value: 1 },
  /**
   * x: the height (world y) up to which the frames stand, y: the metres under it over which they come in cell by
   * cell. Beyond the wall's top (as it is unless a demo walkthrough raises the wall): all of them.
   */
  uWinRise: { value: new THREE.Vector2(1e6, 0.3) },
  /** Scanned window-wall slab: geometry here is kept only where it is a real frame. */
  uWinSlabX: { value: W.frameSlabX },
  uWinMullionZ: { value: mz },
  uWinMullionHalf: { value: W.frameHalfWidth },
  uWinSill: { value: W.sillHeight },
  uWinHead: { value: W.height - W.headDepth },
  uWinCutX: { value: roomConfig.windowWall.cutX },
  uWinZ0: { value: roomConfig.windowWall.zMin },
  uWinZ1: { value: roomConfig.windowWall.zMax },
};

export function setWindowClip(enabled: boolean) {
  windowClipUniforms.uWinEnabled.value = enabled ? 1 : 0;
}

/** How much of the scanned window frames is drawn, 0..1 (only while the clean window wall is on). */
export function setWindowFrames(shown: number) {
  windowClipUniforms.uWinFrames.value = shown;
}

/** The height (world y) up to which the window wall stands, its glass too (null: all of it), and the band under it in which its frames come in. */
export const windowRise = { value: 1e6 };
export function setWindowRise(y: number | null, band = 0.3) {
  windowClipUniforms.uWinRise.value.set(y ?? 1e6, band);
  windowRise.value = y ?? 1e6;
}

/** How much of the procedural glass is drawn, 0..1: seen from outside, a pane with no frames around it is a haze over the room. */
export const windowGlass = { value: 1 };
export function setWindowGlass(shown: number) {
  windowGlass.value = shown;
}

/** Patch a material so fragments in the window-wall region are discarded when enabled. */
export function applyWindowClip(material: THREE.Material) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.call(material, shader, renderer);
    Object.assign(shader.uniforms, windowClipUniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWinWorld;")
      .replace("#include <project_vertex>", "#include <project_vertex>\nvWinWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
varying vec3 vWinWorld;
uniform float uWinEnabled; uniform float uWinFrames; uniform float uWinCutX; uniform float uWinZ0; uniform float uWinZ1;
uniform float uWinSlabX; uniform float uWinMullionZ[${MAX_MULLIONS}]; uniform float uWinMullionHalf;
uniform float uWinSill; uniform float uWinHead; uniform vec2 uWinRise;
bool winIsFrame(vec3 p) {
  if (p.x < uWinSlabX) return false;                 // beyond the wall: balcony fragments
  if (p.y < uWinSill || p.y > uWinHead) return true;  // scanned sill / head rail
  for (int i = 0; i < ${MAX_MULLIONS}; i++) if (abs(p.z - uWinMullionZ[i]) < uWinMullionHalf) return true;
  return false;                                       // pane: reflection smear
}
// one value per 6 cm cell: the frames dissolve cell by cell
float winHash(vec3 p) { return fract(sin(dot(floor(p * 16.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
// share of the cells drawn at a height: all of uWinFrames below the rising wall's top band, none above it
float winShown(vec3 p) { return min(uWinFrames, clamp((uWinRise.x - p.y) / uWinRise.y, 0.0, 1.0)); }`,
      )
      .replace(
        "#include <clipping_planes_fragment>",
        "#include <clipping_planes_fragment>\nif (uWinEnabled > 0.5 && vWinWorld.x < uWinCutX && vWinWorld.z > uWinZ0 && vWinWorld.z < uWinZ1 && (!winIsFrame(vWinWorld) || winHash(vWinWorld) >= winShown(vWinWorld))) discard;",
      );
  };
  material.customProgramCacheKey = () => "sentry3d-window-clip-v4";
  material.needsUpdate = true;
}
