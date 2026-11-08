import { useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { securityDevices, type DeviceConfig } from "../config/devices";
import { useDeviceStore } from "../features/devices/useDeviceStore";
import { useReplayStore } from "../store/useReplayStore";
import type { Vec3 } from "../types/security";

const CYAN = new THREE.Color("#22d3ee");
const DIM = new THREE.Color("#64748b");

function DeviceMarker({ device, position }: { device: DeviceConfig; position: Vec3 }) {
  const ring = useRef<THREE.MeshBasicMaterial>(null);
  const [hovered, setHovered] = useState(false);
  const selected = useReplayStore((s) => s.selectedEntity?.id === device.id);
  const setSelectedEntity = useReplayStore((s) => s.setSelectedEntity);

  const active = selected || hovered;
  const color = active ? CYAN : DIM;

  useFrame(({ clock }) => {
    if (!ring.current) return;
    ring.current.opacity = active ? 0.6 + 0.4 * Math.sin(clock.elapsedTime * 5) : 0.5;
  });

  return (
    <group position={position}>
      <group
        onClick={(e) => {
          e.stopPropagation();
          setSelectedEntity({ id: device.id, label: device.name, kind: "object", details: { type: "Device" } });
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHovered(true);
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          setHovered(false);
          document.body.style.cursor = "";
        }}
      >
        <mesh>
          <sphereGeometry args={[0.07, 20, 20]} />
          <meshStandardMaterial color="#020617" emissive={color} emissiveIntensity={active ? 1.2 : 0.3} />
        </mesh>
        <mesh rotation-x={Math.PI / 2}>
          <ringGeometry args={[0.1, 0.13, 24]} />
          <meshBasicMaterial ref={ring} color={active ? "#22d3ee" : "#64748b"} transparent side={THREE.DoubleSide} toneMapped={false} />
        </mesh>
        {/* Larger invisible hit target */}
        <mesh>
          <sphereGeometry args={[0.18, 8, 8]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      </group>
      <Html position={[0, 0.2, 0]} center zIndexRange={[20, 0]} style={{ pointerEvents: "none" }}>
        <div
          className={`whitespace-nowrap rounded border px-1.5 py-0.5 font-mono text-[10px] tracking-wider backdrop-blur-sm transition-colors ${
            active ? "border-cyan-400/80 bg-cyan-400/20 text-cyan-200" : "border-slate-600/60 bg-slate-900/70 text-slate-300"
          }`}
        >
          {device.name}
        </div>
      </Html>
    </group>
  );
}

/** Markers for devices that have a saved/placed position. Positions come from device placement mode. */
export function DeviceMarkers() {
  const positions = useDeviceStore((s) => s.positions);
  return (
    <group name="DeviceMarkers">
      {securityDevices.map((device) => {
        const position = positions[device.id];
        if (!position) return null;
        return <DeviceMarker key={device.id} device={device} position={position} />;
      })}
    </group>
  );
}
