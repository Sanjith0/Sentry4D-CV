import { useMemo } from "react";
import { Html, Line } from "@react-three/drei";
import type { ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import { useReplayStore } from "../../store/useReplayStore";
import { useViewStore } from "../../store/useViewStore";
import { formatClock } from "../../lib/format";
import { videoPixelToWorld, worldToVideoPixel } from "../../lib/videoProjection";
import type { PersonObservation, Vec3 } from "../../types/security";
import { useActiveObservations, useAnnotationStore } from "./useAnnotationStore";
import { camLabel, frameInfoFor } from "./AnnotationPanel";
import { getRoomMeshes } from "../../scene/viewportCamera";

const CYAN = "#22d3ee";
const NOW_WINDOW = 0.05; // s
const noRaycast = () => null;

function Highlight({ o, selected }: { o: PersonObservation; selected: boolean }) {
  const camPos = useReplayStore((s) => s.cameraPoses[o.cameraId].position);
  const pose = useReplayStore((s) => s.cameraPoses[o.cameraId]);
  const bounds = useViewStore((s) => s.roomBounds);
  const frame = frameInfoFor(o.cameraId);
  const diag = useMemo(() => (frame ? videoPixelToWorld(pose, o.pixel, frame, bounds, getRoomMeshes()) : null), [pose, o.pixel, frame?.width, frame?.height, bounds]); // eslint-disable-line react-hooks/exhaustive-deps
  const [x, , z] = o.worldPosition;
  const color = selected ? "#fbbf24" : CYAN;
  const conf = diag ? (diag.status === "invalid" ? "invalid" : diag.confidence) : "n/a";
  const confColor = ({ high: "#34d399", medium: "#fbbf24", low: "#f87171" } as Record<string, string>)[conf] ?? "#94a3b8";

  return (
    <group>
      {/* Sight ray from the CCTV camera to the floor point */}
      <Line points={[camPos, [x, 0.01, z]]} color={color} lineWidth={1.2} dashed dashSize={0.12} gapSize={0.08} transparent opacity={0.8} raycast={noRaycast} />
      <mesh position={[x, 0.85, z]} raycast={noRaycast}>
        <cylinderGeometry args={[0.16, 0.16, 1.7, 24, 1, true]} />
        <meshBasicMaterial color={color} transparent opacity={0.22} side={THREE.DoubleSide} depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh position={[x, 0.012, z]} rotation-x={-Math.PI / 2} raycast={noRaycast}>
        <ringGeometry args={[0.16, 0.24, 40]} />
        <meshBasicMaterial color={color} toneMapped={false} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[x, 0.012, z]} rotation-x={-Math.PI / 2} raycast={noRaycast}>
        <circleGeometry args={[0.06, 20]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
      <Html position={[x, 1.85, z]} center zIndexRange={[25, 0]} style={{ pointerEvents: "none" }}>
        <div className="rounded border border-cyan-400/60 bg-ink-950/85 px-2 py-1 font-mono text-[10px] leading-tight whitespace-nowrap text-slate-200 backdrop-blur">
          <div className="text-cyan-200">
            {camLabel(o.cameraId)} · M {formatClock(o.masterTime)} · V {formatClock(o.videoTime ?? o.masterTime)}
          </div>
          <div>
            X {x.toFixed(2)} Y {o.worldPosition[1].toFixed(2)} Z {z.toFixed(2)} m{" "}
            <span style={{ color: confColor }}>● {conf}</span>
          </div>
        </div>
      </Html>
    </group>
  );
}

/** Floor plane that accepts clicks in TOP view to correct the selected observation. */
function FloorPicker() {
  const bounds = useViewStore((s) => s.roomBounds);
  const selectedId = useAnnotationStore((s) => s.selectedId);
  const topdown = useReplayStore((s) => s.cameraMode === "topdown");
  if (!bounds || !selectedId || !topdown) return null;
  const [cx, , cz] = bounds.center;
  const w = bounds.size[0] + 2;
  const d = bounds.size[2] + 2;

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    if (e.delta > 4) return; // a drag (pan), not a click
    e.stopPropagation();
    const st = useAnnotationStore.getState();
    const o = (st.persons[st.activePersonId] ?? []).find((x) => x.id === st.selectedId);
    if (!o) return;
    const world: Vec3 = [Math.round(e.point.x * 1000) / 1000, 0, Math.round(e.point.z * 1000) / 1000];
    // Keep the pixel consistent with the corrected point (reprojected into its camera).
    const frame = frameInfoFor(o.cameraId);
    const re = frame ? worldToVideoPixel(useReplayStore.getState().cameraPoses[o.cameraId], world, frame) : null;
    const pixel = re?.pixel && re.inFrame ? ([Math.round(re.pixel[0] * 1e4) / 1e4, Math.round(re.pixel[1] * 1e4) / 1e4] as [number, number]) : o.pixel;
    st.update(o.id, { worldPosition: world, pixel, source: "manual-topdown" });
  };

  return (
    <mesh
      position={[cx, 0.003, cz]}
      rotation-x={-Math.PI / 2}
      onClick={onClick}
      onPointerOver={() => (document.body.style.cursor = "crosshair")}
      onPointerOut={() => (document.body.style.cursor = "")}
    >
      <planeGeometry args={[w, d]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  );
}

/** 3D visualization of the active person's annotations (shown while annotating). */
export function AnnotationLayer() {
  const annotating = useViewStore((s) => s.annotating);
  const obs = useActiveObservations();
  const selectedId = useAnnotationStore((s) => s.selectedId);
  const lastId = useAnnotationStore((s) => s.lastId);
  const t = useReplayStore((s) => s.currentTime);
  if (!annotating) return null;

  const highlighted = obs.filter((o) => o.id === selectedId || o.id === lastId || Math.abs(o.masterTime - t) <= NOW_WINDOW);
  const trail = obs.map((o) => [o.worldPosition[0], 0.02, o.worldPosition[2]] as Vec3);

  return (
    <group name="AnnotationLayer">
      {trail.length > 1 && <Line points={trail} color={CYAN} lineWidth={1.5} transparent opacity={0.45} raycast={noRaycast} />}
      {obs.map((o) => (
        <mesh key={o.id} position={[o.worldPosition[0], 0.015, o.worldPosition[2]]} rotation-x={-Math.PI / 2} raycast={noRaycast}>
          <circleGeometry args={[0.07, 16]} />
          <meshBasicMaterial color={CYAN} transparent opacity={0.6} toneMapped={false} />
        </mesh>
      ))}
      {highlighted.map((o) => (
        <Highlight key={o.id} o={o} selected={o.id === selectedId} />
      ))}
      <FloorPicker />
    </group>
  );
}
