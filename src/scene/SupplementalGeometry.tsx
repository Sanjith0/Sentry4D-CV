import * as THREE from "three";
import { roomConfig } from "../config/roomConfig";
import { useViewStore } from "../store/useViewStore";
import { ceilingPlanes } from "./ceilingClip";

/** Simple floor/wall patches for holes in the scan. Toggle in config/roomConfig.ts. */
export function SupplementalGeometry() {
  const b = useViewStore((s) => s.roomBounds);
  const { floor, walls, color, opacity } = roomConfig.supplemental;
  if (!b || (!floor && !walls)) return null;
  const [w, h, d] = b.size;
  const [cx, , cz] = b.center;
  const y0 = b.min[1];
  const mat = (
    <meshStandardMaterial color={color} transparent={opacity < 1} opacity={opacity} side={THREE.DoubleSide} clippingPlanes={ceilingPlanes} roughness={1} />
  );
  return (
    <group name="SupplementalGeometry">
      {floor && (
        <mesh rotation-x={-Math.PI / 2} position={[cx, y0 - 0.005, cz]} renderOrder={-1}>
          <planeGeometry args={[w, d]} />
          {mat}
        </mesh>
      )}
      {walls && (
        <mesh position={[cx, y0 + h / 2, cz]}>
          <boxGeometry args={[w + 0.02, h, d + 0.02]} />
          <meshStandardMaterial color={color} side={THREE.BackSide} clippingPlanes={ceilingPlanes} roughness={1} />
        </mesh>
      )}
    </group>
  );
}
