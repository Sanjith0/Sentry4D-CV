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
uniform float uWinEnabled; uniform float uWinCutX; uniform float uWinZ0; uniform float uWinZ1;
uniform float uWinSlabX; uniform float uWinMullionZ[${MAX_MULLIONS}]; uniform float uWinMullionHalf;
uniform float uWinSill; uniform float uWinHead;
bool winIsFrame(vec3 p) {
  if (p.x < uWinSlabX) return false;                 // beyond the wall: balcony fragments
  if (p.y < uWinSill || p.y > uWinHead) return true;  // scanned sill / head rail
  for (int i = 0; i < ${MAX_MULLIONS}; i++) if (abs(p.z - uWinMullionZ[i]) < uWinMullionHalf) return true;
  return false;                                       // pane: reflection smear
}`,
      )
      .replace(
        "#include <clipping_planes_fragment>",
        "#include <clipping_planes_fragment>\nif (uWinEnabled > 0.5 && vWinWorld.x < uWinCutX && vWinWorld.z > uWinZ0 && vWinWorld.z < uWinZ1 && !winIsFrame(vWinWorld)) discard;",
      );
  };
  material.customProgramCacheKey = () => "sentry3d-window-clip-v2";
  material.needsUpdate = true;
}
