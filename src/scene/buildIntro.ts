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
  /** 1 when the user has switched the room to wireframe view (brightens the steady wire). */
  uWireMode: { value: 0 },
  /** Seconds since the build started (drives pulses / flicker). */
  uBuildTime: { value: 0 },
};

const WIRE_DURATION = 4.0;
const TEX_DELAY = 1.8;
const TEX_DURATION = 3.6;
export const BUILD_TOTAL = TEX_DELAY + TEX_DURATION;

let played = false;
let wireMode = false;
let building = false;

/** Resting state of the uniforms when no build is running: textured, or wireframe only. */
function settle() {
  buildUniforms.uWireMode.value = wireMode ? 1 : 0;
  buildUniforms.uBuildTexY.value = wireMode ? -1e6 : 1e6;
  buildUniforms.uBuildWireY.value = 1e6;
}

/** Wireframe view toggle. During the page-load build it takes effect when the build ends. */
export function setWireMode(on: boolean) {
  wireMode = on;
  if (!building) settle();
}
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
  buildUniforms.uBuildTime.value = t;
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

/** True once the page-load build has finished (or was skipped). */
export function isBuildFinished() {
  return played && !building;
}

export function primeBuild(y0: number) {
  startAt = null;
  building = true;
  buildUniforms.uWireMode.value = 0;
  buildUniforms.uBuildTexY.value = y0;
  buildUniforms.uBuildWireY.value = y0;
}

export function finishBuild() {
  played = true;
  building = false;
  settle();
}

const BUILD_PARS = /* glsl */ `
varying vec3 vBuildWorld;
uniform float uBuildTexY; uniform float uBuildWireY; uniform vec3 uBuildGlow; uniform float uWireMode; uniform float uBuildTime;
float bHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }`;

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
        `#include <clipping_planes_fragment>
if (uBuildTexY < 1e5) {
  // Digital dissolve: a noisy band just under the front materializes cell by cell.
  float n = bHash(floor(vBuildWorld * 28.0) + floor(uBuildTime * 12.0));
  if (vBuildWorld.y > uBuildTexY - n * 0.22) discard;
} else if (vBuildWorld.y > uBuildTexY) discard;`,
      )
      .replace(
        "#include <opaque_fragment>",
        `#include <opaque_fragment>
if (uBuildTexY < 1e5) {
  float d = uBuildTexY - vBuildWorld.y;
  float band = exp(-max(d, 0.0) * 7.0);
  float line2 = exp(-abs(d - 0.32) * 40.0) * 0.6;
  vec3 hot = mix(uBuildGlow, vec3(1.0), exp(-max(d, 0.0) * 25.0));
  gl_FragColor.rgb = mix(gl_FragColor.rgb, hot * 1.8, clamp(band * 0.9 + line2, 0.0, 1.0));
}`,
      );
  };
  chainKey(material, "build-v2");
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
  float building = uBuildWireY < 1e5 ? 1.0 : 0.0;
  // Height gradient: deep blue at the floor -> cyan -> white-hot at the leading edge.
  vec3 deep = vec3(0.10, 0.25, 1.0);
  vec3 cyan = vec3(0.25, 0.85, 1.0);
  vec3 col = mix(deep, cyan, smoothstep(0.0, 2.5, vBuildWorld.y));
  col = mix(col, vec3(1.0), lead * 0.8);
  // Energy pulses climbing the mesh + hologram flicker.
  float pulse = pow(0.5 + 0.5 * sin(vBuildWorld.y * 14.0 - uBuildTime * 9.0), 8.0) * building;
  float flick = 0.85 + 0.15 * sin(uBuildTime * 61.0 + vBuildWorld.x * 3.0) * building;
  float sparkle = step(0.985, bHash(floor(vBuildWorld * 9.0) + floor(uBuildTime * 8.0))) * building * 2.0;
  float wireModeGain = uWireMode * (1.0 - building);
  gl_FragColor.rgb = col * (0.35 + 2.8 * lead + 1.6 * pulse + sparkle + 0.35 * wireModeGain) * flick * trail * 0.9;
  gl_FragColor.a *= trail; }`,
      );
  };
  m.customProgramCacheKey = () => "sentry3d-build-wire-v2";
  return m;
}

/** Translucent laser-grid plane that rides the wireframe front across the room footprint. */
export function makeBuildScanPlane(width: number, depth: number, center: THREE.Vector3) {
  const geo = new THREE.PlaneGeometry(width, depth, 1, 1).rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...buildUniforms, uSize: { value: new THREE.Vector2(width, depth) } },
    vertexShader: /* glsl */ `
      uniform float uBuildWireY; varying vec2 vXZ; varying vec2 vUv2;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        w.y = uBuildWireY;
        vXZ = w.xz; vUv2 = uv;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uBuildTime; uniform float uBuildWireY; uniform vec3 uBuildGlow; varying vec2 vXZ; varying vec2 vUv2;
      void main() {
        if (uBuildWireY > 1e5) discard;
        vec2 g = abs(fract(vXZ * 2.0) - 0.5);
        float grid = smoothstep(0.47, 0.5, max(g.x, g.y));
        vec2 e = min(vUv2, 1.0 - vUv2);
        float edge = smoothstep(0.0, 0.08, min(e.x, e.y));
        float sweep = pow(0.5 + 0.5 * sin(vXZ.y * 1.5 - uBuildTime * 6.0), 6.0);
        float a = (0.05 + 0.35 * grid + 0.12 * sweep) * edge;
        gl_FragColor = vec4(mix(uBuildGlow, vec3(1.0), grid * 0.4) * 1.4, a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(center);
  mesh.frustumCulled = false;
  mesh.raycast = () => null;
  mesh.name = "BuildScanPlane";
  return mesh;
}
