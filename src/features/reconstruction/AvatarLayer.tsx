/**
 * 3D renderer of the tracked person: ONE reconstructed, articulated body, in two looks.
 *
 *   "hybrid" (3D + FOOTAGE, default)  the body carries the real camera pixels of the shown frame
 *                                     wherever a camera sees it, and its baked texture elsewhere
 *                                     (hybridProjection.ts). Pose and pixels change together, frame by
 *                                     frame, exactly like the footage they come from.
 *   "model"  (3D MODEL)               the body with the single texture baked over the whole clip,
 *                                     animated continuously between frames.
 *
 * Objects the person handles (avatar.json `props`: the carried chair) are rigid meshes with their own
 * pose per frame and are drawn in both looks the same way as the body. An object whose GLB material is
 * metallic also gets that metal's sheen (METAL_FINISH), and while the room is shown as a wireframe the
 * object is drawn as one too, in the room's wireframe material.
 *
 * The body (experiments/reconstruction/avatar) is a skinned mesh fitted offline to all cameras
 * over the whole clip, delivered as a GLB whose single baked clip "motion" carries the pelvis
 * translation in ABSOLUTE room coordinates plus the joint rotations, one key per frame. This
 * layer therefore sits at the scene origin with identity transform (never inside the per-subject
 * group that SceneActors moves) and only chooses the instant:
 *
 *   clip time = clamp(masterTime - t0, 0, duration), set with mixer.setTime() every frame.
 *
 * Nothing is integrated over render time, so play / pause / seek / scrub / reverse always give
 * exactly the same pose for the same master time.
 *
 * Look: the texture is real footage back-projected onto the body, so its lighting is already
 * baked in. It is drawn unlit (like the room scan) with only a soft form term, because the
 * subject's dark clothing otherwise reads as a flat silhouette.
 * Depth: normal depth test against the LiDAR room (furniture in front occludes the person).
 * X-ray: a second skinned mesh sharing geometry + skeleton, drawn with depthFunc GreaterDepth
 * right after the room and BEFORE the body, so it marks in cyan exactly the parts hidden by room
 * geometry (never limbs hidden only by the person's own body).
 */
import { useEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { roomConfig } from "../../config/roomConfig";
import { subjects } from "../../config/subjects";
import { buildUniforms, makeBuildWireMaterial } from "../../scene/buildIntro";
import { ceilingPlanes } from "../../scene/ceilingClip";
import { useReplayStore } from "../../store/useReplayStore";
import { useViewStore } from "../../store/useViewStore";
import { subjectSample } from "../sentry/SceneActors";
import type { CameraId } from "../../types/security";
import { HYBRID_TUNING, HybridProjector, type HybridCrop, type HybridFinish, type HybridOwn } from "./hybridProjection";
import type { AvatarMotion, AvatarProp } from "./ReconstructionTypes";
import { getTexture, prefetchAround, useAppearanceStore } from "./useAppearanceStore";
import { avatarModelUrl, floorAt, motionAt, useAvatarStore } from "./useAvatarStore";
import { demoLook } from "../demo/demoLook";

/** Draw order inside the opaque pass: room (0) -> X-ray silhouette (1) -> body (2). */
const XRAY_ORDER = 1;
const BODY_ORDER = 2;
/** Body colour when the asset carries no texture (placeholder / failed image). */
const UNTEXTURED = "#4a4f58";
const XRAY_COLOR = "#22d3ee";
/** 3D + FOOTAGE: a frame whose cut-outs are still downloading is bridged by the last complete one for this many frames. */
const HOLD_FRAMES = 3;
/** 3D + FOOTAGE: the pose is evaluated on a grid of 1/32 frame (0.2 mm of walking) so an idle view re-renders nothing. */
const POSE_GRID = 32;
/** Wireframe view: strength of an object's lines (the room's are 0.3, in many layers). */
const PROP_WIRE_OPACITY = 0.75;
/** Height (m) above an object's origin (its feet) at which the room's wireframe front is taken to have reached it. */
const PROP_WIRE_AT = 0.4;

type Look = "model" | "hybrid";

/**
 * MeshBasicMaterial (so three injects skinning, colour management and clipping itself) with a
 * soft form term added in onBeforeCompile:
 *   body:  textured: essentially unlit, footage * (0.90 + 0.14 * form) + a tiny lift so near-black
 *          clothing still reads as a volume. The baked texture already holds the footage lighting,
 *          so nothing may crush or highlight it (no specular, no lights, no tone mapping).
 *   flat:  untextured asset: grey * (0.75 + 0.35 * form); a flat grey body needs the form term to read.
 *          form mixes a sky/ground hemisphere, a fixed key direction and a headlight.
 *   xray:  flat cyan with a rim falloff (additive).
 * formShade returns that term as a GLSL block acting on `outgoingLight` (texel x colour).
 */
function formShade(variant: "body" | "flat" | "xray", after = "") {
  const form = /* glsl */ `
          float avHemi = 0.5 + 0.5 * avN.y;
          float avKey = max( dot( avN, normalize( vec3( 0.35, 0.8, 0.45 ) ) ), 0.0 );
          float avForm = 0.4 * avHemi + 0.3 * avKey + 0.3 * avFacing;`;
  const shade =
    variant === "body"
      ? /* glsl */ `${form}
          outgoingLight = outgoingLight * ( 0.90 + 0.14 * avForm ) + vec3( 0.006 ) * avForm + vec3( 0.010 ) * avRim;`
      : variant === "flat"
        ? /* glsl */ `${form}
          outgoingLight = outgoingLight * ( 0.75 + 0.35 * avForm ) + vec3( 0.010 ) * avForm + vec3( 0.022 ) * avRim;`
        : /* glsl */ `
          float avTint = 0.45 + 1.1 * avRim;
          // hologram (demo walkthrough): rim light, fine scan lines drifting up, one bright band sweeping the body
          float avLines = 0.55 + 0.45 * sin( vAvatarP.y * 170.0 - uAvHoloTime * 9.0 );
          float avBand = exp( - abs( vAvatarP.y - uAvHoloBand ) * 11.0 );
          float avHolo = ( 0.07 + 1.25 * pow( 1.0 - avFacing, 1.6 ) ) * avLines + 0.9 * avBand;
          outgoingLight = diffuseColor.rgb * mix( avTint, avHolo, uAvHolo );`;
  return /* glsl */ `{
          vec3 avN = normalize( vAvatarN );
          #ifdef DOUBLE_SIDED
            if ( ! gl_FrontFacing ) avN = - avN;
          #endif
          float avFacing = max( dot( avN, normalize( cameraPosition - vAvatarP ) ), 0.0 );
          float avRim = pow( 1.0 - avFacing, 3.0 );
          ${shade}
          ${after}
        }`;
}

/**
 * X-ray shell as a hologram (demo walkthrough): 0 = the flat X-ray tint, 1 = scan lines, rim light and a
 * bright band at world height uAvHoloBand. Shared by every X-ray material.
 */
const holoUniforms = { uAvHolo: { value: 0 }, uAvHoloTime: { value: 0 }, uAvHoloBand: { value: -10 } };
const HOLO_PARS = "uniform float uAvHolo;\nuniform float uAvHoloTime;\nuniform float uAvHoloBand;";

/** `finish`: a look on top of the form term (a metal object's sheen), the same one its footage-on-model material fills with. */
function shadeMaterial(mat: THREE.MeshBasicMaterial, variant: "body" | "flat" | "xray", finish: HybridFinish | null = null) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, finish?.uniforms, variant === "xray" ? holoUniforms : null);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\nvarying vec3 vAvatarN;\nvarying vec3 vAvatarP;\n${finish?.vertexPars ?? ""}`)
      .replace(
        "#include <project_vertex>",
        /* glsl */ `#include <project_vertex>
        #ifdef USE_SKINNING
          // transformedNormal: skinned normal in view space (defaultnormal_vertex)
          vAvatarN = inverseTransformDirection( transformedNormal, viewMatrix );
        #else
          vAvatarN = normalize( mat3( modelMatrix ) * normal );
        #endif
        vAvatarP = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
        ${finish?.vertexMain ?? ""}`,
      );
    const after = finish ? /* glsl */ `{
            vec3 hyFill = outgoingLight;
            vec3 hyN = avN;
            vec3 hyV = normalize( cameraPosition - vAvatarP );
            ${finish.fill}
            outgoingLight = hyFill;
          }` : "";
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\nvarying vec3 vAvatarN;\nvarying vec3 vAvatarP;\n${variant === "xray" ? HOLO_PARS : ""}\n${finish?.fragmentPars ?? ""}`)
      .replace("#include <opaque_fragment>", `${formShade(variant, after)}\n#include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => `sentry-avatar-v2-${variant}${finish ? `-${finish.key}` : ""}`;
  return mat;
}

/**
 * Sheen of a satin metal object (the silver chair), on top of its measured colour.
 *
 * The object's texture holds one measured grey, which is what a matte surface would show from anywhere. Metal
 * has no colour of its own: it shows what it mirrors, blurred by its roughness. In this room that is the lit
 * ceiling above, the floor below and the daylight of the glass wall on one side, so the same grey is lighter
 * where the mirrored direction points up or at the glass and darker where it points down, and it changes as
 * the viewer moves. On top lie the soft highlights of the ceiling lights and a lighter rim at grazing angles
 * (Fresnel).
 *
 * The proxy is six flat boxes, on which each of those would be one flat tone per face. What it is lit with is
 * therefore the asset's shading normal: the `_SHADE_NORMAL` of each vertex (a leg is a round tube) turned by
 * the normal map (every slat slightly crowned, with rounded edges), so each slat and each leg carries its own
 * light edge. Colours are linear; everything is a factor on the measured colour, so the mean stays close to it.
 *
 * uPropFinish: x strength of the sheen (the material's metallic factor), y exponent of the highlights (from
 * its roughness), z 1 when uPropNormalMap is a normal map, w that map's scale.
 */
const METAL_TUNING = {
  /** Share of the measured colour that follows the mirrored surroundings (the rest stays as measured). */
  mirror: 1.0,
  /** Mirrored brightness, as a factor on the measured colour: looking down at the floor, up at the ceiling. */
  floor: 0.75,
  ceiling: 1.35,
  /** Sine of the elevation over which the mirrored brightness goes from floor to ceiling (blur of the horizon). */
  horizon: 0.4,
  /** Daylight of the glass wall, added where the mirrored direction points at it, and how narrow that patch is. */
  window: 0.5,
  windowExponent: 6,
  /** Highlights of the ceiling lights (factor on the measured colour at their centre). */
  light: 0.8,
  /** Rim at grazing angles. */
  rim: 0.4,
};

/** One set for every metal object, so the look can be tuned from the console (window.__sentryMetal in dev). */
const metalUniforms = {
  uPropTuneA: { value: new THREE.Vector4(METAL_TUNING.mirror, METAL_TUNING.floor, METAL_TUNING.ceiling, METAL_TUNING.horizon) },
  /** w: debug (1: the shading normal as a colour). */
  uPropTuneB: { value: new THREE.Vector4(METAL_TUNING.window, METAL_TUNING.light, METAL_TUNING.rim, 0) },
  /** xyz: horizontal direction from the room towards its glass wall. */
  uPropWindow: { value: new THREE.Vector4(Math.sign(roomConfig.windowWall.glassX) || -1, 0, 0, METAL_TUNING.windowExponent) },
};

const METAL_FINISH_GLSL = {
  vertexPars: /* glsl */ `
attribute vec3 _shade_normal;
varying vec3 vPropShade;`,
  vertexMain: /* glsl */ `
vPropShade = normalize( mat3( modelMatrix ) * _shade_normal );`,
  fragmentPars: /* glsl */ `
uniform sampler2D uPropNormalMap;
uniform vec4 uPropFinish;
uniform vec4 uPropTuneA;                // mirror, floor, ceiling, horizon
uniform vec4 uPropTuneB;                // window, light, rim, debug
uniform vec4 uPropWindow;               // xyz: towards the glass wall, w: exponent
varying vec3 vPropShade;
// N: flat normal of the face, towards the viewer. V: unit vector to the viewer. uv: texture coordinate.
vec3 propSheen( vec3 c, vec3 N, vec3 V, vec2 uv ) {
  vec3 S = normalize( vPropShade );
  if ( dot( S, N ) < 0.0 ) S = - S;
  if ( uPropFinish.z > 0.5 ) {
    // tangent frame of the texture from screen-space derivatives: dP = T du + B dv
    vec3 px = dFdx( vAvatarP );
    vec3 py = dFdy( vAvatarP );
    vec2 ux = dFdx( uv );
    vec2 uy = dFdy( uv );
    float det = ux.x * uy.y - uy.x * ux.y;
    if ( abs( det ) > 1e-14 ) {
      vec3 T = ( px * uy.y - py * ux.y ) * sign( det );
      vec3 B = ( py * ux.x - px * uy.x ) * sign( det );
      T -= S * dot( S, T );
      B -= S * dot( S, B );
      if ( dot( T, T ) > 0.0 && dot( B, B ) > 0.0 ) {
        vec3 m = texture2D( uPropNormalMap, uv ).xyz * 2.0 - 1.0;
        // glTF normal maps: +Y runs against v
        m.xy *= uPropFinish.w;
        S = normalize( normalize( T ) * m.x - normalize( B ) * m.y + S * max( m.z, 0.05 ) );
      }
    }
  }
  if ( uPropTuneB.w > 0.5 ) return S * 0.5 + 0.5;
  float nv = clamp( dot( S, V ), 0.0, 1.0 );
  vec3 R = reflect( - V, S );
  // what the surface mirrors, blurred: the floor below, the lit ceiling above, daylight from the glass wall
  float env = mix( uPropTuneA.y, uPropTuneA.z, smoothstep( - uPropTuneA.w, uPropTuneA.w, R.y ) );
  env += uPropTuneB.x * pow( max( dot( R, uPropWindow.xyz ), 0.0 ), uPropWindow.w );
  // the ceiling lights: rows of fixtures overhead, mirrored as soft highlights
  float n = uPropFinish.y;
  float lights = pow( max( dot( R, vec3( 0.0, 1.0, 0.0 ) ), 0.0 ), n )
    + 0.7 * pow( max( dot( R, vec3( 0.42, 0.8, 0.43 ) ), 0.0 ), n )
    + 0.7 * pow( max( dot( R, vec3( - 0.5, 0.78, - 0.38 ) ), 0.0 ), n );
  float rim = pow( 1.0 - nv, 5.0 );
  return c * ( 1.0 + uPropFinish.x * ( uPropTuneA.x * ( env - 1.0 ) + uPropTuneB.y * lights + uPropTuneB.z * rim ) );
}`,
  // (vMapUv is declared after the pars: handed in from here)
  fill: /* glsl */ `
#ifdef USE_MAP
  hyFill = propSheen( hyFill, hyN, hyV, vMapUv );
#else
  hyFill = propSheen( hyFill, hyN, hyV, vec2( 0.0 ) );
#endif`,
};

