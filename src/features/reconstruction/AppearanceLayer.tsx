/**
 * REAL APPEARANCE renderer: the tracked person drawn with their actual segmented footage.
 *
 * Geometry (per frame, from the master clock only):
 *   P  = subject floor position from the existing fused trajectory (same as tracking / X-ray)
 *   S  = chosen source camera (closest viewing direction to the viewer, or user-forced)
 *   Π  = vertical plane through P whose normal points (horizontally) at S
 *   quad = the 4 rays through the crop's corners, from S, intersected with Π
 * The fragment shader PROJECTIVELY textures the quad: every fragment is projected back into S
 * and looks up the crop at that pixel. Seen from S it reproduces the footage pixel-for-pixel;
 * from elsewhere it is a flat cut-out standing at the person's real location. No surface is
 * invented: there is nothing behind the plane, and pixels hidden from S (e.g. legs behind a
 * table) are simply absent.
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
import { subjectPosition } from "../sentry/SceneActors";
import { clipsAt, frameAt, getTexture, prefetchAround, useAppearanceStore } from "./useAppearanceStore";
import type { AppearanceClipManifest, AppearanceFrame, EvidenceClass } from "./ReconstructionTypes";

/** Viewing within this angle of the source camera counts as the observed (recorded) view. */
const OBSERVED_DEG = 3;
/** Hysteresis for automatic camera switching (degrees). */
const SWITCH_MARGIN_DEG = 6;

const vert = /* glsl */ `
  varying vec3 vWorld;
  #include <common>
  #include <logdepthbuf_pars_vertex>
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
    #include <logdepthbuf_vertex>
  }`;

const frag = /* glsl */ `
  uniform sampler2D uTex;
  uniform mat4 uSrcViewProj;
  uniform vec4 uCrop;      // u0, v0, u1, v1 in the full frame (v down)
  uniform float uXray;     // 0 = real colours, 1 = cyan X-ray silhouette
  uniform vec3 uXrayColor;
  uniform float uEdge;     // projection outline strength (marks it as a re-projection)
  varying vec3 vWorld;
  #include <common>
  #include <logdepthbuf_pars_fragment>
  void main() {
    #include <logdepthbuf_fragment>
    vec4 c = uSrcViewProj * vec4(vWorld, 1.0);
    if (c.w <= 0.0) discard;
    vec2 ndc = c.xy / c.w;
    vec2 fr = vec2((ndc.x + 1.0) * 0.5, (1.0 - ndc.y) * 0.5);            // frame uv, v down
    vec2 cr = (fr - uCrop.xy) / (uCrop.zw - uCrop.xy);                    // crop uv, v down
    if (cr.x < 0.0 || cr.x > 1.0 || cr.y < 0.0 || cr.y > 1.0) discard;
    vec4 t = texture2D(uTex, vec2(cr.x, 1.0 - cr.y));                      // texture flipY
    if (t.a < 0.04) discard;
    if (uXray > 0.5) {
      float lum = dot(t.rgb, vec3(0.299, 0.587, 0.114));
      gl_FragColor = vec4(uXrayColor * (0.55 + 1.2 * lum), 0.75 * t.a);
    } else {
      // thin outline where alpha falls off: shows this is a cut-out, not a solid body
      float edge = smoothstep(0.85, 0.35, t.a) * uEdge;
      gl_FragColor = vec4(mix(t.rgb, uXrayColor, edge), t.a);
    }
    #include <colorspace_fragment>
  }`;

function makeMaterial(xray: boolean) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTex: { value: null },
      uSrcViewProj: { value: new THREE.Matrix4() },
      uCrop: { value: new THREE.Vector4(0, 0, 1, 1) },
      uXray: { value: xray ? 1 : 0 },
      uXrayColor: { value: new THREE.Color("#22d3ee") },
      uEdge: { value: 0.6 },
    },
    vertexShader: vert,
    fragmentShader: frag,
    transparent: true,
    depthWrite: !xray,
    depthTest: true,
    depthFunc: xray ? THREE.GreaterDepth : THREE.LessEqualDepth,
    blending: xray ? THREE.AdditiveBlending : THREE.NormalBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
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

  const { mesh, xrayMesh, geom, mat, xmat } = useMemo(() => {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(12), 3));
    geom.setIndex([0, 1, 2, 0, 2, 3]);
    const mat = makeMaterial(false);
    const xmat = makeMaterial(true);
    const mesh = new THREE.Mesh(geom, mat);
    const xrayMesh = new THREE.Mesh(geom, xmat);
    mesh.frustumCulled = xrayMesh.frustumCulled = false;
    mesh.renderOrder = 2;
    xrayMesh.renderOrder = 1000;
    mesh.name = `appearance-${subjectId}`;
    mesh.raycast = xrayMesh.raycast = () => {};
    return { mesh, xrayMesh, geom, mat, xmat };
  }, [subjectId]);
  useEffect(
    () => () => {
      geom.dispose();
      mat.dispose();
      xmat.dispose();
    },
    [geom, mat, xmat],
  );

  useFrame(() => {
    const r = useReplayStore.getState();
    const v = useViewStore.getState();
    const t = r.currentTime;
    const P = subjectPosition(subjectId, t);
    const hide = (reason: string) => {
      mesh.visible = xrayMesh.visible = false;
      setStatus({ subjectId, active: false, cameraId: null, offSourceDeg: null, evidence: null, clip: null, frameK: null, feetHeightM: null, reason });
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
    if (!tex) return hide("loading footage frame");

    // Source camera exactly as calibrated (16:9 sensor, live pose).
    const src = buildCctvCamera(r.cameraPoses[pick.cam]);
    // Vertical plane through P facing the source camera horizontally.
    const n = new THREE.Vector3(src.position.x - P[0], 0, src.position.z - P[2]).normalize();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, new THREE.Vector3(P[0], 0, P[2]));
    const [u0, v0, u1, v1] = pick.frame.crop!;
    const corners = [
      [u0, v1],
      [u1, v1],
      [u1, v0],
      [u0, v0],
    ];
    const pos = geom.attributes.position.array as Float32Array;
    for (let i = 0; i < 4; i++) {
      const hit = pixelRay(src, corners[i][0], corners[i][1]).intersectPlane(plane, tmpV);
      if (!hit) return hide("source ray parallel to plane");
      pos.set([hit.x, hit.y, hit.z], i * 3);
    }
    geom.attributes.position.needsUpdate = true;
    geom.computeBoundingSphere();

    const viewProj = new THREE.Matrix4().multiplyMatrices(src.projectionMatrix, src.matrixWorldInverse);
    for (const m of [mat, xmat]) {
      m.uniforms.uTex.value = tex;
      m.uniforms.uSrcViewProj.value.copy(viewProj);
      m.uniforms.uCrop.value.set(u0, v0, u1, v1);
    }
    const evidence: EvidenceClass = pick.angle <= OBSERVED_DEG ? "observed" : "reconstructed";
    mat.uniforms.uEdge.value = evidence === "observed" ? 0 : 0.6;
    mesh.visible = true;
    xrayMesh.visible = xray;

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
      reason: null,
    });
  });

  return (
    <>
      <primitive object={mesh} />
      <primitive object={xrayMesh} />
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

