/**
 * REAL APPEARANCE renderer: the tracked person drawn with their actual segmented footage.
 *
 * Geometry (per frame, from the master clock only):
 *   P  = subject floor position from the existing fused trajectory (same as tracking / X-ray)
 *   S  = chosen source camera (closest viewing direction to the viewer, or user-forced)
 *   Π  = vertical plane through P whose normal points (horizontally) at S
 *   body = a dense grid over the crop. Each vertex sits where S's ray through that crop pixel meets
 *          Π, then is pushed by an "inflated silhouette" height map (thick along the medial axis,
 *          thin at the outline and on limbs):
 *            FRONT shell -> toward S ALONG THAT SAME RAY, so from S the footage is pixel-exact;
 *            BACK  shell -> away from S, giving the body real thickness (≈0.6 x its width).
 *   Front shows the real footage (lightly shaded only when viewed off-axis, so the volume reads).
 *   The back was seen by no camera: it is shaded in the clothing's measured mean colour, never
 *   textured with invented detail. Pixels hidden from S (e.g. legs behind a table) stay absent.
 *   A soft contact shadow under the feet gives weight.
 *
 * Depth: normal depth test against the LiDAR room (furniture in front occludes the person).
 * X-ray: a second pass with depthFunc GreaterDepth draws the REAL silhouette in cyan only
 * where geometry hides it, without disabling depth testing for the scene.
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { subjects } from "../../config/subjects";
import { useReplayStore } from "../../store/useReplayStore";
import { useViewStore } from "../../store/useViewStore";
import { buildCctvCamera } from "../../lib/videoProjection";
import type { CameraId } from "../../types/security";
import { subjectSample } from "../sentry/SceneActors";
import { clipsAt, frameAt, getTexture, prefetchAround, useAppearanceStore } from "./useAppearanceStore";
import type { AppearanceClipManifest, AppearanceFrame, EvidenceClass } from "./ReconstructionTypes";

/** Viewing within this angle of the source camera counts as the observed (recorded) view. */
const OBSERVED_DEG = 3;
/** Hysteresis for automatic camera switching (degrees). */
const SWITCH_MARGIN_DEG = 6;

const vert = /* glsl */ `
  attribute vec2 cropUv;            // x right, y down, 0..1 over the crop
  uniform sampler2D uTex;
  uniform sampler2D uDepth;         // inflation height map (0..1 of uHmaxPx)
  uniform mat4 uSrcInvViewProj;
  uniform vec3 uSrcPos;
  uniform vec3 uPlaneN;             // horizontal, points from the body toward S
  uniform float uPlaneC;
  uniform vec4 uCrop;
  uniform float uHmaxPx;
  uniform float uFy;                // source focal length in px (1080-high frame)
  uniform float uDepthScale;
  uniform float uSide;              // +1 front shell, -1 back shell
  varying vec2 vUv;
  varying vec3 vWorld;
  #include <common>
  #include <logdepthbuf_pars_vertex>
  void main() {
    vec2 fr = mix(uCrop.xy, uCrop.zw, cropUv);
    vec4 pn = uSrcInvViewProj * vec4(fr.x * 2.0 - 1.0, 1.0 - fr.y * 2.0, 0.0, 1.0);
    vec3 dir = normalize(pn.xyz / pn.w - uSrcPos);
    float t = -(dot(uPlaneN, uSrcPos) + uPlaneC) / dot(uPlaneN, dir);
    vec3 base = uSrcPos + dir * t;
    vec2 tuv = vec2(cropUv.x, 1.0 - cropUv.y);
    float hn = texture2D(uDepth, tuv).r;
    float hM = hn * uHmaxPx * (t / uFy) * uDepthScale;   // px -> metres at this distance
    vec3 p = uSide > 0.0 ? base - dir * hM : base - uPlaneN * hM;
    vUv = tuv;
    vWorld = p;
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
    #include <logdepthbuf_vertex>
  }`;