/** Flat normal map for a metal object without one. */
let flatNormalMap: THREE.DataTexture | null = null;
function getFlatNormalMap() {
  if (!flatNormalMap) {
    flatNormalMap = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1, THREE.RGBAFormat);
    flatNormalMap.needsUpdate = true;
  }
  return flatNormalMap;
}

/** The sheen for a source material (null: not a metal). */
function metalFinish(src: THREE.MeshStandardMaterial): HybridFinish | null {
  const metal = src.metalness ?? 0;
  if (!(metal >= 0.5)) return null;
  // Width of a highlight from the roughness: Blinn-Phong exponent 2 / a^2 - 2 with a = roughness^2, a quarter of
  // it for a lobe around the mirrored direction (roughness 0.45: about 12, a highlight some 20 degrees wide).
  const a = Math.max(src.roughness ?? 0.5, 0.2) ** 2;
  const exponent = Math.min(Math.max((2 / (a * a) - 2) / 4, 2), 200);
  const normalMap = src.map ? (src.normalMap ?? null) : null; // it is read at the colour texture's coordinates
  if (normalMap) {
    normalMap.colorSpace = THREE.NoColorSpace;
    normalMap.anisotropy = 4;
  }
  return {
    key: "metal",
    uniforms: {
      ...metalUniforms,
      uPropNormalMap: { value: normalMap ?? getFlatNormalMap() },
      uPropFinish: { value: new THREE.Vector4(metal, exponent, normalMap ? 1 : 0, src.normalScale?.x ?? 1) },
    },
    ...METAL_FINISH_GLSL,
  };
}

