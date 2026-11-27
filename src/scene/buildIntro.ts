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
  /** World Y below which the wireframe is not drawn (scan geometry under the floor; off by default). */
  uBuildMinY: { value: -1e6 },
  /** Strength of the room's wireframe lines (1 = as built; a script may dim them behind a subject). */
  uBuildWireGain: { value: 1 },
  /** Strength of the floor grid that rides the wireframe front (1 = as built). */
  uBuildGridGain: { value: 1 },
  /**
   * 1: the wireframe's leading edge glows white-hot and sparkles (the build). 0: no glow; the lines fade out
   * softly towards the front instead (a script draining the room: no white islands where the front cuts it).
   */
  uBuildLead: { value: 1 },
  /**
   * The scan is drawn only inside this box on the floor plan (min x, min z, max x, max z, world metres). Wide
   * open by default; a script looking at the room from outside closes it round the room, so that what the scan
   * caught beyond the walls does not stand in the view.
   */
  uBuildBox: { value: new THREE.Vector4(-1e6, -1e6, 1e6, 1e6) },
  /**
   * A sweep across the picture (a script wiping from a recording to this view): the room's wireframe is drawn
   * over its textured surface in a band of the screen that trails the wipe. x: the band's leading edge, y: its
   * trailing edge (both 0..1 of the picture's width from the left; its lines have their full strength over the
   * first SWEEP_HOLD of the band and fade out from there to the trailing edge), z: strength of its lines (0: no
   * sweep, the wireframe goes by the heights above; above 1 for a large picture: what a line ends up with is capped).
   */
  uBuildSweep: { value: new THREE.Vector4(0, 0, 0, 0) },
};

/** Limit the scan to the floor-plan box [minX, minZ, maxX, maxZ]; null: all of it. */
export function setBuildBox(box: readonly [number, number, number, number] | null) {
  if (box) buildUniforms.uBuildBox.value.set(box[0], box[1], box[2], box[3]);
  else buildUniforms.uBuildBox.value.set(-1e6, -1e6, 1e6, 1e6);
}

/**
 * The room's wireframe twin while it is mounted. Nothing of it passes its shader while the textured front
 * is above the room, so whoever drives the uniforms can skip drawing it then (it is every edge of the scan).
 */
export const buildWire: { object: THREE.Object3D | null } = { object: null };

/** Sweep: the wireframe's lines are drawn at this share of their distance from the eye (see makeBuildWireMaterial). */
const SWEEP_PULL = 0.996;
/**
 * Sweep: how much of the picture a mesh's lines cover goes by the radius of the circle that fits inside its
 * triangles as they appear on screen (edge length per area is 1 / that radius, whatever their shape). Lines of
 * triangles with at least this radius, as a share of the picture's height, have their full strength; those of
 * smaller ones are fainter in proportion. Every part of the picture then gets at most the same amount of line
 * light, whether the scan is coarse there (a wall), fine (furniture), far away or seen edge-on (the ceiling, from
 * a camera mounted on it), instead of a white knot wherever its lines crowd.
 */
const SWEEP_FULL = 0.011;
/** Sweep: the share of the band, from its leading edge, over which the lines keep their full strength. */
const SWEEP_HOLD = 0.25;
const sweepReady = new WeakSet<THREE.BufferGeometry>();

/**
 * Sweep: gives every mesh under `root` (the room's wireframe twin) the vertex attribute the sweep reads:
 * aBuildMesh = (unit normal, that inner radius for the triangles round the vertex: twice their area over their
 * perimeter), in the mesh's own space. One pass over its triangles, once per geometry. (The twin shares its
 * geometry with the textured room, whose materials do not read the attribute; without it the lines all have
 * their full strength.)
 */
