import { useEffect, useMemo, useState } from "react";
import { useGLTF } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { roomConfig, type RoomConfig } from "../config/roomConfig";
import { useViewStore } from "../store/useViewStore";
import { useReplayStore } from "../store/useReplayStore";
import type { RoomBounds, Vec3 } from "../types/security";
import { ceilingPlanes, setCeilingCut } from "./ceilingClip";
import { applyWindowClip } from "./windowWallClip";
import { applyBuildClip, finishBuild, makeBuildScanPlane, makeBuildWireMaterial, primeBuild, setWireMode, shouldPlayBuild, stepBuild } from "./buildIntro";

const DEG = Math.PI / 180;

export function boundsFromBox(box: THREE.Box3): RoomBounds {
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  return {
    min: box.min.toArray() as Vec3,
    max: box.max.toArray() as Vec3,
    size: size.toArray() as Vec3,
    center: center.toArray() as Vec3,
  };
}

/** Sharper sampling at grazing angles. Textures are shared with the loader cache; this only changes sampler state. */
function tuneTexture(tex: THREE.Texture | null, anisotropy: number) {
  if (!tex) return;
  tex.anisotropy = anisotropy;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
}

function prepareMaterial(src: THREE.Material, mode: RoomConfig["materialMode"], anisotropy: number): THREE.Material {
  const m = src as THREE.MeshStandardMaterial;
  tuneTexture(m.map, anisotropy);
  if (mode === "unlit") {
    return new THREE.MeshBasicMaterial({
      map: m.map ?? null,
      color: m.map ? 0xffffff : m.color,
      side: THREE.FrontSide,
      toneMapped: false,
      clippingPlanes: ceilingPlanes,
      name: `${m.name}-unlit`,
    });
  }
  const c = m.clone();
  // glTF defaults metalness to 1 when unspecified, which renders scans black without an env map.
  c.metalness = 0;
  c.roughness = 1;
  c.clippingPlanes = ceilingPlanes;
  return c;
}

interface RoomModelProps {
  url?: string;
  config?: RoomConfig;
  onLoaded?: (bounds: RoomBounds) => void;
}

/**
 * Loads the Polycam scan, preserving textures and real-world scale.
 * The source GLB/cache is never mutated: we clone the scene graph and materials.
 */
export function RoomModel({ url = roomConfig.url, config = roomConfig, onLoaded }: RoomModelProps) {
  const gltf = useGLTF(url);
  const gl = useThree((s) => s.gl);
  const anisotropy =
    config.rendering.anisotropy === "max" ? gl.capabilities.getMaxAnisotropy() : config.rendering.anisotropy;
  // Ceiling is always shown when looking through a CCTV camera (they're ceiling-mounted).
  const ceilingToggle = useViewStore((s) => s.showCeiling);
  const cctvView = useReplayStore((s) => s.cameraMode === "cctv");
  const showCeiling = ceilingToggle || cctvView;

  const { object, wire, bounds, sweep, materials } = useMemo(() => {
    const root = gltf.scene.clone(true);
    const materials: THREE.Material[] = [];
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const prep = (m: THREE.Material) => {
        const n = prepareMaterial(m, config.materialMode, anisotropy);
        applyWindowClip(n);
        applyBuildClip(n);
        materials.push(n);
        return n;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(prep) : prep(mesh.material);
    });

    const { scale, rotationDeg, position, autoGround } = config.transform;
    const inner = new THREE.Group();
    inner.add(root);
    if (Array.isArray(scale)) inner.scale.set(...scale);
    else inner.scale.setScalar(scale);
    inner.rotation.set(rotationDeg[0] * DEG, rotationDeg[1] * DEG, rotationDeg[2] * DEG);
    inner.updateMatrixWorld(true);
    const scanBox = new THREE.Box3().setFromObject(inner);
    // Real room box (excludes geometry seen through windows), transformed like the model.
    const roomBox = config.interior
      ? new THREE.Box3(new THREE.Vector3(...config.interior.min), new THREE.Vector3(...config.interior.max)).applyMatrix4(inner.matrixWorld)
      : scanBox.clone();

    const outer = new THREE.Group();
    outer.name = "RoomModel";
    outer.add(inner);
    const offset = new THREE.Vector3();
    if (autoGround) {
      const c = roomBox.getCenter(new THREE.Vector3());
      offset.set(-c.x, -roomBox.min.y, -c.z);
    }
    offset.add(new THREE.Vector3(...position));
    outer.position.copy(offset);
    outer.updateMatrixWorld(true);
    const box = roomBox.clone().translate(offset);
    const scan = boundsFromBox(scanBox.clone().translate(offset));
    console.info(`[Sentry3D] full scan extent incl. outside geometry: ${scan.size.map((v) => v.toFixed(2)).join(" × ")} m`);
    // Wireframe twin for the page-load build reveal (shares geometry; only mounted while it plays).
    const wireMaterial = makeBuildWireMaterial(ceilingPlanes);
    const wire = outer.clone(true);
    wire.name = "RoomModelBuildWire";
    wire.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.material = wireMaterial;
        mesh.raycast = () => null;
      }
    });
    materials.push(wireMaterial);
    // The scan plane rides with the wireframe (world-positioned in its shader), so add it to the wire group.
    const scanPlane = makeBuildScanPlane(box.max.x - box.min.x + 0.6, box.max.z - box.min.z + 0.6, new THREE.Vector3((box.min.x + box.max.x) / 2, 0, (box.min.z + box.max.z) / 2));
    const planeHolder = new THREE.Group();
    planeHolder.add(scanPlane);
    wire.add(planeHolder);
    scanPlane.position.sub(wire.position); // wire group is offset like the room; keep the plane centred in world space
    materials.push(scanPlane.material as THREE.Material);
    return { object: outer, wire, bounds: boundsFromBox(box), sweep: [Math.min(box.min.y, scan.min[1]) - 0.05, box.max.y + 0.25] as const, materials };
  }, [gltf, config, anisotropy]);

  const wireframe = useViewStore((s) => s.wireframe);
  const [building, setBuilding] = useState(() => shouldPlayBuild());
  useEffect(() => setWireMode(wireframe), [wireframe]);
  useEffect(() => {
    if (building) primeBuild(sweep[0]);
  }, [building, sweep]);
  useEffect(() => () => finishBuild(), []);
  useFrame((state) => {
    if (!building) return;
    if (!stepBuild(state.clock.elapsedTime, sweep[0], sweep[1])) setBuilding(false);
  });

  useEffect(() => {
    onLoaded?.(bounds);
    const [w, h, d] = bounds.size;
    console.info(`[Sentry3D] room interior: ${w.toFixed(2)} × ${h.toFixed(2)} × ${d.toFixed(2)} m (W×H×D)`);
  }, [bounds, onLoaded]);

  useEffect(() => {
    setCeilingCut(showCeiling, bounds.max[1] - config.ceilingCutOffset);
  }, [showCeiling, bounds, config.ceilingCutOffset]);

  useEffect(() => () => materials.forEach((m) => m.dispose()), [materials]);

  return (
    <>
      <primitive object={object} />
      {(building || wireframe) && <primitive object={wire} />}
    </>
  );
}