/** Soft radial texture for the contact shadow decal (same idea as the footage renderer). */
function makeShadowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  const gr = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, "rgba(0,0,0,0.75)");
  gr.addColorStop(0.5, "rgba(0,0,0,0.35)");
  gr.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = gr;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

/** A rigid object next to the body (the carried chair): a wrapper group posed per frame. */
interface PropModel {
  root: THREE.Group;
  /**
   * Per-piece uniforms of its footage-on-model materials (empty without a projector): one entry per mesh
   * of the GLB, `bit` = its index in the prop's `pieces` (-1: not listed, the object is one piece).
   */
  pieces: { bit: number; own: HybridOwn }[];
  setLook: (look: Look) => void;
  /** Draw the object as a wireframe (the room's wireframe view) instead of its surface. */
  setWire: (on: boolean) => void;
  dispose: () => void;
}

interface AvatarModel {
  /** glTF scene root; stays at the origin with identity transform (root motion is in room coordinates). */
  root: THREE.Object3D;
  xray: THREE.SkinnedMesh;
  /** The GLB carries a colour texture (false: the body is drawn in neutral grey, no footage on it). */
  textured: boolean;
  /** Puts the footage of the shown frame onto the body; null when the asset carries no camera data. */
  projector: HybridProjector | null;
  own: HybridOwn | null;
  /** Index-aligned with motion.props; null while loading or when the file is missing. */
  props: (PropModel | null)[];
  setLook: (look: Look) => void;
  /**
   * Demo walkthrough: draw the X-ray shell over the whole body (not only where something hides it) at
   * `strength` 0..1; `hideBody` leaves out the textured body, so only the shell shows. (0, false) = normal.
   */
  setHologram: (strength: number, hideBody: boolean) => void;
  /** Pose the skeleton for a time on the baked clip (seconds). Idempotent and history-free. */
  setTime: (clipTime: number) => void;
  dispose: () => void;
}

const loader = new GLTFLoader();
const BASE_URL = "/reconstruction";

/**
 * Static meshes of a prop GLB under one group, with a material per look. Every mesh is one piece of the
 * object (`names`: the prop's `pieces`, matched to the GLB's node names) with its own outline uniforms,
 * because a camera's matte may show some pieces of the object and not others (poseProp).
 *
 * A GLB may carry a second scene named "wireframe": the object's surfaces as a mesh of small cells, which
 * is what the wireframe view draws (the solid proxy is a few large boxes, whose edges alone would not read
 * as the object next to the room scan's dense mesh). Without one the solid meshes are drawn as wires.
 */
async function loadProp(url: string, projector: HybridProjector | null, names: readonly string[] | undefined, plain: readonly string[] | undefined): Promise<PropModel> {
  const gltf = await loader.loadAsync(url);
  const root = new THREE.Group();
  root.name = "avatar-prop";
  root.add(gltf.scene);
  const lift = { value: 0 }; // one rigid object: all pieces share its display offset
  const pieces: PropModel["pieces"] = [];
  const looks: { mesh: THREE.Mesh; model: THREE.Material; hybrid: THREE.Material | null }[] = [];
  const owned = new Set<{ dispose: () => void }>();
  const models = new Map<THREE.Material, { model: THREE.Material; finish: HybridFinish | null }>(); // per source material
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const src = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
    const map = src.map ?? null;
    if (map) {
      map.colorSpace = THREE.SRGBColorSpace;
      map.anisotropy = 4;
      owned.add(map);
    }
    // alphaMode MASK (gaps between slats): alpha test, antialiased by coverage
    const params: THREE.MeshBasicMaterialParameters = { map, color: map ? 0xffffff : src.color, side: src.side, toneMapped: false, name: "avatar-prop" };
    let made = models.get(src);
    if (!made) {
      const finish = metalFinish(src);
      if (src.normalMap) owned.add(src.normalMap);
      made = { model: shadeMaterial(new THREE.MeshBasicMaterial({ ...params, alphaTest: src.alphaTest, alphaToCoverage: src.alphaTest > 0 }), "body", finish), finish };
      models.set(src, made);
      owned.add(made.model);
      owned.add(src);
    }
    const { model, finish } = made;
    // the normal the sheen is lit with (a round tube on a leg's flat faces); the face normal where the asset has none
    if (finish && !mesh.geometry.getAttribute("_shade_normal")) mesh.geometry.setAttribute("_shade_normal", mesh.geometry.getAttribute("normal"));
    let hybrid: THREE.Material | null = null;
    if (projector) {
      // the glTF loader keeps the node's own name in userData (its `name` may carry a suffix to stay unique)
      const name = (mesh.userData.name as string | undefined) ?? mesh.name;
      const own: HybridOwn = { ...HybridProjector.own(), uHyLift: lift };
      // Which pixels are the object's? The matte and the pieces it shows decide that (poseProp). The colour of a
      // pixel decides it only on the pieces of one plain colour (a chair's legs): a panel of slats shows what is
      // behind it through its gaps, and its baked colour is one measured grey.
      own.uHyAlike.value = plain?.includes(name) ? 1 : 0;
      hybrid = projector.surfaceMaterial(params, formShade("body"), own, finish).material;
      projector.addOccluder(mesh, own, true);
      pieces.push({ bit: names ? names.indexOf(name) : -1, own });
    }
    mesh.material = model;
    mesh.renderOrder = BODY_ORDER;
    mesh.frustumCulled = false;
    mesh.raycast = () => {};
    looks.push({ mesh, model, hybrid });
    owned.add(mesh.geometry);
  });

  // The object as a wireframe, in the material of the room's wireframe (same colours by height, same ceiling
  // cut). It replaces the surface on screen only: the solid meshes keep their own `visible`, which is what the
  // projector's depth maps go by, so the cameras' pixels of the object still stay off the person.
  // The room's lines are faint and lie in many layers; a chair of such lines alone is lost among those behind
  // it. So its lines are stronger, and its faces are drawn into the depth buffer only (after the person, before
  // the room's lines): what is behind a face is hidden as by the solid chair, the face itself stays empty.
  const wireMaterial = makeBuildWireMaterial(ceilingPlanes, PROP_WIRE_OPACITY, false);
  const faceMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2, clippingPlanes: ceilingPlanes, name: "avatar-prop-wire-face" });
  owned.add(wireMaterial);
  owned.add(faceMaterial);
  const wire = gltf.scenes.find((sc) => sc !== gltf.scene && sc.name === "wireframe") ?? gltf.scene.clone(true);
  wire.name = "avatar-prop-wire";
  wire.visible = false;
  const wires: THREE.Mesh[] = [];
  wire.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) wires.push(o as THREE.Mesh);
  });
  for (const mesh of wires) {
    (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach((m) => {
      if (!owned.has(m)) owned.add(m); // the wireframe scene's own (unused) material
    });
    mesh.material = wireMaterial;
    mesh.frustumCulled = false;
    mesh.raycast = () => {};
    owned.add(mesh.geometry);
    const face = new THREE.Mesh(mesh.geometry, faceMaterial);
    face.name = "avatar-prop-wire-face";
    face.renderOrder = BODY_ORDER + 1;
    face.frustumCulled = false;
    face.raycast = () => {};
    mesh.add(face);
  }
  root.add(wire);

  return {
    root,
    pieces,
    setLook: (look) => {
      for (const l of looks) l.mesh.material = look === "hybrid" && l.hybrid ? l.hybrid : l.model;
    },
    setWire: (on) => {
      gltf.scene.visible = !on;
      wire.visible = on;
    },
    dispose: () => {
      owned.forEach((o) => o.dispose());
      root.removeFromParent();
    },
  };
}