export function prepareBuildSweep(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || sweepReady.has(mesh.geometry)) return;
    const geometry = mesh.geometry;
    sweepReady.add(geometry);
    const pos = geometry.getAttribute("position");
    if (!pos || geometry.getAttribute("aBuildMesh")) return;
    const index = geometry.getIndex();
    const out = new Float32Array(pos.count * 4); // xyz: normal (summed by area), w: twice the area (summed)
    const perimeter = new Float32Array(pos.count);
    const corners = index ? index.count : pos.count;
    for (let i = 0; i + 2 < corners; i += 3) {
      const a = index ? index.getX(i) : i;
      const b = index ? index.getX(i + 1) : i + 1;
      const c = index ? index.getX(i + 2) : i + 2;
      const ax = pos.getX(a);
      const ay = pos.getY(a);
      const az = pos.getZ(a);
      const ux = pos.getX(b) - ax;
      const uy = pos.getY(b) - ay;
      const uz = pos.getZ(b) - az;
      const vx = pos.getX(c) - ax;
      const vy = pos.getY(c) - ay;
      const vz = pos.getZ(c) - az;
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const area2 = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const around = Math.sqrt(ux * ux + uy * uy + uz * uz) + Math.sqrt(vx * vx + vy * vy + vz * vz) + Math.sqrt((vx - ux) ** 2 + (vy - uy) ** 2 + (vz - uz) ** 2);
      for (let k = 0; k < 3; k++) {
        const v = k === 0 ? a : k === 1 ? b : c;
        out[v * 4] += nx;
        out[v * 4 + 1] += ny;
        out[v * 4 + 2] += nz;
        out[v * 4 + 3] += area2;
        perimeter[v] += around;
      }
    }
    for (let v = 0; v < pos.count; v++) {
      const k = v * 4;
      const len = Math.sqrt(out[k] * out[k] + out[k + 1] * out[k + 1] + out[k + 2] * out[k + 2]);
      if (len > 0) {
        out[k] /= len;
        out[k + 1] /= len;
        out[k + 2] /= len;
      }
      out[k + 3] = perimeter[v] > 0 ? out[k + 3] / perimeter[v] : 0;
    }
    geometry.setAttribute("aBuildMesh", new THREE.BufferAttribute(out, 4));
  });
}

const WIRE_DURATION = 4.0;
const TEX_DELAY = 1.8;
const TEX_DURATION = 3.6;
export const BUILD_TOTAL = TEX_DELAY + TEX_DURATION;

let played = false;
let wireMode = false;
let building = false;
/** True while the demo walkthrough drives the uniforms itself (see features/demo). */
let scripted = false;

/** Resting state of the uniforms when no build is running: textured, or wireframe only. */
function settle() {
  buildUniforms.uWireMode.value = wireMode ? 1 : 0;
  buildUniforms.uBuildTexY.value = wireMode ? -1e6 : 1e6;
  buildUniforms.uBuildWireY.value = 1e6;
}

/** Wireframe view toggle. During the page-load build it takes effect when the build ends. */
export function setWireMode(on: boolean) {
  wireMode = on;
  if (!building && !scripted) settle();
}

/**
 * Hands the build uniforms to a script (the demo walkthrough) or takes them back. While scripted, the
 * page-load reveal and the wireframe toggle leave the uniforms alone; on release they settle to the
 * resting state for the current wireframe toggle.
 */
export function setBuildScripted(on: boolean) {
  scripted = on;
  if (on) {
    played = true;
    building = false;
  } else {
    buildUniforms.uBuildTime.value = 0;
    buildUniforms.uBuildMinY.value = -1e6;
    buildUniforms.uBuildWireGain.value = 1;
    buildUniforms.uBuildGridGain.value = 1;
    buildUniforms.uBuildLead.value = 1;
    buildUniforms.uBuildSweep.value.set(0, 0, 0, 0);
    if (buildWire.object) buildWire.object.visible = true;
    settle();
  }
}

export function isBuildScripted() {
  return scripted;
}
let startAt: number | null = null;

