import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useReplayStore } from "../../store/useReplayStore";
import type { CameraId } from "../../types/security";
import { formatClock } from "../../lib/format";
import { bakeSubjectPose } from "../reconstruction/avatarBake";
import { subjectSample } from "../sentry/SceneActors";
import { recordingSources } from "./recordingSources";
import { demoLook } from "./demoLook";
import { FORECAST_HORIZON, forecastAt, ghostAt, GHOST_TIMES, nowAt, RAY_CLEAR, raysAt, stampsAt } from "./demo2Script";
import { CAMERA_ORDER, DEMO_SUBJECT } from "./demoScript";
import { useDemoStore } from "./useDemoStore";

const CYAN = new THREE.Color("#35e0ff");
const AMBER = new THREE.Color("#ffc233");
const UP = new THREE.Vector3(0, 1, 0);
/** Above the floor (m): over the tracked path's own line. */
const LIFT = 0.05;
/** The forecast arrow starts this far from his feet (outside the scene's ring on him). */
const ARROW_FROM = 0.5;
const GHOST_RADIUS = 0.3;
/** The exit pin's beam (m). */
const PIN_HEIGHT = 1.6;
/** The predicted route stops this far short of the exit pin (m). */
const ROUTE_SHORT = 0.42;

/** A body of the timeline: its time stands this high over the floor (m), this wide and tall. */
const STAMP_Y = 2.14;
/** The NOW stamp floats this much higher (m), clear of the row of time stamps he walks along. */
const NOW_LIFT = 0.42;
const STAMP_SIZE = [0.84, 0.3] as const;
/** ...and the stamp on him himself. */
const NOW_SIZE = [0.62, 0.3] as const;
/** Their figures: the face the captions are set in (shipped with the app, see index.css). */
const STAMP_FONT = '600 50px "Inter Variable", "Inter", ui-sans-serif, system-ui, -apple-system, sans-serif';

const ghostVertex = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vY;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalMatrix * normal;
    vView = -mv.xyz;
    vY = position.y;
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }
`;
/** A body of the timeline: a hologram, bright at its outline, scan lines running up it. */
const ghostFragment = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
  uniform vec3 uColor;
  uniform float uAlpha;
  uniform float uTime;
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vY;
  void main() {
    #include <logdepthbuf_fragment>
    float rim = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 1.5);
    float lines = 0.8 + 0.2 * sin(vY * 150.0 - uTime * 7.0);
    gl_FragColor = vec4(uColor * (0.7 + 1.2 * rim), uAlpha * (0.24 + 0.76 * rim) * lines);
  }
`;
const ghostDepthFragment = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
  void main() {
    #include <logdepthbuf_fragment>
    gl_FragColor = vec4(0.0);
  }