async function loadAvatarModel(url: string, subjectId: string, motion: AvatarMotion): Promise<AvatarModel> {
  const gltf = await loader.loadAsync(url);
  const root = gltf.scene;
  let body: THREE.SkinnedMesh | null = null;
  root.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (m.isSkinnedMesh && (!body || m.name === "body")) body = m;
  });
  const mesh = body as THREE.SkinnedMesh | null;
  const clip = gltf.animations.find((a) => a.name === "motion") ?? gltf.animations[0];
  if (!mesh || !clip) throw new Error(`avatar GLB ${url} has no ${mesh ? "animation clip" : "skinned mesh"}`);

  // Footage texture, shown as recorded: sRGB in, no tone mapping (same as the unlit room scan).
  const srcMats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const src = srcMats[0] as THREE.MeshStandardMaterial;
  const map = src.map ?? null;
  if (map) {
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = 4;
  }
  const variant = map ? "body" : "flat";
  const params: THREE.MeshBasicMaterialParameters = { map, color: map ? 0xffffff : UNTEXTURED, side: src.side, toneMapped: false, name: "avatar-body" };
  const bodyMat = shadeMaterial(new THREE.MeshBasicMaterial(params), variant);
  // Opaque queue on purpose (blending still applies): it must draw after the room but before the body.
  const xrayMat = shadeMaterial(
    new THREE.MeshBasicMaterial({
      color: XRAY_COLOR,
      opacity: 0.6,
      blending: THREE.AdditiveBlending,
      depthFunc: THREE.GreaterDepth,
      depthWrite: false,
      side: src.side,
      toneMapped: false,
      name: "avatar-xray",
    }),
    "xray",
  );
  srcMats.forEach((m) => m.dispose());

  mesh.material = bodyMat;
  mesh.name = `avatar-${subjectId}`;
  mesh.frustumCulled = false; // bind-pose bounds sit at the origin, the animated body does not
  mesh.renderOrder = BODY_ORDER;
  mesh.raycast = () => {}; // selection uses SubjectActor's hit cylinder

  const xray = new THREE.SkinnedMesh(mesh.geometry, xrayMat);
  xray.name = `avatar-xray-${subjectId}`;
  xray.position.copy(mesh.position);
  xray.quaternion.copy(mesh.quaternion);
  xray.scale.copy(mesh.scale);
  xray.bind(mesh.skeleton, mesh.bindMatrix);
  xray.frustumCulled = false;
  xray.renderOrder = XRAY_ORDER;
  xray.raycast = () => {};
  xray.visible = false;
  (mesh.parent ?? root).add(xray);

  // Footage-on-model look: same mesh, a second material that samples the cameras of the shown frame.
  const projector = motion.projection ? new HybridProjector(motion.projection) : null;
  const hybrid = projector?.surfaceMaterial(params, formShade(variant)) ?? null;
  if (projector && hybrid) {
    projector.addOccluder(mesh, hybrid.own);
    projector.fringe.visible = false;
    root.add(projector.fringe);
  }

  const mixer = new THREE.AnimationMixer(root);
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true; // the last key holds exactly at clip.duration
  action.play();
  let last = NaN;
  const setTime = (clipTime: number) => {
    const tc = Math.min(Math.max(clipTime, 0), clip.duration);
    if (tc === last) return; // bones are written by this mixer only: nothing to redo while paused
    last = tc;
    action.paused = false; // reaching the end pauses a clamped action; setTime must stay absolute
    action.enabled = true;
    mixer.setTime(tc);
  };

  // Handled objects load on their own: the body never waits for them and a missing file only leaves them out.
  let disposed = false;
  let look: Look = "model";
  const props: (PropModel | null)[] = (motion.props ?? []).map(() => null);
  (motion.props ?? []).forEach((p, i) => {
    loadProp(`${BASE_URL}/${motion.clip}/${p.glb}`, projector, p.pieces, p.plain).then(
      (prop) => {
        if (disposed) return prop.dispose();
        prop.root.name = `avatar-prop-${p.id}`;
        prop.root.visible = false;
        prop.setLook(look);
        root.add(prop.root);
        props[i] = prop;
        projector?.invalidate();
      },
      (e) => console.warn(`[Sentry3D] prop ${p.id} of ${motion.clip} failed to load`, e),
    );
  });

  root.visible = false;
  let holo = 0;
  let bodyHidden = false;
  const showFringe = () => {
    if (projector) projector.fringe.visible = look === "hybrid" && !!hybrid && !bodyHidden;
  };
  return {
    root,
    xray,
    textured: !!map,
    projector,
    own: hybrid?.own ?? null,
    props,
    setLook: (next) => {
      if (next === look) return;
      look = next;
      const on = look === "hybrid" && !!hybrid;
      mesh.material = on ? hybrid.material : bodyMat;
      showFringe();
      for (const p of props) p?.setLook(look);
      projector?.invalidate();
    },
    setHologram: (strength, hideBody) => {
      if (strength === holo && hideBody === bodyHidden) return;
      const on = strength > 0;
      if (on !== holo > 0) {
        // over everything and after the body, instead of only where the room is in front
        xrayMat.depthFunc = on ? THREE.AlwaysDepth : THREE.GreaterDepth;
        xray.renderOrder = on ? BODY_ORDER + 3 : XRAY_ORDER;
      }
      xrayMat.opacity = on ? Math.min(1, strength) : 0.6;
      holo = strength;
      if (hideBody !== bodyHidden) {
        bodyHidden = hideBody;
        // still writes depth: the shell keeps a clean silhouette against what is behind it
        bodyMat.colorWrite = !hideBody;
        if (hybrid) hybrid.material.colorWrite = !hideBody;
        showFringe();
      }
    },
    setTime,
    dispose: () => {
      disposed = true;
      for (const p of props) p?.dispose();
      projector?.dispose();
      mixer.stopAllAction();
      mixer.uncacheRoot(root);
      mesh.skeleton.dispose();
      mesh.geometry.dispose();
      bodyMat.dispose();
      xrayMat.dispose();
      map?.dispose();
      root.removeFromParent();
    },
  };
}

