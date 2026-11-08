import { useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { securityDevices, type DeviceConfig } from "../config/devices";
import { useDeviceStore } from "../features/devices/useDeviceStore";
import { useCyberAlertStore, type AlertStage } from "../features/devices/useCyberAlertStore";
import { useReplayStore } from "../store/useReplayStore";
import type { Vec3 } from "../types/security";

const STAGE_COLOR: Record<AlertStage, THREE.Color> = {
  idle: new THREE.Color("#64748b"),
  alert: new THREE.Color("#ef4444"),
  investigating: new THREE.Color("#f59e0b"),
  resolved: new THREE.Color("#34d399"),
};
const STAGE_PULSE_HZ: Record<AlertStage, number> = { idle: 5, alert: 9, investigating: 6, resolved: 2 };
const HOVER_COLOR = new THREE.Color("#22d3ee");

function DeviceMarker({ device, position }: { device: DeviceConfig; position: Vec3 }) {
  const ring = useRef<THREE.MeshBasicMaterial>(null);
  const [hovered, setHovered] = useState(false);
  const selected = useReplayStore((s) => s.selectedEntity?.id === device.id);
  const setSelectedEntity = useReplayStore((s) => s.setSelectedEntity);
  const stage = useCyberAlertStore((s) => s.stages[device.id]);
  const sessionId = useCyberAlertStore((s) =>
    Object.values(s.sessions).find((sess) => sess.deviceId === device.id)?.summary.sessionId,
  );
  const openSession = useCyberAlertStore((s) => s.openSession);

  const highlighted = selected || hovered || stage !== "idle";
  const color = hovered || selected ? HOVER_COLOR : STAGE_COLOR[stage];
  const pulseHz = STAGE_PULSE_HZ[stage];

  useFrame(({ clock }) => {
    if (!ring.current) return;
    ring.current.opacity = highlighted ? 0.6 + 0.4 * Math.sin(clock.elapsedTime * pulseHz) : 0.5;
  });

  return (
    <group position={position}>
      <group
        onClick={(e) => {
          e.stopPropagation();
          setSelectedEntity({
            id: device.id,
            label: device.name,
            kind: "object",
            details: { type: "Device", status: stage.toUpperCase() },
          });
          if (sessionId) openSession(sessionId);
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
          <meshStandardMaterial color="#020617" emissive={color} emissiveIntensity={highlighted ? 1.2 : 0.3} />
        </mesh>
        <mesh rotation-x={Math.PI / 2}>
          <ringGeometry args={[0.1, 0.13, 24]} />
          <meshBasicMaterial ref={ring} color={color} transparent side={THREE.DoubleSide} toneMapped={false} />
        </mesh>
        {/* Larger invisible hit target */}
        <mesh>
          <sphereGeometry args={[0.18, 8, 8]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      </group>
      <Html position={[0, 0.2, 0]} center zIndexRange={[20, 0]} style={{ pointerEvents: "none" }}>
        <div
          className="whitespace-nowrap rounded border px-1.5 py-0.5 font-mono text-[10px] tracking-wider backdrop-blur-sm transition-colors"
          style={{
            borderColor: highlighted ? `#${color.getHexString()}cc` : "rgba(71,85,105,0.6)",
            background: highlighted ? `#${color.getHexString()}33` : "rgba(15,23,42,0.7)",
            color: highlighted ? `#${color.getHexString()}` : "#cbd5e1",
          }}
        >
          {device.name}
          {stage !== "idle" && <span className="ml-1">● {stage.toUpperCase()}</span>}
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
