import * as THREE from "three";

/**
 * Page-load "build" reveal for the scanned room: a glowing wireframe rises from the floor, then the
 * textured surface rises behind it. Purely presentational: it drives two world-height uniforms that
 * room materials read at shading time (no geometry or texture is modified). Plays once per page load.
 */
export const buildUniforms = {
  /** World Y below which the textured surface is visible. */
  uBuildTexY: { value: 1e6 },
  /** World Y below which the wireframe is visible. */
  uBuildWireY: { value: 1e6 },
  uBuildGlow: { value: new THREE.Color("#4fd8ff") },
};

const WIRE_DURATION = 2.4;
const TEX_DELAY = 0.9;
const TEX_DURATION = 2.6;
export const BUILD_TOTAL = TEX_DELAY + TEX_DURATION;

let played = false;
let startAt: number | null = null;

/** True while the reveal should run (only on the first room mount of the page, and not for reduced motion). */
export function shouldPlayBuild() {
  if (played) return false;
  const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const skip = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("intro") === "0";
  if (reduced || skip) {
    played = true;
    return false;
  }
  return true;
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

/**
 * Advance the reveal. `y0`/`y1` are the world heights the fronts sweep between.
 * Returns false once finished (uniforms are left fully revealed).
 */
export function stepBuild(now: number, y0: number, y1: number): boolean {
  if (startAt === null) startAt = now;
  const t = now - startAt;
  const span = y1 - y0;
  const wire = easeInOut(clamp01(t / WIRE_DURATION));
  const tex = easeInOut(clamp01((t - TEX_DELAY) / TEX_DURATION));
  buildUniforms.uBuildWireY.value = y0 + wire * span;
  buildUniforms.uBuildTexY.value = tex >= 1 ? 1e6 : y0 + tex * span;
  if (t >= BUILD_TOTAL) {
    finishBuild();
    return false;
  }
  return true;
}

export function primeBuild(y0: number) {
  startAt = null;
  buildUniforms.uBuildTexY.value = y0;
  buildUniforms.uBuildWireY.value = y0;
}

export function finishBuild() {
  played = true;
  buildUniforms.uBuildTexY.value = 1e6;
  buildUniforms.uBuildWireY.value = 1e6;
}

const BUILD_PARS = /* glsl */ `
varying vec3 vBuildWorld;
uniform float uBuildTexY; uniform float uBuildWireY; uniform vec3 uBuildGlow;`;

function chainKey(material: THREE.Material, tag: string) {
  const prevKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${prevKey()}|${tag}`;
}

function injectVaryings(shader: THREE.WebGLProgramParametersWithUniforms) {
  Object.assign(shader.uniforms, buildUniforms);
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", "#include <common>\nvarying vec3 vBuildWorld;")
    .replace("#include <project_vertex>", "#include <project_vertex>\nvBuildWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");
}

/** Textured surface: hidden above the texture front, with a bright scan line at the front. */
export function applyBuildClip(material: THREE.Material) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.call(material, shader, renderer);
    injectVaryings(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${BUILD_PARS}`)
      .replace(
        "#include <clipping_planes_fragment>",
        "#include <clipping_planes_fragment>\nif (vBuildWorld.y > uBuildTexY) discard;",
      )
      .replace(
        "#include <opaque_fragment>",
        `#include <opaque_fragment>
{ float d = uBuildTexY - vBuildWorld.y;
  float band = (uBuildTexY < 1e5) ? exp(-d * 9.0) : 0.0;
  gl_FragColor.rgb = mix(gl_FragColor.rgb, uBuildGlow * 1.6, clamp(band, 0.0, 1.0) * 0.85); }`,
      );
  };
  chainKey(material, "build-v1");
  material.needsUpdate = true;
}

/** Wireframe overlay: visible between the texture front and the wire front, brightest at its leading edge. */
export function makeBuildWireMaterial(clippingPlanes: THREE.Plane[]) {
  const m = new THREE.MeshBasicMaterial({
    color: "#3cc8ff",
    wireframe: true,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    clippingPlanes,
  });
  m.onBeforeCompile = (shader) => {
    injectVaryings(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${BUILD_PARS}`)
      .replace(
        "#include <clipping_planes_fragment>",
        `#include <clipping_planes_fragment>
if (vBuildWorld.y > uBuildWireY || vBuildWorld.y < uBuildTexY - 0.04) discard;`,
      )
      .replace(
        "#include <opaque_fragment>",
        `#include <opaque_fragment>
{ float lead = exp(-(uBuildWireY - vBuildWorld.y) * 6.0);
  float trail = smoothstep(uBuildTexY - 0.04, uBuildTexY + 0.25, vBuildWorld.y);
  gl_FragColor.rgb *= (0.35 + 2.6 * lead) * trail;
  gl_FragColor.a *= trail; }`,
      );
  };
  m.customProgramCacheKey = () => "sentry3d-build-wire-v1";
  return m;
}
