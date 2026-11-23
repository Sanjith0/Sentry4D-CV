import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Html, Line } from "@react-three/drei";
import * as THREE from "three";
import { CCTV_ASPECT, FRUSTUM_LENGTH } from "../config/cameras";
import { useCameras } from "../store/useReplayStore";
import { CAMERA_STATE_COLOR, CAMERA_STATE_LABEL, useEvidenceStore } from "../features/sentry/useEvidence";
import { poseQuaternion } from "../lib/cameraMath";
import { demoLook } from "../features/demo/demoLook";
import { useLabelSlot } from "../features/demo/labelFit";
import { useDemoStore } from "../features/demo/useDemoStore";

// Marker geometry opens along +Z; cameras look down -Z.
const FLIP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
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
  const coverage = useRef<THREE.Group>(null);
  const coverageFill = useRef<THREE.MeshBasicMaterial>(null);
  const coverageEdge = useRef<THREE.LineBasicMaterial>(null);
  // demo walkthrough: the label gives way to the subject's tag and to the cameras before it
  const { anchorRef: labelAnchorRef, elRef: labelRef } = useLabelSlot(index + 1);
  const statusRef = useRef<HTMLSpanElement>(null);
  // ... and sits on a dark plate: the walkthrough flies it over the bright room, where the tinted one cannot be read
  const demo = useDemoStore((s) => s.phase !== "idle");
  const selected = useReplayStore((s) => s.selectedCameraId === cam.id);
  const viewingThrough = useReplayStore((s) => s.cameraMode === "cctv" && s.selectedCameraId === cam.id);
  const viewThroughCamera = useReplayStore((s) => s.viewThroughCamera);
  const hovered = useViewStore((s) => s.hoveredCameraId === cam.id);
  const setHovered = useViewStore((s) => s.setHoveredCamera);
  const showCoverage = useViewStore((s) => s.showCoverage);

  const length = FRUSTUM_LENGTH;
  const { g, edges } = useMemo(() => frustumGeometry(cam.fov, CCTV_ASPECT, length), [cam.fov, length]);

  const quaternion = useMemo(() => poseQuaternion(cam).multiply(FLIP), [cam]);

  // Evidence: does this camera currently see a tracked person?
  const evidence = useEvidenceStore((s) => s.byCamera[cam.id]);
  const tracking = evidence === "tracking";

  const active = selected || hovered || tracking;
  const color = active ? CYAN : DIM;

  useFrame(({ clock }) => {
    // Looking through this camera, its own housing must not draw. Read from the store rather than from the
    // rendered state: the demo walkthrough can move the viewpoint into a camera and select it within one
    // frame, before React has re-rendered this marker, and the lens would fill that frame.
    if (group.current) {
      const s = useReplayStore.getState();
      group.current.visible = !(s.cameraMode === "cctv" && s.selectedCameraId === cam.id);
    }
    // The demo walkthrough takes the subject out for its rewind: the cameras' status on him goes with him
    // (it would otherwise flicker through TRACKING / NO DETECTION / OUT OF FRAME as time runs backwards).
    if (statusRef.current) statusRef.current.style.display = demoLook.active && demoLook.hideSubject ? "none" : "";
    if (ring.current) ring.current.opacity = selected || tracking ? 0.6 + 0.4 * Math.sin(clock.elapsedTime * (tracking ? 8 : 5)) : 0.5;
    if (coverage.current) {
      // The demo walkthrough unfolds the volumes one camera after another; otherwise they are simply drawn.
      const u = demoLook.active ? Math.min(1, Math.max(0, demoLook.coverage * 2.2 - index * 0.4)) : 1;
      const k = u * u * (3 - 2 * u);
      coverage.current.scale.setScalar(0.25 + 0.75 * k);
      if (coverageFill.current) coverageFill.current.opacity = (active ? 0.12 : 0.045) * k;
      if (coverageEdge.current) coverageEdge.current.opacity = (active ? 0.9 : 0.35) * k;
    }
  });

  return (
    <group position={cam.position}>
      <group ref={group} quaternion={quaternion} visible={!viewingThrough}>
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
          <group ref={coverage} raycast={() => null}>
            <mesh geometry={g} raycast={() => null} renderOrder={2}>
              <meshBasicMaterial ref={coverageFill} color={color} transparent opacity={active ? 0.12 : 0.045} depthWrite={false} side={THREE.DoubleSide} toneMapped={false} />
            </mesh>
            <lineSegments geometry={edges} raycast={() => null}>
              <lineBasicMaterial ref={coverageEdge} color={color} transparent opacity={active ? 0.9 : 0.35} toneMapped={false} />
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
        <group position={[0, 0.28, 0]} ref={labelAnchorRef}>
          <Html center zIndexRange={[20, 0]} style={{ pointerEvents: "none" }}>
            <div
              ref={labelRef}
              className={`whitespace-nowrap rounded border px-1.5 py-0.5 font-mono text-[10px] tracking-wider backdrop-blur-sm transition-colors ${
                active ? `border-cyan-400/80 text-cyan-200 ${demo ? "bg-ink-950/85" : "bg-cyan-400/20"}` : "border-slate-600/60 bg-slate-900/70 text-slate-300"
              }`}
            >
              CAM {String(index + 1).padStart(2, "0")}
              {selected && <span className="ml-1 text-cyan-300">● LINKED</span>}
              {evidence && evidence !== "no-evidence" && evidence !== "not-recording" && (
                <span ref={statusRef} className="ml-1" style={{ color: CAMERA_STATE_COLOR[evidence] }}>
                  {tracking ? "◉ " : ""}
                  {CAMERA_STATE_LABEL[evidence]}
                </span>
              )}
            </div>
          </Html>
        </group>
      )}
    </group>
  );
}

export function CameraMarkers() {
  const show = useViewStore((s) => s.showMarkers);
  const securityCameras = useCameras();
  if (!show) return null;
  return (
    <group name="CameraMarkers">
      {securityCameras.map((cam, i) => (
        <CameraMarker key={cam.id} cam={cam} index={i} />
      ))}
    </group>
  );
}
