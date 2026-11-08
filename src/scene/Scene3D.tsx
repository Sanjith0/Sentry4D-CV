import { Suspense } from "react";
import { Canvas } from "@react-three/fiber";
import { roomConfig } from "../config/roomConfig";
import { useCameras, useReplayStore } from "../store/useReplayStore";
import { useViewStore, type RenderQuality } from "../store/useViewStore";
import * as THREE from "three";
import { ErrorBoundary } from "../lib/ErrorBoundary";
import { SceneActors } from "../features/sentry/SceneActors";
import { RoomStage } from "./RoomStage";
import { SupplementalGeometry } from "./SupplementalGeometry";
import { WindowWall } from "./WindowWall";
import { CameraMarkers } from "./CameraMarkers";
import { CameraControls } from "./CameraControls";
import { DEFAULT_FOV } from "./cameraPoses";
import { ViewportCameraProbe } from "./viewportCamera";
import { PostFX } from "./PostFX";
import { CalibrationControls } from "./CalibrationControls";
import { AnnotationLayer } from "../features/annotation/AnnotationLayer";
import { AppearanceLayer } from "../features/reconstruction/AppearanceLayer";

export function SceneLighting() {
  const l = roomConfig.lighting;
  return (
    <>
      <ambientLight intensity={l.ambientIntensity} />
      <hemisphereLight args={["#cfe8ff", "#1a1f2b", l.hemisphereIntensity]} />
      <directionalLight position={l.directionalPosition} intensity={l.directionalIntensity} />
    </>
  );
}

/** Feeds replay state into the sentry feature. Isolated so its per-frame re-renders stay local. */
export function SceneActorsBridge() {
  const currentTime = useReplayStore((s) => s.currentTime);
  const xrayEnabled = useReplayStore((s) => s.xrayEnabled);
  const sentryEnabled = useReplayStore((s) => s.sentryEnabled);
  const roomBounds = useViewStore((s) => s.roomBounds);
  const cameraOffsets = useReplayStore((s) => s.cameraOffsets);
  const cameras = useCameras();
  return (
    <ErrorBoundary fallback={null}>
      <Suspense fallback={null}>
        <SceneActors
          currentTime={currentTime}
          xrayEnabled={xrayEnabled}
          sentryEnabled={sentryEnabled}
          roomBounds={roomBounds}
          cameras={cameras}
          cameraOffsets={cameraOffsets}
        />
      </Suspense>
    </ErrorBoundary>
  );
}

const DPR: Record<RenderQuality, number | [number, number]> = {
  performance: [1, 1.5],
  balanced: [1, 2],
  ultra: Math.min(typeof window !== "undefined" ? window.devicePixelRatio * 1.25 : 2, 2.5),
};

function CalibrationBridge() {
  const active = useReplayStore((s) => s.cameraMode === "cctv");
  const calibrating = useViewStore((s) => s.calibrating);
  return active && calibrating ? <CalibrationControls /> : null;
}

export function Scene3D() {
  const quality = useViewStore((s) => s.quality);
  return (
    <Canvas
      camera={{ fov: DEFAULT_FOV, near: 0.03, far: 500, position: [12, 10, 14] }}
      dpr={DPR[quality]}
      gl={{ antialias: true, powerPreference: "high-performance", preserveDrawingBuffer: false }}
      onCreated={({ gl }) => {
        gl.localClippingEnabled = true;
        gl.outputColorSpace = THREE.SRGBColorSpace;
      }}
    >
      <color attach="background" args={["#05080d"]} />
      <SceneLighting />
      <RoomStage />
      <SupplementalGeometry />
      <WindowWall />
      <CameraMarkers />
      <SceneActorsBridge />
      <AnnotationLayer />
      <AppearanceLayer />
      <CameraControls />
      <CalibrationBridge />
      <ViewportCameraProbe />
      <PostFX />
    </Canvas>
  );
}
