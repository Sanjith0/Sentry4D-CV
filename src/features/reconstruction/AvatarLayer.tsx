/**
 * 3D MODEL renderer: the tracked person drawn as ONE reconstructed, articulated, textured body.
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
import { subjects } from "../../config/subjects";
import { useReplayStore } from "../../store/useReplayStore";
import { useViewStore } from "../../store/useViewStore";
import { subjectSample } from "../sentry/SceneActors";
import { avatarModelUrl, floorAt, useAvatarStore } from "./useAvatarStore";

/** Draw order inside the opaque pass: room (0) -> X-ray silhouette (1) -> body (2). */
const XRAY_ORDER = 1;
const BODY_ORDER = 2;
/** Body colour when the asset carries no texture (placeholder / failed image). */
const UNTEXTURED = "#4a4f58";
const XRAY_COLOR = "#22d3ee";

/**
 * MeshBasicMaterial (so three injects skinning, colour management and clipping itself) with a
 * soft form term added in onBeforeCompile:
 *   body:  textured: essentially unlit, footage * (0.90 + 0.14 * form) + a tiny lift so near-black
 *          clothing still reads as a volume. The baked texture already holds the footage lighting,
 *          so nothing may crush or highlight it (no specular, no lights, no tone mapping).
 *   flat:  untextured asset: grey * (0.75 + 0.35 * form); a flat grey body needs the form term to read.
 *          form mixes a sky/ground hemisphere, a fixed key direction and a headlight.
 *   xray:  flat cyan with a rim falloff (additive).
 */
function shadeMaterial(mat: THREE.MeshBasicMaterial, variant: "body" | "flat" | "xray") {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vAvatarN;\nvarying vec3 vAvatarP;")
      .replace(
        "#include <project_vertex>",
        /* glsl */ `#include <project_vertex>
        #ifdef USE_SKINNING
          // transformedNormal: skinned normal in view space (defaultnormal_vertex)
          vAvatarN = inverseTransformDirection( transformedNormal, viewMatrix );
        #else
          vAvatarN = normalize( mat3( modelMatrix ) * normal );
        #endif
        vAvatarP = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`,
      );
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
          outgoingLight = diffuseColor.rgb * ( 0.45 + 1.1 * avRim );`;
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vAvatarN;\nvarying vec3 vAvatarP;")
      .replace(
        "#include <opaque_fragment>",
        /* glsl */ `{
          vec3 avN = normalize( vAvatarN );
          #ifdef DOUBLE_SIDED
            if ( ! gl_FrontFacing ) avN = - avN;
          #endif
          float avFacing = max( dot( avN, normalize( cameraPosition - vAvatarP ) ), 0.0 );
          float avRim = pow( 1.0 - avFacing, 3.0 );
          ${shade}
        }
        #include <opaque_fragment>`,
      );
  };
  mat.customProgramCacheKey = () => `sentry-avatar-${variant}`;
  return mat;
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

interface AvatarModel {
  /** glTF scene root; stays at the origin with identity transform (root motion is in room coordinates). */
  root: THREE.Object3D;
  xray: THREE.SkinnedMesh;
  /** The GLB carries a colour texture (false: the body is drawn in neutral grey, no footage on it). */
  textured: boolean;
  /** Pose the skeleton for a time on the baked clip (seconds). Idempotent and history-free. */
  setTime: (clipTime: number) => void;
  dispose: () => void;
}

const loader = new GLTFLoader();

async function loadAvatarModel(url: string, subjectId: string): Promise<AvatarModel> {
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
  const bodyMat = shadeMaterial(
    new THREE.MeshBasicMaterial({ map, color: map ? 0xffffff : UNTEXTURED, side: src.side, toneMapped: false, name: "avatar-body" }),
    map ? "body" : "flat",
  );
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

  root.visible = false;
  return {
    root,
    xray,
    textured: !!map,
    setTime,
    dispose: () => {
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
}

function SubjectAvatar({ subjectId }: { subjectId: string }) {
  const motions = useAvatarStore((s) => s.bySubject[subjectId]);
  const mode = useViewStore((s) => s.subjectRenderMode);
  const xray = useReplayStore((s) => s.xrayEnabled);
  const setStatus = useAvatarStore((s) => s.setStatus);
  const holder = useRef<THREE.Group>(null);
  const live = useRef<Live>({ models: {}, shadow: null });

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
      loadAvatarModel(avatarModelUrl(motion), subjectId).then(
        (model) => {
          if (cancelled) return model.dispose();
          models[motion.clip] = model;
          group.add(model.root);
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
    () => () => setStatus({ subjectId, active: false, clip: null, frameK: null, cameras: null, placeholder: false, textured: false, reason: "renderer not mounted" }),
    [setStatus, subjectId],
  );

  useFrame(() => {
    const t = useReplayStore.getState().currentTime;
    const { models, shadow } = live.current;
    const hide = (reason: string) => {
      for (const m of Object.values(models)) if (m !== "failed") m.root.visible = false;
      if (shadow) shadow.visible = false;
      setStatus({ subjectId, active: false, clip: null, frameK: null, cameras: null, placeholder: false, textured: false, reason });
    };
    if (mode !== "model") return hide(mode === "footage" ? "footage mode" : "debug avatar mode");
    const load = useAvatarStore.getState().loadStatus;
    if (load === "idle" || load === "loading") return hide("loading reconstruction");
    if (!motions?.length) return hide("no reconstructed body on this machine");
    if (!subjectSample(subjectId, t)) return hide("subject not present");
    const at = floorAt(motions, t);
    if (!at) return hide("no reconstructed body at this time");
    if (!at.valid) return hide("no usable pose at this time");
    const model = models[at.clip];
    if (!model) return hide("loading 3D model");
    if (model === "failed") return hide("model failed to load");

    for (const m of Object.values(models)) if (m !== "failed") m.root.visible = m === model;
    model.setTime(at.clipTime);
    model.xray.visible = xray;

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
      frameK: at.k,
      cameras: at.cameras,
      placeholder: !!motions.find((m) => m.clip === at.clip)?.placeholder,
      textured: model.textured,
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
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <group name="AvatarLayer">
      {subjects.map((s) => (
        <SubjectAvatar key={s.id} subjectId={s.id} />
      ))}
    </group>
  );
}