const frag = /* glsl */ `
  uniform sampler2D uTex;
  uniform float uSide;
  uniform float uXray;
  uniform vec3 uXrayColor;
  uniform vec3 uBackColor;          // measured mean clothing colour (linear)
  uniform float uShade;             // 0 at the source view (exact footage) .. 1 well off-axis
  varying vec2 vUv;
  varying vec3 vWorld;
  #include <common>
  #include <logdepthbuf_pars_fragment>
  void main() {
    #include <logdepthbuf_fragment>
    vec4 t = texture2D(uTex, vUv);
    if (t.a < 0.5) discard;
    vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
    if (!gl_FrontFacing) n = -n;
    vec3 L = normalize(vec3(0.35, 0.85, 0.4));
    float lam = 0.5 + 0.5 * abs(dot(n, L));
    if (uXray > 0.5) {
      float lum = uSide > 0.0 ? dot(t.rgb, vec3(0.299, 0.587, 0.114)) : 0.25;
      gl_FragColor = vec4(uXrayColor * (0.55 + 1.2 * lum), 0.7);
    } else if (uSide > 0.0) {
      gl_FragColor = vec4(mix(t.rgb, t.rgb * (0.65 + 0.55 * lam), uShade), 1.0);
    } else {
      gl_FragColor = vec4(uBackColor * (0.55 + 0.6 * lam), 1.0);
    }
    #include <colorspace_fragment>
  }`;

function makeMaterial(xray: boolean, side: 1 | -1) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTex: { value: null },
      uDepth: { value: null },
      uSrcInvViewProj: { value: new THREE.Matrix4() },
      uSrcPos: { value: new THREE.Vector3() },
      uPlaneN: { value: new THREE.Vector3(0, 0, 1) },
      uPlaneC: { value: 0 },
      uCrop: { value: new THREE.Vector4(0, 0, 1, 1) },
      uHmaxPx: { value: 0 },
      uFy: { value: 1000 },
      uDepthScale: { value: 0.6 },
      uSide: { value: side },
      uXray: { value: xray ? 1 : 0 },
      uXrayColor: { value: new THREE.Color("#22d3ee") },
      uBackColor: { value: new THREE.Color("#222") },
      uShade: { value: 0 },
    },
    vertexShader: vert,
    fragmentShader: frag,
    transparent: xray,
    depthWrite: !xray,
    depthTest: true,
    depthFunc: xray ? THREE.GreaterDepth : THREE.LessEqualDepth,
    blending: xray ? THREE.AdditiveBlending : THREE.NormalBlending,
    side: THREE.DoubleSide,
    alphaToCoverage: !xray,
    toneMapped: false,
  });
}