const qa = new THREE.Quaternion();
const qb = new THREE.Quaternion();

/** Pose a prop at (fractional) frame f; `shown` is the frame whose footage is on screen (hybrid look). */
function poseProp(prop: PropModel, data: AvatarProp, f: number, shown: number, slots: readonly (CameraId | null)[] | null) {
  const { pos, quat, lift, visible, inMatte, cut } = data.frames;
  const last = pos.length - 1;
  const k0 = Math.min(Math.max(Math.floor(f), 0), last);
  const k1 = Math.min(k0 + 1, last);
  const s = Math.min(Math.max(f - k0, 0), 1);
  const a = pos[k0];
  const b = pos[k1];
  const up = lift[k0] + (lift[k1] - lift[k0]) * s;
  prop.root.position.set(a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s + up, a[2] + (b[2] - a[2]) * s);
  qa.fromArray(quat[k0]);
  qb.fromArray(quat[k1]);
  prop.root.quaternion.copy(qa).slerp(qb, s).normalize();
  prop.root.visible = visible ? !!visible[Math.min(Math.max(Math.round(f), 0), last)] : true;
  for (const piece of prop.pieces) {
    piece.own.uHyLift.value = up;
    // Its outline is that of a camera's matte only where that matte really shows it: a matte that contains
    // the object often lacks some of its pieces (the thin legs). Those are drawn from the proxy alone (-1):
    // what that matte holds where they are is the person or another piece, not them.
    const on = (i: number) => {
      const id = slots?.[i];
      if (!id) return 0;
      const bits = piece.bit >= 0 ? cut?.[id]?.[shown] : undefined;
      if (bits === undefined) return inMatte?.[id]?.[shown] ? 2 : 0;
      if (bits === 0) return 0; // this matte does not have the object at all: the person alone
      return (bits >> piece.bit) & 1 ? 2 : -1;
    };
    piece.own.uHyTrimOn.value.set(on(0), on(1), on(2), on(3));
  }
}

/** Contact shadow decal: soft ellipse laid on the floor under the body. */
function makeShadow() {
  const tex = makeShadowTexture();
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false, opacity: 0.55 }),
  );
  mesh.name = "avatar-shadow";
  mesh.rotation.x = -Math.PI / 2;
  mesh.scale.set(0.85, 0.6, 1);
  mesh.renderOrder = 1;
  mesh.raycast = () => {};
  mesh.visible = false;
  return {
    mesh,
    dispose: () => {
      mesh.removeFromParent();
      mesh.geometry.dispose();
      mesh.material.dispose();
      tex.dispose();
    },
  };
}

/** Three.js objects owned by one SubjectAvatar (created and destroyed imperatively, never React state). */
interface Live {
  /** Loaded model per clip id, or "failed". */
  models: Record<string, AvatarModel | "failed">;
  shadow: THREE.Mesh | null;
  /** 3D + FOOTAGE: the last frame that was shown with all its cut-outs. */
  shown: { clip: string; k: number } | null;
}

