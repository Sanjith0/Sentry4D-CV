import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useViewStore } from "../store/useViewStore";

const LOOK_SENSITIVITY = 0.0022;
const PITCH_LIMIT = Math.PI / 2 - 0.01;
const MOVE_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "Space", "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "KeyQ", "KeyE"]);

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
}

/**
 * Spectator / noclip camera.
 * Click canvas → pointer lock. WASD move, mouse look, Space up, Shift down,
 * Ctrl sprint, wheel adjusts speed, Esc releases the pointer.
 */
export function FreeFlyControls() {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const keys = useRef(new Set<string>());
  const yaw = useRef(0);
  const pitch = useRef(0);
  const targetYaw = useRef(0);
  const targetPitch = useRef(0);
  const velocity = useRef(new THREE.Vector3());

  // Initialize look angles from the current camera so entering free mode never jumps.
  useEffect(() => {
    const e = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ");
    yaw.current = targetYaw.current = e.y;
    pitch.current = targetPitch.current = THREE.MathUtils.clamp(e.x, -PITCH_LIMIT, PITCH_LIMIT);
    velocity.current.set(0, 0, 0);
  }, [camera]);

  useEffect(() => {
    const el = gl.domElement;
    const view = useViewStore.getState;

    const onClick = () => {
      if (view().hoveredCameraId) return; // clicking a CCTV marker, not entering look mode
      if (document.pointerLockElement !== el) {
        const p = el.requestPointerLock() as unknown as Promise<void> | undefined;
        p?.catch?.(() => {});
      }
    };
    const onLockChange = () => {
      const locked = document.pointerLockElement === el;
      view().setPointerLocked(locked);
      if (!locked) keys.current.clear();
    };
    const onMouseMove = (e: MouseEvent) => {
      if (document.pointerLockElement !== el) return;
      targetYaw.current -= e.movementX * LOOK_SENSITIVITY;
      targetPitch.current = THREE.MathUtils.clamp(targetPitch.current - e.movementY * LOOK_SENSITIVITY, -PITCH_LIMIT, PITCH_LIMIT);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey) return;
      if (MOVE_KEYS.has(e.code)) {
        keys.current.add(e.code);
        if (e.code === "Space") {
          e.preventDefault(); // don't scroll or "click" a focused button
          (document.activeElement as HTMLElement | null)?.blur?.();
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => keys.current.delete(e.code);
    const onBlur = () => keys.current.clear();
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const s = view();
      s.setFlySpeed(s.flySpeed * (e.deltaY > 0 ? 0.9 : 1.1));
    };

    el.addEventListener("click", onClick);
    el.addEventListener("wheel", onWheel, { passive: false });
    document.addEventListener("pointerlockchange", onLockChange);
    document.addEventListener("mousemove", onMouseMove);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      el.removeEventListener("click", onClick);
      el.removeEventListener("wheel", onWheel);
      document.removeEventListener("pointerlockchange", onLockChange);
      document.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      if (document.pointerLockElement === el) document.exitPointerLock();
      view().setPointerLocked(false);
    };
  }, [gl]);

  const fwd = useRef(new THREE.Vector3());
  const right = useRef(new THREE.Vector3());
  const wish = useRef(new THREE.Vector3());
  const euler = useRef(new THREE.Euler(0, 0, 0, "YXZ"));

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    // Smooth look
    const lookK = 1 - Math.exp(-dt * 25);
    yaw.current += (targetYaw.current - yaw.current) * lookK;
    pitch.current += (targetPitch.current - pitch.current) * lookK;
    euler.current.set(pitch.current, yaw.current, 0);
    camera.quaternion.setFromEuler(euler.current);

    // Movement relative to view direction; Space/Shift (and E/Q) are world up/down.
    const k = keys.current;
    camera.getWorldDirection(fwd.current);
    right.current.crossVectors(fwd.current, camera.up).normalize();
    const w = wish.current.set(0, 0, 0);
    if (k.has("KeyW")) w.add(fwd.current);
    if (k.has("KeyS")) w.sub(fwd.current);
    if (k.has("KeyD")) w.add(right.current);
    if (k.has("KeyA")) w.sub(right.current);
    if (k.has("Space") || k.has("KeyE")) w.y += 1;
    if (k.has("ShiftLeft") || k.has("ShiftRight") || k.has("KeyQ")) w.y -= 1;
    if (w.lengthSq() > 0) w.normalize();
    const sprint = k.has("ControlLeft") || k.has("ControlRight") ? 3 : 1;
    w.multiplyScalar(useViewStore.getState().flySpeed * sprint);

    const moveK = 1 - Math.exp(-dt * 10);
    velocity.current.lerp(w, moveK);
    camera.position.addScaledVector(velocity.current, dt);
  });

  return null;
}