/** Grid over the crop (cropUv attribute); positions are computed in the vertex shader. */
function makeGrid(nx: number, ny: number) {
  const g = new THREE.BufferGeometry();
  const uv = new Float32Array((nx + 1) * (ny + 1) * 2);
  const pos = new Float32Array((nx + 1) * (ny + 1) * 3);
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) uv.set([i / nx, j / ny], (j * (nx + 1) + i) * 2);
  const idx: number[] = [];
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      idx.push(a, a + nx + 1, a + 1, a + 1, a + nx + 1, a + nx + 2);
    }
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("cropUv", new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** Soft radial shadow texture for the contact shadow decal. */
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

const tmpV = new THREE.Vector3();
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();

function angleDeg(from: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3) {
  tmpA.copy(a).sub(from).normalize();
  tmpB.copy(b).sub(from).normalize();
  return (Math.acos(THREE.MathUtils.clamp(tmpA.dot(tmpB), -1, 1)) * 180) / Math.PI;
}

/** Ray from a calibrated camera through a normalized frame pixel. */
function pixelRay(cam: THREE.PerspectiveCamera, u: number, v: number) {
  const dir = new THREE.Vector3(u * 2 - 1, 1 - v * 2, 0.5).unproject(cam).sub(cam.position).normalize();
  return new THREE.Ray(cam.position.clone(), dir);
}

interface Choice {
  clip: AppearanceClipManifest;
  cam: CameraId;
  frame: AppearanceFrame;
  angle: number;
}

function SubjectAppearance({ subjectId, heightM }: { subjectId: string; heightM: number }) {
  const camera = useThree((s) => s.camera);
  const mode = useViewStore((s) => s.subjectRenderMode);
  const xray = useReplayStore((s) => s.xrayEnabled);
  const setStatus = useAppearanceStore((s) => s.setStatus);
  const lastCam = useRef<CameraId | null>(null);

  const parts = useMemo(() => {
    const geom = makeGrid(40, 80);
    const mats = [makeMaterial(false, 1), makeMaterial(false, -1), makeMaterial(true, 1), makeMaterial(true, -1)];
    const meshes = mats.map((m, i) => {
      const mesh = new THREE.Mesh(geom, m);
      mesh.frustumCulled = false;
      mesh.renderOrder = i < 2 ? 2 : 1000;
      mesh.raycast = () => {};
      return mesh;
    });
    meshes[0].name = `appearance-${subjectId}`;
    const shadowTex = makeShadowTexture();
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, toneMapped: false, opacity: 0.55 }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.renderOrder = 1;
    shadow.raycast = () => {};
    return { geom, mats, meshes, shadow, shadowTex };
  }, [subjectId]);
  const { geom, mats, meshes, shadow, shadowTex } = parts;
  const [front, back, xFront, xBack] = meshes;
  useEffect(
    () => () => {
      geom.dispose();
      mats.forEach((m) => m.dispose());
      shadow.geometry.dispose();
      (shadow.material as THREE.Material).dispose();
      shadowTex.dispose();
    },
    [geom, mats, shadow, shadowTex],
  );

  useFrame(() => {
    const r = useReplayStore.getState();
    const v = useViewStore.getState();
    const t = r.currentTime;
    const sample = subjectSample(subjectId, t);
    const P = sample?.position ?? null;
    const hide = (reason: string) => {
      for (const m of meshes) m.visible = false;
      shadow.visible = false;
      setStatus({ subjectId, active: false, cameraId: null, offSourceDeg: null, evidence: null, clip: null, frameK: null, feetHeightM: null, positionEstimated: false, reason });
    };
    if (mode !== "footage") return hide("avatar mode");
    if (!P) return hide("subject not present");
    prefetchAround(subjectId, t, 0.8);

    // Candidate source cameras: those with a usable real crop at this instant.
    const Pv = new THREE.Vector3(P[0], heightM * 0.55, P[2]);
    const cands: Choice[] = [];
    for (const clip of clipsAt(subjectId, t)) {
      for (const cam of Object.keys(clip.cameras) as CameraId[]) {
        const frame = frameAt(clip, cam, t);
        if (!frame?.file || !frame.crop) continue;
        const pos = r.cameraPoses[cam].position;
        cands.push({ clip, cam, frame, angle: angleDeg(Pv, camera.position, tmpV.set(...pos)) });
      }
    }
    if (!cands.length) return hide("no footage crop at this time");

    let pick: Choice | undefined;
    if (v.appearanceSource !== "auto") pick = cands.find((c) => c.cam === v.appearanceSource);
    if (!pick) {
      cands.sort((a, b) => a.angle - b.angle);
      pick = cands[0];
      const keep = cands.find((c) => c.cam === lastCam.current);
      if (keep && keep.angle - pick.angle < SWITCH_MARGIN_DEG) pick = keep; // hysteresis: no flicker at the bisector
    }
    lastCam.current = pick.cam;

    const tex = getTexture(pick.clip.clip, pick.frame.file!);
    const depthTex = pick.frame.depthFile ? getTexture(pick.clip.clip, pick.frame.depthFile, false) : null;
    if (!tex) return hide("loading footage frame");

    // Source camera exactly as calibrated (16:9 sensor, live pose).
    const src = buildCctvCamera(r.cameraPoses[pick.cam]);
    // Vertical plane through P facing the source camera horizontally.
    const n = new THREE.Vector3(src.position.x - P[0], 0, src.position.z - P[2]).normalize();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, new THREE.Vector3(P[0], 0, P[2]));
    const [u0, v0, u1, v1] = pick.frame.crop!;
    const invViewProj = new THREE.Matrix4().multiplyMatrices(src.projectionMatrix, src.matrixWorldInverse).invert();
    const fy = 540 / Math.tan(THREE.MathUtils.degToRad(src.fov) / 2);
    const bc = pick.frame.meanColor ?? [40, 40, 40];
    const shadeAmt = THREE.MathUtils.smoothstep(pick.angle, OBSERVED_DEG, 35);
    for (const m of mats) {
      const u = m.uniforms;
      u.uTex.value = tex;
      u.uDepth.value = depthTex;
      u.uHmaxPx.value = depthTex ? (pick.frame.inflateMaxPx ?? 0) : 0; // flat until the height map loads
      u.uSrcInvViewProj.value.copy(invViewProj);
      u.uSrcPos.value.copy(src.position);
      u.uPlaneN.value.copy(plane.normal);
      u.uPlaneC.value = plane.constant;
      u.uCrop.value.set(u0, v0, u1, v1);
      u.uFy.value = fy;
      (u.uBackColor.value as THREE.Color).setRGB(bc[0] / 255, bc[1] / 255, bc[2] / 255, THREE.SRGBColorSpace);
      u.uShade.value = shadeAmt;
    }
    const evidence: EvidenceClass = pick.angle <= OBSERVED_DEG ? "observed" : "reconstructed";
    front.visible = back.visible = true;
    xFront.visible = xBack.visible = xray;

    // Contact shadow: footprint-sized ellipse on the floor, aligned with the body plane.
    const widthM = Math.max(0.35, (u1 - u0) * 1920 * (src.position.distanceTo(new THREE.Vector3(P[0], 0.9, P[2])) / fy) * 0.7);
    shadow.position.set(P[0], 0.004, P[2]);
    shadow.rotation.set(-Math.PI / 2, 0, Math.atan2(n.x, n.z));
    shadow.scale.set(Math.min(widthM, 1.4), 0.55, 1);
    shadow.visible = true;

    // Floor-contact check: where the source camera's lowest mask pixel meets the plane.
    let feet: number | null = null;
    const mb = pick.frame.maskBottomPx;
    const size = pick.clip.cameras[pick.cam];
    if (mb && size) {
      const h = pixelRay(src, mb[0] / size.width, mb[1] / size.height).intersectPlane(plane, tmpV);
      if (h) feet = Math.round(h.y * 100) / 100;
    }
    setStatus({
      subjectId,
      active: true,
      cameraId: pick.cam,
      offSourceDeg: Math.round(pick.angle),
      evidence,
      clip: pick.clip.clip,
      frameK: pick.frame.k,
      feetHeightM: feet,
      positionEstimated: sample!.status === "estimated",
      reason: null,
    });
  });

  return (
    <>
      {meshes.map((m, i) => (
        <primitive key={i} object={m} />
      ))}
      <primitive object={shadow} />
    </>
  );
}

/** Mounted inside the existing <Canvas> next to SceneActors. */
export function AppearanceLayer() {
  const load = useAppearanceStore((s) => s.load);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <group name="AppearanceLayer">
      {subjects.map((s) => (
        <SubjectAppearance key={s.id} subjectId={s.id} heightM={s.heightM} />
      ))}
    </group>
  );
}

/** True when the real-footage renderer is drawing this subject (SceneActors hides the avatar body). */
export function appearanceActive(subjectId: string) {
  return !!useAppearanceStore.getState().status[subjectId]?.active;
}