const rootFit = new THREE.Vector3();
const pelvis = new THREE.Vector3();
const angles: number[] = [];
const DEG = 180 / Math.PI;

function SubjectAvatar({ subjectId }: { subjectId: string }) {
  const motions = useAvatarStore((s) => s.bySubject[subjectId]);
  const setStatus = useAvatarStore((s) => s.setStatus);
  const holder = useRef<THREE.Group>(null);
  const live = useRef<Live>({ models: {}, shadow: null, shown: null });

  // Models are attached straight to the holder group: a slow or failed download can never
  // suspend or blank the scene, the subject simply keeps its fallback body meanwhile.
  useEffect(() => {
    const group = holder.current;
    if (!group || !motions?.length) return;
    let cancelled = false;
    const slot = live.current;
    const models: Live["models"] = {};
    slot.models = models;
    for (const motion of motions) {
      loadAvatarModel(avatarModelUrl(motion), subjectId, motion).then(
        (model) => {
          if (cancelled) return model.dispose();
          models[motion.clip] = model;
          group.add(model.root);
          if (import.meta.env.DEV) Object.assign(window, { __sentryHybrid: model.projector, __sentryMetal: metalUniforms });
        },
        (e) => {
          console.warn(`[Sentry3D] avatar model for ${motion.clip} failed to load`, e);
          models[motion.clip] = "failed";
        },
      );
    }
    return () => {
      cancelled = true;
      for (const m of Object.values(models)) if (m !== "failed") m.dispose();
      if (slot.models === models) slot.models = {};
    };
  }, [motions, subjectId]);

  useEffect(() => {
    const group = holder.current;
    if (!group) return;
    const slot = live.current;
    const shadow = makeShadow();
    group.add(shadow.mesh);
    slot.shadow = shadow.mesh;
    return () => {
      if (slot.shadow === shadow.mesh) slot.shadow = null;
      shadow.dispose();
    };
  }, []);

  // No longer drawing this subject once unmounted (lets the fallback body show again).
  useEffect(
    () => () => setStatus({ subjectId, active: false, clip: null, frameK: null, cameras: null, placeholder: false, textured: false, footage: null, reason: "renderer not mounted" }),
    [setStatus, subjectId],
  );

  useFrame(({ gl, camera }) => {
    // The look is read here, not rendered: a change of mode lands in the frame it is made in, together with
    // everything else that frame sets (no frame with the old body in the new look).
    const mode = useViewStore.getState().subjectRenderMode;
    const { currentTime: t, xrayEnabled: xray } = useReplayStore.getState();
    const { models, shadow } = live.current;
    const hide = (reason: string) => {
      for (const m of Object.values(models)) if (m !== "failed") m.root.visible = false;
      if (shadow) shadow.visible = false;
      setStatus({ subjectId, active: false, clip: null, frameK: null, cameras: null, placeholder: false, textured: false, footage: null, reason });
    };
    if (mode !== "model" && mode !== "hybrid") return hide(mode === "footage" ? "footage mode" : "debug avatar mode");
    const load = useAvatarStore.getState().loadStatus;
    if (load === "idle" || load === "loading") return hide("loading reconstruction");
    if (!motions?.length) return hide("no reconstructed body on this machine");
    if (!subjectSample(subjectId, t)) return hide("subject not present");
    if (demoLook.active && demoLook.hideSubject) return hide("left out by the demo walkthrough");
    const motion = motionAt(motions, t);
    let at = floorAt(motions, t);
    if (!motion || !at) return hide("no reconstructed body at this time");
    const model = models[at.clip];
    if (!model) return hide("loading 3D model");
    if (model === "failed") return hide("model failed to load");

    const projector = mode === "hybrid" ? model.projector : null;
    const projection = motion.projection;
    const fps = motion.fps;
    let frame = at.clipTime * fps; // (fractional) frame the pose is evaluated at
    let shownK = at.k;
    let footage: { cameras: CameraId[]; nearest: CameraId | null; offDeg: number | null } | null = null;

    if (projector && projection) {
      // --- which frame's footage is on screen: the current one, or (while its cut-outs download) the last complete one
      const manifest = useAppearanceStore.getState().clips[motion.clip];
      const cropsOf = (k: number) => {
        let want = 0;
        const crops = projector.slots.map((id): HybridCrop | null => {
          const f = id ? manifest?.cameras[id]?.frames[k] : undefined;
          if (!id || !f?.file || !f.cropPx) return null;
          if (projection.use?.[id]?.[k] === false) return null; // this cut-out disagrees with the body (a sliver at the frame edge)
          want++;
          const texture = getTexture(motion.clip, f.file);
          if (!texture) return null;
          return {
            texture,
            rect: f.cropPx,
            known: projection.known?.[id]?.[k] ?? null,
            register: projection.register?.[id]?.[k] ?? null,
            tone: projection.tone?.cameras[id]?.[k] ?? null,
          };
        });
        return { crops, complete: crops.filter(Boolean).length === want };
      };
      let pick = cropsOf(at.k); // requested first, then the frames around it
      if (!demoLook.active) prefetchAround(subjectId, t, 0.8, false); // the walkthrough loads its frames up front
      const held = live.current.shown;
      if (!pick.complete && held && held.clip === motion.clip && held.k !== at.k && Math.abs(held.k - at.k) <= HOLD_FRAMES && motion.frames.valid[held.k]) {
        const prev = cropsOf(held.k);
        if (prev.complete) {
          pick = prev;
          shownK = held.k;
        }
      }
      if (pick.complete) live.current.shown = { clip: motion.clip, k: shownK };
      if (shownK !== at.k) at = floorAt(motions, motion.t0 + shownK / fps) ?? at;

      // --- pose of that frame. Camera c exposed its image k at clip time k / fps - dt_c (a fraction of a
      // frame apart); the body takes the instant of the cameras the viewer looks along, so it lines up
      // with the pixels it carries.
      const r = motion.frames.root[shownK] ?? [at.x, at.y + 1, at.z];
      const lift0 = projection.lift[shownK] ?? 0;
      pelvis.set(r[0], r[1], r[2]);
      projector.viewAngles(camera.position, pelvis, lift0, angles);
      let wSum = 0;
      let dt = 0;
      let nearest = -1;
      const on: CameraId[] = [];
      projector.slots.forEach((id, i) => {
        if (!id || !pick.crops[i]) return;
        on.push(id);
        const w = Math.exp(-((angles[i] / HYBRID_TUNING.viewSigma) ** 2)) + 1e-4;
        wSum += w;
        dt += w * (projection.cameras[id]?.dt ?? 0);
        if (nearest < 0 || angles[i] < angles[nearest]) nearest = i;
      });
      const lastK = motion.frameCount - 1;
      frame = Math.min(Math.max(Math.round((shownK - (wSum > 0 ? dt / wSum : 0) * fps) * POSE_GRID) / POSE_GRID, 0), lastK);
      if (!motion.frames.valid[Math.floor(frame)] || !motion.frames.valid[Math.ceil(frame)]) frame = shownK;
      const k0 = Math.floor(frame);
      const lift = projection.lift[k0] + (projection.lift[Math.min(k0 + 1, lastK)] - projection.lift[k0]) * (frame - k0);
      if (model.own) {
        model.own.uHyLift.value = lift;
        model.own.uHyTrimOn.value.set(1, 1, 1, 1); // the person is in every matte
      }
      rootFit.set(r[0], r[1] - lift0, r[2]);
      projector.setFrame(pick.crops, rootFit, lift);
      footage = { cameras: on, nearest: nearest >= 0 ? projector.slots[nearest] : null, offDeg: nearest >= 0 ? Math.round(angles[nearest] * DEG) : null };
    }
    if (!at.valid) return hide("no usable pose at this time");

    for (const m of Object.values(models)) if (m !== "failed") m.root.visible = m === model;
    model.setLook(projector ? "hybrid" : "model");
    model.setTime(frame / fps);
    const holo = demoLook.active ? demoLook.hologram : 0;
    model.setHologram(holo, holo > 0 && demoLook.hideBody);
    holoUniforms.uAvHolo.value = holo > 0 ? demoLook.holoStyle : 0;
    holoUniforms.uAvHoloTime.value = demoLook.applied;
    holoUniforms.uAvHoloBand.value = demoLook.holoBand;
    model.xray.visible = xray || holo > 0;
    // Wireframe view (once the room is shown as one: after the page-load reveal): the handled objects are drawn
    // as wireframes like the room. The cameras whose cut-out of the shown frame contains such an object then keep
    // its pixels off the person.
    // Where the room turns to wireframe gradually (the walkthrough's dissolve, from the ceiling down), an object
    // stays solid until the front of that dissolve reaches it: above the front there is wireframe, below it none yet.
    const wireRoom = buildUniforms.uWireMode.value > 0.5;
    let wired = false;
    let open = 0;
    motion.props?.forEach((data, i) => {
      const prop = model.props[i];
      let wire = wireRoom;
      if (prop) {
        poseProp(prop, data, frame, shownK, projector?.slots ?? null);
        wire = wireRoom && buildUniforms.uBuildTexY.value < prop.root.position.y + PROP_WIRE_AT;
        prop.setWire(wire);
      }
      if (!wire) return;
      wired = true;
      projector?.slots.forEach((id, s) => {
        if (id && (data.frames.cut?.[id]?.[shownK] || data.frames.inMatte?.[id]?.[shownK])) open |= 1 << s;
      });
    });
    projector?.setSeeThrough(open, wired);
    if (projector) {
      // the cameras' depth maps of this pose, before the frame is drawn
      model.root.updateMatrixWorld(true);
      projector.renderDepth(gl, `${shownK}|${frame}|${footage?.cameras.join() ?? ""}|${model.props.filter(Boolean).length}`);
    }

    // Contact shadow: footprint-sized ellipse on the scanned floor under the body, turned with it.
    if (shadow) {
      shadow.position.set(at.x, at.y + 0.004, at.z);
      shadow.rotation.set(-Math.PI / 2, 0, at.heading);
      shadow.visible = true;
    }

    setStatus({
      subjectId,
      active: true,
      clip: at.clip,
      frameK: shownK,
      cameras: at.cameras,
      placeholder: !!motion.placeholder,
      textured: model.textured,
      footage,
      reason: null,
    });
  });

  return <group ref={holder} name={`avatar-holder-${subjectId}`} />;
}

/**
 * Mounted inside the existing <Canvas> next to AppearanceLayer, at the scene origin
 * (identity transform): the baked root motion is already in room coordinates.
 */
export function AvatarLayer() {
  const load = useAvatarStore((s) => s.load);
  const loadFootage = useAppearanceStore((s) => s.load);
  useEffect(() => {
    void load();
    void loadFootage(); // the cut-outs the 3D + FOOTAGE look projects onto the body
  }, [load, loadFootage]);
  return (
    <group name="AvatarLayer">
      {subjects.map((s) => (
        <SubjectAvatar key={s.id} subjectId={s.id} />
      ))}
    </group>
  );
}
