import { useEffect, useMemo } from "react";
import { Grid } from "@react-three/drei";
import * as THREE from "three";
import { roomConfig } from "../config/roomConfig";
import { useViewStore } from "../store/useViewStore";
import type { RoomBounds } from "../types/security";
import { ceilingPlanes, setCeilingCut } from "./ceilingClip";

/** Fallback room used when room.glb is missing or fails to load. Floor at y = 0. */
export function ProceduralRoom({ width = roomConfig.placeholder.width, height = roomConfig.placeholder.height, depth = roomConfig.placeholder.depth }) {
  const setRoomBounds = useViewStore((s) => s.setRoomBounds);
  const showCeiling = useViewStore((s) => s.showCeiling);

  const bounds = useMemo<RoomBounds>(
    () => ({
      min: [-width / 2, 0, -depth / 2],
      max: [width / 2, height, depth / 2],
      size: [width, height, depth],
      center: [0, height / 2, 0],
    }),
    [width, height, depth],
  );

  useEffect(() => setRoomBounds(bounds), [bounds, setRoomBounds]);
  useEffect(() => setCeilingCut(showCeiling, height - 0.05), [showCeiling, height]);

  return (
    <group name="ProceduralRoom">
      <mesh position={[0, height / 2, 0]}>
        <boxGeometry args={[width, height, depth]} />
        <meshStandardMaterial color="#1a2230" side={THREE.BackSide} roughness={0.95} clippingPlanes={ceilingPlanes} />
      </mesh>
      <Grid
        position={[0, 0.002, 0]}
        args={[width, depth]}
        cellSize={0.5}
        sectionSize={1}
        cellColor="#1f3b4d"
        sectionColor="#22d3ee"
        sectionThickness={0.8}
        fadeDistance={40}
        infiniteGrid={false}
      />
    </group>
  );
}
