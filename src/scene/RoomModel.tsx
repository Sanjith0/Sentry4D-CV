import { useEffect, useMemo } from "react";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { roomConfig, type RoomConfig } from "../config/roomConfig";
import { useViewStore } from "../store/useViewStore";
import type { RoomBounds, Vec3 } from "../types/security";
import { ceilingPlanes, setCeilingCut } from "./ceilingClip";

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

function prepareMaterial(src: THREE.Material, mode: RoomConfig["materialMode"]): THREE.Material {
  const m = src as THREE.MeshStandardMaterial;
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
  const showCeiling = useViewStore((s) => s.showCeiling);

  const { object, bounds, materials } = useMemo(() => {
    const root = gltf.scene.clone(true);
    const materials: THREE.Material[] = [];
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const prep = (m: THREE.Material) => {
        const n = prepareMaterial(m, config.materialMode);
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
    const raw = new THREE.Box3().setFromObject(inner);

    const outer = new THREE.Group();
    outer.name = "RoomModel";
    outer.add(inner);
    if (autoGround) {
      const c = raw.getCenter(new THREE.Vector3());
      outer.position.set(-c.x, -raw.min.y, -c.z);
    }
    outer.position.add(new THREE.Vector3(...position));
    outer.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(outer);
    return { object: outer, bounds: boundsFromBox(box), materials };
  }, [gltf, config]);

  useEffect(() => {
    onLoaded?.(bounds);
    const [w, h, d] = bounds.size;
    console.info(`[Sentry3D] room loaded: ${w.toFixed(2)} × ${h.toFixed(2)} × ${d.toFixed(2)} m (W×H×D)`);
  }, [bounds, onLoaded]);

  useEffect(() => {
    setCeilingCut(showCeiling, bounds.max[1] - config.ceilingCutOffset);
  }, [showCeiling, bounds, config.ceilingCutOffset]);

  useEffect(() => () => materials.forEach((m) => m.dispose()), [materials]);

  return <primitive object={object} />;
}
