import { useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Html, Line } from "@react-three/drei";
import * as THREE from "three";
import { CCTV_ASPECT, FRUSTUM_LENGTH, securityCameras } from "../config/cameras";
import { useReplayStore } from "../store/useReplayStore";
import { useViewStore } from "../store/useViewStore";
import type { SecurityCamera } from "../types/security";

const CYAN = new THREE.Color("#22d3ee");
const DIM = new THREE.Color("#64748b");

function frustumGeometry(fov: number, aspect: number, length: number) {
  const h = Math.tan((fov * Math.PI) / 360) * length;
  const w = h * aspect;
  // Apex at origin, opening along +Z (Object3D.lookAt points +Z at the target).
  const v = [0, 0, 0, -w, -h, length, w, -h, length, w, h, length, -w, h, length];
  const faces = [0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1];
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
  g.setIndex(faces);
  const edges = new THREE.BufferGeometry();
  const e = [0, 1, 0, 2, 0, 3, 0, 4, 1, 2, 2, 3, 3, 4, 4, 1].flatMap((i) => v.slice(i * 3, i * 3 + 3));
  edges.setAttribute("position", new THREE.Float32BufferAttribute(e, 3));
  return { g, edges };
}

function CameraMarker({ cam, index }: { cam: SecurityCamera; index: number }) {
  const group = useRef<THREE.Group>(null);
  const ring = useRef<THREE.MeshBasicMaterial>(null);
  const selected = useReplayStore((s) => s.selectedCameraId === cam.id);
  const viewingThrough = useReplayStore((s) => s.cameraMode === "cctv" && s.selectedCameraId === cam.id);
  const viewThroughCamera = useReplayStore((s) => s.viewThroughCamera);
  const hovered = useViewStore((s) => s.hoveredCameraId === cam.id);
  const setHovered = useViewStore((s) => s.setHoveredCamera);
  const showCoverage = useViewStore((s) => s.showCoverage);

  const dist = useMemo(() => new THREE.Vector3(...cam.position).distanceTo(new THREE.Vector3(...cam.target)), [cam]);
  const length = Math.min(FRUSTUM_LENGTH, dist);
  const { g, edges } = useMemo(() => frustumGeometry(cam.fov, CCTV_ASPECT, length), [cam.fov, length]);

  useLayoutEffect(() => {
    group.current?.lookAt(...cam.target);
  }, [cam]);

  useFrame(({ clock }) => {
    if (!ring.current) return;
    const pulse = selected ? 0.6 + 0.4 * Math.sin(clock.elapsedTime * 5) : 0.5;
    ring.current.opacity = pulse;
  });

  const active = selected || hovered;
  const color = active ? CYAN : DIM;

  return (
    <group position={cam.position}>
      <group ref={group} visible={!viewingThrough}>
        {/* Housing */}
        <group
          onClick={(e) => {
            e.stopPropagation();
            viewThroughCamera(cam.id);
          }}
          onPointerOver={(e) => {
            e.stopPropagation();
            setHovered(cam.id);
            document.body.style.cursor = "pointer";
          }}
          onPointerOut={() => {
            setHovered(null);
            document.body.style.cursor = "";
          }}
        >
          <mesh position={[0, 0, -0.06]}>
            <boxGeometry args={[0.16, 0.13, 0.3]} />
            <meshStandardMaterial color="#0f172a" metalness={0.3} roughness={0.5} />
          </mesh>
          <mesh position={[0, 0, 0.1]} rotation-x={Math.PI / 2}>
            <cylinderGeometry args={[0.05, 0.05, 0.04, 20]} />
            <meshStandardMaterial color="#020617" emissive={color} emissiveIntensity={active ? 1.2 : 0.3} />
          </mesh>
          <mesh position={[0, 0, 0.122]}>
            <ringGeometry args={[0.055, 0.075, 24]} />
            <meshBasicMaterial ref={ring} color={active ? "#22d3ee" : "#ef4444"} transparent side={THREE.DoubleSide} toneMapped={false} />
          </mesh>
          {/* Larger invisible hit target */}
          <mesh>
            <sphereGeometry args={[0.3, 8, 8]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          </mesh>
        </group>

        {showCoverage && (
          <group raycast={() => null}>
            <mesh geometry={g} raycast={() => null} renderOrder={2}>
              <meshBasicMaterial color={color} transparent opacity={active ? 0.12 : 0.045} depthWrite={false} side={THREE.DoubleSide} toneMapped={false} />
            </mesh>
            <lineSegments geometry={edges} raycast={() => null}>
              <lineBasicMaterial color={color} transparent opacity={active ? 0.9 : 0.35} toneMapped={false} />
            </lineSegments>
          </group>
        )}
      </group>

      {/* Sightline to the camera's aim point while its feed is linked */}
      {selected && !viewingThrough && (
        <group raycast={() => null}>
          <Line
            points={[[0, 0, 0], [cam.target[0] - cam.position[0], cam.target[1] - cam.position[1], cam.target[2] - cam.position[2]]]}
            color="#22d3ee"
            lineWidth={1.5}
            dashed
            dashSize={0.15}
            gapSize={0.1}
            transparent
            opacity={0.85}
          />
          <mesh position={[cam.target[0] - cam.position[0], cam.target[1] - cam.position[1], cam.target[2] - cam.position[2]]}>
            <sphereGeometry args={[0.06, 16, 16]} />
            <meshBasicMaterial color="#22d3ee" toneMapped={false} />
          </mesh>
        </group>
      )}

      {!viewingThrough && (
        <Html position={[0, 0.28, 0]} center zIndexRange={[20, 0]} style={{ pointerEvents: "none" }}>
          <div
            className={`whitespace-nowrap rounded border px-1.5 py-0.5 font-mono text-[10px] tracking-wider backdrop-blur-sm transition-colors ${
              active ? "border-cyan-400/80 bg-cyan-400/20 text-cyan-200" : "border-slate-600/60 bg-slate-900/70 text-slate-300"
            }`}
          >
            CAM {String(index + 1).padStart(2, "0")}
            {selected && <span className="ml-1 text-cyan-300">● LINKED</span>}
          </div>
        </Html>
      )}
    </group>
  );
}

export function CameraMarkers() {
  const show = useViewStore((s) => s.showMarkers);
  if (!show) return null;
  return (
    <group name="CameraMarkers">
      {securityCameras.map((cam, i) => (
        <CameraMarker key={cam.id} cam={cam} index={i} />
      ))}
    </group>
  );
}