/** True while the reveal should run (only on the first room mount of the page, and not for reduced motion). */
export function shouldPlayBuild() {
  if (played) return false;
  const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  // `?demo=…` starts the walkthrough straight away, which stages its own build.
  const skip = scripted || params?.get("intro") === "0" || params?.has("demo") === true;
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
  if (scripted) return false;
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
  if (scripted) return;
  startAt = null;
  building = true;
  buildUniforms.uWireMode.value = 0;
  buildUniforms.uBuildTexY.value = y0;
  buildUniforms.uBuildWireY.value = y0;
}

export function finishBuild() {
  played = true;
  building = false;
  if (!scripted) settle();
}

const BUILD_PARS = /* glsl */ `
varying vec3 vBuildWorld;
uniform float uBuildTexY; uniform float uBuildWireY; uniform vec3 uBuildGlow; uniform float uWireMode; uniform float uBuildTime;
uniform float uBuildMinY; uniform float uBuildWireGain; uniform float uBuildLead; uniform vec4 uBuildBox;
bool bOutside(vec3 p) { return p.x < uBuildBox.x || p.z < uBuildBox.y || p.x > uBuildBox.z || p.z > uBuildBox.w; }
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
if (bOutside(vBuildWorld)) discard;
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
  chainKey(material, "build-v3");
  material.needsUpdate = true;
}

/**
 * Wireframe overlay: visible between the texture front and the wire front, brightest at its leading edge.
 * `opacity`: strength of a line (0.3 suits the room scan, whose many layers of lines add up; a single small
 * object next to it needs more to be made out). `dimmable`: follows uBuildWireGain (the room does; an object
 * drawn next to it keeps its own strength).
 */
export function makeBuildWireMaterial(clippingPlanes: THREE.Plane[], opacity = 0.3, dimmable = true) {
  const m = new THREE.MeshBasicMaterial({
    color: "#3cc8ff",
    wireframe: true,
    transparent: true,
    opacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    clippingPlanes,
  });
  m.onBeforeCompile = (shader) => {
    injectVaryings(shader);
    if (!dimmable) {
      // an object next to the room keeps its own strength, and takes no part in a sweep
      shader.uniforms.uBuildWireGain = { value: 1 };
      shader.uniforms.uBuildSweep = { value: new THREE.Vector4(0, 0, 0, 0) };
    }
    // Sweep: the lines lie in the textured surface they are drawn over, so they are taken a touch nearer along
    // the line of sight (same place on screen) and win the depth test against it, not against what hides it.
    // vBuildFine: the inner radius of the triangles here as a share of the picture's height (their size by the
    // distance, less when they are seen edge-on: the area shrinks with the cosine, the edges by less): SWEEP_FULL.
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform vec4 uBuildSweep; attribute vec4 aBuildMesh; varying vec2 vBuildClip; varying float vBuildFine;")
      .replace(
        "#include <project_vertex>",
        `#include <project_vertex>
vBuildFine = 1.0;
if (uBuildSweep.z > 0.0) {
  gl_Position = projectionMatrix * vec4(mvPosition.xyz * ${SWEEP_PULL.toFixed(4)}, 1.0);
  vec3 bNormal = normalMatrix * aBuildMesh.xyz;
  float bFacing = dot(bNormal, bNormal) > 1e-12 ? abs(dot(normalize(bNormal), normalize(mvPosition.xyz))) : 1.0;
  bFacing /= mix(0.637, 1.0, bFacing);
  vBuildFine = aBuildMesh.w * length(modelViewMatrix[0].xyz) * projectionMatrix[1][1] * 0.5 * bFacing / max(-mvPosition.z, 0.05);
}
vBuildClip = gl_Position.xw;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${BUILD_PARS}\nuniform vec4 uBuildSweep; varying vec2 vBuildClip; varying float vBuildFine;`)
      .replace(
        "#include <clipping_planes_fragment>",
        `#include <clipping_planes_fragment>
