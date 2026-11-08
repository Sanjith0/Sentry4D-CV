import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { roomConfig } from "../config/roomConfig";
import { useViewStore } from "../store/useViewStore";
import { setWindowClip } from "./windowWallClip";

/**
 * Clean procedural replacement for the scanned glass wall (between CAM 01 and CAM 04) and the
 * balcony outside it. Purely presentational: room.glb is not modified; the scanned fragments in
 * that region are hidden by a shader discard (windowWallClip.ts) while this is enabled.
 */

/** Fresnel glass: almost invisible face-on, a soft cool sheen at grazing angles. */
function makeGlassMaterial(opacity = 0.07) {
  return new THREE.ShaderMaterial({
    uniforms: { uTint: { value: new THREE.Color("#cfe9f5") }, uBase: { value: opacity } },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV; varying float vY;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vN = normalize(mat3(modelMatrix) * normal);
        vV = normalize(cameraPosition - w.xyz);
        vY = w.y;
        gl_Position = projectionMatrix * viewMatrix * w;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uTint; uniform float uBase;
      varying vec3 vN; varying vec3 vV; varying float vY;
      #include <common>
      #include <logdepthbuf_pars_fragment>
      void main() {
        #include <logdepthbuf_fragment>
        float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 3.0);
        // faint vertical gradient: a touch brighter toward the top, like sky reflection
        float g = 0.85 + 0.15 * smoothstep(0.0, 3.0, vY);
        gl_FragColor = vec4(uTint * g, uBase + 0.32 * f);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}

/** Subtle concrete texture for the balcony floor (procedural, tileable). */
function makeConcreteTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#b8b2a8";
  ctx.fillRect(0, 0, 256, 256);
  const img = ctx.getImageData(0, 0, 256, 256);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rnd() - 0.5) * 18;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  // expansion joints every ~1.1 m (texture repeats per 1.1 m)
  ctx.strokeStyle = "rgba(70,66,60,0.35)";
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, 254, 254);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export function WindowWall() {
  const enabled = useViewStore((s) => s.cleanWindows);
  const w = roomConfig.windowWall;

  useEffect(() => {
    setWindowClip(enabled);
  }, [enabled]);

  const assets = useMemo(() => {
    const glass = makeGlassMaterial(0.07);
    const railGlass = makeGlassMaterial(0.12);
    const frame = new THREE.MeshStandardMaterial({ color: "#2a2e35", roughness: 0.45, metalness: 0.6 });
    const concrete = makeConcreteTexture();
    const floor = new THREE.MeshStandardMaterial({ map: concrete, roughness: 0.95, metalness: 0 });
    return { glass, railGlass, frame, concrete, floor };
  }, []);
  useEffect(
    () => () => {
      Object.values(assets).forEach((a) => (a as { dispose?: () => void }).dispose?.());
    },
    [assets],
  );

  if (!enabled) return null;

  const len = w.zMax - w.zMin;
  const zc = (w.zMin + w.zMax) / 2;
  const balconyDepth = w.glassX - w.balconyOuterX;
  const floorX = (w.glassX + w.balconyOuterX) / 2;
  assets.concrete.repeat.set(len / 1.1, balconyDepth / 1.1);
  const noRay = () => null;

  return (
    <group name="WindowWall">
      {/* Glass pane, floor to ceiling */}
      <mesh position={[w.glassX, w.height / 2, zc]} rotation-y={Math.PI / 2} material={assets.glass} renderOrder={5} raycast={noRay}>
        <planeGeometry args={[len, w.height]} />
      </mesh>
      {/* Mullions */}
      {w.mullionsZ.map((z) => (
        <mesh key={z} position={[w.glassX + 0.02, w.height / 2, z]} material={assets.frame} raycast={noRay}>
          <boxGeometry args={[0.1, w.height, 0.055]} />
        </mesh>
      ))}
      {/* Top and bottom frame rails */}
      <mesh position={[w.glassX + 0.02, 0.04, zc]} material={assets.frame} raycast={noRay}>
        <boxGeometry args={[0.12, 0.08, len]} />
      </mesh>
      <mesh position={[w.glassX + 0.02, w.height - 0.05, zc]} material={assets.frame} raycast={noRay}>
        <boxGeometry args={[0.12, 0.1, len]} />
      </mesh>
      {/* Balcony floor: from just inside the glass (covers the trimmed strip) out to the edge */}
      <mesh position={[floorX + 0.1, -0.006, zc]} rotation-x={-Math.PI / 2} material={assets.floor} receiveShadow raycast={noRay}>
        <planeGeometry args={[balconyDepth + 0.2, len]} />
      </mesh>
      {/* Balcony slab edge */}
      <mesh position={[w.balconyOuterX - 0.05, -0.12, zc]} material={assets.frame} raycast={noRay}>
        <boxGeometry args={[0.1, 0.24, len]} />
      </mesh>
      {/* Glass railing with a slim top rail and posts */}
      <mesh position={[w.balconyOuterX + 0.05, w.railingHeight / 2, zc]} rotation-y={Math.PI / 2} material={assets.railGlass} renderOrder={5} raycast={noRay}>
        <planeGeometry args={[len, w.railingHeight]} />
      </mesh>
      <mesh position={[w.balconyOuterX + 0.05, w.railingHeight, zc]} material={assets.frame} raycast={noRay}>
        <boxGeometry args={[0.05, 0.04, len]} />
      </mesh>
      {w.mullionsZ.filter((_, i) => i % 2 === 0).map((z) => (
        <mesh key={`p${z}`} position={[w.balconyOuterX + 0.05, w.railingHeight / 2, z]} material={assets.frame} raycast={noRay}>
          <boxGeometry args={[0.04, w.railingHeight, 0.04]} />
        </mesh>
      ))}
    </group>
  );
}