`;

/** One body of the timeline: its own depth first (so that it is one shape, not its far side through its near one), then its glow, and its time. */
interface Ghost {
  group: THREE.Group;
  uniforms: { uColor: THREE.IUniform; uAlpha: THREE.IUniform; uTime: THREE.IUniform };
  stamp: THREE.SpriteMaterial;
  /** Where it stands (floor point). */
  at: readonly [number, number, number];
  dispose: () => void;
}

/** While he is himself this close to one of the timeline's bodies (m) it is left out; from the second distance on it is whole. */
const GHOST_CLEAR = [0.45, 0.9] as const;

/** A time of the timeline as a pill: dark with light figures; the one on him himself light with dark letters. */
function stampTexture(label: string, now = false) {
  const size = now ? NOW_SIZE : STAMP_SIZE;
  const c = document.createElement("canvas");
  c.height = 96;
  c.width = Math.round((c.height * size[0]) / size[1]);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const draw = () => {
    const g = c.getContext("2d")!;
    const inset = 5;
    const q = c.height / 2 - inset;
    g.clearRect(0, 0, c.width, c.height);
    g.beginPath();
    g.arc(inset + q, c.height / 2, q, Math.PI / 2, (Math.PI * 3) / 2);
    g.arc(c.width - inset - q, c.height / 2, q, -Math.PI / 2, Math.PI / 2);
    g.closePath();
    g.fillStyle = now ? "rgba(248,250,252,0.96)" : "rgba(4,7,12,0.8)";
    g.fill();
    if (!now) {
      g.strokeStyle = "rgba(255,255,255,0.26)";
      g.lineWidth = 2.5;
      g.stroke();
    }
    g.fillStyle = now ? "#04070c" : "#f8fafc";
    g.font = STAMP_FONT;
    g.textAlign = "center";
    g.textBaseline = "middle";
    const spacing = "letterSpacing" in g ? (now ? 5 : 1) : 0;
    if (spacing) g.letterSpacing = `${spacing}px`;
    g.fillText(label, c.width / 2 + spacing / 2, c.height / 2 + 3);
    tex.needsUpdate = true;
  };
  draw();
  // (made behind the loading card, possibly before the face has arrived: drawn again when it has)
  if (document.fonts && !document.fonts.check(STAMP_FONT)) document.fonts.load(STAMP_FONT).then(draw, () => {});
  return tex;
}

/** The subject's body (and what he carries) as it stood at incident time t; null until his model is there. */
function makeGhost(t: number): Ghost | null {
  const at = subjectSample(DEMO_SUBJECT, t);
  const geometries = at ? bakeSubjectPose(DEMO_SUBJECT, t) : null;
  if (!at || !geometries) return null;
  const uniforms = { uColor: { value: CYAN }, uAlpha: { value: 0 }, uTime: { value: 0 } };
  const depth = new THREE.ShaderMaterial({ vertexShader: ghostVertex, fragmentShader: ghostDepthFragment, colorWrite: false });
  const glow = new THREE.ShaderMaterial({ vertexShader: ghostVertex, fragmentShader: ghostFragment, uniforms, transparent: true, depthWrite: false, depthFunc: THREE.LessEqualDepth, toneMapped: false });
  const group = new THREE.Group();
  group.visible = false;
  for (const g of geometries) {
    const first = new THREE.Mesh(g, depth);
    first.renderOrder = 4;
    const second = new THREE.Mesh(g, glow);
    second.renderOrder = 5;
    first.frustumCulled = second.frustumCulled = false;
    group.add(first, second);
  }
  const texture = stampTexture(formatClock(t).slice(1, -1));
  const stamp = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, opacity: 0 });
  const sprite = new THREE.Sprite(stamp);
  sprite.position.set(at.position[0], at.position[1] + STAMP_Y, at.position[2]);
  sprite.scale.set(STAMP_SIZE[0], STAMP_SIZE[1], 1);
  sprite.renderOrder = 6;
  group.add(sprite);
  return {
    group,
    uniforms,
    stamp,
    at: [at.position[0], at.position[1], at.position[2]],
    dispose: () => {
      for (const g of geometries) g.dispose();
      depth.dispose();
      glow.dispose();
      texture.dispose();
      stamp.dispose();
    },
  };
}

const beamVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
/**
 * A sight line's tube (a unit one, stretched to the line's length): as thick, everywhere along it, as its
 * distance from the viewpoint there asks for, so it is one thin line of even width on the screen from a camera
 * across the room to him, however near the viewpoint it passes.
 */
const rayVertex = /* glsl */ `
  uniform float uWidth;
  varying vec2 vUv;
  varying float vDepth;
  void main() {
    vUv = uv;
    vDepth = -(modelViewMatrix * vec4(0.0, position.y, 0.0, 1.0)).z;
    float radius = uWidth * max(vDepth, 0.05);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position.x * radius, position.y, position.z * radius, 1.0);
  }
`;
/** A sight line: pulses run along it from the camera to the subject. */
const rayFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uAlpha;
  uniform float uLen;
  uniform float uTime;
  uniform vec2 uNear;
  varying vec2 vUv;
  varying float vDepth;
  void main() {
    float d = fract(vUv.y * uLen / 0.55 - uTime * 2.6);
    float pulse = smoothstep(0.0, 0.1, d) * (1.0 - smoothstep(0.42, 0.6, d));
    // (clear of the camera's own marker, and gone where it passes right before the viewpoint)
    float a = uAlpha * (0.22 + 0.78 * pulse) * smoothstep(0.0, 0.35 / max(uLen, 0.001), vUv.y) * smoothstep(uNear.x, uNear.y, vDepth);
    gl_FragColor = vec4(uColor, a);
  }
`;
/** The exit pin's beam: bright at the floor, fading upwards. */
const pinFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uAlpha;
  uniform float uTime;
  varying vec2 vUv;
  void main() {
    float rise = fract(vUv.y * 3.0 - uTime * 0.9);
    float a = uAlpha * (1.0 - vUv.y) * (0.55 + 0.45 * smoothstep(0.0, 0.2, rise) * (1.0 - smoothstep(0.5, 0.9, rise)));
    gl_FragColor = vec4(uColor, a);
  }