if (bOutside(vBuildWorld)) discard;
// (in a sweep the textured room is all there: the lines go by their place on screen instead of the fronts)
float bSweep = 0.0;
float bTexY = uBuildTexY;
if (uBuildSweep.z > 0.0) {
  float bAcross = 0.5 + 0.5 * vBuildClip.x / vBuildClip.y;
  float bBehind = (uBuildSweep.x - bAcross) / max(uBuildSweep.x - uBuildSweep.y, 1e-4);
  if (bBehind < 0.0 || bBehind >= 1.0) discard;
  bSweep = min(1.0, uBuildSweep.z * (1.0 - smoothstep(${SWEEP_HOLD.toFixed(3)}, 1.0, bBehind)) * min(1.0, vBuildFine / ${SWEEP_FULL.toFixed(4)}));
  bTexY = -1e6;
}
if (vBuildWorld.y > uBuildWireY || vBuildWorld.y < bTexY - 0.04 || vBuildWorld.y < uBuildMinY) discard;`,
      )
      .replace(
        "#include <opaque_fragment>",
        `#include <opaque_fragment>
{ float lead = exp(-(uBuildWireY - vBuildWorld.y) * 6.0) * uBuildLead;
  // without the glow the lines thin out over the last 0.6 m under the front rather than end in a hard cut
  float soft = mix(smoothstep(0.0, 0.6, uBuildWireY - vBuildWorld.y), 1.0, uBuildLead);
  float trail = smoothstep(bTexY - 0.04, bTexY + 0.25, vBuildWorld.y);
  float building = uBuildWireY < 1e5 ? 1.0 : 0.0;
  // Height gradient: deep blue at the floor -> cyan -> white-hot at the leading edge.
  vec3 deep = vec3(0.10, 0.25, 1.0);
  vec3 cyan = vec3(0.25, 0.85, 1.0);
  vec3 col = mix(deep, cyan, smoothstep(0.0, 2.5, vBuildWorld.y));
  col = mix(col, vec3(1.0), lead * 0.8);
  // Energy pulses climbing the mesh + hologram flicker.
  float pulse = pow(0.5 + 0.5 * sin(vBuildWorld.y * 14.0 - uBuildTime * 9.0), 8.0) * building * uBuildLead;
  float flick = 0.85 + 0.15 * sin(uBuildTime * 61.0 + vBuildWorld.x * 3.0) * building;
  float sparkle = step(0.985, bHash(floor(vBuildWorld * 9.0) + floor(uBuildTime * 8.0))) * building * 2.0 * uBuildLead;
  float wireModeGain = uWireMode * (1.0 - building);
  gl_FragColor.rgb = col * (0.35 + 2.8 * lead + 1.6 * pulse + sparkle + 0.35 * wireModeGain) * flick * trail * 0.9;
  gl_FragColor.rgb *= soft;
  gl_FragColor.a *= trail * soft * uBuildWireGain;
  // (in a sweep: one weight for every line, and less of the floor's deep blue, which is dark over a textured room)
  if (uBuildSweep.z > 0.0) gl_FragColor = vec4(mix(mix(deep, cyan, 0.4 + 0.6 * smoothstep(0.0, 2.5, vBuildWorld.y)), vec3(1.0), 0.2), bSweep); }`,
      );
  };
  m.customProgramCacheKey = () => `sentry3d-build-wire-v7${dimmable ? "" : "-fixed"}`;
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
      uniform float uBuildTime; uniform float uBuildWireY; uniform float uBuildGridGain; uniform vec3 uBuildGlow; varying vec2 vXZ; varying vec2 vUv2;
      void main() {
        if (uBuildWireY > 1e5) discard;
        vec2 g = abs(fract(vXZ * 2.0) - 0.5);
        float grid = smoothstep(0.47, 0.5, max(g.x, g.y));
        vec2 e = min(vUv2, 1.0 - vUv2);
        float edge = smoothstep(0.0, 0.08, min(e.x, e.y));
        float sweep = pow(0.5 + 0.5 * sin(vXZ.y * 1.5 - uBuildTime * 6.0), 6.0);
        float a = (0.05 + 0.35 * grid + 0.12 * sweep) * edge * uBuildGridGain;
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
