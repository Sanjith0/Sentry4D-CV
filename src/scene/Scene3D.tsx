import { Suspense } from "react";
import { Canvas } from "@react-three/fiber";
import { roomConfig } from "../config/roomConfig";
import { securityCameras } from "../config/cameras";
import { useReplayStore } from "../store/useReplayStore";
import { useViewStore } from "../store/useViewStore";
import { ErrorBoundary } from "../lib/ErrorBoundary";
import { SceneActors } from "../features/sentry/SceneActors";
import { RoomStage } from "./RoomStage";
import { SupplementalGeometry } from "./SupplementalGeometry";
import { CameraMarkers } from "./CameraMarkers";
import { CameraControls } from "./CameraControls";
import { DEFAULT_FOV } from "./cameraPoses";
import { ViewportCameraProbe } from "./viewportCamera";

function SceneLighting() {
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
function SceneActorsBridge() {
  const currentTime = useReplayStore((s) => s.currentTime);
  const xrayEnabled = useReplayStore((s) => s.xrayEnabled);
  const sentryEnabled = useReplayStore((s) => s.sentryEnabled);
  const roomBounds = useViewStore((s) => s.roomBounds);
  return (
    <ErrorBoundary fallback={null}>
      <Suspense fallback={null}>
        <SceneActors
          currentTime={currentTime}
          xrayEnabled={xrayEnabled}
          sentryEnabled={sentryEnabled}
          roomBounds={roomBounds}
          cameras={securityCameras}
        />
      </Suspense>
    </ErrorBoundary>
  );
}

export function Scene3D() {
  return (
    <Canvas
      camera={{ fov: DEFAULT_FOV, near: 0.03, far: 500, position: [12, 10, 14] }}
      dpr={[1, 2]}
      gl={{ antialias: true, powerPreference: "high-performance", preserveDrawingBuffer: false }}
      onCreated={({ gl }) => {
        gl.localClippingEnabled = true;
      }}
    >
      <color attach="background" args={["#05080d"]} />
      <SceneLighting />
      <RoomStage />
      <SupplementalGeometry />
      <CameraMarkers />
      <SceneActorsBridge />
      <CameraControls />
      <ViewportCameraProbe />
    </Canvas>
  );
}
