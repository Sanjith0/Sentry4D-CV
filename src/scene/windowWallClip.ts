import * as THREE from "three";
import { roomConfig } from "../config/roomConfig";

/**
 * Shared uniforms that hide scanned geometry behind the window line (world space).
 * Injected into the room's materials at compile time; toggled live without recompiling.
 */
export const windowClipUniforms = {
  uWinEnabled: { value: 1 },
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
        "#include <common>\nvarying vec3 vWinWorld;\nuniform float uWinEnabled; uniform float uWinCutX; uniform float uWinZ0; uniform float uWinZ1;",
      )
      .replace(
        "#include <clipping_planes_fragment>",
        "#include <clipping_planes_fragment>\nif (uWinEnabled > 0.5 && vWinWorld.x < uWinCutX && vWinWorld.z > uWinZ0 && vWinWorld.z < uWinZ1) discard;",
      );
  };
  material.customProgramCacheKey = () => "sentry3d-window-clip";
  material.needsUpdate = true;
}
