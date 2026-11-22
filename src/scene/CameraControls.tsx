import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { MOUSE } from "three";
import { getCameras, useReplayStore } from "../store/useReplayStore";
import { poseQuaternion, viewportFov } from "../lib/cameraMath";
import { useViewStore } from "../store/useViewStore";
import type { CameraMode, Vec3 } from "../types/security";
import { homePose, type CameraPose } from "./cameraPoses";
import { FreeFlyControls } from "./FreeFlyControls";
import { useDemoStore } from "../features/demo/useDemoStore";

interface Transition {
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  fromQuat: THREE.Quaternion;
  toQuat: THREE.Quaternion;
  fromFov: number;
  toFov: number;
  t: number;
  duration: number;
}

/** Where the user's own camera stood when the demo walkthrough took it over (orbit, top-down and free modes). */
interface UserView {
  mode: CameraMode;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  fov: number;
  /** Pivot of the orbit / top-down controls. */
  target: Vec3 | null;
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const helperCam = new THREE.PerspectiveCamera();

/**
 * Single owner of the viewport camera. Animates between mode poses, and only
 * mounts a mode's interactive controls once the transition is finished, so
 * controllers never fight over the camera.
 */
export function CameraControls() {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  const mode = useReplayStore((s) => s.cameraMode);
  const selectedCameraId = useReplayStore((s) => s.selectedCameraId);
  const bounds = useViewStore((s) => s.roomBounds);
  const resetToken = useViewStore((s) => s.resetToken);
  const setTransitioning = useViewStore((s) => s.setTransitioning);
  // The demo walkthrough flies the camera itself; afterwards this component eases back to where the user was
  // (or to the mode's home when the camera was not at rest in orbit, top-down or free mode).
  const demo = useDemoStore((s) => s.phase !== "idle");
  const get = useThree((s) => s.get);
  const userView = useRef<UserView | null>(null);

  const transition = useRef<Transition | null>(null);
  const [settledPose, setSettledPose] = useState<CameraPose | null>(null);
  const [busy, setBusy] = useState(true);

  const cctvCam = mode === "cctv" ? getCameras().find((c) => c.id === selectedCameraId) : undefined;
  const boundsKey = bounds ? bounds.size.map((v) => v.toFixed(2)).join(",") : "none";
  const lastMode = useRef<string | null>(null);
  const lastReset = useRef(resetToken);

  useEffect(() => {
    if (demo) {
      if (lastMode.current !== "demo") {
        // (this runs in the commit that starts the walkthrough, before its first frame moves the camera)
        const pivot = (get().controls as { target?: THREE.Vector3 } | null)?.target;
        const atRest = !busy && !transition.current && (mode === "free" || ((mode === "orbit" || mode === "topdown") && !!pivot));
        userView.current = atRest
          ? { mode, position: camera.position.clone(), quaternion: camera.quaternion.clone(), fov: camera.fov, target: mode === "free" ? null : (pivot!.toArray() as Vec3) }
          : null;
      }
      transition.current = null;
      setBusy(true); // no interactive controls
      setTransitioning(false);
      lastMode.current = "demo";
      return;
    }
    const aspect = size.width / Math.max(size.height, 1);
    const home = homePose(mode, bounds, aspect, cctvCam);
    const isReset = lastReset.current !== resetToken;
    const firstRun = lastMode.current === null;
    // After the walkthrough: back to the user's own view, once the viewer is in the mode it was taken in again.
    const back = !isReset && userView.current?.mode === mode ? userView.current : null;
    if (back || lastMode.current !== "demo") userView.current = null;
    const pose: CameraPose = back ? { position: back.position.toArray() as Vec3, target: back.target ?? home.target, fov: back.fov } : home;
    // Stepping out of a CCTV view keeps that viewpoint; from orbit/top-down we fly into the room.
    const enteringFree = !back && mode === "free" && lastMode.current === "cctv" && !isReset;
    lastMode.current = mode;
    lastReset.current = resetToken;

    setSettledPose(pose);
    if (enteringFree) {
      // Keep the current viewpoint; just hand over to the fly controls.
      transition.current = null;
      setBusy(false);
      setTransitioning(false);
      return;
    }

    helperCam.position.set(...pose.position);
    helperCam.up.set(0, 1, 0);
    helperCam.lookAt(...pose.target);
    // CCTV: exact calibrated orientation (incl. roll) and the FOV that makes the
    // 16:9 sensor box in the viewport match the real recording's framing.
    if (cctvCam) poseQuaternion(cctvCam, helperCam.quaternion);
    if (back) helperCam.quaternion.copy(back.quaternion);
    const toFov = cctvCam ? viewportFov(cctvCam.fov, size.width, size.height) : pose.fov;
    transition.current = {
      fromPos: camera.position.clone(),
      toPos: helperCam.position.clone(),
      fromQuat: camera.quaternion.clone(),
      toQuat: helperCam.quaternion.clone(),
      fromFov: camera.fov,
      toFov,
      t: 0,
      duration: firstRun ? 0.01 : 0.9,
    };
    setBusy(true);
    setTransitioning(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, cctvCam?.id, resetToken, boundsKey, demo]);

  useFrame((_, dt) => {
    if (demo) return;
    const tr = transition.current;
    if (!tr) {
      // Locked to a CCTV camera: follow its live pose so calibration edits show instantly.
      if (mode === "cctv") {
        const s = useReplayStore.getState();
        const pose = s.selectedCameraId ? s.cameraPoses[s.selectedCameraId] : null;
        if (pose) {
          camera.position.set(...pose.position);
          poseQuaternion(pose, camera.quaternion);
          const fov = viewportFov(pose.fov, size.width, size.height);
          if (Math.abs(camera.fov - fov) > 1e-4) {
            camera.fov = fov;
            camera.updateProjectionMatrix();
          }
        }
      }
      return;
    }
    tr.t = Math.min(tr.t + dt / tr.duration, 1);
    const e = ease(tr.t);
    camera.position.lerpVectors(tr.fromPos, tr.toPos, e);
    camera.quaternion.slerpQuaternions(tr.fromQuat, tr.toQuat, e);
    camera.fov = THREE.MathUtils.lerp(tr.fromFov, tr.toFov, e);
    camera.updateProjectionMatrix();
    if (tr.t >= 1) {
      transition.current = null;
      setBusy(false);
      setTransitioning(false);
    }
  });

  const target = useMemo(() => (settledPose ? new THREE.Vector3(...settledPose.target) : new THREE.Vector3()), [settledPose]);

  if (busy || !settledPose) return null;

  switch (mode) {
    case "free":
      return <FreeFlyControls />;
    case "orbit":
      return <OrbitControls key="orbit" makeDefault target={target} enableDamping dampingFactor={0.08} maxDistance={200} minDistance={0.3} />;
    case "topdown":
      return (
        <OrbitControls
          key="topdown"
          makeDefault
          target={target}
          enableRotate={false}
          enableDamping
          dampingFactor={0.1}
          screenSpacePanning
          mouseButtons={{ LEFT: MOUSE.PAN, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN }}
          minDistance={1}
          maxDistance={200}
        />
      );
    default:
      return null; // cctv: locked to the physical camera's pose
  }
}