`;
const floorVertex = /* glsl */ `
  varying vec2 vAt;
  void main() {
    vAt = position.xz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
/**
 * The forecast on the floor, in metres from his feet (x ahead of him): a lane of chevrons running ahead, an
 * arrow head, and a ring where he will stand FORECAST_HORIZON seconds from now at this heading and speed.
 */
const arrowFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uAlpha;
  uniform float uLen;
  uniform float uTime;
  varying vec2 vAt;
  void main() {
    float x = vAt.x;
    float z = abs(vAt.y);
    float tip = uLen - ${GHOST_RADIUS.toFixed(2)};
    float neck = tip - 0.42;
    float lane = step(x, neck) * (1.0 - smoothstep(0.13, 0.16, z)) * smoothstep(${ARROW_FROM.toFixed(2)}, ${(ARROW_FROM + 0.55).toFixed(2)}, x);
    float c = fract((x + z * 1.1) / 0.4 - uTime * 1.8);
    float chevron = smoothstep(0.0, 0.12, c) * (1.0 - smoothstep(0.45, 0.62, c));
    float h = (x - neck) / 0.42;
    float head = step(0.0, h) * step(h, 1.0) * (1.0 - smoothstep(-0.025, 0.0, z - 0.34 * (1.0 - h)));
    float dr = distance(vAt, vec2(uLen, 0.0));
    float ring = max(1.0 - smoothstep(0.0, 0.028, abs(dr - ${GHOST_RADIUS.toFixed(2)})), 0.2 * (1.0 - smoothstep(${(GHOST_RADIUS - 0.03).toFixed(2)}, ${GHOST_RADIUS.toFixed(2)}, dr)));
    float a = max(max(lane * (0.22 + 0.78 * chevron), head), ring);
    gl_FragColor = vec4(uColor, a * uAlpha);
  }
`;
/** The predicted route: dashes running from the forecast's ring to the exit (x: metres along it). */
const routeFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uAlpha;
  uniform float uLen;
  uniform float uTime;
  varying vec2 vAt;
  void main() {
    float x = vAt.x * uLen;
    float z = abs(vAt.y);
    float d = fract(x / 0.34 - uTime * 2.2);
    float dash = smoothstep(0.0, 0.08, d) * (1.0 - smoothstep(0.5, 0.58, d));
    float line = 1.0 - smoothstep(0.035, 0.055, z);
    float ends = smoothstep(0.0, 0.2, x) * (1.0 - smoothstep(uLen - 0.15, uLen, x));
    gl_FragColor = vec4(uColor, uAlpha * line * dash * ends);
  }
`;
/** Rings spreading on the floor round the exit pin. */
const ringsFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uAlpha;
  uniform float uTime;
  varying vec2 vAt;
  void main() {
    float d = length(vAt);
    float core = 1.0 - smoothstep(0.1, 0.13, d);
    float fixedRing = 1.0 - smoothstep(0.0, 0.025, abs(d - 0.32));
    float w = fract(uTime * 0.9);
    float wave = (1.0 - smoothstep(0.0, 0.04, abs(d - (0.32 + 0.6 * w)))) * (1.0 - w);
    gl_FragColor = vec4(uColor, max(max(core, fixedRing), wave) * uAlpha);
  }
`;

/** Shared by the one set of layers there is; written every frame of the walkthrough. */
/** A sight line's radius per metre from the viewpoint (about four pixels wide), and the metres before the viewpoint over which it comes in. */
const RAY_WIDTH = 0.0032;
const RAY_NEAR = new THREE.Vector2(0.8, 2.4);
const rayUniforms = CAMERA_ORDER.map(() => ({
  uColor: { value: CYAN },
  uAlpha: { value: 0 },
  uTime: { value: 0 },
  uLen: { value: 1 },
  uWidth: { value: RAY_WIDTH },
  uNear: { value: RAY_NEAR },
}));
const arrowUniforms = { uColor: { value: AMBER }, uAlpha: { value: 0 }, uTime: { value: 0 }, uLen: { value: 1 } };
const routeUniforms = { uColor: { value: AMBER }, uAlpha: { value: 0 }, uTime: { value: 0 }, uLen: { value: 1 } };
const pinUniforms = { uColor: { value: AMBER }, uAlpha: { value: 0 }, uTime: { value: 0 } };
const ringsUniforms = { uColor: { value: AMBER }, uAlpha: { value: 0 }, uTime: { value: 0 } };

function shader(fragmentShader: string, vertexShader: string, uniforms: Record<string, THREE.IUniform>) {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
}

/** A flat sheet on the floor: x from x0 to x1, half-width w (metres, its own axes). */
function sheet(x0: number, x1: number, w: number) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([x0, 0, -w, x1, 0, -w, x1, 0, w, x0, 0, w], 3));
  g.setIndex([0, 2, 1, 0, 3, 2]);
  return g;
}

const a = new THREE.Vector3();
const b = new THREE.Vector3();
const dir = new THREE.Vector3();
const point = new THREE.Vector3();

/** His position averaged over three samples ending `back` seconds before t (the track's jitter evened out). */
function meanPosition(t: number, back: number, out: THREE.Vector3): boolean {
  out.set(0, 0, 0);
  for (let i = 0; i < 3; i++) {
    const st = subjectSample(DEMO_SUBJECT, t - back - i * 0.1);
    if (!st) return false;
    out.x += st.position[0] / 3;
    out.y += st.position[1] / 3;
    out.z += st.position[2] / 3;
  }
  return true;
}

function Layers() {
  const rays = useRef<(THREE.Mesh | null)[]>([]);
  const arrow = useRef<THREE.Mesh>(null);
  const pin = useRef<THREE.Group>(null);
  const route = useRef<THREE.Mesh>(null);
  const timeline = useRef<THREE.Group>(null);
  const now = useRef<THREE.Sprite>(null);
  const ghosts = useRef<(Ghost | null)[]>(GHOST_TIMES.map(() => null));
  useEffect(() => {
    const list = ghosts.current;
    return () => {
      list.forEach((g, i) => {
        g?.group.removeFromParent();
        g?.dispose();
        list[i] = null;
      });
    };
  }, []);

  const made = useMemo(() => {
    const tube = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
    return {
      tube,
      arrowSheet: sheet(0, 6, 0.75),
      ringSheet: sheet(-1, 1, 1),
      routeSheet: sheet(0, 1, 0.08),
      rayMaterials: rayUniforms.map((u) => shader(rayFragment, rayVertex, u)),
      arrowMaterial: shader(arrowFragment, floorVertex, arrowUniforms),
      pinMaterial: shader(pinFragment, beamVertex, pinUniforms),
      ringsMaterial: shader(ringsFragment, floorVertex, ringsUniforms),
      routeMaterial: shader(routeFragment, floorVertex, routeUniforms),
      nowMaterial: new THREE.SpriteMaterial({ map: stampTexture("NOW", true), transparent: true, depthTest: false, depthWrite: false, toneMapped: false, opacity: 0 }),
    };
  }, []);
  useEffect(
    () => () => {
      made.tube.dispose();
      made.arrowSheet.dispose();
      made.ringSheet.dispose();
      made.routeSheet.dispose();
      for (const m of [...made.rayMaterials, made.arrowMaterial, made.pinMaterial, made.ringsMaterial, made.routeMaterial]) m.dispose();
      made.nowMaterial.map?.dispose();
      made.nowMaterial.dispose();
    },
    [made],
  );

  useFrame(({ camera, size }) => {
    const e = demoLook.applied;
    const f = demoLook.forecast;
    const s = useDemoStore.getState();
    const live = s.phase === "running" || s.phase === "ended";
    const replay = useReplayStore.getState();
    const T = replay.currentTime;
    const here = live && !demoLook.hideSubject ? subjectSample(DEMO_SUBJECT, T) : null;

    // ---- the timeline: his body at moments already played, one after the other
    // (made one a frame, behind the loading card, as soon as his model is there)
    const missing = ghosts.current.findIndex((g) => g === null);
    if (missing >= 0 && timeline.current) {
      const made = makeGhost(GHOST_TIMES[missing]);
      if (made) {
        ghosts.current[missing] = made;
        timeline.current.add(made.group);
      }
    }
    const stamps = stampsAt(e);
    ghosts.current.forEach((g, i) => {
      if (!g) return;
      // (not where he is himself right now: he walks out along the line he came in on)
      const clear = here ? THREE.MathUtils.smoothstep(Math.hypot(here.position[0] - g.at[0], here.position[2] - g.at[2]), GHOST_CLEAR[0], GHOST_CLEAR[1]) : 1;
      const alpha = live && T >= GHOST_TIMES[i] ? ghostAt(e, i) * clear : 0;
      g.group.visible = alpha > 0.004;
      g.uniforms.uAlpha.value = alpha;
      g.uniforms.uTime.value = e;
      g.stamp.opacity = alpha * stamps;
    });
    if (now.current) {
      const alpha = here ? nowAt(e) * stamps : 0;
      now.current.visible = alpha > 0.004;
      now.current.material.opacity = alpha;
      if (here) now.current.position.set(here.position[0], here.position[1] + STAMP_Y + NOW_LIFT, here.position[2]);
    }

    // ---- sight lines: from every camera whose recording has him now, to his chest
    const rayGain = here ? raysAt(e) : 0;
    const sources = rayGain > 0 ? recordingSources(T) : null;
    CAMERA_ORDER.forEach((id: CameraId, i) => {
      const mesh = rays.current[i];
      if (!mesh) return;
      const gain = rayGain * (sources?.[id] ?? 0);
      mesh.visible = gain > 0.004 && !!here;
      if (!mesh.visible || !here) return;
      const from = replay.cameraPoses[id].position;
      a.set(from[0], from[1], from[2]);
      b.set(here.position[0], here.position[1] + 1.05, here.position[2]);
      // (not the line of the camera the viewport looks along: it would come in from beside the lens, right across the picture)
      const off = point.subVectors(camera.position, b).angleTo(dir.subVectors(a, b)) * THREE.MathUtils.RAD2DEG;
      const alpha = gain * THREE.MathUtils.smoothstep(off, RAY_CLEAR[0], RAY_CLEAR[1]);
      mesh.visible = alpha > 0.004;
      if (!mesh.visible) return;
      dir.subVectors(b, a);
      const len = dir.length();
      mesh.position.copy(a).addScaledVector(dir, 0.5);
      mesh.quaternion.setFromUnitVectors(UP, dir.divideScalar(len));
      // (its thickness is the shader's: see rayVertex)
      mesh.scale.set(1, len, 1);
      const u = rayUniforms[i];
      u.uAlpha.value = 0.85 * alpha;
      u.uLen.value = len;
      u.uTime.value = e;
    });

    // ---- forecast: where his heading and speed over the last half second take him
    const gain = here ? forecastAt(e) : { arrow: 0, exit: 0 };
    let speed = 0;
    let heading = 0;
    f.exitOn = false;
    if (here && (gain.arrow > 0 || gain.exit > 0) && meanPosition(T, 0, a) && meanPosition(T, 0.5, b)) {
      dir.subVectors(a, b).setY(0).divideScalar(0.5);
      speed = dir.length();
      heading = Math.atan2(dir.x, dir.z);
    }
    const moving = THREE.MathUtils.smoothstep(speed, 0.45, 0.9);
    const arrowAlpha = gain.arrow * moving;
    const reachNow = speed * FORECAST_HORIZON;
    if (arrow.current) {
      arrow.current.visible = arrowAlpha > 0.004 && !!here;
      if (arrow.current.visible && here) {
        const reach = speed * FORECAST_HORIZON;
        arrow.current.position.set(here.position[0], here.position[1] + LIFT, here.position[2]);
        arrow.current.rotation.set(0, Math.atan2(-dir.z, dir.x), 0);
        arrowUniforms.uAlpha.value = 0.95 * arrowAlpha;
        arrowUniforms.uLen.value = reach;
        arrowUniforms.uTime.value = e;
      }
    }

    // ---- exit: the door he came in through, and the time to it at this speed
    const exitAlpha = gain.exit;
    if (pin.current) {
      pin.current.visible = exitAlpha > 0.004 && !!here && demoLook.pathInfo.length > 0;
      if (pin.current.visible && here) {
        const [x, y, z] = demoLook.pathInfo.entry;
        pin.current.position.set(x, y + LIFT, z);
        pinUniforms.uAlpha.value = 0.9 * exitAlpha;
        pinUniforms.uTime.value = e;
        ringsUniforms.uAlpha.value = 0.95 * exitAlpha;
        ringsUniforms.uTime.value = e;
        // (one figure on the pin: the seconds to it at the speed he walks now; none while he stands)
        const metres = Math.hypot(here.position[0] - x, here.position[2] - z);
        point.set(x, y + PIN_HEIGHT * 0.86, z).project(camera);
        f.exitOn = point.z < 1;
        f.ex = (0.5 + point.x / 2) * size.width;
        f.ey = (0.5 - point.y / 2) * size.height;
        f.exitText = speed > 0.45 ? `EXIT IN ${(metres / speed).toFixed(1)}s` : "EXIT";
        f.exitAlpha = exitAlpha;
      }
    }

    // ---- the predicted route: from where the forecast puts him, straight to the exit
    if (route.current) {
      const [x, y, z] = demoLook.pathInfo.entry;
      let shown = false;
      if (here && exitAlpha > 0.004 && demoLook.pathInfo.length > 0) {
        const from = arrowAlpha > 0.004 ? reachNow + GHOST_RADIUS : ARROW_FROM;
        a.set(here.position[0] + Math.sin(heading) * from, y + LIFT, here.position[2] + Math.cos(heading) * from);
        b.set(x, y + LIFT, z);
        dir.subVectors(b, a);
        const len = dir.length() - ROUTE_SHORT;
        if (len > 0.3) {
          shown = true;
          route.current.position.copy(a);
          route.current.rotation.set(0, Math.atan2(-dir.z, dir.x), 0);
          route.current.scale.set(len, 1, 1);
          routeUniforms.uAlpha.value = 0.9 * exitAlpha * THREE.MathUtils.smoothstep(len, 0.3, 0.9);
          routeUniforms.uLen.value = len;
          routeUniforms.uTime.value = e;
        }
      }
      route.current.visible = shown;
    }
  });

  return (
    <group raycast={() => null}>
      <group ref={timeline} />
      <sprite ref={now} material={made.nowMaterial} scale={[NOW_SIZE[0], NOW_SIZE[1], 1]} visible={false} renderOrder={7} />
      {CAMERA_ORDER.map((id, i) => (
        <mesh
          key={id}
          ref={(el) => {
            rays.current[i] = el;
          }}
          geometry={made.tube}
          material={made.rayMaterials[i]}
          visible={false}
          frustumCulled={false}
          renderOrder={3}
        />
      ))}
      <mesh ref={arrow} geometry={made.arrowSheet} material={made.arrowMaterial} visible={false} frustumCulled={false} renderOrder={3} />
      <mesh ref={route} geometry={made.routeSheet} material={made.routeMaterial} visible={false} frustumCulled={false} renderOrder={3} />
      <group ref={pin} visible={false}>
        <mesh geometry={made.ringSheet} material={made.ringsMaterial} frustumCulled={false} renderOrder={3} />
        <mesh geometry={made.tube} material={made.pinMaterial} position={[0, PIN_HEIGHT / 2, 0]} scale={[0.035, PIN_HEIGHT, 0.035]} frustumCulled={false} renderOrder={3} />
      </group>
    </group>
  );
}

/**
 * DEMO 2's own layers in the scene, all from the fused track at the shown time: a sight line from every
 * camera whose recording has the subject, a forecast arrow on the floor ahead of him (heading and speed over
 * the last half second, carried FORECAST_HORIZON seconds on), the exit (the door he came in through) with the
 * distance and the time to it at that speed, and a straight dashed route from the forecast to that exit. Nothing here reads a later moment of the track.
 */
export function Demo2Scene() {
  const on = useDemoStore((s) => s.phase !== "idle" && s.variant === 2);
  return on ? <Layers /> : null;
}
